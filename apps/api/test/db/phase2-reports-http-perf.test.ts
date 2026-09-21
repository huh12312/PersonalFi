// SPDX-License-Identifier: MIT
/**
 * WP 2.12 — the reports p95 budget, over real HTTP.
 *
 * `apps/api/test/db/reports-aggregation.test.ts`'s own
 * `'report p95 < 200 ms on the 50k seed'` (WP 2.8) measures
 * `computeCategoryMonthActivity` called directly, in-process — real, and
 * explicitly recorded as such in `docs/evidence/phase-2/wp2.8-reports.md`
 * §11 open item 5: "measured in-process (aggregation function latency, not
 * full HTTP round trip) ... WP 2.12's own perf-budget work is the place a
 * full HTTP-level measurement belongs." This file is that measurement:
 * Fastify's own routing/auth/serialisation overhead, a real TCP round trip
 * (`h.listen()` + `fetch()`, not `app.inject()`, which never opens a real
 * socket), on the same route a browser actually calls.
 *
 * **A stale scale claim, corrected here rather than silently worked
 * around.** `reports-aggregation.test.ts` builds its dataset from
 * `generateDemoData(1) // 24 months, ~50k rows (Phase 1's budget)` — that
 * comment is wrong today: `generateDemoData(1)` with no options produces
 * **982** transactions (verified directly:
 * `generateDemoData(1).transactions.length === 982`), not ~50,000. This file
 * uses `generateDemoData(1, { monthCount: 1264 })` — the same option this
 * WP's own `packages/contexts/ledger/test/growth-bound.test.ts` uses,
 * verified to produce exactly 50,040 transactions — so the "50k" in this
 * file's own title is checked, not repeated on faith. Not fixed in
 * `reports-aggregation.test.ts` itself: that file is not owned by this WP
 * (`apps/api/test/db/reports-aggregation.test.ts` is WP 2.8's, and this WP's
 * new-file allowance is `phase2-*.test.ts`) — reported here rather than
 * silently worked around, per this WP's own rule.
 */
import { systemClock } from '@core/kernel';
import { generateDemoData } from '@core/seed';
import { loadSeedDataset } from '@ctx/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHarness, NO_DATABASE, type ApiHarness } from '../helpers/api-harness.ts';

const describeWithDb = describe.skipIf(NO_DATABASE);

/** Verified once, in this file's own header comment, and asserted again here. */
const EXPECTED_TRANSACTION_COUNT = 50_040;
const BUDGET_MS = 200;
const SAMPLE_COUNT = 15;
const WARMUP_COUNT = 2;

function percentile(samplesAscending: readonly number[], p: number): number {
  const index = Math.floor(samplesAscending.length * p);
  return samplesAscending[Math.min(index, samplesAscending.length - 1)] ?? 0;
}

async function timeGet(base: string, path: string, cookie: string): Promise<number> {
  const start = performance.now();
  const response = await fetch(`${base}${path}`, { headers: { cookie } });
  const elapsed = performance.now() - start;
  // Drain the body so the connection is actually finished, not just headers.
  await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`GET ${path} -> ${String(response.status)}: ${await response.text()}`);
  }
  return elapsed;
}

describeWithDb('[slow] reports p95, over real HTTP (50k seed)', () => {
  let h: ApiHarness;
  let base: string;
  let cookie: string;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp2-12-reports-http-perf' });
    const dataset = generateDemoData(1, { monthCount: 1264 });
    expect(dataset.transactions.length).toBe(EXPECTED_TRANSACTION_COUNT);
    await loadSeedDataset(h.database.db, h.userId, dataset, { clock: systemClock });
    base = await h.listen();
    cookie = `__Host-pfi_session=${h.fresh.accessToken}`;
  }, 300_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('GET /reports/spending holds p95 < 200 ms over real HTTP on the 50k seed', async () => {
    const path = '/reports/spending?from=2024-10-01&to=2026-09-30';

    for (let i = 0; i < WARMUP_COUNT; i += 1) await timeGet(base, path, cookie);

    const samples: number[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i += 1) samples.push(await timeGet(base, path, cookie));
    samples.sort((a, b) => a - b);

    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    // Printed, not just asserted: the in-process budget (WP 2.8) plus the
    // HTTP overhead this file adds is what the browser actually experiences,
    // and the gap between the two numbers is itself worth having on record.
    process.stdout.write(
      `reports p95 (HTTP, 50k seed): p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms ` +
        `samples=${JSON.stringify(samples.map((s) => Math.round(s)))}\n`,
    );

    expect(p95).toBeLessThan(BUDGET_MS);
  });
});
