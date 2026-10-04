// SPDX-License-Identifier: MIT
/**
 * WP 5.14's seed-bound backtest (05-phase-5-dispatch.md §1 cut line 2).
 *
 * 07 §8.2's point-in-time backtest and §8.5's `NOT_TRUE`-rate release gate are
 * not built as written, because the bitemporal store they need (`valid_time`
 * and `knowledge_time` on every fact) was not built this phase. What this file
 * builds instead is deliberately narrower than that, and the narrowing is the
 * point: **U2, S2 and C3 are evaluated as-of weekly over a seed built for this
 * file**, re-running the real `SnapshotBuilder` and the real rule at each
 * weekly cutoff against ports that only ever reveal a row dated on or before
 * that cutoff.
 *
 * **Why this is sound on the seed and nowhere else.** A generated seed has no
 * late arrivals and no restatements: every row's `effective_date` /
 * `month` / `next_due_date` is the date this file gave it, once, and that date
 * never changes after the fact. `valid_time` (when the thing happened) and
 * `knowledge_time` (when it would have been learned) therefore **coincide by
 * construction** — truncating the seed's rows by their own date, as the
 * "honest" ports below do, is exactly equivalent to truncating by knowledge
 * time, which is the thing a real backtest actually needs. On real data the
 * two diverge (a transaction can be categorised, corrected or backdated days
 * after it happened) and this same truncation would silently assume a fact
 * was known before it was — which is why 05 §1 calls this backtest "leak-free
 * only because a generated seed has no late arrivals or restatements… and
 * nowhere else", and why WP 5.9's forward-validation outcomes (the live
 * `insight_outcomes` mechanism, `docs/evidence/phase-5/wp5.9-feedback.md` §5)
 * is the honest, forward-only substitute this app actually runs in production.
 *
 * **Why the check inspects the snapshot's own content, not just rule
 * firing.** U2 and S2 each carry their own internal defence against a
 * future-dated row — U2's `age < 0` skip (`advisors/rules-subscriptions.ts`)
 * and S2's `completeMonths` filter (`advisors/support.ts`) — so a naive port
 * that leaks a future row can still produce a rule that never fires wrong.
 * That defence lives in the *rule*, not in the *snapshot the platform would
 * have sent a model or stored for the inspector* — and `AdvisorRequest.snapshot`
 * is exactly what a `local_model` narrator or a run's retained payload would
 * read. The first test below therefore asserts directly on the snapshot's
 * rows, independent of whether a rule's own filter happens to save the day;
 * the control test shows what the check catches when that snapshot-level
 * truncation is removed.
 */
import { describe, expect, it } from 'vitest';

import { DateOnly, Money, newId } from '@core/kernel';

import { BUILTIN_CATALOGUE } from '../src/advisors/catalogue.ts';
import { contextOf } from '../src/advisors/support.ts';
import type { AdvisorManifest } from '../src/contract/manifest.ts';
import type { AdvisorRequest } from '../src/contract/request.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import { SnapshotBuilder } from '../src/snapshot/builder.ts';
import {
  inMemoryBudgetPort,
  inMemoryInvestmentsPort,
  inMemoryLedgerPort,
  inMemoryMarketDataPort,
  inMemoryRecurringPort,
  type InsightsAccount,
  type InsightsRecurringStream,
  type MonthlyCashflowRow,
  type SnapshotPorts,
} from '../src/snapshot/ports.ts';
import { deriveTokenKey } from '../src/snapshot/tokens.ts';

const USER_ID = '01930000-0000-7000-8000-00000000bc70';
const USD = 'USD';
const GRANTED_SCOPES = ['cash.summary', 'cashflow.monthly', 'recurring.list'] as const;

function money(minor: number): Money {
  return Money.of(BigInt(minor), USD);
}

function d(text: string): DateOnly {
  return DateOnly.parse(text);
}

function monthOf(dateText: string): string {
  return dateText.slice(0, 7);
}

// ---------------------------------------------------------------------------
// The seed: sixteen months of cashflow (S2's creep), one subscription price
// rise (U2) and two bills landing inside a fortnight against a thin balance
// (C3). Every date below is the ground truth this test checks firing against.
// ---------------------------------------------------------------------------

/** `food.dining`, flat at $200.00/mo, then $450.00/mo from 2026-02 on. */
const ELEVATED_FROM_MONTH = '2026-02';
const DINING_BASELINE_MINOR = 20_000n;
const DINING_ELEVATED_MINOR = 45_000n;

