// SPDX-License-Identifier: MIT
import type pg from 'pg';
import { describeError } from './errors.ts';
import type { PlatformLogger } from './executor.ts';

/**
 * Channel names. Postgres identifiers, so lower-case and unquoted everywhere.
 */
export const CHANNEL = {
  domainEvents: 'personalfi_domain_events',
  jobs: 'personalfi_jobs',
  featureFlags: 'personalfi_feature_flags',
} as const;

export type Channel = (typeof CHANNEL)[keyof typeof CHANNEL];

export interface NotifyListener {
  /** Resolve as soon as a notification arrives, or after `timeoutMs`. */
  wait(timeoutMs: number): Promise<'notified' | 'timeout'>;
  /**
   * Wake the current (or, if none is parked, the next) `wait` as though a
   * notification had arrived, without involving the database. For the owner of
   * the loop to say "something I run changed what is claimable" — a job
   * finishing frees capacity, and no `NOTIFY` is sent for that.
   */
  nudge(): void;
  close(): Promise<void>;
}

/**
 * A `LISTEN` on a dedicated connection, exposed as "sleep until something
 * happens, or at most this long".
 *
 * **The notification is an optimisation, never the mechanism.** Every caller
 * passes a timeout and re-reads the database when it expires, so a dropped
 * connection, a notification lost during a failover, or a Postgres restart costs
 * latency and nothing else. Correctness lives in the `seq > last_seq` query and
 * in `FOR UPDATE SKIP LOCKED`; this file only decides whether the next poll
 * happens in 4 milliseconds or 5 seconds.
 *
 * The connection is taken out of the pool for the listener's lifetime. That is
 * one connection per listening loop, which is why the worker has a handful of
 * loops and not one per consumer... except that per-consumer isolation is worth
 * more than a connection here, so the pump shares a single listener across all
 * consumers and wakes them all. See `src/events/pump.ts`.
 */
export async function createNotifyListener(
  pool: pg.Pool,
  channel: Channel,
  logger: PlatformLogger,
): Promise<NotifyListener> {
  const client = await pool.connect();
  let closed = false;
  let pending = false;
  let wake: (() => void) | null = null;

  const onNotification = (message: pg.Notification): void => {
    if (message.channel !== channel) return;
    pending = true;
    wake?.();
  };

  // A dropped listener connection must not take the process with it. The loop
  // that owns this listener keeps polling; the next `close`/`create` cycle or a
  // restart re-establishes it.
  const onError = (error: Error): void => {
    if (closed) return;
    logger.warn({ err: error, channel }, 'listen connection failed; falling back to polling');
    pending = true;
    wake?.();
  };

  client.on('notification', onNotification);
  client.on('error', onError);
  await client.query(`LISTEN ${channel}`);

  return {
    async wait(timeoutMs) {
      if (closed) return 'timeout';
      if (pending) {
        pending = false;
        return 'notified';
      }
      return await new Promise<'notified' | 'timeout'>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve('timeout');
        }, timeoutMs);
        // Do not hold the event loop open for a poll interval on shutdown.
        timer.unref?.();
        wake = () => {
          clearTimeout(timer);
          wake = null;
          pending = false;
          resolve('notified');
        };
      });
    },

    nudge() {
      if (closed) return;
      pending = true;
      wake?.();
    },

    async close() {
      if (closed) return;
      closed = true;
      wake?.();
      client.off('notification', onNotification);
      client.off('error', onError);
      try {
        await client.query(`UNLISTEN ${channel}`);
      } catch (cause) {
        logger.debug({ err: describeError(cause), channel }, 'unlisten failed on shutdown');
      } finally {
        client.release();
      }
    },
  };
}
