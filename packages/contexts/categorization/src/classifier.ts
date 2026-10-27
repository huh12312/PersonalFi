// SPDX-License-Identifier: MIT
/**
 * The local classifier: multinomial naive Bayes over token counts.
 *
 * 04 §5.2 makes this the last tier and hedges it heavily — "*optional, off by
 * default, behind an interface*", "below a threshold it stays uncategorized
 * rather than guessing", "**never silently apply**". Everything below is built to
 * honour those three sentences, and the shape is 02 §4.4's verdict on
 * `smart_importer`: "reimplement the ~200-line pipeline on our types" rather than
 * take a dependency with GPL transitive deps.
 *
 * ## Why naive Bayes and not something better
 *
 * Because the training set is *this user's* confirmed categorisations — hundreds
 * of examples, not millions — and at that size the thing that decides accuracy is
 * feature engineering, not model class. Naive Bayes is also the only option here
 * that is trivially **explainable**: the decision decomposes into a per-token
 * contribution, so `explainAssignment` can say "because of the tokens CHEWY and
 * PETCO" instead of "because the model said so". An insight the user cannot
 * interrogate is an insight the user will not trust (principle 2, §2.1).
 *
 * ## Features
 *
 * Tokens from the *normalised* payee, plus coarse contextual features:
 *
 *     t:chewy  t:com          — payee tokens
 *     b:3                     — amount magnitude bucket (powers of ~3)
 *     d:out                   — direction (with `b:`, the sign-magnitude bucket)
 *     a:credit                — account type
 *     m:family.pet_medical    — the MCC's category leaf, when a code is present
 *     mf:family               — the MCC's *family*: the leaf's top level (WP 11.1)
 *     p:food_and_drink        — the provider's PFC primary, when one was sent (WP 11.1)
 *     dm:early | mid | late   — where in the month it fell: 1–10, 11–20, 21+ (WP 11.1)
 *
 * WP 11.1 added the last three, deterministically (11 §3.1: "accuracy at a few
 * hundred examples is feature engineering"). `mf:` lets two vets with different
 * leaf codes share evidence the leaf alone splits; `p:` lets the provider's
 * coarse opinion count as evidence where the mapping does not place it (a
 * primary newer than our table — the provider *tier* only speaks when the
 * mapping does), and lets training learn from the provider
 * codes on every confirmed row; `dm:` is the signal a rent, a paycheck or a card payment carries in
 * its date. Each is named in `topFeatures`, so `explainAssignment` shows it by
 * name when it moved the answer. The account's management or role overlay was
 * considered and left out: `CategorizableTransaction` does not carry it, and
 * widening `@ctx/ledger`'s port for a feature that only separates accounts the
 * `a:` type already separates was not cheap.
 *
 * Amount is bucketed rather than used raw because naive Bayes wants categorical
 * features, and because the *scale* is what carries signal: a $4 charge and a
 * $400 charge at the same merchant are usually different things, while $4.15 and
 * $4.40 never are.
 *
 * ## Calibration, and why the raw posterior is not the confidence
 *
 * Naive Bayes posteriors are famously overconfident: the independence assumption
 * multiplies correlated evidence, so ten tokens that all say "groceries" produce
 * 0.9999 whether or not the model has any business being sure. Reporting that as
 * `confidence` would poison every downstream number, because the confidence
 * column is what the review queue sorts on and what a budget's "how much of this
 * is guessed?" figure is computed from.
 *
 * So the score is tempered — the log-likelihood is divided by the feature count,
 * making it a geometric mean rather than a product — and then three gates apply
 * before the model is allowed to speak at all:
 *
 *   * `MIN_EXAMPLES_PER_CATEGORY` confirmed examples for the winning category;
 *   * `MIN_MARGIN` between the winner and the runner-up;
 *   * the caller's `confidenceFloor`.
 *
 * Below any of them it abstains, and abstention is a first-class outcome with its
 * own reason string rather than a low-confidence guess. `classifier.test.ts`
 * asserts that a cold model abstains on everything — the state it ships in.
 */

