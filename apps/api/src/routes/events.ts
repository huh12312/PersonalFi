// SPDX-License-Identifier: MIT
/**
 * `GET /sync/stream` and `GET /connections/:id/events` — sync progress over SSE.
 *
 * ## Why SSE and not a WebSocket (04 §6.4)
 *
 * Progress is unidirectional. SSE gets automatic browser reconnection with
 * `Last-Event-ID` for free, traverses Caddy without upgrade negotiation, and
 * needs no dependency. A WebSocket would add a protocol, a library and a
 * heartbeat implementation to solve a problem we do not have.
 *
 * ## Where the events come from
 *
 * The outbox, read directly — not a second in-process bus. `domain_events` is
 * already the total, gap-free commit order of every fact the application states
 * (`seq` is taken under a transaction-scoped advisory lock precisely so a reader
 * that has seen 6 can never miss a 5), and the sync that produces them runs in
 * the **worker**, a different container. An in-process `EventEmitter` would
 * therefore see nothing at all.
 *
 * `LISTEN`/`NOTIFY` on `personalfi_domain_events` is the wake-up, never the
 * mechanism — the same rule `@core/platform`'s own pump follows. Every wait has a
 * timeout and re-reads the table when it expires, so a dropped listener
 * connection, a notification lost in a failover, or a Postgres restart costs
 * latency and nothing else. `Last-Event-ID` is honoured, so a browser that
 * reconnects resumes at the sequence it had rather than replaying the day.
 *
 * ## The heartbeat
 *
 * A `:` comment every fifteen seconds. Two reasons, both real: an idle SSE
 * connection behind a reverse proxy gets reaped somewhere between 30 and 120
 * seconds depending on whose default is in force, and a client has no other way
 * to distinguish "nothing is happening" from "the connection died quietly".
 *
 * ## Event names
 *
 * | SSE event           | Domain event                            | Stream             |
 * | ------------------- | --------------------------------------- | ------------------ |
 * | `connection.created`| `connections.ConnectionCreated`         | both               |
 * | `connection.status` | `connections.ConnectionStatusChanged`   | both               |
 * | `sync.completed`    | `connections.SyncRunCompleted`          | both               |
 * | `sync.progress`     | `ledger.TransactionsUpserted`           | `/sync/stream`     |
 * | `account.upserted`  | `ledger.AccountUpserted`                | `/sync/stream`     |
 * | `balance.recorded`  | `ledger.BalanceRecorded`                | `/sync/stream`     |
 *
 * The client-facing names are deliberately not the domain event types: a domain
 * event type is an internal contract a context may version, an SSE event name is
 * in a browser's `addEventListener` and in a `switch`. This table is the only
 * place the two vocabularies meet.
 *
 * The per-connection stream carries the three events whose `aggregate_id` *is* a
 * connection. The ledger's are aggregated on an account or a transaction, so
 * filtering them by connection would require a join the outbox deliberately does
 * not support — a consumer that wants more re-reads the read model. Per-row
 * progress is on `/sync/stream`.
 *
 * ## Concurrent-stream caps (R-9, gate-security-review.md §5.3/§6 C-6)
 *
 * Each open stream holds **one dedicated connection out of the shared pool**
 * for its entire life (`createNotifyListener`'s `pool.connect()`, released in
 * `finally`). With no cap, `DATABASE_POOL_MAX` browser tabs on one session —
 * stolen cookie or not — exhaust the pool and take down every other route,
 * reads and mutations alike, because they all borrow from the same pool. The
 * gate measured this at 10 tabs against the production default.
 *
 * Two caps, both enforced in-process (this deployment runs one `api`
 * container; `compose.yml` has no replica count to share state across):
 *
 * - **Per session** (`SSE_MAX_STREAMS_PER_SESSION`, below): a real browser
 *   opens a handful of tabs at most. Three covers "the dashboard plus two
 *   background tabs" and is small enough that a stolen cookie cannot starve
 *   the pool on its own.
 * - **Global** (`sseGlobalLimit`, below): derived from the pool's own `max`
 *   rather than a second constant that can drift from it — half the pool,
 *   floored at 1, so streams can never claim every connection the process
 *   holds. The other half stays available for ordinary request handling,
 *   which borrows a connection for the length of one query rather than the
 *   length of a browser tab.
 *
 * Exceeding either returns `429` with `Retry-After` before the stream ever
 * opens a socket or checks a connection out of the pool; the slot is released
 * the moment the stream's own `finally` runs, whether the client closed it or
 * the server ended it.
 */
