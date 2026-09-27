// SPDX-License-Identifier: MIT
/**
 * WP 4.13 — the Phase 4 **scale** seed: a household big enough that the 800 ms
 * / 150 ms budgets in docs/research/08-system-architecture.md §7.1–7.2 mean
 * something. wp3.14 §8 item 6 named the gap this closes: *"The perf dataset is
 * a correctness seed, not a scale seed … quoting 32.7 ms p95 as headroom
 * against a six-account seed is the same error as quoting a green `just
 * check` as a green CI."*
 *
 * ## A second dataset, not a replacement
 *
 * `generatePhase3Investments` (`phase3-investments.ts`) stays byte-identical
 * — it is the *correctness* seed the Phase 3 exit criteria and the basis
 * engine's ground truth reason about, and this file never touches it, imports
 * it, or shares its PRNG stream. This generator answers a different question
 * ("does a route stay inside its budget at scale?"), never "is the basis
 * arithmetic right?" — that question already has an answer, hand-computed,
 * and re-deriving it against 200 positions would prove nothing new.
 *
 * ## What "200 positions" means here, and what does not exist
 *
 * 200 holdings across eleven accounts spanning all four tax buckets
 * (`TAXABLE`, `TAX_DEFERRED`, `ROTH`, `HSA`) and one CAD-denominated taxable
 * account with its own FX series (one declared gap, exactly as Phase 3 did —
 * see `fxGap`). Each holding is its own distinct security: this dataset is
 * about *scale* (breadth of rows), not about the lot/wash-sale/basis
 * scenarios `phase3-investments.ts` already covers by hand, so there is
 * nothing to gain from reusing a security across positions and every position
 * gets a clean, single-lot security.
 *
 * Five years, daily: `days` is 1,825 dates ending on `asOf`, and `prices` and
 * `holdingsSnapshots` are built over every one of them for every security and
 * every holding respectively. **`holdingsSnapshots` holds each holding's
 * quantity constant across the window** — this dataset does not model trading
 * activity (buys/sells) within the five years, only price movement — which is
 * declared here rather than discovered by a reader counting rows and finding
 * every day's quantity identical. `netWorthDaily` is the one *aggregate* daily
 * series (08 §7.1's own subject, 1,825 points): one point per day, each with a
 * per-account breakdown computed from that day's prices (and, for the CAD
 * account, that day's FX rate), so a caller can load it straight into
 * `net_worth_daily` without recomputing anything.
 *
 * ## Why this file emits generic shapes, not `@ctx/planning` types
 *
 * `types.ts`'s own header states the rule this generator follows: "Phase 1's
 * job, not this package's" — mapping a seed shape to a context's real schema
 * belongs to the consumer, and `packages/seed`'s one allowed dependency is
 * `@core/kernel` (`OWNERSHIP.md`; wp3.14 §8 item 3: "the shipped generator
 * still depends on `@core/kernel` alone"). So `ScaleGoal`/`ScaleContribution`/
 * `ScaleLifeEvent` echo WP 4.1/4.6's shapes in vocabulary only
 * (`kind`/`cadence` unions match `@ctx/planning`'s schema literally, so a
 * consumer's mapping is a rename, never a translation) and the net-worth
 * breakdown fields are named to match `BreakdownEntry`'s ten CHECK-policed
 * fields for the same reason — but no type here is imported from, or asserted
 * assignable to, `@ctx/planning`.
 *
 * ## Determinism
 *
 * Every id, every price-walk parameter and every quantity is drawn from one
 * `mulberry32` stream seeded from the caller's integer (xor'd against a
 * distinct constant from every other generator in this package, so the same
 * integer seed does not make two generators draw the same bytes). The
 * *shape* — eleven accounts, their bucket and currency, the account-to-position
 * counts, the day count, the goal/contribution/life-event literals — is fixed
 * regardless of seed, exactly as `phase3-investments.ts`'s facts are: a
 * dataset whose shape depended on a random draw could not be sanity-checked
 * by reading the code.
 */
