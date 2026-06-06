/**
 * Event bus
 * ---------
 * Decouples dispatch (services calling `dispatch.messageCreate`) from the
 * connection registry (which actually delivers events to clients).
 *
 * V1 ships with the in-memory implementation only. The interface is shaped
 * so a Redis pub/sub backend can be plugged in later without touching the
 * service or registry code: emit() becomes PUBLISH; subscribe() becomes
 * SUBSCRIBE on a single channel name like "zekktris:gateway".
 *
 * Why a single channel rather than per-guild? Two reasons:
 *   1. Per-guild gives O(guilds × replicas) subscriptions, which on Redis
 *      means a lot of wakeups for events that won't actually deliver.
 *   2. The Audience filter is cheap; doing it server-side after a single
 *      broadcast is simpler than maintaining a fan-out subscription map.
 *
 * This trades bandwidth (every replica sees every event) for simplicity. At
 * unraid scale that's fine; at Discord scale you'd partition by shard id.
 */

import type { GatewayEventName, GatewayFrame } from '@zekktris/shared/events';
import type { Audience } from './types';

export interface PublishedEvent {
  /** Event name (frame `t`). */
  t: GatewayEventName;
  /** Frame payload (frame `d`). */
  d: unknown;
  /** Who should receive it. The bus doesn't filter; subscribers do. */
  audience: Audience;
}

export interface EventBus {
  publish(event: PublishedEvent): void;
  subscribe(handler: (event: PublishedEvent) => void): () => void;
}

export class InMemoryEventBus implements EventBus {
  private handlers = new Set<(event: PublishedEvent) => void>();

  publish(event: PublishedEvent): void {
    // Iterate a snapshot so handlers can subscribe/unsubscribe during dispatch
    // without mutating the set we're walking.
    const snapshot = Array.from(this.handlers);
    for (const h of snapshot) {
      try {
        h(event);
      } catch {
        // A bad subscriber must not poison delivery to the others.
        // Log via the handler's own surface — we have no log dep here.
      }
    }
  }

  subscribe(handler: (event: PublishedEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Test/diagnostic only. */
  get subscriberCount(): number {
    return this.handlers.size;
  }
}

/** Singleton instance — replace by setEventBus() if a different impl is wired later. */
let bus: EventBus = new InMemoryEventBus();

export function eventBus(): EventBus {
  return bus;
}

export function setEventBus(next: EventBus): void {
  bus = next;
}

/**
 * Close the active bus if it holds resources (e.g. the Redis-backed bus owns
 * two connections). No-op for the in-memory bus. Call on graceful shutdown.
 */
export async function closeEventBus(): Promise<void> {
  const closable = bus as { close?: () => Promise<void> | void };
  if (typeof closable.close === 'function') {
    await closable.close();
  }
}

/** For tests. */
export function _resetEventBus(): void {
  bus = new InMemoryEventBus();
}

// Helper: assemble a PublishedEvent from a frame plus an audience.
export function asPublished(
  frame: GatewayFrame,
  audience: Audience,
): PublishedEvent {
  if (frame.t === undefined) {
    throw new Error('publish requires a DISPATCH frame (t must be set)');
  }
  return { t: frame.t, d: frame.d, audience };
}