import type { Database } from '@core/db';
import { CHANNEL, createNotifyListener, domainEvents, toInstant } from '@core/platform';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, PROBLEM_CONTENT_TYPE, problems, toProblem } from '../problem.ts';
import type { RouteDeps } from './deps.ts';

/**
 * A real browser opens a handful of tabs at most (R-9). Not configurable: a
 * per-deployment override here is a lever an operator reaches for under
 * exactly the load this cap exists to survive, which is how a cap stops being
 * one. `sseGlobalLimit` is the knob that actually moves with the deployment.
 */
export const SSE_MAX_STREAMS_PER_SESSION = 3;

/** How long a `429` here asks the client to wait before retrying. */
const SSE_RETRY_AFTER_SECONDS = 5;

/**
 * Half the pool, floored at 1 — never all of it. `poolMax` is
 * `pg.Pool#options.max`, which is `DATABASE_POOL_MAX` verbatim (`main.ts`
 * passes it straight through to `createPool`), so this tracks the deployment's
 * actual pool size rather than a hardcoded number that could drift from it.
 */
export function sseGlobalLimit(poolMax: number): number {
  return Math.max(1, Math.floor(poolMax / 2));
}

type SlotResult =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly reason: 'session' | 'global' };

/**
 * In-process accounting for the two caps above. One instance per `api`
 * process (constructed once, inside `eventRoutes`, and closed over by both
 * route handlers), which is exactly right for a deployment with one `api`
 * container and no shared state between replicas.
 */
export class StreamSlots {
  readonly #perSession = new Map<string, number>();
  #global = 0;
  // Not TS constructor-parameter-property shorthand: `log-hygiene.test.ts`
  // boots the real application under plain `node`'s type-stripping mode,
  // which does not support that syntax — see that suite's own header.
  readonly #perSessionLimit: number;
  readonly #globalLimit: number;

  constructor(perSessionLimit: number, globalLimit: number) {
    this.#perSessionLimit = perSessionLimit;
    this.#globalLimit = globalLimit;
  }

  /** Current count for one session. Exposed for tests, not for a route. */
  countFor(sessionId: string): number {
    return this.#perSession.get(sessionId) ?? 0;
  }

  /** Current total across every session. Exposed for tests, not for a route. */
  get globalCount(): number {
    return this.#global;
  }

