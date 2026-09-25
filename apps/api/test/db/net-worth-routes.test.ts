// SPDX-License-Identifier: MIT
/**
 * `/net-worth/series` and `/net-worth/corrections` — WP 3.9 over WP 3.8's
 * `net_worth_daily`, against a real database.
 *
 * The days under test are written by **`@ctx/planning`'s own writers**
 * (`computeNetWorth` → `upsertOpenDay` → `sealDay`), not by raw SQL. That is the
 * harness rule honoured properly for once: these are the exact three calls the
 * 04:00 `planning.net_worth_snapshot` job makes, so a row that only this test
 * could produce cannot exist here. The balances behind them arrive through a
 * linked `ManualConnector`, over HTTP, like every other suite's.
 *
 * Three claims:
 *
 *   * **The series is gapless and a missing day is `null`, not zero.** The day
 *     between the two written days has no row; a chart has to draw a gap there,
 *     and a zero would draw a crash to the axis instead.
 *   * **A sealed day is labelled as one.** 08 §3.5, and WP 3.12's chart needs it
 *     as a field because it cannot infer it.
 *   * **A correction supersedes; it never rewrites.** The sealed row is read
 *     back after the correction and compared to what it said before — the
 *     byte-identity property the whole revision ladder exists for.
 */
import { DateOnly, systemClock } from '@core/kernel';
import { money } from '@core/kernel';
import { computeNetWorth, sealDay, upsertOpenDay } from '@ctx/planning';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planningPortsFor } from '../../src/domain.ts';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  linkManual,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const DAY_MS = 86_400_000;

function day(offset: number): string {
  return new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
}

interface SeriesBody {
  readonly from: string;
  readonly to: string;
  readonly baseCurrency: string;
  readonly points: readonly {
    asOfDate: string;
    netWorth: { minor: string; currency: string } | null;
    assets: { minor: string } | null;
    sealed: boolean;
    sealedAt: string | null;
    revision: number;
    source: string | null;
    stalePrice: boolean;
    correctionReason: string | null;
  }[];
}

