// SPDX-License-Identifier: MIT
/**
 * Idle-cash dwell — the third of the 3.10a gap fields.
 *
 * `src/analytics/cash.ts`'s `idleCash()` (WP 3.3) already takes `idleDays` as
 * an input on `CashPosition`, with a comment saying exactly why it cannot
 * derive it itself: *"how long has this balance been sitting?" is a question
 * about a snapshot history (WP 3.2's `holdings_snapshots`) and this module
 * reads nothing.* This file is that history read.
 *
 * `idleDaysOf` is pure — an array of `(date, cash)` pairs in, a day count out
 * — and is tested as such in `test/dwell.test.ts` with no database. The one
 * function that touches Postgres, {@link cashSnapshotHistory}, does nothing
 * but sum `holdings_snapshots.institution_value_minor` per calendar day for
 * the rows a `securities` join marks `CASH` or `is_cash_equivalent` — the same
 * predicate `src/analytics/cash.ts`'s `isCash` uses over live holdings, so a
 * "today" computed from `holdings` and a "yesterday" computed from
 * `holdings_snapshots` agree on what counts as cash.
 *
 * **This module never reads `@ctx/planning`.** 07 I3's "not earmarked" is
 * `@ctx/planning`'s `cash_earmarks` (migration 0020), and 08 §1.6 draws no
 * arrow from `@ctx/investments` up to Planning. So {@link cashPositionFor}
 * takes the earmarked amount as a parameter — `earmarkedAmount`, a `Money`,
 * zero when nothing is earmarked — rather than a query. Composing it with
 * Planning's earmark reader is the composition root's job
 * (`createInsightsInvestmentsPort` in `apps/api/src/domain.ts`), which is
 * allowed to read both contexts (08 §1.3 #9) and is specified, not written, by
 * this work package — see `docs/evidence/phase-4/wp4.7-gap-fields.md`.
 */
import {
  DateOnly,
  Money,
  type CurrencyCode,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
} from '@core/kernel';
import { and, eq, lte, or } from 'drizzle-orm';
import { holdingsSnapshots, securities } from '../schema/index.ts';
import type { CashPosition } from './analytics/cash.ts';
import type { InvestmentsExecutor } from './store.ts';

/** One calendar day's cash-and-equivalents total for one account. */
export interface CashSnapshot {
  readonly asOfDate: DateOnlyType;
  readonly cash: MoneyType;
}

/**
 * Every `holdings_snapshots` day for one account, on or before `asOfDate`,
 * summed across every security a `securities` join calls cash — most recent
 * day first. A day with two cash rows (a sweep fund and a settled deposit,
 * say) sums to one entry; a day with no snapshot at all is simply absent, and
 * {@link idleDaysOf} treats an absence as "no information", never as zero.
 *
 * NULL `institution_value_minor` rows (migration `0025`'s watch-only-wallet
 * case) contribute nothing to the sum rather than poisoning it — a wallet
 * reports no fiat assertion of its own, which is a different fact from
 * reporting zero cash.
 */
export async function cashSnapshotHistory(
  db: InvestmentsExecutor,
  input: {
    readonly userId: string;
    readonly accountId: string;
    readonly asOfDate: DateOnlyType;
    readonly currency: CurrencyCode;
  },
): Promise<readonly CashSnapshot[]> {
  const rows = await db
    .select({
      asOfDate: holdingsSnapshots.asOfDate,
      institutionValueMinor: holdingsSnapshots.institutionValueMinor,
      currency: holdingsSnapshots.currency,
    })
    .from(holdingsSnapshots)
    .innerJoin(
      securities,
      and(
        eq(securities.id, holdingsSnapshots.securityId),
        eq(securities.userId, holdingsSnapshots.userId),
      ),
    )
    .where(
      and(
        eq(holdingsSnapshots.userId, input.userId),
        eq(holdingsSnapshots.accountId, input.accountId),
        lte(holdingsSnapshots.asOfDate, input.asOfDate),
        eq(holdingsSnapshots.currency, input.currency),
        // `isCash()`, src/analytics/cash.ts: CASH by asset class, or the
        // cash-equivalent flag regardless of class (a sweep money-market fund).
        or(eq(securities.assetClass, 'CASH'), eq(securities.isCashEquivalent, true)),
      ),
    );

  const byDay = new Map<string, MoneyType>();
  for (const row of rows) {
    if (row.institutionValueMinor === null) continue;
    const existing = byDay.get(row.asOfDate) ?? Money.zero(input.currency);
    byDay.set(
      row.asOfDate,
      Money.add(existing, Money.of(row.institutionValueMinor, input.currency)),
    );
  }
  return [...byDay.entries()]
    .map(([asOfDate, cash]) => ({ asOfDate: asOfDate as DateOnlyType, cash }))
    .sort((a, b) => DateOnly.compare(b.asOfDate, a.asOfDate));
}