function monthsSeries(): readonly MonthlyCashflowRow[] {
  const months: string[] = [];
  for (let year = 2025, month = 1; `${year}-${String(month).padStart(2, '0')}` <= '2026-04';) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months.map((month) => {
    const dining = month >= ELEVATED_FROM_MONTH ? DINING_ELEVATED_MINOR : DINING_BASELINE_MINOR;
    return {
      month,
      income: money(500_000),
      expense: money(250_000),
      byCategory: [
        { categoryId: 'cat-dining', slug: 'food.dining', amount: money(Number(dining)) },
      ],
    };
  });
}

/** U2's own seed: one price rise, effective 2026-06-01, within the 180-day window either side. */
const PRICE_RISE_EFFECTIVE = '2026-06-01';

function recurringSeries(): readonly InsightsRecurringStream[] {
  return [
    {
      id: 'series-subscription-a',
      merchantId: 'merchant-streaming-a',
      cadence: 'MONTHLY',
      type: 'subscription',
      status: 'ACTIVE',
      userConfirmed: true,
      confidence: 0.95,
      typicalAmount: money(1_899),
      observedMin: money(1_599),
      observedMax: money(1_899),
      nextDueDate: null,
      firstSeen: d('2024-01-15'),
      lastSeen: d('2026-09-15'),
      periodsPerYear: 12,
      eligibleForImpact: true,
      priceChanges: [
        {
          effectiveDate: d(PRICE_RISE_EFFECTIVE),
          direction: 'INCREASE',
          previousAmount: money(1_599),
          newAmount: money(1_899),
          annualImpact: money(3_600),
        },
      ],
    },
    // C3's two bills, due inside a fortnight of each other, against a thin balance.
    {
      id: 'series-rent',
      merchantId: 'merchant-landlord',
      cadence: 'MONTHLY',
      type: 'housing',
      status: 'ACTIVE',
      userConfirmed: true,
      confidence: 0.99,
      typicalAmount: money(145_000),
      observedMin: money(145_000),
      observedMax: money(145_000),
      nextDueDate: d('2026-09-24'),
      firstSeen: d('2024-01-01'),
      lastSeen: d('2026-08-24'),
      periodsPerYear: 12,
      eligibleForImpact: false,
      priceChanges: [],
    },
    {
      id: 'series-power',
      merchantId: 'merchant-utility',
      cadence: 'MONTHLY',
      type: 'utility',
      status: 'ACTIVE',
      userConfirmed: true,
      confidence: 0.9,
      typicalAmount: money(80_000),
      observedMin: money(75_000),
      observedMax: money(80_000),
      nextDueDate: d('2026-09-28'),
      firstSeen: d('2024-02-01'),
      lastSeen: d('2026-08-28'),
      periodsPerYear: 12,
      eligibleForImpact: false,
      priceChanges: [],
    },
  ];
}

const ALL_MONTHS = monthsSeries();
const ALL_STREAMS = recurringSeries();

/** C3's thin balance: below the rent + power total ($2,250.00), as the seed is tight. */
const ACCOUNTS: readonly InsightsAccount[] = [
  {
    id: 'account-checking',
    type: 'checking',
    isCash: true,
    balance: money(188_420),
    apy: null,
    closed: false,
  },
];

// ---------------------------------------------------------------------------
// Two readers over the same seed: the honest one truncates every row to what
// would have been known as of the chosen date; the leaking one does not —
// `inMemoryLedgerPort`/`inMemoryRecurringPort` already behave this way today
// (neither `LedgerPort.monthlyCashflow` nor `RecurringPort.listStreams` takes
// an as-of bound, confirmed by reading `src/snapshot/ports.ts`), so "leaking"
// below is simply "the ports this package already ships, used unmodified".
// ---------------------------------------------------------------------------

function honestCashflow(asOf: string): readonly MonthlyCashflowRow[] {
  const cutoff = monthOf(asOf);
  return ALL_MONTHS.filter((row) => row.month <= cutoff);
}

function honestStreams(asOf: string): readonly InsightsRecurringStream[] {
  return ALL_STREAMS.map((stream) => ({
    ...stream,
    priceChanges: stream.priceChanges.filter((change) => change.effectiveDate <= asOf),
  }));
}