describe.skipIf(NO_DATABASE)('/net-worth/series and /net-worth/corrections (WP 3.9)', () => {
  let h: ApiHarness;
  let sealedDay: string;
  let openDay: string;
  let sealedNetWorthMinor: string;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp39-nw' });

    await linkManual(h, {
      providerConnectionId: 'wp39-nw-conn',
      displayName: 'Test Bank',
      accounts: [
        { providerAccountId: 'checking', name: 'Checking', type: 'depository', currency: 'USD' },
      ],
      batch: {
        balances: [
          {
            providerAccountId: 'checking',
            // Observed before the window, so every day in it has a balance to
            // carry forward — the ordinary case, and the one where a gap in the
            // *series* is genuinely a missing snapshot rather than missing data.
            current: money(1_000_000n, 'USD'),
            available: null,
            limit: null,
            asOf: new Date(Date.now() - 5 * DAY_MS),
          },
        ],
      },
    });

    sealedDay = day(-2);
    openDay = day(0);

    const ports = planningPortsFor(h.database.db, {
      userId: h.userId,
      timeZone: 'UTC',
      clock: systemClock,
    });

    // The two writes the nightly job makes, in the order it makes them.
    for (const asOfDate of [sealedDay, openDay]) {
      const snapshot = await computeNetWorth(ports, {
        userId: h.userId,
        asOfDate,
        baseCurrency: 'USD',
      });
      await upsertOpenDay(h.database.db, { userId: h.userId, snapshot, clock: systemClock });
    }
    const sealed = await sealDay(h.database.db, {
      userId: h.userId,
      asOfDate: sealedDay,
      clock: systemClock,
    });
    sealedNetWorthMinor = sealed.netWorthMinor.toString();
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it('draws a gapless series and reports a day with no data as null, not zero', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/net-worth/series?from=${sealedDay}&to=${openDay}`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as SeriesBody;

    expect(body.points.map((point) => point.asOfDate)).toEqual([sealedDay, day(-1), openDay]);

    const missing = body.points[1];
    expect(
      missing?.netWorth,
      'a day with no row is null — "we did not know" is not "zero"',
    ).toBeNull();
    expect(missing?.assets).toBeNull();
    expect(missing?.sealed).toBe(false);
    expect(missing?.revision).toBe(0);

    const written = body.points[0];
    expect(written?.netWorth?.minor).toBe(sealedNetWorthMinor);
    expect(written?.netWorth?.currency).toBe('USD');
  });

  it('labels a sealed day so a chart can draw history differently from today', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/net-worth/series?from=${sealedDay}&to=${openDay}`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as SeriesBody;

    const sealed = body.points.find((point) => point.asOfDate === sealedDay);
    const open = body.points.find((point) => point.asOfDate === openDay);
    expect(sealed?.sealed).toBe(true);
    expect(sealed?.sealedAt).not.toBeNull();
    expect(sealed?.revision).toBe(1);
    // `interpolated`, and that is the correct answer rather than a weaker one:
    // the balance behind this day was observed five days earlier and carried
    // forward, and 04 §5.4's rule is that a carried-forward figure is *labelled*
    // instead of being passed off as an observation. The field exists so the
    // chart can say so.
    expect(sealed?.source).toBe('interpolated');
    expect(open?.sealed, "today's row is still open and still allowed to move").toBe(false);
    expect(open?.sealedAt).toBeNull();
  });

  it('refuses a window wider than ten years rather than materialising the spine', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/net-worth/series?from=1990-01-01&to=${openDay}`,
      session: h.stale,
    });
    expect(response.statusCode).toBe(400);
    expect(problemOf(response)['code']).toBe('planning.window_too_wide');
  });

  it('a correction supersedes the sealed day and never rewrites it', async () => {
    // The same projection on both sides of the correction, so `toEqual` below
    // is a real byte-for-byte comparison of the row and not of a subset that
    // happens to exclude the columns a rewrite would have touched.
    const revisionsOf = async (): Promise<readonly Record<string, unknown>[]> =>
      (
        await h.database.db.execute<Record<string, unknown>>(sql`
          SELECT id::text AS id, revision, base_currency,
                 assets_minor::text AS assets_minor,
                 liabilities_minor::text AS liabilities_minor,
                 net_worth_minor::text AS net_worth_minor,
                 liquid_minor::text AS liquid_minor,
                 investable_minor::text AS investable_minor,
                 on_budget_minor::text AS on_budget_minor,
                 breakdown::text AS breakdown, source, stale_price, dirty,
                 sealed_at::text AS sealed_at, computed_at::text AS computed_at,
                 updated_at::text AS updated_at,
                 correction_reason, supersedes_id::text AS supersedes_id
            FROM net_worth_daily
           WHERE user_id = ${h.userId}::uuid AND as_of_date = ${sealedDay}::date
           ORDER BY revision
        `)
      ).rows;

    const before = { rows: await revisionsOf() };
    expect(before.rows).toHaveLength(1);

    const stale = await h.request({
      method: 'POST',
      url: '/net-worth/corrections',
      session: h.stale,
      body: { asOfDate: sealedDay, reason: 'a late balance landed' },
    });
    expect(stale.statusCode, 'a correction is a decision, and needs a step-up').toBe(403);
    expect(problemOf(stale)['code']).toBe('step_up_required');

    const corrected = await h.request({
      method: 'POST',
      url: '/net-worth/corrections',
      session: h.fresh,
      body: { asOfDate: sealedDay, reason: 'a late balance landed' },
    });
    expectStatus(corrected, 200);
    const body = corrected.json() as { asOfDate: string; revision: number; source: string };
    expect(body.asOfDate).toBe(sealedDay);
    expect(body.revision).toBe(2);
    expect(body.source).toBe('corrected');

    const after = { rows: await revisionsOf() };
    expect(after.rows).toHaveLength(2);

    // The row that was current before the correction is *byte-identical*. This
    // is the property the whole revision ladder exists for: the app can still
    // answer "what did we show on that day?" after it has been corrected.
    expect(after.rows[0]).toEqual(before.rows[0]);

    const revision2 = after.rows[1];
    expect(revision2?.['revision']).toBe(2);
    expect(revision2?.['correction_reason']).toBe('a late balance landed');
    expect(revision2?.['supersedes_id']).toBe(before.rows[0]?.['id']);
    expect(
      revision2?.['sealed_at'],
      'a correction to a closed day arrives already sealed',
    ).not.toBeNull();

    // And the series now reads the new revision.
    const series = await h.request({
      method: 'GET',
      url: `/net-worth/series?from=${sealedDay}&to=${sealedDay}`,
      session: h.stale,
    });
    expectStatus(series, 200);
    const point = (series.json() as SeriesBody).points[0];
    expect(point?.revision).toBe(2);
    expect(point?.source).toBe('corrected');
    expect(point?.correctionReason).toBe('a late balance landed');
  });

  it('refuses a correction to a day that has no revision to supersede', async () => {
    const response = await h.request({
      method: 'POST',
      url: '/net-worth/corrections',
      session: h.fresh,
      body: { asOfDate: day(-1), reason: 'nothing to correct' },
    });
    expect(response.statusCode).toBe(404);
    expect(problemOf(response)['code']).toBe('planning.day_not_found');
  });

  it('refuses an empty correction reason', async () => {
    const response = await h.request({
      method: 'POST',
      url: '/net-worth/corrections',
      session: h.fresh,
      body: { asOfDate: sealedDay, reason: '' },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses another user's net-worth history", async () => {
    const otherUserId = await h.database.createUser('Second Holder');
    const theirs = await h.issueSession({ userId: otherUserId, fresh: true });

    const series = await h.request({
      method: 'GET',
      url: `/net-worth/series?from=${sealedDay}&to=${openDay}`,
      session: theirs,
    });
    expectStatus(series, 200);
    const body = series.json() as SeriesBody;
    // The spine is still drawn — they have days, they just have no data — and
    // not one of ours appears in it.
    expect(body.points).toHaveLength(3);
    for (const point of body.points) {
      expect(point.netWorth).toBeNull();
      expect(point.sealed).toBe(false);
      expect(point.revision).toBe(0);
    }
    expect(series.body).not.toContain(sealedNetWorthMinor);

    // And they cannot correct a day of ours: there is no revision of it under
    // their user id to supersede.
    const correction = await h.request({
      method: 'POST',
      url: '/net-worth/corrections',
      session: theirs,
      body: { asOfDate: sealedDay, reason: 'reaching across users' },
    });
    expect(correction.statusCode).toBe(404);

    const ours = await h.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM net_worth_daily
       WHERE user_id = ${h.userId}::uuid AND as_of_date = ${sealedDay}::date
    `);
    expect(ours.rows[0]?.count, 'their refused correction wrote nothing of ours').toBe('2');
  });

  it('is the only /net-worth route that changes history — the current read is unchanged', async () => {
    // `GET /net-worth` (accounts.ts) is *now*, per currency, from @ctx/ledger.
    // Asserted here so the two are visibly different surfaces rather than two
    // spellings of one.
    const now = await h.request({ method: 'GET', url: '/net-worth', session: h.stale });
    expectStatus(now, 200);
    const body = now.json() as { totals?: unknown };
    expect(body).toBeTruthy();
    expect(DateOnly.is(day(0))).toBe(true);
  });
});

