// SPDX-License-Identifier: MIT

/**
 * Platform failures.
 *
 * Every one of these is `internal` in the RFC 9457 taxonomy (08 §6.4): a consumer
 * that cannot decode an event, a job kind with no handler, a lock that could not
 * be taken. None of them is the user's fault and none of them should reach a user
 * as anything but an error id, so the class carries a machine `code` and nothing
 * that would be safe to render.
 */
export class PlatformError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'PlatformError';
    this.code = code;
  }
}

/** A handler threw. Carries the consumer and the event so the log line is useful. */
export class ConsumerHandlerError extends PlatformError {
  readonly consumerName: string;
  readonly eventSeq: bigint;

  constructor(consumerName: string, eventSeq: bigint, cause: unknown) {
    super(
      'platform.consumer_handler_failed',
      `${consumerName} failed on event seq ${String(eventSeq)}: ${describeError(cause)}`,
      { cause },
    );
    this.name = 'ConsumerHandlerError';
    this.consumerName = consumerName;
    this.eventSeq = eventSeq;
  }
}

/**
 * A process's connection pool cannot cover the connections it pins for its
 * whole life (WP 4.12b, C-6; G3-5, `gate-security-review.md` §2.7, §6).
 *
 * The failure mode this exists to name: a pool that is short does not error,
 * it *hangs* — every `pool.connect()` in a job-runner poll or a scheduler tick
 * queues forever, with 0% CPU and no crash. `apps/api/src/worker.ts`'s
 * `assertPoolCoversLeases` used to log this and continue, which the Phase 3
 * gate's own sabotage (S-P1, S-P2) found: making the check a no-op, or
 * zeroing the very reservation it verifies, left `api` 75/75 green, because
 * the only test asserted the check's *name* appears in the source text, never
 * its arithmetic and never its consequence. Throwing turns a silent deadlock
 * into a crash-loop `docker compose ps` shows immediately — worse to watch,
 * far better to notice.
 */
export class PoolCannotCoverPinnedConnectionsError extends PlatformError {
  readonly poolMax: number;
  readonly pinnedConnections: number;

  constructor(poolMax: number, pinnedConnections: number, detail: string) {
    super(
      'platform.pool_cannot_cover_pinned_connections',
      `pool max (${String(poolMax)}) does not exceed this process's pinned connections ` +
        `(${String(pinnedConnections)}): ${detail}`,
    );
    this.name = 'PoolCannotCoverPinnedConnectionsError';
    this.poolMax = poolMax;
    this.pinnedConnections = pinnedConnections;
  }
}

/**
 * Reduce an unknown throw to something JSON-serialisable for `last_error`.
 *
 * Stack included, message truncated: a 2 MB provider HTML error page in a JSONB
 * column is how a `jobs` table becomes the biggest table in the database.
 */
export function serializeError(cause: unknown): Record<string, unknown> {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message.slice(0, 2_000),
      ...('code' in cause ? { code: String((cause as { code: unknown }).code) } : {}),
      stack: cause.stack?.split('\n').slice(0, 20).join('\n'),
    };
  }
  return { name: 'NonError', message: String(cause).slice(0, 2_000) };
}

export function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