import type { DateOnly } from '@core/kernel';
import { lookupMcc } from './mcc-codes.ts';
import { fingerprint } from './normalize/fingerprint.ts';

/** Confirmed examples for the winning category before it may be predicted. */
export const MIN_EXAMPLES_PER_CATEGORY = 3;
/** How far ahead of the runner-up the winner must be, in tempered log space. */
export const MIN_MARGIN = 0.08;
/** Laplace smoothing. One pseudo-count, the textbook default. */
const ALPHA = 1;

export interface ClassifierFeatureInput {
  /** The cleaned descriptor. Tokenised here so callers cannot disagree about how. */
  readonly cleanedPayee: string;
  readonly amountMinor: bigint;
  readonly accountType: string | null;
  readonly mcc?: string | null;
  /** The provider's PFC primary (`FOOD_AND_DRINK`), as `readProviderCategory` reads it. */
  readonly providerPrimary?: string | null;
  /** The transaction's date, for the day-of-month bucket. */
  readonly date?: DateOnly | null;
}

/** Day-of-month thirds. Calendar days, so a 28-day February loses nothing. */
export function dayOfMonthBucket(date: DateOnly): 'early' | 'mid' | 'late' {
  const day = Number(date.slice(8, 10));
  if (day <= 10) return 'early';
  if (day <= 20) return 'mid';
  return 'late';
}

/**
 * A trained model, as stored.
 *
 * Plain objects rather than `Map`s at rest so the whole thing round-trips through
 * `jsonb` without a custom serialiser — the model lives in `classifier_versions`
 * and must survive being written by one process and read by another.
 */
export interface ClassifierModel {
  readonly version: number;
  readonly totalExamples: number;
  /** categoryKey -> example count. */
  readonly categoryCounts: Readonly<Record<string, number>>;
  /** feature -> categoryKey -> count. */
  readonly featureCounts: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Distinct features seen. The denominator of Laplace smoothing. */
  readonly vocabulary: number;
}

/** The state the app ships in: knows nothing, abstains on everything. */
export const COLD_MODEL: ClassifierModel = Object.freeze({
  version: 0,
  totalExamples: 0,
  categoryCounts: Object.freeze({}),
  featureCounts: Object.freeze({}),
  vocabulary: 0,
});

/**
 * Amount magnitude, bucketed.
 *
 * Roughly one bucket per tripling, so $1–$3, $3–$10, $10–$30 and so on. Log
 * spacing because spending is log-distributed: the gap between $4 and $40 is
 * meaningful and the gap between $400 and $436 is not.
 */
export function amountBucket(amountMinor: bigint): string {
  const magnitude = amountMinor < 0n ? -amountMinor : amountMinor;
  if (magnitude === 0n) return '0';
  const dollars = Number(magnitude) / 100;
  return String(Math.max(0, Math.round(Math.log(dollars + 1) / Math.log(3))));
}

export function featuresOf(input: ClassifierFeatureInput): readonly string[] {
  const features: string[] = [];

  const key = fingerprint(input.cleanedPayee);
  for (const token of key.split(' ')) {
    if (token !== '') features.push(`t:${token}`);
  }

  features.push(`b:${amountBucket(input.amountMinor)}`);
  features.push(`d:${input.amountMinor < 0n ? 'out' : 'in'}`);
  if (input.accountType !== null && input.accountType !== '') {
    features.push(`a:${input.accountType}`);
  }
  const mcc = lookupMcc(input.mcc);
  if (mcc !== undefined) {
    features.push(`m:${mcc.categoryKey}`);
    const family = mcc.categoryKey.split('.')[0];
    if (family !== undefined && family !== '') features.push(`mf:${family}`);
  }
  const primary = input.providerPrimary?.trim().toLowerCase() ?? '';
  if (/^[a-z0-9_]{1,64}$/u.test(primary)) features.push(`p:${primary}`);
  if (input.date !== undefined && input.date !== null) {
    features.push(`dm:${dayOfMonthBucket(input.date)}`);
  }

  // Deduplicated: a descriptor that repeats a word should not count it twice,
  // and the fingerprint has already deduplicated the payee tokens anyway.
  return [...new Set(features)];
}