/**
 * WP 3.14 close-out — exit criterion (d), "a missing FX rate surfaces rather
 * than defaulting" (docs/evidence/phase-3/wp3.14-quality.md §1 row d, §8
 * item 4). `packages/contexts/planning/test/fx-missing.test.ts` proves the
 * domain layer (`computeNetWorth` throws `FxRateUnavailable`, never a 1.0);
 * this is the HTTP seam the evidence doc named as untested:
 * `apps/api/src/routes/net-worth.ts` around line 344 catches it with the
 * exported `isFxRateUnavailable` predicate and translates it to a 409 named
 * `planning.fx_rate_missing`, never a 500 and never a converted total.
 *
 * A **separate, isolated harness** on purpose: the describe block above
 * seals `sealedDay` in USD only, and adding a CAD account with no FX rate
 * into that shared setup would make every other test in this file fail at
 * `beforeAll` instead of the one thing this suite exists to prove.
 *
 * Two surfaces, both required by the criterion's wording:
 *
 *   1. `POST /net-worth/corrections` — the write path that would otherwise
 *      *compute and persist* a converted total — refuses outright, by name,
 *      rather than writing a row that quietly priced CAD at par.
 *   2. `GET /net-worth` (`accounts.ts`, `@ctx/ledger`'s "now" read) never
 *      attempts FX conversion at all (its own file header: "adding dollars
 *      to euros here would be a wrong number rendered confidently"), so the
 *      CAD balance is asserted to still appear on **its own currency line**
 *      and the USD total is asserted to be exactly the USD account's own
 *      balance — proof the CAD amount was never folded in at 1.0.
 */
