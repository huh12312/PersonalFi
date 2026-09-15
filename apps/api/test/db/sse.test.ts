// SPDX-License-Identifier: MIT
/**
 * `GET /sync/stream` and `GET /connections/:id/events`, over a real socket.
 *
 * These are the one set of routes `app.inject` cannot test. An SSE body is an
 * open socket that the handler writes to until the *client* goes away, and
 * `inject` has no client to go away — so the suite starts the application on an
 * ephemeral port and drives it with `fetch` and an `AbortController`, which is
 * also what a browser does.
 *
 * The claims:
 *
 * 1. **Events reach a live stream during a sync**, with the client-facing names
 *    from the table in `routes/events.ts` and not the domain event types.
 * 2. **`id:` is the outbox sequence**, strictly ascending, so `Last-Event-ID`
 *    is a position in the same total order the first read used.
 * 3. **A reconnect resumes rather than replaying the day** — both spellings,
 *    `Last-Event-ID` and `?from=`.
 * 4. **The per-connection stream is filtered** to the three events whose
 *    aggregate *is* a connection, and to that connection.
 * 5. **The heartbeat is a `:` comment every 15 seconds**, driven by the
 *    injected clock rather than by fifteen seconds of wall time.
 * 6. **Closing is clean**: the dedicated `LISTEN` connection each stream holds
 *    is released when the client vanishes mid-stream, and not leaked.
 */
import { DateOnly, money, mutableClock } from '@core/kernel';
import { manualTransaction } from '@connector/manual';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SSE_MAX_STREAMS_PER_SESSION } from '../../src/routes/events.ts';
import {
  createApiHarness,
  linkManual,
  NO_DATABASE,
  syncConnection,
  type ApiHarness,
  type LinkedConnection,
  type TestSession,
} from '../helpers/api-harness.ts';

const CHECKING = 'checking';

interface Frame {
  /** `id:` — the outbox sequence. */
  readonly id: string | null;
  readonly event: string | null;
  readonly data: Record<string, unknown> | null;
  /** True for a `:` line, which is a comment and carries no event. */
  readonly comment: string | null;
}

/**
 * An open stream, and everything it has said so far.
 *
 * The reader runs detached: a test opens a stream, *then* causes something to
 * happen, then waits for the frames it expects. Awaiting the read loop instead
 * would deadlock, because the loop only ends when the stream does.
 */
interface OpenStream {
  readonly frames: Frame[];
  readonly raw: () => string;
  /** Resolve once `predicate` holds, or reject after `timeoutMs`. */
  waitFor(
    description: string,
    predicate: (frames: Frame[]) => boolean,
    timeoutMs?: number,
  ): Promise<void>;
  close(): Promise<void>;
}

function parseFrame(block: string): Frame {
  let id: string | null = null;
  let event: string | null = null;
  let data: Record<string, unknown> | null = null;
  let comment: string | null = null;

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) comment = line.slice(1).trim();
    else if (line.startsWith('id: ')) id = line.slice(4);
    else if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data = JSON.parse(line.slice(6)) as Record<string, unknown>;
  }
  return { id, event, data, comment };
}

async function openStream(
  base: string,
  path: string,
  session: TestSession,
  headers: Readonly<Record<string, string>> = {},
): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, {
    headers: {
      accept: 'text/event-stream',
      cookie: `__Host-pfi_session=${session.accessToken}`,
      ...headers,
    },
    signal: controller.signal,
  });

  if (response.status !== 200) {
    throw new Error(`stream did not open: ${String(response.status)} ${await response.text()}`);
  }
  expectEventStream(response.headers.get('content-type'));
  // The header every nginx-shaped proxy understands as "do not buffer this".
  if (response.headers.get('x-accel-buffering') !== 'no') {
    throw new Error('the stream did not ask proxies to stop buffering');
  }

  const frames: Frame[] = [];
  let raw = '';
  let buffer = '';
  const body = response.body;
  if (body === null) throw new Error('the stream had no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        raw += text;
        buffer += text;
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (block.length > 0) frames.push(parseFrame(block));
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // An abort is how every test ends. Nothing here is an error.
    }
  })();

  return {
    frames,
    raw: () => raw,
    async waitFor(description, predicate, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(frames)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        `timed out waiting for ${description}; saw ${String(frames.length)} frames: ` +
          JSON.stringify(frames.map((frame) => frame.event ?? `:${frame.comment ?? ''}`)),
      );
    },
    async close() {
      controller.abort();
      await pump;
    },
  };
}