import { DateOnly, Money, type DateOnly as DateOnlyType, type MoneyJson } from '@core/kernel';
import { formatScaledInteger, mulberry32, randomInt, randomUuid, type Rng } from './prng.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `@ctx/planning`'s four tax buckets (`PROJECTION_BUCKETS`), echoed by name. */
export const SCALE_TAX_BUCKETS = ['TAXABLE', 'TAX_DEFERRED', 'ROTH', 'HSA'] as const;
export type ScaleTaxBucket = (typeof SCALE_TAX_BUCKETS)[number];

export interface ScaleAccount {
  readonly id: string;
  readonly name: string;
  readonly bucket: ScaleTaxBucket;
  readonly currency: string;
}

export interface ScaleSecurity {
  readonly id: string;
  readonly symbol: string;
  readonly currency: string;
}

/** One position: an (account, security) pair with a quantity held throughout the window. */
export interface ScaleHolding {
  readonly accountId: string;
  readonly securityId: string;
  /** Decimal string, up to 4 places — a share count, never a float. */
  readonly quantity: string;
}

/** A daily close. Decimal string, matching `SeedPricePoint`'s own convention. */
export interface ScalePricePoint {
  readonly securityId: string;
  readonly date: DateOnlyType;
  readonly close: string;
}

/** One holding's reported quantity on one day. Constant per holding across `days` (see header). */
export interface ScaleHoldingsSnapshotPoint {
  readonly accountId: string;
  readonly securityId: string;
  readonly date: DateOnlyType;
  readonly quantity: string;
}

export interface ScaleFxPoint {
  /** `'CAD/USD'`. */
  readonly pair: string;
  readonly date: DateOnlyType;
  readonly rate: string;
}

export interface ScaleFxGap {
  readonly pair: string;
  readonly date: DateOnlyType;
  readonly why: string;
}

/**
 * One account's line in one day's net-worth breakdown. Field names match
 * `@ctx/planning`'s `BreakdownEntry` (the ten fields
 * `net_worth_breakdown_is_well_formed` polices) so a consumer's mapping is the
 * identity function; `nativeMinor`/`baseMinor` are already signed bigint-as-string.
 */
export interface ScaleAccountDayTotal {
  readonly accountId: string;
  readonly currency: string;
  readonly nativeMinor: string;
  readonly baseMinor: string;
  readonly fxRate: string;
  readonly fxRateDate: DateOnlyType;
}

/** One day of the aggregate series `net_worth_daily` stores (08 §7.1's own subject). */
export interface ScaleNetWorthDailyPoint {
  readonly date: DateOnlyType;
  readonly baseCurrency: string;
  readonly assetsMinor: string;
  readonly liabilitiesMinor: string;
  readonly netWorthMinor: string;
  readonly byAccount: readonly ScaleAccountDayTotal[];
}

/** WP 4.1's `goals` vocabulary, echoed (`GoalKind` literally). */
export type ScaleGoalKind = 'retirement' | 'purchase';

export interface ScaleGoal {
  readonly id: string;
  readonly kind: ScaleGoalKind;
  readonly name: string;
  readonly target: MoneyJson;
  readonly targetDate: DateOnlyType;
  readonly priority: number;
}

/** WP 4.1's `goal_contributions` vocabulary, echoed (`ContributionCadence`/`ContributionSource`). */
export interface ScaleContribution {
  readonly goalId: string;
  readonly cadence: 'monthly';
  readonly amount: MoneyJson;
  readonly startsOn: DateOnlyType;
  readonly source: 'USER';
}

/** WP 4.6's `plan_life_events` vocabulary, echoed (`LifeEventKind`). Amount is signed. */
export type ScaleLifeEventKind = 'inheritance' | 'home_purchase';

export interface ScaleLifeEvent {
  readonly kind: ScaleLifeEventKind;
  readonly name: string;
  readonly occursOn: DateOnlyType;
  readonly amount: MoneyJson;
}