async function snapshotAsOf(asOf: string, reader: 'honest' | 'leaking'): Promise<AdvisorSnapshot> {
  const cashflow = reader === 'honest' ? honestCashflow(asOf) : ALL_MONTHS;
  const streams = reader === 'honest' ? honestStreams(asOf) : ALL_STREAMS;
  const ports: SnapshotPorts = {
    ledger: inMemoryLedgerPort({ accounts: ACCOUNTS, cashflow }),
    budget: inMemoryBudgetPort(null),
    recurring: inMemoryRecurringPort(streams),
    investments: inMemoryInvestmentsPort({}),
    marketData: inMemoryMarketDataPort(null),
  };
  const built = await new SnapshotBuilder(ports).build({
    userId: USER_ID,
    kind: 'builtin',
    grantedScopes: [...GRANTED_SCOPES],
    today: d(asOf),
    baseCurrency: USD,
    tokenKey: deriveTokenKey('wp-5-14-backtest-seed', USER_ID),
  });
  return built.snapshot;
}

/** Every row in the snapshot's own content whose date is after `asOf`. Empty on an honest reader. */
function futureLeaks(snapshot: AdvisorSnapshot, asOf: string): readonly string[] {
  const leaks: string[] = [];
  const cutoffMonth = monthOf(asOf);
  const months = (snapshot as { cashflow_monthly?: { months?: readonly { month: string }[] } })
    .cashflow_monthly?.months;
  for (const [index, month] of (months ?? []).entries()) {
    if (month.month > cutoffMonth)
      leaks.push(`cashflow_monthly.months[${String(index)}].month=${month.month}`);
  }
  const streams = (
    snapshot as {
      recurring_list?: {
        streams?: readonly { price_changes?: readonly { effective_date: string }[] }[];
      };
    }
  ).recurring_list?.streams;
  for (const [streamIndex, stream] of (streams ?? []).entries()) {
    for (const [changeIndex, change] of (stream.price_changes ?? []).entries()) {
      if (change.effective_date > asOf) {
        leaks.push(
          `recurring_list.streams[${String(streamIndex)}].price_changes[${String(changeIndex)}].effective_date=${change.effective_date}`,
        );
      }
    }
  }
  return leaks;
}

function requestAsOf(
  manifest: AdvisorManifest,
  snapshot: AdvisorSnapshot,
  asOf: string,
): AdvisorRequest {
  return {
    contract_version: 1,
    request_id: newId(),
    advisor_id: manifest.advisor_id,
    advisor_version: manifest.version,
    kind: manifest.kind,
    generated_at: `${asOf}T08:15:00.000Z`,
    base_currency: USD,
    time_zone: 'America/New_York',
    today: asOf,
    granted_scopes: [...manifest.requires_scopes],
    input_digest: `sha256:${'b'.repeat(64)}`,
    limits: {
      max_insights: manifest.limits.max_insights,
      max_response_bytes: manifest.limits.max_response_bytes,
      deadline: `${asOf}T08:20:00.000Z`,
    },
    snapshot,
  };
}

function catalogueEntry(ruleId: string) {
  const entry = BUILTIN_CATALOGUE.find((candidate) => candidate.ruleId === ruleId);
  if (entry === undefined) throw new Error(`no catalogue entry for ${ruleId}`);
  return entry;
}

function fires(ruleId: string, snapshot: AdvisorSnapshot, asOf: string): boolean {
  const entry = catalogueEntry(ruleId);
  const request = requestAsOf(entry.rule.manifest, snapshot, asOf);
  return entry.rule.evaluate(contextOf(request)).insights.length > 0;
}

/** Every Sunday from `start` to `end`, inclusive, `YYYY-MM-DD`. */
function weeklyAsOfDates(start: string, end: string): readonly string[] {
  const dates: string[] = [];
  let cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 7 * 86_400_000);
  }
  return dates;
}

/** Spans before U2's rise, S2's creep and well past C3's due dates — one series for all three. */
const WEEKLY_AS_OF = weeklyAsOfDates('2026-01-04', '2026-10-04');

// ---------------------------------------------------------------------------
// Ground truth, derived from the dates above, not asserted against the rule's
// internal arithmetic — a change to the rule's thresholds would change these
// only if it also changed when the finding is genuinely first supportable.
// ---------------------------------------------------------------------------

/** U2: never before the rise, never more than 180 days after it. */
function u2GroundTruth(asOf: string): boolean {
  const days =
    (new Date(`${asOf}T00:00:00Z`).getTime() -
      new Date(`${PRICE_RISE_EFFECTIVE}T00:00:00Z`).getTime()) /
    86_400_000;
  return days >= 0 && days <= 180;
}