describe.skipIf(NO_DATABASE)(
  'a missing FX rate surfaces rather than defaulting (WP 3.14 close-out, criterion d)',
  () => {
    let h: ApiHarness;
    let asOfDate: string;

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'wp314-fx-missing' });

      await linkManual(h, {
        providerConnectionId: 'wp314-fx-usd-conn',
        displayName: 'Test Bank USD',
        accounts: [
          { providerAccountId: 'checking', name: 'Checking', type: 'depository', currency: 'USD' },
        ],
        batch: {
          balances: [
            {
              providerAccountId: 'checking',
              current: money(500_000n, 'USD'),
              available: null,
              limit: null,
              asOf: new Date(Date.now() - 5 * DAY_MS),
            },
          ],
        },
      });

      asOfDate = day(-1);

      const ports = planningPortsFor(h.database.db, {
        userId: h.userId,
        timeZone: 'UTC',
        clock: systemClock,
      });

      // A first, USD-only snapshot, so `asOfDate` has an existing revision —
      // `correctDay` needs one to supersede (`SealedRowImmutable`/404
      // otherwise; see 'refuses a correction to a day that has no revision
      // to supersede' above). At this point there is no CAD account yet, so
      // this computation cannot itself hit the missing-rate path.
      const snapshot = await computeNetWorth(ports, {
        userId: h.userId,
        asOfDate,
        baseCurrency: 'USD',
      });
      await upsertOpenDay(h.database.db, { userId: h.userId, snapshot, clock: systemClock });

      // Now add the CAD account and a balance dated on `asOfDate`, with
      // deliberately **no** `fx_rates` row for CAD/USD at all — the S0
      // sabotage from wp3.14-quality.md §5 ("computeNetWorth threw ...
      // unplanned"), reproduced here on purpose.
      await linkManual(h, {
        providerConnectionId: 'wp314-fx-cad-conn',
        displayName: 'Test Bank CAD',
        accounts: [
          {
            providerAccountId: 'cad-savings',
            name: 'CAD Savings',
            type: 'depository',
            currency: 'CAD',
          },
        ],
        batch: {
          balances: [
            {
              providerAccountId: 'cad-savings',
              current: money(708_000n, 'CAD'),
              available: null,
              limit: null,
              asOf: new Date(Date.now() - 5 * DAY_MS),
            },
          ],
        },
      });
    }, 120_000);

    afterAll(async () => {
      await h.close();
    });

    it('POST /net-worth/corrections surfaces planning.fx_rate_missing rather than defaulting to 1.0', async () => {
      const response = await h.request({
        method: 'POST',
        url: '/net-worth/corrections',
        session: h.fresh,
        body: { asOfDate, reason: 'CAD account added; no FX rate seeded yet' },
      });
      expect(response.statusCode).toBe(409);
      const problem = problemOf(response);
      expect(problem['code']).toBe('planning.fx_rate_missing');
      // `error.message` (FxRateUnavailable) names the pair and says out loud
      // what did not happen — the same assertions
      // `packages/contexts/planning/test/fx-missing.test.ts` makes on the
      // domain error, now checked on the wire.
      const detail = String(problem['detail']);
      expect(detail).toContain('CAD');
      expect(detail).toContain('USD');
      expect(detail).toContain('rather than a 1.0');
    });

    it('GET /net-worth (the ledger "now" read) reports the CAD balance on its own line, never folded into USD at 1.0', async () => {
      const response = await h.request({ method: 'GET', url: '/net-worth', session: h.stale });
      expectStatus(response, 200);
      const body = response.json() as {
        totals: readonly {
          currency: string;
          assets: { minor: string; currency: string };
          net: { minor: string; currency: string };
        }[];
      };

      const usdTotal = body.totals.find((total) => total.currency === 'USD');
      const cadTotal = body.totals.find((total) => total.currency === 'CAD');
      expect(
        cadTotal,
        'the CAD balance gets its own currency line, not a converted USD one',
      ).toBeTruthy();
      expect(cadTotal?.assets.minor).toBe('708000');
      // The USD total is exactly the USD account's own balance. Had the CAD
      // amount been folded in at par, it would read 500000 + 708000 =
      // 1208000 instead.
      expect(usdTotal?.assets.minor).toBe('500000');
      expect(body.totals).toHaveLength(2);
    });
  },
);