export interface ScaleDataset {
  readonly seed: number;
  readonly baseCurrency: string;
  /** The last day of `days`; the plan's starting balances are as of this date. */
  readonly asOf: DateOnlyType;
  /** Ascending, `days.length` entries, `days[days.length - 1] === asOf`. */
  readonly days: readonly DateOnlyType[];
  readonly accounts: readonly ScaleAccount[];
  readonly securities: readonly ScaleSecurity[];
  /** 200 entries — the dispatch's own count. */
  readonly holdings: readonly ScaleHolding[];
  /** `securities.length * days.length` entries. */
  readonly prices: readonly ScalePricePoint[];
  /** `holdings.length * days.length` entries (see header: quantity held constant). */
  readonly holdingsSnapshots: readonly ScaleHoldingsSnapshotPoint[];
  /** `days.length - 1` entries: one declared gap, at `fxGap.date`. */
  readonly fx: readonly ScaleFxPoint[];
  readonly fxGap: ScaleFxGap;
  /** `days.length` entries, one per calendar day. */
  readonly netWorthDaily: readonly ScaleNetWorthDailyPoint[];
  readonly goals: readonly ScaleGoal[];
  readonly contributions: readonly ScaleContribution[];
  readonly lifeEvents: readonly ScaleLifeEvent[];
}

// ---------------------------------------------------------------------------
// The fixed shape
// ---------------------------------------------------------------------------

/** name, bucket, currency, position count. Sums to 200; spans all four buckets. */
const ACCOUNT_SPEC: readonly [string, ScaleTaxBucket, string, number][] = [
  ['brokerage-1', 'TAXABLE', 'USD', 34],
  ['brokerage-2', 'TAXABLE', 'USD', 22],
  ['brokerage-3', 'TAXABLE', 'USD', 9],
  ['401k-current', 'TAX_DEFERRED', 'USD', 26],
  ['401k-previous', 'TAX_DEFERRED', 'USD', 18],
  ['rollover-ira', 'TAX_DEFERRED', 'USD', 30],
  ['roth-ira-1', 'ROTH', 'USD', 20],
  ['roth-ira-2', 'ROTH', 'USD', 16],
  ['hsa', 'HSA', 'USD', 12],
  ['crypto-wallet', 'TAXABLE', 'USD', 8],
  // The multi-currency account (dispatch §3 WP 4.13).
  ['cad-brokerage', 'TAXABLE', 'CAD', 5],
];

export const SCALE_POSITION_COUNT = ACCOUNT_SPEC.reduce((sum, [, , , count]) => sum + count, 0);
export const SCALE_DAY_COUNT = 5 * 365; // 1,825 — 08 §7.1's own figure.

const DEFAULT_AS_OF = DateOnly.of(2026, 9, 25);