/** S2: never before the first elevated month (2026-02) is itself complete — i.e. `asOf` reaches March. */
function s2GroundTruth(asOf: string): boolean {
  return monthOf(asOf) > ELEVATED_FROM_MONTH;
}

/**
 * C3: the rule sums whichever bills are themselves within the fortnight and
 * compares the sum with cash — not "within a fortnight of the earlier bill",
 * which is a different, looser claim. Mirrors the rule's own two-bill sum
 * exactly rather than approximating it with one date, because the rule fires
 * only once *both* bills are within the window (rent alone, $1,450.00, never
 * exceeds the $1,884.20 balance by itself).
 */
const RENT_DUE = '2026-09-24';
const POWER_DUE = '2026-09-28';
const RENT_MINOR = 145_000n;
const POWER_MINOR = 80_000n;
const CASH_MINOR = 188_420n;

function withinFortnight(asOf: string, due: string): boolean {
  const days = Math.round(
    (new Date(`${due}T00:00:00Z`).getTime() - new Date(`${asOf}T00:00:00Z`).getTime()) / 86_400_000,
  );
  return days >= 0 && days <= 14;
}

function c3GroundTruth(asOf: string): boolean {
  let due = 0n;
  if (withinFortnight(asOf, RENT_DUE)) due += RENT_MINOR;
  if (withinFortnight(asOf, POWER_DUE)) due += POWER_MINOR;
  return due > CASH_MINOR;
}

interface RuleRun {
  readonly ruleId: string;
  readonly groundTruth: (asOf: string) => boolean;
}

const RULES: readonly RuleRun[] = [
  { ruleId: 'U2', groundTruth: u2GroundTruth },
  { ruleId: 'S2', groundTruth: s2GroundTruth },
  { ruleId: 'C3', groundTruth: c3GroundTruth },
];

describe('the seed-bound backtest (WP 5.14)', () => {
  it('the seed-bound backtest reads no row generated after its as-of date', async () => {
    for (const asOf of WEEKLY_AS_OF) {
      const snapshot = await snapshotAsOf(asOf, 'honest');
      expect(futureLeaks(snapshot, asOf), `as of ${asOf}`).toEqual([]);
    }
  });

  it('a deliberately future-leaking reader is caught', async () => {
    // Early, before the price rise and before any elevated month — the exact
    // week an honest reader's snapshot has nothing of either to leak.
    const asOf = '2026-01-04';
    const leaking = await snapshotAsOf(asOf, 'leaking');
    const leaks = futureLeaks(leaking, asOf);
    expect(
      leaks.length,
      'the untruncated reader leaks the price rise and every elevated month',
    ).toBeGreaterThan(0);
    expect(leaks.some((row) => row.includes('price_changes'))).toBe(true);
    expect(leaks.some((row) => row.includes('cashflow_monthly'))).toBe(true);

    // The honest reader, same week, same seed: nothing leaks. The control
    // proves the first test's assertion has teeth rather than vacuously
    // passing because the seed never contains a future row at all.
    const honest = await snapshotAsOf(asOf, 'honest');
    expect(futureLeaks(honest, asOf)).toEqual([]);
  });

  describe.each(RULES)(
    '$ruleId, evaluated as-of weekly over the seed',
    ({ ruleId, groundTruth }) => {
      it(`fires exactly where it is genuinely supportable, never earlier (precision 1.0 over ${String(WEEKLY_AS_OF.length)} weeks)`, async () => {
        const falsePositives: string[] = [];
        const falseNegatives: string[] = [];
        let truePositives = 0;
        let firstFire: string | null = null;

        for (const asOf of WEEKLY_AS_OF) {
          const snapshot = await snapshotAsOf(asOf, 'honest');
          const observed = fires(ruleId, snapshot, asOf);
          const expected = groundTruth(asOf);
          if (observed && !expected) falsePositives.push(asOf);
          if (!observed && expected) falseNegatives.push(asOf);
          if (observed && expected) {
            truePositives += 1;
            firstFire ??= asOf;
          }
        }

        // Precision: of every week the rule actually fired, none is a false
        // positive — the number this file's evidence table reports per rule.
        expect(falsePositives, `${ruleId} fired before it was genuinely supportable`).toEqual([]);
        expect(truePositives, `${ruleId} never fired at all over the seed`).toBeGreaterThan(0);
        expect(falseNegatives, `${ruleId} failed to fire once genuinely supportable`).toEqual([]);
        expect(firstFire, `${ruleId}'s first true-positive week`).not.toBeNull();
      });
    },
  );
});
