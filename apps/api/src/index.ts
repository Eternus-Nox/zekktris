/**
 * Entry point
 * -----------
 * Wire env → app → http server. Handle SIGTERM / SIGINT so containers shut
 * down cleanly (drain in-flight requests, close db pool, then exit).
 *
 * Startup sequence:
 *   1. env validation (happens at import time)
 *   2. runStartupChecks() — every subsystem reports green or aborts
 *   3. createApp() + serve() — only after all checks pass
 */

import { serve, type ServerType } from '@hono/node-server';
import { env } from './env';
import { log } from './log';
import { createApp } from './server';
import { closeDb } from './db';
import { runStartupChecks } from './startup-checks';
import { runBootstrapAdmin } from './bootstrap-admin';
import { attachGateway, detachGateway } from './gateway/server';
import { setEventBus, closeEventBus } from './gateway/bus';
import { sweepInactiveAccounts } from './services/inactivitySweep';
import { purgeExpiredSessions } from './auth/sessions';
import { sweepExpiredDmMessages } from './services/dms';

async function main(): Promise<void> {
  await runStartupChecks();

  // First-install bootstrap. If BOOTSTRAP_ADMIN_EMAIL is set and no
  // admin exists yet, promote the matching user. Idempotent once
  // any admin exists. Failures here are logged and swallowed —
  // server should still come up so the operator can fix things via
  // SQL or another path if needed.
  await runBootstrapAdmin().catch((err: unknown) => {
    log.error('bootstrap admin task failed', { err });
  });

  const app = createApp();

  const server: ServerType = serve({
    fetch: app.fetch,
    hostname: env.HOST,
    port: env.PORT,
  });

  // Gateway event bus. Default is in-process (correct for a single instance).
  // When REDIS_URL is set, swap in the Redis-backed bus so gateway events fan
  // out across API replicas. MUST run before attachGateway() — the connection
  // registry subscribes to whichever bus is active at that moment. The Redis
  // module (and ioredis) is only imported when actually enabled.
  if (env.REDIS_URL) {
    const { createRedisEventBus } = await import('./gateway/redis-bus');
    setEventBus(
      createRedisEventBus(env.REDIS_URL, (err) =>
        log.error('gateway redis bus error', {
          err: (err as Error)?.message ?? String(err),
        }),
      ),
    );
    log.info('gateway event bus: redis (multi-instance fan-out enabled)');
  } else {
    log.info('gateway event bus: in-memory (single instance)');
  }

  // Attach the WebSocket gateway to the same HTTP listener. The gateway
  // handles its own /gateway path via `upgrade` events; Hono never sees
  // those requests.
  attachGateway(server as unknown as import('node:http').Server);

  log.info('server listening', {
    host: env.HOST,
    port: env.PORT,
    publicUrl: env.PUBLIC_URL,
    workerId: env.WORKER_ID,
    env: env.NODE_ENV,
  });

  // Greppable build marker — `docker compose logs api | grep "zekktris build"`
  // confirms which version a running container is on. Bump on changes so
  // operators can verify a redeploy actually took.
  log.info('zekktris build', { build: 'v2.144' });

  // ── Inactivity sweep timer ─────────────────────────────────────────────
  // Periodically delete accounts that haven't been used in
  // INACTIVITY_TTL_DAYS days. We schedule the first run 5 minutes
  // after boot (so the server is fully warm) and then on the
  // configured interval. Errors are logged but never crash the
  // process — a sweep failure is not a service outage.
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  if (env.INACTIVITY_TTL_DAYS > 0) {
    const intervalMs = env.INACTIVITY_SWEEP_INTERVAL_HOURS * 60 * 60 * 1000;
    const runOnce = () => {
      void sweepInactiveAccounts().catch((err) =>
        log.error('inactivity sweep failed', { err }),
      );
      // Piggy-back the session purge on the same tick. Expired
      // session rows (logged-out devices, password-changed
      // sessions, etc.) accumulate forever otherwise — the function
      // existed but wasn't wired to anything. Same low-priority
      // maintenance window, same error-isolation pattern: a purge
      // failure logs and continues, doesn't block the rest of the
      // sweep.
      void purgeExpiredSessions()
        .then((n) => {
          if (n > 0) log.info('expired sessions purged', { count: n });
        })
        .catch((err) => log.error('session purge failed', { err }));
    };
    setTimeout(runOnce, 5 * 60 * 1000);
    sweepTimer = setInterval(runOnce, intervalMs);
    log.info('inactivity sweep scheduled', {
      ttlDays: env.INACTIVITY_TTL_DAYS,
      intervalHours: env.INACTIVITY_SWEEP_INTERVAL_HOURS,
    });
  } else {
    log.info('inactivity sweep disabled (INACTIVITY_TTL_DAYS=0)');
  }

  // ── DM auto-delete sweep timer ──────────────────────────────────────────
  // Finer-grained than the inactivity sweep — every 60 s. The minimum
  // configurable TTL is 10 s but in practice users will set 30 s / 60 s /
  // 120 s; a 60 s sweep cadence keeps the actual lifetime within one
  // tick of the configured value without burning resources. The sweep
  // service is bounded internally at 1000 rows per call so a sudden
  // burst doesn't lock the messages table. Same error-isolation
  // pattern as the inactivity sweep: log + continue, never crash.
  const dmSweepTimer = setInterval(() => {
    void sweepExpiredDmMessages().catch((err) =>
      log.error('DM auto-delete sweep failed', { err }),
    );
  }, 60_000);
  log.info('DM auto-delete sweep scheduled', { intervalSeconds: 60 });

  // ── Image compression sweep timer ──────────────────────────────────────
  // Re-encodes image attachments older than COMPRESS_AFTER_DAYS at a
  // lower quality target to reduce disk footprint. Requires the `sharp`
  // npm package; gracefully no-ops if not installed. First run is
  // delayed 10 minutes after boot so the api is fully warmed before
  // we start CPU-bound image work. Internally capped to BATCH_LIMIT
  // rows per tick so a backlog can't stall the loop.
  let compressTimer: ReturnType<typeof setInterval> | null = null;
  if (env.IMAGE_COMPRESS_ENABLED) {
    const intervalMs = env.IMAGE_COMPRESS_SWEEP_INTERVAL_HOURS * 60 * 60 * 1000;
    const runCompress = () =>
      void (async () => {
        try {
          const { runCompressionSweep } = await import(
            './services/imageCompression'
          );
          const r = await runCompressionSweep();
          if (r.processed > 0) {
            log.info('image compression sweep', {
              processed: r.processed,
              compressed: r.compressed,
              bytesSaved: r.bytesSaved,
              sharpAvailable: r.sharpAvailable,
            });
          } else if (!r.sharpAvailable) {
            // Log this once per tick at debug so the operator knows
            // why nothing's happening. Not warning-level because
            // it's a valid configuration choice.
            log.debug('image compression skipped — sharp not installed');
          }
        } catch (err) {
          log.error('image compression sweep failed', { err });
        }
      })();
    setTimeout(runCompress, 10 * 60 * 1000);
    compressTimer = setInterval(runCompress, intervalMs);
    log.info('image compression sweep scheduled', {
      quality: env.IMAGE_COMPRESS_QUALITY,
      intervalHours: env.IMAGE_COMPRESS_SWEEP_INTERVAL_HOURS,
    });
  } else {
    log.info('image compression sweep disabled (IMAGE_COMPRESS_ENABLED=false)');
  }

  // ── Event status sweep ────────────────────────────────────────────────
  //
  // Flips scheduled → active and active → completed events whose
  // start/end times have passed. Bounded by the partial
  // scheduled_events_active_idx so terminal-state events are
  // excluded from the scan. Once per minute matches the UI's
  // minute-level start-time precision. Cheap when no events are
  // live (index has no matching rows).
  const eventSweepTimer = setInterval(() => {
    void (async () => {
      try {
        const { runEventStatusSweep } = await import('./services/events');
        const r = await runEventStatusSweep();
        if (r.activated > 0 || r.completed > 0) {
          log.info('event status sweep', {
            activated: r.activated,
            completed: r.completed,
          });
        }
      } catch (err) {
        log.error('event status sweep failed', { err });
      }
    })();
  }, 60 * 1000);

  // ── Poll expiry sweep ─────────────────────────────────────────────────
  //
  // Auto-closes polls whose expires_at has passed. Bounded by the
  // partial polls_active_expiring_idx, so the scan is empty when no
  // polls are pending expiry — typical for most ticks.
  //
  // For each closed poll, dispatch a focused messagePollUpdate
  // broadcast carrying just the pollId + closedAt + channel/message
  // refs. The client reducer locates the message and patches the
  // poll subtree in place — much cheaper than rebuilding the full
  // message DTO when only one field actually changed.
  //
  // Vote-attempt rejection on expired polls is already handled by
  // vote(); this sweep keeps data hygiene and gives clients a live
  // "Final results" indicator without manual refresh.
  const pollSweepTimer = setInterval(() => {
    void (async () => {
      try {
        const { runPollExpirySweep } = await import('./services/polls');
        const closed = await runPollExpirySweep();
        if (closed.length === 0) return;
        log.info('poll expiry sweep', { closed: closed.length });

        // Resolve channel→guild for all affected polls in one query.
        // The sweep is rare and small (typically <5 polls per tick),
        // so this stays cheap.
        const { db, schema } = await import('./db');
        const { inArray } = await import('drizzle-orm');
        const dispatch = await import('./gateway/dispatch');
        const channelIds = Array.from(new Set(closed.map((c) => c.channelId)));
        const channelRows = await db
          .select({ id: schema.channels.id, guildId: schema.channels.guildId })
          .from(schema.channels)
          .where(inArray(schema.channels.id, channelIds));
        const guildByChannel = new Map(channelRows.map((c) => [c.id, c.guildId]));

        // Use a single now() for the closedAt timestamp on every
        // dispatched event so all clients agree on the timestamp,
        // even though the bulk UPDATE inside the service may have
        // used a different now() per row in theory.
        const closedAt = new Date();
        for (const c of closed) {
          try {
            dispatch.messagePollUpdate({
              pollId: c.pollId,
              messageId: c.messageId,
              channelId: c.channelId,
              guildId: guildByChannel.get(c.channelId) ?? null,
              closedAt,
            });
          } catch (perPollErr) {
            log.warn('poll expiry broadcast failed for one poll', {
              pollId: c.pollId.toString(),
              err: perPollErr,
            });
          }
        }
      } catch (err) {
        log.error('poll expiry sweep failed', { err });
      }
    })();
  }, 60 * 1000);

  // ── AFK auto-move sweep ───────────────────────────────────────────────
  //
  // Relocates members who've been self-muted longer than their guild's
  // afkTimeoutSeconds (default 5 min) into that guild's AFK voice channel,
  // where their mic is hardware-disabled at the SFU. Runs every 30s — fine
  // granularity isn't needed (the threshold is minutes) and the candidate
  // scan is cheap (filtered to muted rows in AFK-configured guilds). Each
  // move is broadcast as a VOICE_STATE_UPDATE so every client, including
  // the moved member's own (which re-joins the AFK room), stays in sync.
  // Same log-and-continue isolation as the other sweeps.
  const afkSweepTimer = setInterval(() => {
    void (async () => {
      try {
        const { sweepAfkMutedMembers } = await import('./services/voice');
        const dispatch = await import('./gateway/dispatch');
        const { toVoiceState } = await import('./lib/dto');
        const moves = await sweepAfkMutedMembers();
        if (moves.length === 0) return;
        log.info('AFK auto-move sweep', { moved: moves.length });
        for (const m of moves) {
          try {
            dispatch.voiceStateUpdate({
              guildId: m.guildId,
              channelId: m.voiceState.channelId,
              voiceState: toVoiceState(m.voiceState),
            });
          } catch (perMoveErr) {
            log.warn('AFK auto-move broadcast failed for one member', {
              userId: m.userId.toString(),
              err: perMoveErr,
            });
          }
        }
      } catch (err) {
        log.error('AFK auto-move sweep failed', { err });
      }
    })();
  }, 30 * 1000);

  // ── Scheduled message sweep ───────────────────────────────────────────
  //
  // Reifies queued future-send messages as real messages once their
  // scheduled_for has passed. The worker fetches up to 50 due rows
  // per tick (configurable in the service constant POLL_BATCH).
  // Each row is processed independently: success deletes the row;
  // failure bumps the attempt counter so the next tick retries.
  // After 3 failures the partial index excludes the row from future
  // polls and it stays visible in the user's "scheduled messages"
  // list with the lastError text so they can decide what to do.
  //
  // Per-row try/catch isolates failures: one user's broken row
  // (e.g. lost permission to a channel) shouldn't stop the worker
  // from processing other users' messages in the same batch.
  const scheduledMsgTimer = setInterval(() => {
    void (async () => {
      try {
        const scheduledSvc = await import('./services/scheduledMessages');
        const messagesSvc = await import('./services/messages');
        const due = await scheduledSvc.fetchDue();
        if (due.length === 0) return;
        let sent = 0;
        let failed = 0;

        // Load each due row's channel once per tick so we can pass
        // guildId to createMessage. We don't batch the lookup
        // because POLL_BATCH (50) is small enough that the per-row
        // SELECT cost is dwarfed by the message-create + dispatch
        // cost, and per-row loops keep the failure-isolation logic
        // simple.
        const { db, schema } = await import('./db');
        const { eq } = await import('drizzle-orm');
        const dispatch = await import('./gateway/dispatch');
        const { toMessage } = await import('./lib/dto');

        for (const row of due) {
          try {
            const [channel] = await db
              .select()
              .from(schema.channels)
              .where(eq(schema.channels.id, row.channelId))
              .limit(1);
            if (!channel) {
              throw new Error('Channel no longer exists');
            }
            // Re-verify the author can still post here at fire time —
            // they may have been kicked/banned, lost SEND_MESSAGES, or
            // (for DMs) stopped being a recipient since scheduling.
            // computeMemberChannelPermissions fails closed (0n) for
            // non-members and non-recipients, so one check covers both
            // guild channels and DMs. A failure here lands in the
            // catch below: attempts bump + lastError surfaces to the
            // user's scheduled-messages list.
            const { computeMemberChannelPermissions, hasPermission, Permissions } =
              await import('./services/permissions');
            const perms = await computeMemberChannelPermissions(
              row.channelId,
              row.authorId,
            );
            if (!hasPermission(perms, Permissions.SEND_MESSAGES)) {
              throw new Error('No permission to send in this channel');
            }
            // Scheduled messages can NEVER @everyone — even if the
            // user has the permission. A message firing at 3am to
            // ping the whole guild is a footgun; require it to be
            // a manual send.
            const created = await messagesSvc.createMessage({
              channelId: row.channelId,
              authorId: row.authorId,
              content: row.content,
              replyToId: row.replyToMessageId ?? null,
              guildId: channel.guildId ?? null,
              attachments: [],
              allowEveryoneMention: false,
            });

            // Dispatch the messageCreate over the gateway so live
            // clients pick it up. The DTO build needs the author —
            // load it once here.
            const [author] = await db
              .select()
              .from(schema.users)
              .where(eq(schema.users.id, row.authorId))
              .limit(1);
            if (author) {
              const dto = toMessage({
                message: created.message,
                author,
                attachments: [],
                reactions: [],
              });
              dispatch.messageCreate({
                messageDTO: dto,
                guildId: channel.guildId ?? null,
                channelId: row.channelId,
              });
            }

            await scheduledSvc.completeScheduled(row.id);
            sent++;
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : 'Unknown send error';
            await scheduledSvc
              .failScheduled(row.id, msg)
              .catch(() => undefined);
            failed++;
          }
        }
        log.info('scheduled message sweep', {
          due: due.length,
          sent,
          failed,
        });
      } catch (err) {
        log.error('scheduled message sweep failed', { err });
      }
    })();
  }, 60 * 1000);

  // ── Thread auto-archive sweep ──────────────────────────────────────────
  //
  // Flips idle threads to archived when last_activity_at +
  // auto_archive_minutes has passed. Bounded by the partial
  // channels_active_threads_idx so the scan stays cheap even on guilds
  // with thousands of historical archived posts.
  //
  // Each archived thread gets a CHANNEL_UPDATE broadcast so connected
  // clients see the transition live — ForumView grays the post out in
  // its list; MessageView switches the stream to read-only.
  const threadArchiveSweepTimer = setInterval(() => {
    void (async () => {
      try {
        const { runThreadAutoArchiveSweep } = await import('./services/threads');
        const { toChannel } = await import('./lib/dto');
        const dispatch = await import('./gateway/dispatch');
        const archived = await runThreadAutoArchiveSweep();
        if (archived.length === 0) return;
        log.info('thread auto-archive sweep', { archived: archived.length });

        for (const thread of archived) {
          if (!thread.guildId) continue; // defense; shouldn't happen
          try {
            dispatch.channelUpdate({
              channelDTO: toChannel(thread),
              channelId: thread.id,
              guildId: thread.guildId,
            });
          } catch (perThreadErr) {
            log.warn('thread archive broadcast failed for one thread', {
              threadId: thread.id.toString(),
              err: perThreadErr,
            });
          }
        }
      } catch (err) {
        log.error('thread auto-archive sweep failed', { err });
      }
    })();
  }, 60 * 1000);

  // ── Attachment GC sweep ────────────────────────────────────────────────
  //
  // Hourly cadence — orphan files accumulate slowly (mostly from
  // abandoned pre-create event uploads), and the scan walks the
  // upload directory + runs ~10 SELECTs to build the referenced set.
  // Not free, but not so heavy that hourly is wasteful.
  //
  // First run is delayed 5 minutes after boot so the API is fully
  // warmed before we start a potentially long disk scan that competes
  // with request handling.
  let attachmentGcTimer: ReturnType<typeof setInterval> | null = null;
  const runAttachmentGc = () =>
    void (async () => {
      try {
        const { runAttachmentGcSweep } = await import('./services/uploads');
        const r = await runAttachmentGcSweep();
        if (r.deleted > 0) {
          log.info('attachment GC sweep', {
            scanned: r.scanned,
            deleted: r.deleted,
          });
        }
      } catch (err) {
        log.error('attachment GC sweep failed', { err });
      }
    })();
  // Defer the first run so boot stays fast.
  setTimeout(runAttachmentGc, 5 * 60 * 1000);
  attachmentGcTimer = setInterval(runAttachmentGc, 60 * 60 * 1000);

  // ── Graceful shutdown ──────────────────────────────────────────────────

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);

    // Stop the inactivity sweep timer so we don't kick off a long
    // delete query mid-shutdown.
    if (sweepTimer) clearInterval(sweepTimer);
    clearInterval(dmSweepTimer);
    if (compressTimer) clearInterval(compressTimer);
    clearInterval(eventSweepTimer);
    clearInterval(pollSweepTimer);
    clearInterval(afkSweepTimer);
    clearInterval(threadArchiveSweepTimer);
    if (attachmentGcTimer) clearInterval(attachmentGcTimer);

    // Close all gateway connections first; they're the long-lived ones.
    detachGateway();

    // Release the event bus's resources (Redis connections, when enabled).
    try {
      await closeEventBus();
    } catch (err) {
      log.error('event bus close failed during shutdown', { err });
    }

    // Stop accepting new connections; finish in-flight ones.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    try {
      await closeDb();
    } catch (err) {
      log.error('db close failed during shutdown', { err });
    }

    log.info('shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Last-resort handlers — these mean a bug, log loudly and exit.
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', { err });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { reason });
  process.exit(1);
});

main().catch((err: unknown) => {
  // runStartupChecks exits the process directly on failure, but anything
  // unexpected during boot still lands here.
  log.error('boot failed', { err });
  process.exit(1);
});