export interface TrainingExample {
  readonly features: readonly string[];
  readonly categoryKey: string;
}

/**
 * Build a model from confirmed examples.
 *
 * A full rebuild rather than an incremental update, and called from a job rather
 * than inline: with a few thousand examples it takes milliseconds, and "the model
 * is a pure function of the confirmed assignments" is worth far more than the
 * microseconds an incremental path would save. It means a bug in training is
 * fixed by re-running training, not by repairing accumulated state, and it means
 * two processes cannot race each other into a model that reflects neither.
 */
export function train(examples: readonly TrainingExample[]): ClassifierModel {
  const categoryCounts: Record<string, number> = {};
  const featureCounts: Record<string, Record<string, number>> = {};

  for (const example of examples) {
    categoryCounts[example.categoryKey] = (categoryCounts[example.categoryKey] ?? 0) + 1;
    for (const feature of example.features) {
      const perCategory = (featureCounts[feature] ??= {});
      perCategory[example.categoryKey] = (perCategory[example.categoryKey] ?? 0) + 1;
    }
  }

  return {
    version: 1,
    totalExamples: examples.length,
    categoryCounts,
    featureCounts,
    vocabulary: Object.keys(featureCounts).length,
  };
}

export interface FeatureContribution {
  readonly feature: string;
  /** Log-odds this feature contributed to the winner. Positive means "for". */
  readonly weight: number;
}

export type ClassifierOutcome =
  | {
      readonly kind: 'predicted';
      readonly categoryKey: string;
      readonly confidence: number;
      readonly runnerUp: string | null;
      readonly margin: number;
      /** A word of the payee's own had been seen with this category (WP 11.1). */
      readonly payeeEvidence: boolean;
      /** The three features that moved the answer most. The explanation. */
      readonly topFeatures: readonly FeatureContribution[];
    }
  | {
      readonly kind: 'abstained';
      readonly reason: string;
      readonly categoryKey: string | null;
      /**
       * Which gate stopped it, as a code a caller can switch on (WP 11.1). The
       * Inbox's "why" line is composed from this and the figures beside it —
       * never by parsing `reason`, which is prose and gets rewritten.
       */
      readonly code: AbstainCode;
      /** The calibrated confidence it reached, when it got as far as computing one. */
      readonly confidence?: number;
      /** The floor it was held to, when `code` is `below_floor`. */
      readonly floor?: number;
      /** Confirmed examples for the leading category, when `code` is `under_supported`. */
      readonly examples?: number;
      /** Whether a payee word had been seen with the leader, when `code` is `below_floor`. */
      readonly payeeEvidence?: boolean;
    };

/** The six ways the classifier declines, in the order its gates run. */
export type AbstainCode =
  'cold' | 'no_features' | 'single_category' | 'under_supported' | 'too_close' | 'below_floor';

/**
 * Score every category and return the winner, or abstain.
 *
 * The returned `confidence` is a softmax over *tempered* log scores, so it is a
 * number that means something when a budget divides by it. It is not the naive
 * posterior, on purpose — see the file header.
 */