  acquire(sessionId: string): SlotResult {
    const current = this.#perSession.get(sessionId) ?? 0;
    if (current >= this.#perSessionLimit) return { ok: false, reason: 'session' };
    if (this.#global >= this.#globalLimit) return { ok: false, reason: 'global' };

    this.#perSession.set(sessionId, current + 1);
    this.#global += 1;
    let released = false;

    return {
      ok: true,
      release: () => {
        if (released) return; // idempotent: a double-release must not free a slot twice
        released = true;
        const next = (this.#perSession.get(sessionId) ?? 1) - 1;
        if (next <= 0) this.#perSession.delete(sessionId);
        else this.#perSession.set(sessionId, next);
        this.#global -= 1;
      },
    };
  }
}

/**
 * `429`, built and sent directly rather than thrown through `app.ts`'s shared
 * error handler — that handler runs after the SSE headers could already be
 * written, and a `Retry-After` set on the reply before a throw is one more
 * thing to trust about ordering when a `reply.code(429).send(...)` here says
 * exactly what happens with no assumption at all.
 */
async function sendTooManyStreams(
  reply: FastifyReply,
  request: FastifyRequest,
  reason: 'session' | 'global',
): Promise<void> {
  const detail =
    reason === 'session'
      ? `This session already has ${String(SSE_MAX_STREAMS_PER_SESSION)} concurrent event ` +
        'stream(s) open. Close one (another tab, an old connection) before opening another.'
      : 'This deployment has reached its concurrent event-stream limit. Try again shortly.';
  const error = new AppError({
    status: 429,
    code: reason === 'session' ? 'connections.sse_session_limit' : 'connections.sse_global_limit',
    title: 'Too Many Requests',
    detail,
    family: 'user',
  });
  const { problem } = toProblem(error, String(request.id), request.url);
  await reply
    .code(429)
    .header('retry-after', String(SSE_RETRY_AFTER_SECONDS))
    .type(PROBLEM_CONTENT_TYPE)
    .send(problem);
}

/** Domain event type → SSE event name. Anything absent is not streamed. */
const EVENT_NAMES: Readonly<Record<string, string>> = {
  'connections.ConnectionCreated': 'connection.created',
  'connections.ConnectionStatusChanged': 'connection.status',
  'connections.SyncRunCompleted': 'sync.completed',
  'ledger.TransactionsUpserted': 'sync.progress',
  'ledger.AccountUpserted': 'account.upserted',
  'ledger.BalanceRecorded': 'balance.recorded',
};

/** The events whose aggregate is a connection, for the per-connection stream. */
const CONNECTION_TYPES = [
  'connections.ConnectionCreated',
  'connections.ConnectionStatusChanged',
  'connections.SyncRunCompleted',
];

const ALL_TYPES = Object.keys(EVENT_NAMES);

/** 15 s, per the doc comment. Shorter than any proxy's idle reaper. */
const HEARTBEAT_MS = 15_000;
/** How long a wait blocks before re-reading regardless. NOTIFY normally wins. */
const POLL_MS = 1_000;
/** Rows per read. A full batch means "there is more"; the loop does not sleep. */
const BATCH = 200;

interface StreamOptions {
  readonly userId: string;
  /** `null` streams everything this user owns; a uuid filters to one connection. */
  readonly aggregateId: string | null;
  readonly types: readonly string[];
  readonly from: bigint | null;
}

/**
 * Serialise one row as an SSE frame.
 *
 * `id:` is the outbox sequence, so `Last-Event-ID` on a reconnect is a position
 * in the same total order the first read used. The payload is the domain event's
 * own payload, which by the registry's rule is ids, counts and enums — never a
 * row, and so never anything that needs redacting on the way out.
 */
function frameOf(row: {
  seq: bigint;
  eventType: string;
  aggregateId: string | null;
  payload: unknown;
  occurredAt: Date | string;
  correlationId: string;
}): string {
  const name = EVENT_NAMES[row.eventType] ?? 'event';
  const data = JSON.stringify({
    type: name,
    aggregateId: row.aggregateId,
    occurredAt: toInstant(row.occurredAt).toISOString(),
    correlationId: row.correlationId,
    payload: row.payload,
  });
  return `id: ${row.seq.toString()}\nevent: ${name}\ndata: ${data}\n\n`;
}

/**
 * Where to resume from.
 *
 * `Last-Event-ID` arrives from a browser that reconnected on its own; `?from=` is
 * the same thing for a client managing its own retries. Anything that is not a
 * non-negative integer is ignored rather than rejected: a malformed header on a
 * reconnect must not turn a network blip into a 400 the user sees.
 */
function resumeFrom(header: unknown, query: string | undefined): bigint | null {
  for (const candidate of [header, query]) {
    if (typeof candidate === 'string' && /^\d{1,19}$/u.test(candidate)) return BigInt(candidate);
  }
  return null;
}

/** The outbox's high-water mark. A fresh stream starts here, not at zero. */
async function latestSeq(database: Database, userId: string): Promise<bigint> {
  const rows = await database
    .select({ seq: sql<string | null>`max(${domainEvents.seq})` })
    .from(domainEvents)
    .where(eq(domainEvents.userId, userId));
  const value = rows[0]?.seq;
  return value === null || value === undefined ? 0n : BigInt(value);
}

export const eventRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { clock, guards, database, pool } = deps;

  // One tracker for the process, shared by both routes below — a tab open on
  // `/sync/stream` and a tab open on `/connections/{id}/events` both hold a
  // pool connection and both count against the same two caps (R-9).
  const slots = new StreamSlots(
    SSE_MAX_STREAMS_PER_SESSION,
    sseGlobalLimit(pool.options.max ?? 10),
  );

  /**
   * The stream itself, shared by both routes.
   *
   * Written against `reply.raw`: an SSE body is an open socket, not a value, and
   * Fastify's response serialiser has nothing useful to do with it. The route
   * still declares a schema so the operation, its parameters and its 401 appear
   * in the OpenAPI document.
   */
  async function stream(
    request: FastifyRequest,
    reply: FastifyReply,
    options: StreamOptions,
  ): Promise<void> {
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      // Caddy and every nginx-shaped proxy buffer ordinary responses; this is
      // the header they understand as "do not".
      'x-accel-buffering': 'no',
    });
    raw.write(': stream open\n\n');

    let closed = false;
    // Resolved the instant the socket closes, so the loop below does not have
    // to wait out the rest of a `listener.wait(POLL_MS)` call (up to a second)
    // before it notices — which matters for R-9's slot release, and for
    // `finally` releasing the pool connection promptly rather than merely
    // "eventually".
    let notifyClosed: (() => void) | null = null;
    const closedSignal = new Promise<void>((resolve) => {
      notifyClosed = resolve;
    });
    const onClose = (): void => {
      closed = true;
      notifyClosed?.();
    };
    request.raw.on('close', onClose);
    request.raw.on('error', onClose);

    // One dedicated connection for the life of the stream, released in `finally`
    // whatever happens — including the client vanishing mid-write.
    const listener = await createNotifyListener(pool, CHANNEL.domainEvents, request.log);
    let cursor = options.from ?? (await latestSeq(database, options.userId));
    // `clock`, not `Date.now()`: the ban is repo-wide and a heartbeat is exactly
    // the kind of timing a test wants to drive rather than wait out.
    let lastBeatMs = clock.nowMs();

    try {
      while (!closed && !raw.writableEnded) {
        const conditions = [
          eq(domainEvents.userId, options.userId),
          gt(domainEvents.seq, cursor),
          inArray(domainEvents.eventType, [...options.types]),
        ];
        if (options.aggregateId !== null) {
          conditions.push(eq(domainEvents.aggregateId, options.aggregateId));
        }

        const rows = await database
          .select({
            seq: domainEvents.seq,
            eventType: domainEvents.eventType,
            aggregateId: domainEvents.aggregateId,
            payload: domainEvents.payload,
            occurredAt: domainEvents.occurredAt,
            correlationId: domainEvents.correlationId,
          })
          .from(domainEvents)
          .where(and(...conditions))
          .orderBy(asc(domainEvents.seq))
          .limit(BATCH);

        for (const row of rows) {
          if (closed || raw.writableEnded) break;
          raw.write(frameOf(row));
          cursor = row.seq;
          lastBeatMs = clock.nowMs();
        }

        if (closed || raw.writableEnded) break;
        if (rows.length === BATCH) continue;

        await Promise.race([listener.wait(POLL_MS), closedSignal]);
        if (clock.nowMs() - lastBeatMs >= HEARTBEAT_MS && !closed && !raw.writableEnded) {
          raw.write(': heartbeat\n\n');
          lastBeatMs = clock.nowMs();
        }
      }
    } finally {
      request.raw.off('close', onClose);
      request.raw.off('error', onClose);
      await listener.close();
      if (!raw.writableEnded) raw.end();
    }
  }