export interface GeneratePhase4ScaleOptions {
  readonly asOf?: DateOnlyType;
  readonly dayCount?: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function daysEndingOn(asOf: DateOnlyType, count: number): DateOnlyType[] {
  const out: DateOnlyType[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    out.push(DateOnly.addDays(asOf, -offset));
  }
  return out;
}

/**
 * `quantity` (decimal string) × `closeMinor` (the walk's own bigint cents, never re-parsed
 * through a float) → `Money`, rounded once by `multiplyByDecimal`.
 */
function positionValue(
  quantity: string,
  closeMinor: bigint,
  currency: string,
): ReturnType<typeof Money.of> {
  return Money.multiplyByDecimal(Money.of(closeMinor, currency), quantity);
}

/** A month-end-free daily walk in bigint cents (or the scale a caller names), never a float step. */
function walkDaily(
  rng: Rng,
  openMinor: bigint,
  volatilityBps: number,
  driftBps: number,
  days: number,
): bigint[] {
  const out: bigint[] = [];
  let current = openMinor;
  for (let i = 0; i < days; i += 1) {
    const shockBps = randomInt(rng, -volatilityBps, volatilityBps);
    current = current + (current * BigInt(driftBps + shockBps)) / 10_000n;
    if (current < 1n) current = 1n;
    out.push(current);
  }
  return out;
}

function usd(minor: bigint): MoneyJson {
  return { minor: minor.toString(), currency: 'USD' };
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/**
 * The scale dataset, deterministic in `seed`: 200 positions across four tax
 * buckets, five years of daily prices / holdings snapshots / net worth, a
 * multi-currency (CAD) account with an FX series carrying one declared gap,
 * and a plan with two goals, their contribution plans, and two life events —
 * one inflow the engine can express, one outflow it names as unapplied
 * (`life-events.ts`'s own documented limit).
 */
export function generatePhase4Scale(
  seed: number,
  options: GeneratePhase4ScaleOptions = {},
): ScaleDataset {
  const asOf = options.asOf ?? DEFAULT_AS_OF;
  const dayCount = options.dayCount ?? SCALE_DAY_COUNT;
  if (!Number.isInteger(dayCount) || dayCount < 2) {
    throw new RangeError(`dayCount must be an integer >= 2, got ${String(dayCount)}`);
  }
  const rng = mulberry32(seed ^ 0x4_13_00);
  const baseCurrency = 'USD';
  const days = daysEndingOn(asOf, dayCount);
  const fxGapIndex = Math.floor(days.length / 2);

  // --- accounts -------------------------------------------------------------
  const accounts: ScaleAccount[] = ACCOUNT_SPEC.map(([name, bucket, currency]) => ({
    id: randomUuid(rng),
    name,
    bucket,
    currency,
  }));

  // --- securities + holdings: one distinct security per position -----------
  const securities: ScaleSecurity[] = [];
  const holdings: ScaleHolding[] = [];
  let positionNumber = 0;
  const priceWalks = new Map<string, bigint[]>();
  for (let i = 0; i < ACCOUNT_SPEC.length; i += 1) {
    const [, , currency, count] = ACCOUNT_SPEC[i] as (typeof ACCOUNT_SPEC)[number];
    const account = accounts[i] as ScaleAccount;
    for (let k = 0; k < count; k += 1) {
      positionNumber += 1;
      const securityId = randomUuid(rng);
      securities.push({ id: securityId, symbol: `SCL${String(positionNumber)}`, currency });
      const quantity = formatScaledInteger(BigInt(randomInt(rng, 100, 500_000)), 4);
      holdings.push({ accountId: account.id, securityId, quantity });

      const openMinor = 2_000n + BigInt(randomInt(rng, 0, 48_000)); // $20–$500 open
      // Daily, not monthly (unlike `phase3-investments.ts`'s `walkTo`): 1,825
      // compounding steps means bps sized for a *month* would compound to
      // billions. 60–150 bps/day (~1–1.5% daily) is a realistic daily equity
      // vol; 4 bps/day drift compounds to roughly 2× over five years, which is
      // the outer edge of "aggressive but not absurd" for a scale fixture.
      const volatilityBps = 60 + randomInt(rng, 0, 90);
      const driftBps = randomInt(rng, -1, 4);
      priceWalks.set(securityId, walkDaily(rng, openMinor, volatilityBps, driftBps, days.length));
    }
  }

  // --- prices, every security × every day -----------------------------------
  const prices: ScalePricePoint[] = [];
  for (const security of securities) {
    const walk = priceWalks.get(security.id) ?? [];
    days.forEach((date, index) => {
      prices.push({
        securityId: security.id,
        date,
        close: formatScaledInteger(walk[index] ?? 0n, 2),
      });
    });
  }

  // --- holdings_snapshots: quantity held constant across the window --------
  const holdingsSnapshots: ScaleHoldingsSnapshotPoint[] = [];
  for (const holding of holdings) {
    for (const date of days) {
      holdingsSnapshots.push({
        accountId: holding.accountId,
        securityId: holding.securityId,
        date,
        quantity: holding.quantity,
      });
    }
  }

  // --- FX, CAD/USD, one declared gap ----------------------------------------
  // 40 bps/day vol (~0.4%, realistic for a G10 pair), 0–1 bps/day drift — a
  // wider drift here would carry CAD/USD somewhere no five-year window has
  // actually gone.
  const fxWalk = walkDaily(rng, 7_300n, 40, randomInt(rng, 0, 1), days.length); // opens ~0.73
  const fxGap: ScaleFxGap = {
    pair: 'CAD/USD',
    date: days[fxGapIndex] as DateOnlyType,
    why:
      'the one deliberate hole in the series (dispatch §3 WP 4.13, "one declared gap is fine, as ' +
      'Phase 3 did"). A consumer that reads this day for the CAD account must surface the gap, ' +
      'never default to 1.0 (D4).',
  };
  const fx: ScaleFxPoint[] = [];
  days.forEach((date, index) => {
    if (index === fxGapIndex) return;
    fx.push({ pair: 'CAD/USD', date, rate: formatScaledInteger(fxWalk[index] ?? 7_300n, 4) });
  });

  // --- net worth, one point per day, one line per account -------------------
  const holdingsByAccount = new Map<string, ScaleHolding[]>();
  for (const holding of holdings) {
    const list = holdingsByAccount.get(holding.accountId) ?? [];
    list.push(holding);
    holdingsByAccount.set(holding.accountId, list);
  }
  const closeOnDay = (securityId: string, dayIndex: number): bigint =>
    priceWalks.get(securityId)?.[dayIndex] ?? 0n;
  let lastKnownFx = formatScaledInteger(fxWalk[0] ?? 7_300n, 4);
  const netWorthDaily: ScaleNetWorthDailyPoint[] = days.map((date, dayIndex) => {
    if (dayIndex !== fxGapIndex) lastKnownFx = formatScaledInteger(fxWalk[dayIndex] ?? 7_300n, 4);
    const byAccount: ScaleAccountDayTotal[] = accounts.map((account) => {
      const positions = holdingsByAccount.get(account.id) ?? [];
      let nativeTotal = Money.zero(account.currency);
      for (const holding of positions) {
        const closeMinor = closeOnDay(holding.securityId, dayIndex);
        nativeTotal = Money.add(
          nativeTotal,
          positionValue(holding.quantity, closeMinor, account.currency),
        );
      }
      const fxRate = account.currency === baseCurrency ? '1' : lastKnownFx;
      // `multiplyByDecimal` scales the minor amount but keeps the operand's own
      // currency tag, so the base-currency Money is rebuilt from that minor amount.
      const baseTotal =
        account.currency === baseCurrency
          ? nativeTotal
          : Money.of(Money.multiplyByDecimal(nativeTotal, fxRate).minor, baseCurrency);
      return {
        accountId: account.id,
        currency: account.currency,
        nativeMinor: nativeTotal.minor.toString(),
        baseMinor: baseTotal.minor.toString(),
        fxRate,
        fxRateDate: dayIndex === fxGapIndex ? (days[dayIndex - 1] ?? date) : date,
      };
    });
    const assetsMinor = byAccount.reduce((sum, entry) => sum + BigInt(entry.baseMinor), 0n);
    return {
      date,
      baseCurrency,
      assetsMinor: assetsMinor.toString(),
      liabilitiesMinor: '0',
      netWorthMinor: assetsMinor.toString(),
      byAccount,
    };
  });

  // --- the plan: two goals, their contributions, two life events -----------
  const retirementGoalId = randomUuid(rng);
  const purchaseGoalId = randomUuid(rng);
  const goals: ScaleGoal[] = [
    {
      id: retirementGoalId,
      kind: 'retirement',
      name: 'Retire comfortably',
      target: usd(300_000_000n), // $3,000,000.00
      targetDate: DateOnly.addYears(asOf, 25),
      priority: 1,
    },
    {
      id: purchaseGoalId,
      kind: 'purchase',
      name: 'Lake house down payment',
      target: usd(12_000_000n), // $120,000.00
      targetDate: DateOnly.addYears(asOf, 5),
      priority: 2,
    },
  ];
  const contributions: ScaleContribution[] = [
    {
      goalId: retirementGoalId,
      cadence: 'monthly',
      amount: usd(200_000n), // $2,000.00/mo
      startsOn: asOf,
      source: 'USER',
    },
    {
      goalId: purchaseGoalId,
      cadence: 'monthly',
      amount: usd(80_000n), // $800.00/mo
      startsOn: asOf,
      source: 'USER',
    },
  ];
  const lifeEvents: ScaleLifeEvent[] = [
    {
      // A positive event the engine can express (life-events.ts: applied as a one-year `otherIncome`).
      kind: 'inheritance',
      name: 'Parent’s estate',
      occursOn: DateOnly.addYears(asOf, 3),
      amount: usd(15_000_000n), // $150,000.00
    },
    {
      // A negative event the engine cannot yet express — named as `unapplied` (life-events.ts's header).
      kind: 'home_purchase',
      name: 'Lake house',
      occursOn: DateOnly.addYears(asOf, 5),
      amount: usd(-12_000_000n), // -$120,000.00
    },
  ];

  return Object.freeze({
    seed,
    baseCurrency,
    asOf,
    days,
    accounts,
    securities,
    holdings,
    prices,
    holdingsSnapshots,
    fx,
    fxGap,
    netWorthDaily,
    goals,
    contributions,
    lifeEvents,
  });
}
