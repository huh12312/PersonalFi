// SPDX-License-Identifier: MIT
/**
 * The alert budget: 5 on the dashboard, 20 in the list, $50 a year to qualify.
 *
 * 02-phase-2-dispatch.md §6 question 4's default. The number that matters is not
 * 5 or 20, it is the one implied by them: **the rest are withheld, not
 * deleted.** Every proposal still lands in `insights` as `pending_review` with
 * its evidence; the budget decides what is *shown*, and it is applied at read
 * time so that raising the ceiling does not require a re-run and lowering it
 * does not lose anything.
 *
 * That split is what keeps the first run from being a wall of red (the stated
 * worry in question 4) without making the feed lossy.
 *
 * ## The $50 floor, and the exception it needs
 *
 * "$50 minimum annual impact" is a filter on advice that is *about money left on
 * the table*: a $3-a-year saving is true, uninteresting, and crowds out a $400
 * one. Applied literally to everything, though, it would suppress "a direct
 * debit failed" and "you have been charged twice", which have no annualised
 * saving at all and are the most urgent things this app can say.
 *
 * So the floor applies to an insight that **claims an impact**. An insight with
 * `impact.annualized === null && impact.one_time === null` is not measured
 * against it and is ranked on severity instead. An insight that claims $3 is
 * withheld; an insight that claims nothing is judged on what it is.
 *
 * A one-time saving counts at half a recurring one of equal size (07 §3.2),
 * which is the same weighting WP 2.7's ranking formula uses, so an insight that
 * clears the floor also clears it under ranking.
 *
 * ## Ranking here is provisional, deliberately
 *
 * WP 2.7 owns the real formula — `annualized_impact × confidence ×
 * actionability × urgency × (1 − 0.5·dismiss_rate)`. Two of those factors
 * (actionability, dismiss rate) need the catalogue and the feedback table that
 * WP 2.7 and the UI produce. What is here is the subset that is already
 * knowable: impact, confidence and severity. It is a stable, total ordering
 * with an explicit tie-break on `key`, so the feed does not reshuffle between
 * two reads, and `rank()` is exported so WP 2.7 can replace the body without
 * touching any caller.
 */
import { Money, USD, isCurrencyCode, minorUnitScale } from '@core/kernel';
import { severityRank, type Severity } from '../contract/response.ts';

export const ALERT_BUDGET = Object.freeze({
  /** How many reach the dashboard. */
  dashboard: 5,
  /** How many reach the full list. The rest are withheld, not deleted. */
  list: 20,
  /** Minimum annualised impact, in major units, for an insight that claims one. */
  minimumAnnualImpactMajor: 50,
});

/** 07 §3.2: a one-off is worth half a recurring saving of the same size. */
export const ONE_TIME_WEIGHT = 0.5;

/** What the budget needs to know about an insight. A projection, not the row. */
export interface RankableInsight {
  readonly key: string;
  readonly severity: Severity;
  readonly confidence: number;
  readonly annualizedImpact: Money | null;
  readonly oneTimeImpact: Money | null;
}

/**
 * The impact an insight is judged on, in minor units, one-time discounted.
 *
 * `null` when the insight claims none — which is a different thing from zero
 * and is why the return type is nullable rather than `0n`.
 */
export function effectiveImpactMinor(insight: RankableInsight): bigint | null {
  const annual = insight.annualizedImpact;
  const oneTime = insight.oneTimeImpact;
  if (annual === null && oneTime === null) return null;
  const annualMinor = annual === null ? 0n : Money.absolute(annual).minor;
  const oneTimeMinor =
    oneTime === null
      ? 0n
      : // Half, rounded down in minor units. `Money.multiplyByDecimal` would be
        // the right tool for a general ratio; halving is exact in integers and
        // does not need a rounding mode argued about.
        Money.absolute(oneTime).minor / 2n;
  return annualMinor + oneTimeMinor;
}

/**
 * `true` when the insight is below the floor it is subject to.
 *
 * An unrecognised currency code falls back to `USD`'s scale rather than
 * throwing. This runs on the read path of a feed; a display filter is the wrong
 * place to turn a bad row into a 500, and every real currency this app supports
 * has a two-digit minor unit anyway — the fallback changes the answer only for
 * a code that should never have reached the database.
 */
export function belowFloor(insight: RankableInsight, currencyCode: string): boolean {
  const impact = effectiveImpactMinor(insight);
  if (impact === null) return false;
  const code = isCurrencyCode(currencyCode) ? currencyCode : USD;
  const scale = 10n ** BigInt(minorUnitScale(code));
  return impact < BigInt(ALERT_BUDGET.minimumAnnualImpactMajor) * scale;
}

