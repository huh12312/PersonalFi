// SPDX-License-Identifier: MIT
/**
 * Concurrent-stream caps on `GET /sync/stream` and `GET /connections/:id/events`
 * (R-9, gate-security-review.md §5.3/§6 C-3, §6 C-6).
 *
 * The gate's finding: each open stream holds one dedicated connection out of
 * the shared pool for its whole life, with no cap — ten browser tabs on one
 * session (stolen cookie or not) exhaust `DATABASE_POOL_MAX` and take every
 * other route down with it. `routes/events.ts` now enforces two caps,
 * in-process: `SSE_MAX_STREAMS_PER_SESSION` per session, and `sseGlobalLimit`
 * (half the pool, floored at 1) across every session in this process.
 *
 * The claims:
 *
 * 1. **A session cannot exceed its own cap** — the `SSE_MAX_STREAMS_PER_SESSION + 1`th
 *    concurrent stream on one session gets `429` with `Retry-After`, naming
 *    `connections.sse_session_limit`, before the socket is ever opened.
 * 2. **A slot is released on close**, and the cap is checked again on the next
 *    attempt: the refused session succeeds once one of its existing streams
 *    closes.
 * 3. **The global cap is independent of the per-session cap.** Several
 *    sessions, each under their own per-session limit, can together exhaust
 *    the deployment-wide cap; the next stream — even from a session that has
 *    opened none of its own — is refused with `connections.sse_global_limit`.
 * 4. **A refusal never opens a pool connection**: the pool's checkout count
 *    does not move across a refused attempt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sseGlobalLimit, SSE_MAX_STREAMS_PER_SESSION } from '../../src/routes/events.ts';
import {
  createApiHarness,
  NO_DATABASE,
  type ApiHarness,
  type TestSession,
} from '../helpers/api-harness.ts';

interface OpenAttempt {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown> | null;
  close(): Promise<void>;
}

/**
 * Open (or attempt to open) a stream, without decoding SSE frames — these
 * tests only care about the response line, the headers, and whether the
 * connection stays checked out until closed. `sse.test.ts` owns the frame-
 * level claims.
 */
async function attempt(base: string, path: string, session: TestSession): Promise<OpenAttempt> {
  const controller = new AbortController();
  const response = await fetch(`${base}${path}`, {
    headers: {
      accept: 'text/event-stream',
      cookie: `__Host-pfi_session=${session.accessToken}`,
    },
    signal: controller.signal,
  });

  const body = response.body;
  let jsonBody: Record<string, unknown> | null = null;
  const pump = (async () => {
    if (body === null) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // An abort ends every stream this file opens; nothing here is an error.
    }
    if (response.status !== 200 && text.length > 0) {
      try {
        jsonBody = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Not JSON; leave jsonBody null.
      }
    }
  })();

  if (response.status === 200) {
    // Give the stream a moment to actually write its opening comment, so the
    // pool checkout this test is about to measure has definitely happened.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } else {
    await pump;
  }

  return {
    status: response.status,
    headers: response.headers,
    get body() {
      return jsonBody;
    },
    async close() {
      controller.abort();
      await pump;
    },
  };
}

describe.skipIf(NO_DATABASE)('concurrent SSE stream caps (R-9)', () => {
  let h: ApiHarness;
  let base: string;
  const checkedOut = (): number => h.database.pool.totalCount - h.database.pool.idleCount;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'ssecaps' });
    base = await h.listen();
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  it('refuses one more stream than SSE_MAX_STREAMS_PER_SESSION on one session, with 429 and Retry-After', async () => {
    const session = await h.issueSession({ fresh: false });
    const before = checkedOut();
    const streams: OpenAttempt[] = [];

    try {
      for (let index = 0; index < SSE_MAX_STREAMS_PER_SESSION; index += 1) {
        const opened = await attempt(base, '/sync/stream', session);
        expect(opened.status).toBe(200);
        streams.push(opened);
      }
      expect(checkedOut()).toBeGreaterThanOrEqual(before + SSE_MAX_STREAMS_PER_SESSION);

      const refusedBefore = checkedOut();
      const refused = await attempt(base, '/sync/stream', session);
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toEqual(expect.any(String));
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(refused.headers.get('content-type')).toContain('application/problem+json');
      expect(refused.body?.['code']).toBe('connections.sse_session_limit');
      // The refusal never opened a socket to hold a LISTEN on.
      expect(checkedOut()).toBe(refusedBefore);

      // Releasing one slot lets the next attempt through — the cap is
      // re-checked, not a one-time gate.
      const toClose = streams.shift();
      await toClose?.close();
      const deadline = Date.now() + 10_000;
      while (checkedOut() > before + (SSE_MAX_STREAMS_PER_SESSION - 1) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const readmitted = await attempt(base, '/sync/stream', session);
      expect(readmitted.status).toBe(200);
      streams.push(readmitted);
    } finally {
      for (const stream of streams) await stream.close();
    }

    const deadline = Date.now() + 15_000;
    while (checkedOut() > before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(checkedOut()).toBeLessThanOrEqual(before);
  }, 60_000);

  it(
    'the global cap is independent of the per-session cap: several sessions under their own ' +
      'limit can still exhaust the deployment total',
    async () => {
      const globalLimit = sseGlobalLimit(h.database.pool.options.max ?? 10);
      // Fill the deployment to its global cap using as few sessions as the
      // per-session cap allows, each staying strictly under its own limit —
      // this is the scenario the per-session cap alone cannot see.
      const sessions: TestSession[] = [];
      const streams: OpenAttempt[] = [];
      let opened = 0;

      try {
        while (opened < globalLimit) {
          const session = await h.issueSession({ fresh: false });
          sessions.push(session);
          const forThisSession = Math.min(SSE_MAX_STREAMS_PER_SESSION, globalLimit - opened);
          for (let index = 0; index < forThisSession; index += 1) {
            const response = await attempt(base, '/sync/stream', session);
            expect(response.status).toBe(200);
            streams.push(response);
            opened += 1;
          }
        }

        // A brand-new session, holding none of its own streams, still cannot
        // get one: the deployment total, not this session's count, is what
        // refuses it.
        const freshSession = await h.issueSession({ fresh: false });
        const before = checkedOut();
        const refused = await attempt(base, '/sync/stream', freshSession);
        expect(refused.status).toBe(429);
        expect(refused.headers.get('retry-after')).toEqual(expect.any(String));
        expect(refused.body?.['code']).toBe('connections.sse_global_limit');
        expect(checkedOut()).toBe(before);
      } finally {
        for (const stream of streams) await stream.close();
      }
    },
    60_000,
  );
});