export function predict(
  model: ClassifierModel,
  features: readonly string[],
  confidenceFloor: number,
): ClassifierOutcome {
  if (model.totalExamples === 0) {
    return {
      kind: 'abstained',
      reason: 'model is cold: no confirmed examples yet',
      categoryKey: null,
      code: 'cold',
    };
  }
  if (features.length === 0) {
    return {
      kind: 'abstained',
      reason: 'no usable features',
      categoryKey: null,
      code: 'no_features',
    };
  }

  const categories = Object.keys(model.categoryCounts);
  if (categories.length < 2) {
    // One category is not a classifier, it is a constant. Predicting it would
    // look like learning and would be worth nothing.
    return {
      kind: 'abstained',
      reason: 'fewer than two categories have confirmed examples',
      categoryKey: null,
      code: 'single_category',
    };
  }

  const vocabulary = Math.max(model.vocabulary, 1);
  const scores = new Map<string, number>();
  const perCategoryContributions = new Map<string, FeatureContribution[]>();

  for (const category of categories) {
    const categoryCount = model.categoryCounts[category] ?? 0;
    const prior = Math.log(categoryCount / model.totalExamples);

    let likelihood = 0;
    const contributions: FeatureContribution[] = [];
    for (const feature of features) {
      const seen = model.featureCounts[feature]?.[category] ?? 0;
      const probability = (seen + ALPHA) / (categoryCount + ALPHA * vocabulary);
      const weight = Math.log(probability);
      likelihood += weight;
      contributions.push({ feature, weight });
    }

    // Temper the **whole** score, prior included, not the likelihood alone.
    //
    // Shrinking the likelihood while leaving the prior at full strength does not
    // calibrate anything — it changes the *ranking*, and changes it for the
    // worse: the prior then dominates, and the model predicts whichever category
    // the user spends in most often regardless of the payee. That bug shipped in
    // the first draft of this file and the golden set caught it, with
    // `groceries.supermarkets` winning for Chevron and Kaiser Permanente alike.
    //
    // `features.length` is the same for every category in this loop, so dividing
    // by it is a monotone transform of the score: the ranking is exactly
    // textbook naive Bayes, and the only thing tempering touches is how far apart
    // the softmax spreads the results. Which is precisely what calibration is
    // supposed to touch.
    scores.set(category, (prior + likelihood) / features.length);
    perCategoryContributions.set(category, contributions);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [winner, winnerScore] = ranked[0] as [string, number];
  const runnerUp = ranked[1];
  const margin = runnerUp === undefined ? Number.POSITIVE_INFINITY : winnerScore - runnerUp[1];

  const winnerExamples = model.categoryCounts[winner] ?? 0;
  if (winnerExamples < MIN_EXAMPLES_PER_CATEGORY) {
    return {
      kind: 'abstained',
      reason: `only ${winnerExamples} confirmed example(s) for ${winner}; needs ${MIN_EXAMPLES_PER_CATEGORY}`,
      categoryKey: winner,
      code: 'under_supported',
      examples: winnerExamples,
    };
  }
  if (margin < MIN_MARGIN) {
    return {
      kind: 'abstained',
      reason: `too close to call: ${winner} leads ${runnerUp?.[0] ?? '(nothing)'} by ${margin.toFixed(4)}`,
      categoryKey: winner,
      code: 'too_close',
      confidence: confidenceFromMargin(margin, true),
    };
  }

  // WP 11.1's calibration split: does anything in the payee's own name point
  // at the winner? See `confidenceFromMargin`.
  const payeeEvidence = features.some(
    (feature) => feature.startsWith('t:') && (model.featureCounts[feature]?.[winner] ?? 0) > 0,
  );
  const confidence = confidenceFromMargin(margin, payeeEvidence);
  if (confidence < confidenceFloor) {
    return {
      kind: 'abstained',
      reason: `confidence ${confidence.toFixed(4)} is below the floor of ${confidenceFloor}`,
      categoryKey: winner,
      code: 'below_floor',
      confidence,
      floor: confidenceFloor,
      payeeEvidence,
    };
  }

  // Rank features by how much better they are for the winner than for the
  // runner-up: a token that is equally likely everywhere explains nothing, even
  // if its absolute weight is large.
  const winnerContributions = perCategoryContributions.get(winner) ?? [];
  const runnerContributions = new Map(
    (runnerUp === undefined ? [] : (perCategoryContributions.get(runnerUp[0]) ?? [])).map(
      (contribution) => [contribution.feature, contribution.weight],
    ),
  );
  const topFeatures = [...winnerContributions]
    .map((contribution) => ({
      feature: contribution.feature,
      weight:
        contribution.weight -
        (runnerContributions.get(contribution.feature) ?? contribution.weight),
    }))
    .sort((a, b) => b.weight - a.weight || a.feature.localeCompare(b.feature))
    .slice(0, 3);

  return {
    kind: 'predicted',
    categoryKey: winner,
    confidence,
    runnerUp: runnerUp?.[0] ?? null,
    margin,
    payeeEvidence,
    topFeatures,
  };
}

/**
 * How sure the model is, as a function of the **margin** — not of a softmax —
 * and of whether the payee's own words back the answer.
 *
 * A softmax over the category scores is the obvious thing and it is wrong here,
 * for a reason that is easy to miss and that the golden set made obvious: its
 * output depends on *how many categories exist*. With 25 categories the best
 * prediction in the seed dataset scored 0.29, so a floor of 0.6 rejected
 * everything; adding a category to the taxonomy would have lowered every
 * confidence score in the app without any model having changed. A number that
 * moves when an unrelated picklist grows is not a confidence.
 *
 * The margin has none of that. It is the gap between the winner and the
 * runner-up in mean log-odds per feature — "the winner is e^margin times more
 * likely, per piece of evidence" — and it is unchanged by the existence of
 * twenty other categories that both beat.
 *
 * ## The calibration, re-derived in WP 11.1
 *
 * WP 11.1 widened the feature set (`mf:`, `p:`, `dm:`) and built the gold-set
 * replay (`eval/replay.ts`), and the replay showed the old single curve
 * (`logistic(2.2 × margin)`) was wrong in *both* directions once it could be
 * measured on merchants the model had never been told about:
 *
 *   * **Payee-evidenced** predictions — at least one `t:` token of this payee
 *     has been confirmed under the winning category — were right 98.8 % of the
 *     time (4,045 predictions over the demo seed's four variants × two
 *     holdouts), and right ≥ 85 % in every margin bin from 0.08 up. The old
 *     curve called the 0.08–0.19 bin 55–60 % sure; it was 95 % right.
 *   * **Context-only** predictions — no payee word ever seen with the winner,
 *     so only the amount bucket, the account type, the direction, the MCC, the
 *     provider primary and the day of month spoke — were right **7.4 %** of the
 *     time (2,279 predictions) and no better than 11 % in any margin bin. The
 *     old curve let 1,495 of them through the 0.6 floor at 8 % precision. That
 *     is the classifier guessing, which 04 §5.2 forbids.
 *
 * So the curve is two segments:
 *
 *     payee-evidenced   logistic(PAYEE_MARGIN_SCALE × margin), capped at 0.99
 *         margin 0.08 -> 0.64   the MIN_MARGIN gate; just over the default floor
 *         margin 0.19 -> 0.79
 *         margin 0.50 -> 0.97
 *     context-only      the same, capped at CONTEXT_ONLY_CEILING (0.5)
 *
 * `PAYEE_MARGIN_SCALE` is the maximum-likelihood slope of a one-parameter
 * logistic (anchored at 0.5 for a margin of 0, a tie being a coin flip) fitted
 * to the payee-evidenced predictions: 7.10, rounded down to 7. The context-only
 * ceiling is a policy, not a fit — the fit says ~0.07, which is a property of a
 * seed whose 32 merchants mostly sit in categories of their own; 0.5 says what
 * is true everywhere, that context alone is no better than a coin flip, and it
 * keeps the default floor of 0.6 an abstention for every context-only answer.
 * A holder who lowers the floor below 0.5 has asked for guesses and gets them.
 *
 * `classifier.test.ts` re-runs the fit on the demo seed and fails if the shipped
 * slope drifts from it by more than 10 %, and asserts that above the floor the
 * cold-merchant replay is right at least as often as the floor promises.
 *
 * Capped at 0.99: a model trained on a few hundred of one household's
 * transactions is never entitled to say "certain", and 1.0 is reserved for the
 * tiers that are instructions rather than estimates — a user's edit and a user's
 * rule.
 */
export const PAYEE_MARGIN_SCALE = 7;
/** The most a prediction resting on context features alone may claim. */
export const CONTEXT_ONLY_CEILING = 0.5;

export function confidenceFromMargin(margin: number, payeeEvidence = true): number {
  const ceiling = payeeEvidence ? 0.99 : CONTEXT_ONLY_CEILING;
  if (!Number.isFinite(margin)) return ceiling;
  return Math.min(ceiling, 1 / (1 + Math.exp(-PAYEE_MARGIN_SCALE * margin)));
}
