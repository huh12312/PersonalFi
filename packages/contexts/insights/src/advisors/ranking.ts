// SPDX-License-Identifier: MIT
/**
 * Ranking (07 §3.2) and the alert budget applied on top of it.
 *
 * ```
 * rank_score = annualized_impact × confidence × actionability
 *            × urgency_multiplier × (1 − 0.5 × dismiss_rate)
 * ```
 *
 * WP 2.6 shipped the knowable half of that in `policy/alert-budget.ts`'s
 * `rank()` — impact and confidence, with severity additive and dominant — and
 * said the other three factors were WP 2.7's, because they need a catalogue and
 * a feedback table. This module supplies them, and it **composes with** `rank()`
 * rather than replacing it:
 *
 * ```
 * rankBuiltin(row) = rank(row) × actionability × urgency × (1 − 0.5 · dismissRate)
 * ```
 *
 * Composing rather than rewriting matters for a reason that is not stylistic.
 * `rank()` is what an advisor with no catalogue entry is ranked by — a Phase 6
 * sidecar declares no actionability tier and has no dismissal history on day
 * one — so the two functions have to agree on the ordering of everything the
 * catalogue does not know about. Making the catalogue's ranking a *multiplier
 * over* the platform's guarantees that: with every extra factor at its neutral
 * value (1.0, 1.0, 0) the two functions return the same number.
 *
 * ## Why the three factors are read off the insight, not a hand table
 *
 * `actionability` and `urgency` are derived from fields the *contract* already
 * carries — `proposed_actions[].kind` and `horizon` — rather than from a column
 * beside each rule. A table would drift: somebody adds an action to a rule and
 * forgets the tier, and the rule silently keeps ranking as informational. Read
 * off the insight, the two can only disagree if the insight itself is wrong.
 *
 * `dismiss_rate` is the one input from outside: `insight_feedback` and
 * `insight_dismissals` are where it comes from, WP 2.10's feed passes it, and it
 * defaults to `0` so a catalogue with no history ranks on its merits.
 *
 * ## Severity stays dominant, and one-time still counts at half
 *
 * Both properties come through `rank()` unchanged. A one-time saving is halved
 * inside `effectiveImpactMinor` (07 §3.2: "a recurring dollar is worth more than
 * a one-time dollar"), and an urgent finding with no dollar figure at all still
 * outranks a large but merely notable one — which is what makes "you are about
 * to overdraw" beat "you could earn $900 more a year", correctly.
 */
import {
  ALERT_BUDGET,
  belowFloor,
  effectiveImpactMinor,
  rank,
  type BudgetedFeed,
  type RankableInsight,
} from '../policy/alert-budget.ts';
import { PROPOSED_ACTION_KINDS, type ProposedActionKind } from '../contract/response.ts';

/**
 * 07 §3.2's three tiers, read off what the insight actually proposes.
 *
 * | Tier | 07's wording | What earns it here |
 * | --- | --- | --- |
 * | 1.0 | one-click | an action the app performs on confirmation — a rule or goal **draft** |
 * | 0.7 | do-it-yourself | a suggestion or a link; the user does the work elsewhere |
 * | 0.4 | informational | no action at all |
 */
export const ACTIONABILITY = Object.freeze({
  oneClick: 1,
  doItYourself: 0.7,
  informational: 0.4,
});

/** 07 §3.2: "2.0 if a deadline < 14d, 1.0 otherwise". */
export const URGENCY_MULTIPLIER = Object.freeze({ deadline: 2, none: 1 });

/** 07 §3.2's learned suppression: `1 − 0.5 · dismiss_rate`. */
export const DISMISS_PENALTY = 0.5;

const DRAFT_KINDS: ReadonlySet<ProposedActionKind> = new Set<ProposedActionKind>([
  'create_goal_draft',
  'create_rule_draft',
]);

export function actionabilityOf(kinds: readonly string[]): number {
  const known = kinds.filter((kind): kind is ProposedActionKind =>
    (PROPOSED_ACTION_KINDS as readonly string[]).includes(kind),
  );
  if (known.length === 0) return ACTIONABILITY.informational;
  if (known.some((kind) => DRAFT_KINDS.has(kind))) return ACTIONABILITY.oneClick;
  return ACTIONABILITY.doItYourself;
}

/**
 * `immediate` is the contract's word for "there is a deadline and it is now".
 *
 * Mapping the multiplier onto `horizon` rather than onto a date arithmetic is
 * what keeps ranking a pure function of the row: the deadline was already
 * evaluated, against the snapshot's `today`, by the rule that emitted it.
 */
export function urgencyOf(horizon: string): number {
  return horizon === 'immediate' ? URGENCY_MULTIPLIER.deadline : URGENCY_MULTIPLIER.none;
}

/** A `RankableInsight` plus the three factors the catalogue adds. */
export interface RankableBuiltin extends RankableInsight {
  readonly horizon: string;
  readonly actionKinds: readonly string[];
  /** From `insight_feedback`. `0` when there is no history. */
  readonly dismissRate?: number;
}

export function rankBuiltin(row: RankableBuiltin): number {
  const dismissRate = Math.min(1, Math.max(0, row.dismissRate ?? 0));
  return (
    rank(row) *
    actionabilityOf(row.actionKinds) *
    urgencyOf(row.horizon) *
    (1 - DISMISS_PENALTY * dismissRate)
  );
}

/** The shape WP 2.10's feed already has. `InsightView` satisfies it. */
export interface RankableFeedRow extends RankableInsight {
  readonly horizon: string;
  readonly actions: readonly { readonly kind: string }[];
}

export function rankableBuiltinOf(row: RankableFeedRow, dismissRate = 0): RankableBuiltin {
  return {
    key: row.key,
    severity: row.severity,
    confidence: row.confidence,
    annualizedImpact: row.annualizedImpact,
    oneTimeImpact: row.oneTimeImpact,
    horizon: row.horizon,
    actionKinds: row.actions.map((action) => action.kind),
    dismissRate,
  };
}

/**
 * The alert budget, over the catalogue's ranking.
 *
 * Same contract as `policy/alert-budget.ts`'s `applyAlertBudget` — same
 * constants, same floor, same four slices, same "withheld, not deleted" —
 * differing only in the comparator. The floor itself is deliberately *not*
 * re-implemented: `belowFloor` is imported, so the `$50` rule and its
 * no-impact exception have one definition and the catalogue cannot drift into a
 * second one.
 *
 * The sort is total and stable: score descending, then `key` ascending. A feed
 * that reshuffles when nothing changed is a feed nobody trusts.
 */
export function applyCatalogueBudget<T>(
  rows: readonly T[],
  project: (row: T) => RankableBuiltin,
  currencyCode: string,
): BudgetedFeed<T> {
  const qualified: T[] = [];
  const floored: T[] = [];
  for (const row of rows) {
    if (belowFloor(project(row), currencyCode)) floored.push(row);
    else qualified.push(row);
  }

  const ordered = [...qualified].sort((left, right) => {
    const difference = rankBuiltin(project(right)) - rankBuiltin(project(left));
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

/** Re-exported so a caller ranks and budgets from one import. */
export { ALERT_BUDGET, effectiveImpactMinor, type BudgetedFeed };
