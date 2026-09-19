// SPDX-License-Identifier: MIT
/**
 * The fake channel.
 *
 * Every database-backed suite in this package drives the outbox, the backoff
 * ladder and the dead-letter path through this rather than through a socket.
 * 02-phase-2-dispatch.md's rule for WP 2.4 is that no test ever sends a real
 * email or a real ntfy push, and this is how that rule is kept without also
 * losing coverage of the delivery job.
 *
 * It lives in `src/` and not in `test/` on purpose, for the same reason
 * `@ctx/recurring`'s `inMemoryLedgerPort` does: a reviewer re-running these
 * proofs must not be able to accidentally write a friendlier fake. There is one,
 * it is exported from the package surface, and `apps/api` never constructs it —
 * the `notifications` module registers the real adapters (see
 * `docs/evidence/phase-2/wp2.4-notifications.md` §6).
 *
 * What it deliberately does **not** do is bypass the egress guard. The
 * coalescing exit test is asserted on the outbox and not on this adapter —
 * "asserted on the outbox, not the adapter" is the dispatch note's own wording
 * — precisely because an adapter-level count would pass even if the outbox had
 * inserted 2,000 rows and something downstream had swallowed 1,999 of them.
 */
import type {
  ChannelCapabilities,
  ChannelConfig,
  DeliveryResult,
  Notification,
  NotificationChannel,
  VerifyResult,
} from '../channel.ts';

export interface FakeDelivery {
  readonly notification: Notification;
  readonly config: ChannelConfig;
}

export interface FakeChannel extends NotificationChannel {
  /** Everything `send` was called with, in order. */
  readonly deliveries: readonly FakeDelivery[];
  /** Everything `verify` was called with. */
  readonly verifications: readonly ChannelConfig[];
  /**
   * Make the next `send` (and every one after it, until reset) answer with
   * this. The delivery job's backoff and dead-letter behaviour are driven from
   * here.
   */
  setNextResult(result: DeliveryResult): void;
  /** Answer `count` calls with `result`, then go back to delivering. */
  failFor(count: number, result: DeliveryResult): void;
  reset(): void;
}

const CAPABILITIES: ChannelCapabilities = Object.freeze({
  markdown: true,
  actions: true,
  attachments: false,
  maxBytes: 65_536,
});

export function createFakeChannel(): FakeChannel {
  const deliveries: FakeDelivery[] = [];
  const verifications: ChannelConfig[] = [];
  let standing: DeliveryResult = { outcome: 'delivered' };
  let remaining = Number.POSITIVE_INFINITY;
  let fallback: DeliveryResult = { outcome: 'delivered' };

  return {
    kind: 'fake',
    capabilities: CAPABILITIES,
    deliveries,
    verifications,

    setNextResult(result: DeliveryResult): void {
      standing = result;
      remaining = Number.POSITIVE_INFINITY;
    },

    failFor(count: number, result: DeliveryResult): void {
      standing = result;
      remaining = count;
      fallback = { outcome: 'delivered' };
    },

    reset(): void {
      deliveries.length = 0;
      verifications.length = 0;
      standing = { outcome: 'delivered' };
      remaining = Number.POSITIVE_INFINITY;
      fallback = { outcome: 'delivered' };
    },

    send(notification: Notification, config: ChannelConfig): Promise<DeliveryResult> {
      deliveries.push({ notification, config });
      if (remaining <= 0) return Promise.resolve(fallback);
      remaining -= 1;
      return Promise.resolve(standing);
    },

    verify(config: ChannelConfig): Promise<VerifyResult> {
      verifications.push(config);
      return Promise.resolve({ ok: true });
    },
  };
}