  return async (app) => {
    app.get(
      '/sync/stream',
      {
        schema: {
          operationId: 'streamSyncEvents',
          summary: 'Server-sent events for every connection',
          description:
            '`text/event-stream`. Events: `connection.created`, `connection.status`, ' +
            '`sync.progress`, `sync.completed`, `account.upserted`, `balance.recorded`. A `:` ' +
            'comment every 15 seconds keeps a proxy from reaping an idle stream. `id:` is the ' +
            'outbox sequence; send it back as `Last-Event-ID` (or `?from=`) to resume.',
          tags: ['connections'],
          querystring: z.object({ from: z.string().optional() }),
          produces: ['text/event-stream'],
          response: { 200: z.string(), ...problems(401, 429, 503) },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const slot = slots.acquire(session.id);
        if (!slot.ok) {
          await sendTooManyStreams(reply, request, slot.reason);
          return;
        }
        try {
          await stream(request, reply, {
            userId: session.userId,
            aggregateId: null,
            types: ALL_TYPES,
            from: resumeFrom(request.headers['last-event-id'], request.query.from),
          });
        } finally {
          slot.release();
        }
      },
    );

    app.get(
      '/connections/:connectionId/events',
      {
        schema: {
          operationId: 'streamConnectionEvents',
          summary: 'Server-sent events for one connection',
          description:
            'The link-flow stream: opened after `POST /connections` so the UI can follow the ' +
            'backfill. Carries the three events whose aggregate is a connection — ' +
            '`connection.created`, `connection.status`, `sync.completed`. Per-row progress is ' +
            'aggregated on an account and is on `/sync/stream`.',
          tags: ['connections'],
          params: z.object({ connectionId: z.uuid() }),
          querystring: z.object({ from: z.string().optional() }),
          produces: ['text/event-stream'],
          response: { 200: z.string(), ...problems(401, 404, 429, 503) },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const slot = slots.acquire(session.id);
        if (!slot.ok) {
          await sendTooManyStreams(reply, request, slot.reason);
          return;
        }
        try {
          await stream(request, reply, {
            userId: session.userId,
            aggregateId: request.params.connectionId,
            types: CONNECTION_TYPES,
            from: resumeFrom(request.headers['last-event-id'], request.query.from),
          });
        } finally {
          slot.release();
        }
      },
    );
  };
};
