// SPDX-License-Identifier: MIT
/**
 * `POST /imports/csv` — D2-2 (docs/evidence/phase-1/gate-security-review.md
 * §9.4, LOW): the first upload reported `staged: 0` even though the rows
 * landed.
 *
 * ## What the re-walk found, and the correction to record
 *
 * The Phase 2 dispatch (§2) filed this against `apps/api/src/routes/imports.ts`
 * — that file does not exist. The route has always lived in
 * `apps/api/src/routes/connections.ts` alongside every other provider-linking
 * route, which is where this fix and this test both point.
 *
 * ## The bug
 *
 * `CsvImportConnector.connect()` calls its own `addFile` once per file and
 * discards each call's `{staged, skipped}` — a data-loss-free but
 * user-visible lie: the rows are durably staged (D-5's staging store; nothing
 * here is about correctness) but the *response* on a cold, first upload
 * always said `staged: 0`. `routes/connections.ts`'s `stagedCountsOf` fixes
 * it by recomputing the identical count with the identical pure parse
 * (`addFile`'s own `importFile`), after `connect` has already succeeded.
 *
 * **Sabotage.** Reverting the "new connection" branch to `staged: 0, skipped:
 * 0` (its pre-fix form) turns the exit test below red; restoring it turns it
 * green again. Observed both ways while landing this WP.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface ImportResponse {
  readonly connectionId: string;
  readonly syncRunId: string | null;
  readonly staged: number;
  readonly skipped: number;
  readonly status: string | null;
}

describe.skipIf(NO_DATABASE)('POST /imports/csv staged count (D2-2)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'stagedcount' });
  }, 300_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('a first cold upload reports staged equal to the row count', async () => {
    const content = [
      'Date,Description,Amount',
      '2026-05-01,COFFEE SHOP,-4.50',
      '2026-05-02,BOOK SHOP,-22.00',
      '2026-05-03,REFUND,12.00',
    ].join('\n');

    const response = await h.request({
      method: 'POST',
      url: '/imports/csv',
      session: h.stale,
      body: {
        displayName: 'May statement',
        files: [
          {
            name: 'may.csv',
            content,
            format: 'csv',
            presetId: 'iso_signed',
            account: {
              providerAccountId: 'staged-checking',
              name: 'Staged Checking',
              type: 'depository',
              currency: 'USD',
            },
          },
        ],
      },
    });
    expectStatus(response, 200);
    const body = response.json() as ImportResponse;

    // The exit test, verbatim: on a genuinely first, cold upload — no prior
    // connection, no prior staging — the reported count is the row count.
    expect(body.staged).toBe(3);
    expect(body.skipped).toBe(0);

    // And the rows actually landed, which was never in question (D-5's
    // durable staging is proven elsewhere) — this just confirms the count the
    // response reported matches what a re-read of the ledger agrees with.
    const rows = await h.request({
      method: 'GET',
      url: '/transactions?limit=200',
      session: h.stale,
    });
    expectStatus(rows, 200);
    expect((rows.json() as { items: unknown[] }).items).toHaveLength(3);
  });

  it('a second upload onto the same connection reports only the new rows', async () => {
    const firstContent = ['Date,Description,Amount', '2026-06-01,GYM MEMBERSHIP,-40.00'].join('\n');
    const account = {
      providerAccountId: 'staged-checking-2',
      name: 'Staged Checking Two',
      type: 'depository' as const,
      currency: 'USD',
    };

    const first = await h.request({
      method: 'POST',
      url: '/imports/csv',
      session: h.stale,
      body: {
        displayName: 'June statement',
        files: [
          {
            name: 'june-1.csv',
            content: firstContent,
            format: 'csv',
            presetId: 'iso_signed',
            account,
          },
        ],
      },
    });
    expectStatus(first, 200);
    const firstBody = first.json() as ImportResponse;
    expect(firstBody.staged).toBe(1);
    expect(firstBody.skipped).toBe(0);

    const secondContent = [
      'Date,Description,Amount',
      '2026-06-01,GYM MEMBERSHIP,-40.00',
      '2026-06-15,GYM MEMBERSHIP,-40.00',
    ].join('\n');
    const second = await h.request({
      method: 'POST',
      url: '/imports/csv',
      session: h.stale,
      body: {
        connectionId: firstBody.connectionId,
        files: [
          {
            name: 'june-2.csv',
            content: secondContent,
            format: 'csv',
            presetId: 'iso_signed',
            account,
          },
        ],
      },
    });
    expectStatus(second, 200);
    const secondBody = second.json() as ImportResponse;
    // The first row of the second file is the same content as the row already
    // staged; only the mid-month charge is new.
    expect(secondBody.staged).toBe(1);
    expect(secondBody.skipped).toBe(1);
  });

  it('refuses an anonymous upload at the CSRF gate, and an unauthenticated one past it, per connections.ts policy', async () => {
    const anonymous = await h.request({
      method: 'POST',
      url: '/imports/csv',
      headers: { 'sec-fetch-site': 'cross-site' },
      body: { files: [{ name: 'x.csv', content: 'Date,Description,Amount\n' }] },
    });
    expect(anonymous.statusCode).toBe(403);

    const noSession = await h.request({
      method: 'POST',
      url: '/imports/csv',
      session: { accessToken: 'not-a-real-session-token', csrf: 'x'.repeat(40), fresh: false },
      body: { files: [{ name: 'x.csv', content: 'Date,Description,Amount\n' }] },
    });
    expect(noSession.statusCode).toBe(401);
  });
});
