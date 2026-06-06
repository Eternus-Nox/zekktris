/**
 * Raid protection
 * ---------------
 * Join-time gates (account age, verified email, hard lockdown) plus an
 * automatic raid-mode trigger driven by join rate. `assertJoinAllowed` runs
 * inside the join transaction (invite-accept / discovery-join) and throws a
 * FORBIDDEN AppError when a join should be refused. When the join-rate limit
 * trips it flips the guild into raid mode (in the same transaction) so the
 * surge is shut off immediately, then blocks the current join too.
 */
import type { Database } from '@zekktris/db';
import { and, eq, gte, sql } from 'drizzle-orm';
import { schema } from '../db';
import { AppError } from '../errors';

type DbHandle = Omit<Database, '$client'>;

/** The guild raid-protection columns plus its id. */
export interface GuildJoinGate {
  id: bigint;
  minAccountAgeMinutes: number;
  requireVerifiedEmail: boolean;
  raidModeEnabled: boolean;
  joinRateLimitCount: number | null;
  joinRateLimitSeconds: number | null;
}

export interface JoiningUser {
  createdAt: Date;
  emailVerified: boolean;
}

function blocked(reason: string, message: string): never {
  throw new AppError('FORBIDDEN', message, { raidBlocked: reason });
}

export async function assertJoinAllowed(
  tx: DbHandle,
  guild: GuildJoinGate,
  user: JoiningUser,
): Promise<void> {
  // 1. Hard lockdown — refuse everyone.
  if (guild.raidModeEnabled) {
    blocked('raid_mode', 'This server isn’t accepting new members right now');
  }

  // 2. Verified-email gate.
  if (guild.requireVerifiedEmail && !user.emailVerified) {
    blocked('verified_email', 'This server requires a verified email address to join');
  }

  // 3. Account-age gate.
  if (guild.minAccountAgeMinutes > 0) {
    const ageMinutes = (Date.now() - user.createdAt.getTime()) / 60_000;
    if (ageMinutes < guild.minAccountAgeMinutes) {
      blocked('account_age', 'Your account is too new to join this server');
    }
  }

  // 4. Join-rate auto-trigger. Count recent joins; if the surge exceeds the
  //    configured threshold, enable raid mode and block this join too.
  const count = guild.joinRateLimitCount;
  const seconds = guild.joinRateLimitSeconds;
  if (count != null && seconds != null && count > 0 && seconds > 0) {
    const since = new Date(Date.now() - seconds * 1000);
    const [row] = await tx
      .select({ c: sql<number>`count(*)::int` })
      .from(schema.guildMembers)
      .where(
        and(eq(schema.guildMembers.guildId, guild.id), gte(schema.guildMembers.joinedAt, since)),
      );
    if (Number(row?.c ?? 0) >= count) {
      await tx
        .update(schema.guilds)
        .set({ raidModeEnabled: true, updatedAt: new Date() })
        .where(eq(schema.guilds.id, guild.id));
      blocked('raid_rate', 'This server isn’t accepting new members right now');
    }
  }
}