function expectEventStream(contentType: string | null): void {
  if (contentType === null || !contentType.includes('text/event-stream')) {
    throw new Error(`expected text/event-stream, got ${String(contentType)}`);
  }
}

/** Append one transaction to the manual log, so the next sync has work to do. */
function nextTransaction(index: number): ReturnType<typeof manualTransaction> {
  return manualTransaction({
    providerAccountId: CHECKING,
    providerTransactionId: `sse-${String(index)}`,
    amount: money(BigInt(-100 * (index + 1)), 'USD'),
    postedDate: DateOnly.addDays(DateOnly.parse('2026-06-01'), index),
    name: `SSE MERCHANT ${String(index)}`,
  });
}

describe.skipIf(NO_DATABASE)('server-sent event streams', () => {
  let h: ApiHarness;
  let base: string;
  let link: LinkedConnection;
  let staged = 0;

  /** Stage a row and sync, which is what makes events appear on a live stream. */
  async function causeASync(): Promise<void> {
    h.manualStore.append(link.providerConnectionId, { added: [nextTransaction(staged)] });
    staged += 1;
    await syncConnection(h, link.connectionId);
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'sse' });
    base = await h.listen();
    link = await linkManual(h, {
      providerConnectionId: 'sse-conn',
      displayName: 'Streaming Bank',
      accounts: [
        { providerAccountId: CHECKING, name: 'Checking', type: 'depository', currency: 'USD' },
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  it('opens with a comment and carries sync events as they happen', async () => {
    const stream = await openStream(base, '/sync/stream', h.stale);
    try {
      // The stream starts at the outbox high-water mark, so nothing that
      // happened before it opened is replayed — which is why the sync has to
      // come after the open.
      await stream.waitFor('the stream to open', () => stream.raw().includes(': stream open'));
      await causeASync();

      await stream.waitFor('a completed sync', (frames) =>
        frames.some((frame) => frame.event === 'sync.completed'),
      );

      const names = stream.frames.map((frame) => frame.event).filter((name) => name !== null);
      // The client-facing names, not the domain event types. `routes/events.ts`
      // holds the only mapping between the two vocabularies.
      expect(names).toContain('sync.completed');
      expect(names).toContain('sync.progress');
      expect(names.some((name) => name.includes('.'))).toBe(true);
      expect(names).not.toContain('connections.SyncRunCompleted');
      expect(names).not.toContain('ledger.TransactionsUpserted');

      const completed = stream.frames.find((frame) => frame.event === 'sync.completed');
      expect(completed?.data?.['type']).toBe('sync.completed');
      expect(completed?.data?.['aggregateId']).toBe(link.connectionId);
      expect(completed?.data?.['correlationId']).toEqual(expect.any(String));
      expect(completed?.data?.['occurredAt']).toEqual(expect.any(String));
    } finally {
      await stream.close();
    }
  }, 60_000);

  it('numbers frames with the outbox sequence, strictly ascending', async () => {
    const stream = await openStream(base, '/sync/stream', h.stale);
    try {
      await stream.waitFor('the stream to open', () => stream.raw().includes(': stream open'));
      await causeASync();
      await stream.waitFor(
        'two events',
        (frames) => frames.filter((frame) => frame.event !== null).length >= 2,
      );

      const ids = stream.frames
        .filter((frame) => frame.id !== null)
        .map((frame) => BigInt(frame.id ?? '0'));
      expect(ids.length).toBeGreaterThanOrEqual(2);
      for (let index = 1; index < ids.length; index += 1) {
        expect(ids[index] ?? 0n).toBeGreaterThan(ids[index - 1] ?? 0n);
      }
    } finally {
      await stream.close();
    }
  }, 60_000);

  it('resumes from Last-Event-ID rather than replaying the day', async () => {
    const first = await openStream(base, '/sync/stream', h.stale);
    let resumePoint = '0';
    try {
      await first.waitFor('the stream to open', () => first.raw().includes(': stream open'));
      await causeASync();
      await first.waitFor('a completed sync', (frames) =>
        frames.some((frame) => frame.event === 'sync.completed'),
      );
      resumePoint = first.frames.filter((frame) => frame.id !== null).at(-1)?.id ?? '0';
    } finally {
      await first.close();
    }

    // Reconnect at the position the last stream reached, then make one more
    // thing happen. Everything before the resume point must stay unsent.
    const second = await openStream(base, '/sync/stream', h.stale, {
      'last-event-id': resumePoint,
    });
    try {
      await second.waitFor('the stream to open', () => second.raw().includes(': stream open'));
      await causeASync();
      await second.waitFor('a completed sync on the resumed stream', (frames) =>
        frames.some((frame) => frame.event === 'sync.completed'),
      );

      const ids = second.frames
        .filter((frame) => frame.id !== null)
        .map((frame) => BigInt(frame.id ?? '0'));
      expect(ids.length).toBeGreaterThan(0);
      // Strictly after: `gt(seq, cursor)`, so the resume point itself is not resent.
      expect(ids.every((id) => id > BigInt(resumePoint))).toBe(true);
    } finally {
      await second.close();
    }
  }, 60_000);

  it('accepts ?from= as the same thing, for a client managing its own retries', async () => {
    const stream = await openStream(base, '/sync/stream?from=1', h.stale);
    try {
      await stream.waitFor('the stream to open', () => stream.raw().includes(': stream open'));
      // `from=1` rewinds to the beginning of the outbox, so the backlog every
      // earlier test produced arrives without anything new having to happen.
      await stream.waitFor(
        'the replayed backlog',
        (frames) => frames.filter((frame) => frame.event !== null).length >= 3,
      );
      const ids = stream.frames
        .filter((frame) => frame.id !== null)
        .map((frame) => BigInt(frame.id ?? '0'));
      expect(ids.every((id) => id > 1n)).toBe(true);
    } finally {
      await stream.close();
    }
  }, 60_000);

  it('ignores a malformed resume header instead of failing the reconnect', async () => {
    // A network blip must not become a 400 the user sees.
    const stream = await openStream(base, '/sync/stream', h.stale, {
      'last-event-id': 'not-a-sequence',
    });
    try {
      await stream.waitFor('the stream to open', () => stream.raw().includes(': stream open'));
    } finally {
      await stream.close();
    }
  }, 60_000);

  it('filters the per-connection stream to the events whose aggregate is a connection', async () => {
    const stream = await openStream(base, `/connections/${link.connectionId}/events`, h.stale);
    try {
      await stream.waitFor('the stream to open', () => stream.raw().includes(': stream open'));
      await causeASync();
      await stream.waitFor('a completed sync', (frames) =>
        frames.some((frame) => frame.event === 'sync.completed'),
      );
      // Give any ledger event that was going to leak through time to arrive.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const names = new Set(
        stream.frames.map((frame) => frame.event).filter((name) => name !== null),
      );
      expect(names.has('sync.completed')).toBe(true);
      // The ledger's events are aggregated on an account or a transaction, so
      // filtering them by connection would need a join the outbox deliberately
      // does not support. Per-row progress lives on `/sync/stream`.
      expect(names.has('sync.progress')).toBe(false);
      expect(names.has('account.upserted')).toBe(false);
      expect(names.has('balance.recorded')).toBe(false);

      for (const frame of stream.frames) {
        if (frame.data !== null) expect(frame.data['aggregateId']).toBe(link.connectionId);
      }
    } finally {
      await stream.close();
    }
  }, 60_000);

  it('sends nothing to a stream for somebody else’s connection', async () => {
    const other = '01920000-0000-7000-8000-0000000fffff';
    const stream = await openStream(base, `/connections/${other}/events`, h.stale);
    try {
      await stream.waitFor('the stream to open', () => stream.raw().includes(': stream open'));
      await causeASync();
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(stream.frames.filter((frame) => frame.event !== null)).toHaveLength(0);
    } finally {
      await stream.close();
    }
  }, 60_000);

  it('requires a session to open either stream', async () => {
    for (const path of ['/sync/stream', `/connections/${link.connectionId}/events`]) {
      const response = await fetch(`${base}${path}`, { headers: { accept: 'text/event-stream' } });
      expect(response.status).toBe(401);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      await response.text();
    }
  }, 60_000);

  it('releases the connection its LISTEN was holding when the client vanishes', async () => {
    /**
     * Each stream checks one client out of the pool for its whole life, to hold
     * a `LISTEN`. A handler whose `finally` did not release it would leak one
     * connection per browser tab, and the tenth reload would exhaust the pool
     * and take the whole API down with it.
     *
     * The instrument is the pool's own checkout count, not `pg_stat_activity`:
     * a checked-out client is usually an *already established* backend being
     * handed out, so the server-side connection count does not move and would
     * make this assertion silently vacuous — it did, on the first run.
     *
     * `SSE_MAX_STREAMS_PER_SESSION` streams, not one more (R-9, gate C-6):
     * `h.stale` is one session, and a fourth open on it now gets a `429`
     * rather than a connection — see `events.test.ts` for that cap's own
     * claims. This test's claim is unaffected: it still proves every one of
     * the streams the session was allowed to hold gets its connection back.
     */
    const checkedOut = (): number => h.database.pool.totalCount - h.database.pool.idleCount;
    const before = checkedOut();

    const streams: OpenStream[] = [];
    try {
      for (let index = 0; index < SSE_MAX_STREAMS_PER_SESSION; index += 1) {
        streams.push(await openStream(base, '/sync/stream', h.stale));
      }
      for (const stream of streams) {
        await stream.waitFor('the stream to open', () => stream.raw().includes(': stream open'));
      }
      expect(checkedOut()).toBeGreaterThanOrEqual(before + SSE_MAX_STREAMS_PER_SESSION);
    } finally {
      // Always, even when the assertion above fails: streams left open would
      // hang `app.close()` in `afterAll` and bury this failure under a hook
      // timeout.
      for (const stream of streams) await stream.close();
    }

    // The release happens in the handler's `finally`, after the socket closes,
    // so it is not instantaneous.
    const deadline = Date.now() + 15_000;
    while (checkedOut() > before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(checkedOut()).toBeLessThanOrEqual(before);
  }, 60_000);

  it('does not leak a connection when a stream is opened and dropped repeatedly', async () => {
    // The same claim as above, stated as the thing that actually happens: a
    // user reloading the dashboard. Ten opens and drops must cost nothing.
    const checkedOut = (): number => h.database.pool.totalCount - h.database.pool.idleCount;
    const before = checkedOut();

    for (let index = 0; index < 10; index += 1) {
      const stream = await openStream(base, '/sync/stream', h.stale);
      await stream.waitFor('the stream to open', () => stream.raw().includes(': stream open'));
      await stream.close();
    }

    const deadline = Date.now() + 15_000;
    while (checkedOut() > before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(checkedOut()).toBe(before);
  }, 60_000);
});

describe.skipIf(NO_DATABASE)('server-sent event heartbeat', () => {
  /**
   * A clock the test winds forward.
   *
   * The heartbeat is fifteen seconds apart by design — shorter than any proxy's
   * idle reaper — and waiting that out in a test suite is fifteen seconds
   * nobody gets back. `routes/events.ts` reads the injected `clock` rather than
   * `Date.now()` precisely so this is drivable, and that is the repo-wide rule
   * on clocks paying for itself.
   */
  const clock = mutableClock('2026-06-01T12:00:00.000Z');
  let h: ApiHarness;
  let base: string;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'ssebeat', clock });
    base = await h.listen();
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  it('writes a : comment once the clock has moved fifteen seconds', async () => {
    const stream = await openStream(base, '/sync/stream', h.stale);
    try {
      await stream.waitFor('the stream to open', () => stream.raw().includes(': stream open'));
      // Nothing is happening, and no time has passed as far as the app is
      // concerned: an idle stream must stay silent.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(stream.raw()).not.toContain(': heartbeat');

      clock.advanceMs(20_000);
      await stream.waitFor('a heartbeat', () => stream.raw().includes(': heartbeat'), 20_000);

      // A comment, so an `EventSource` ignores it and the connection stays warm.
      expect(stream.frames.some((frame) => frame.comment === 'heartbeat')).toBe(true);
      expect(stream.frames.every((frame) => frame.event !== 'heartbeat')).toBe(true);
    } finally {
      await stream.close();
    }
  }, 90_000);
});