/**
 * 02 §6 Q3's P0-safety class: overdraft ahead, a charge that may have landed
 * twice, and a missed debt payment — findings where the harm is dollars
 * leaving the account, not a probability drifting. None of the three claims
 * an impact figure (the amount is unknown, banded, or the mismatch is the
 * point), so under `rank()`'s magnitude term every one of them ties with
 * every other `urgent` finding that claims none. wp4.9 §12 item 1 found what
 * a bare `key` tie-break does next: `S6` (`spending.duplicate_charge`) lost
 * its dashboard slot to `R2`/`R7` every time, because `'spending.'` sorts
 * after `'retirement.'` — an artefact of the alphabet, not a decision about
 * which finding matters more.
 *
 * Matched by `key` rather than by a `type` field the projection does not
 * carry: `RankableInsight` is a read-time projection over `insights`, and
 * every rule in this class emits a key that begins with its own type string
 * (`insightOf`'s convention, unenforced but universal in this catalogue) — so
 * the key already carries what is needed and the term below adds no new
 * field to reach it.
 */
const P0_SAFETY_KEY_PREFIXES: readonly string[] = Object.freeze([
  // C3 — a projected shortfall against cash on hand.
  'cash.projected_shortfall',
  // S6 — a charge that may have landed twice.
  'spending.duplicate_charge.',
  // D6 — a missed debt payment.
  'debt.missed_payment.',
]);

/**
 * `true` for an `urgent` finding in the P0-safety class.
 *
 * Gated on severity because the class is defined by what it warns about, not
 * by a key prefix alone — a rule that reused one of these prefixes for a
 * lower-severity finding (none does today) would not be this.
 */
export function isP0Safety(insight: RankableInsight): boolean {
  if (insight.severity !== 'urgent') return false;
  return P0_SAFETY_KEY_PREFIXES.some(
    (prefix) => insight.key === prefix || insight.key.startsWith(prefix),
  );
}

/**
 * The P0-safety term's size, in `rank()`'s own units.
 *
 * Smaller than one full severity tier (10) and smaller than any dollar figure
 * a claiming `urgent` finding would add — this only ever breaks a tie among
 * findings that already tied on severity and claimed impact, exactly the
 * `magnitude === 0` case wp4.9 found. It is not a claim that a safety finding
 * outranks every dollar figure a rule might report.
 */
const P0_SAFETY_TERM = 0.5;

/**
 * A score, higher is shown sooner.
 *
 * Deliberately a plain number: this is presentation ordering, not money, and
 * nothing here flows into a `*_minor` column. The severity term is additive and
 * dominant so that an urgent finding with no dollar figure outranks a large but
 * merely notable saving — the app's job is to lead with what will hurt. The
 * P0-safety term is the next tie-break, before `key`: among findings already
 * equal on severity and magnitude, a safety finding is shown for what it is,
 * not for what its key happens to start with.
 */
export function rank(insight: RankableInsight): number {
  const impact = effectiveImpactMinor(insight) ?? 0n;
  // Log-scaled so a $10,000 finding does not bury nineteen $400 ones. Money
  // beyond a point is all "a lot" to a reader deciding what to click.
  const magnitude = Math.log10(1 + Number(impact < 0n ? -impact : impact));
  const confidence = Math.min(1, Math.max(0, insight.confidence));
  const safetyTerm = isP0Safety(insight) ? P0_SAFETY_TERM : 0;
  return severityRank(insight.severity) * 10 + magnitude * confidence + safetyTerm;
}

export interface BudgetedFeed<T> {
  /** The dashboard's slice. At most `ALERT_BUDGET.dashboard`. */
  readonly dashboard: readonly T[];
  /** The list's slice, which starts with the dashboard's. */
  readonly list: readonly T[];
  /** Everything that qualified but did not fit, in rank order. */
  readonly overflow: readonly T[];
  /** Everything the floor excluded. Kept separate: a different reason. */
  readonly belowFloor: readonly T[];
}

/**
 * Apply the budget to a set of proposals.
 *
 * Generic over the row type so the same function serves the read model, a test
 * with a bare projection, and WP 2.7's catalogue harness without any of them
 * converting first. `project` is how a caller says which fields to rank on.
 *
 * The sort is total and stable: rank descending, then `key` ascending. Without
 * the tie-break, two insights with identical scores could swap between two
 * reads of the same data, and a feed that reorders itself when nothing changed
 * is a feed nobody trusts.
 */
export function applyAlertBudget<T>(
  rows: readonly T[],
  project: (row: T) => RankableInsight,
  currencyCode: string,
): BudgetedFeed<T> {
  const qualified: T[] = [];
  const floored: T[] = [];
  for (const row of rows) {
    if (belowFloor(project(row), currencyCode)) floored.push(row);
    else qualified.push(row);
  }

  const ordered = [...qualified].sort((left, right) => {
    const difference = rank(project(right)) - rank(project(left));
    if (difference !== 0) return difference;
    return project(left).key.localeCompare(project(right).key);
  });

  return {
    dashboard: ordered.slice(0, ALERT_BUDGET.dashboard),
    list: ordered.slice(0, ALERT_BUDGET.list),
    overflow: ordered.slice(ALERT_BUDGET.list),
    belowFloor: floored,
  };
}