/**
 * How many days the balance has sat at or above its most recent level.
 *
 * `history` need not be sorted or filtered to `asOfDate` — this function does
 * both — but it must be daily: `holdings_snapshots`' own uniqueness
 * (`holdings_snapshots_day_uniq`, migration 0014) already guarantees at most
 * one row per day per security, and the summing step above collapses same-day
 * rows, so a gap in the returned array is a day nothing synced, not a day two
 * rows disagreed.
 *
 * Pure, and the whole reason it is: `test/dwell.test.ts` drives it against
 * fixture arrays with no database, the same split `idleCash()` makes for its
 * own `idleDays` input.
 */
export function idleDaysOf(history: readonly CashSnapshot[], asOfDate: DateOnlyType): number {
  const onOrBefore = history
    .filter((row) => DateOnly.compare(row.asOfDate, asOfDate) <= 0)
    .sort((a, b) => DateOnly.compare(b.asOfDate, a.asOfDate));
  if (onOrBefore.length === 0) return 0;

  const first = onOrBefore[0] as CashSnapshot;
  const current = first.cash;
  let earliest = first.asOfDate;
  for (const row of onOrBefore) {
    if (Money.compare(row.cash, current) < 0) break;
    earliest = row.asOfDate;
  }
  return DateOnly.differenceInDays(earliest, asOfDate);
}

export interface DwellCashInput {
  readonly accountId: string;
  readonly asOfDate: DateOnlyType;
  /** Today's cash balance and the account's total value — from the same
   * valuation the aggregate block already computed. This module reads no
   * price and no live holding; it only reads history. */
  readonly cash: MoneyType;
  readonly accountValue: MoneyType;
  /**
   * The live earmark total for this account, from `@ctx/planning`'s
   * `cash_earmarks` reader. `Money.zero(currency)` when nothing is earmarked.
   * An **input**, never a query — see the file header.
   */
  readonly earmarkedAmount: MoneyType;
}

/**
 * One account's {@link CashPosition}, ready for `idleCash()` — `idleDays` from
 * {@link idleDaysOf} over an already-fetched `history`, `earmarked` from the
 * caller's `earmarkedAmount` rather than a table this context may not read.
 *
 * Pure, deliberately: the caller fetches `history` with
 * {@link cashSnapshotHistory} (the one function here that touches Postgres)
 * and passes it in, so `test/dwell.test.ts` can drive the whole composition —
 * including "an earmarked balance is never idle" — against fixture arrays,
 * with no database.
 *
 * A non-zero earmark makes the whole position `earmarked: true` rather than
 * splitting the balance into an earmarked and an idle remainder: `CashPosition`
 * carries one boolean per account (WP 3.3's shape), and `cash_earmarks` is a
 * reservation *within* an account rather than a second cash figure. Splitting
 * the balance is a real refinement `idleCash()`'s shape does not yet carry;
 * recorded as an open item in `docs/evidence/phase-4/wp4.7-gap-fields.md`
 * rather than done silently here.
 */
export function cashPositionFor(
  input: DwellCashInput,
  history: readonly CashSnapshot[],
): CashPosition {
  const idleDays = idleDaysOf(history, input.asOfDate);
  return {
    accountId: input.accountId,
    cash: input.cash,
    accountValue: input.accountValue,
    idleDays,
    earmarked: !Money.isZero(input.earmarkedAmount),
  };
}
