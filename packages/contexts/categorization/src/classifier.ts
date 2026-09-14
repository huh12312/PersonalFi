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
 * Tokens from the *normalised* payee, plus three coarse contextual features:
 *
 *     t:chewy  t:com          — payee tokens
 *     b:3                     — amount magnitude bucket (powers of ~3)
 *     a:credit                — account type
 *     d:out                   — direction
 *     m:family.pets           — the MCC's category, when a code is present
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
  if (mcc !== undefined) features.push(`m:${mcc.categoryKey}`);

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
      /** The three features that moved the answer most. The explanation. */
      readonly topFeatures: readonly FeatureContribution[];
    }
  | { readonly kind: 'abstained'; readonly reason: string; readonly categoryKey: string | null };

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
    };
  }
  if (features.length === 0) {
    return { kind: 'abstained', reason: 'no usable features', categoryKey: null };
  }

  const categories = Object.keys(model.categoryCounts);
  if (categories.length < 2) {
    // One category is not a classifier, it is a constant. Predicting it would
    // look like learning and would be worth nothing.
    return {
      kind: 'abstained',
      reason: 'fewer than two categories have confirmed examples',
      categoryKey: null,
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
    };
  }
  if (margin < MIN_MARGIN) {
    return {
      kind: 'abstained',
      reason: `too close to call: ${winner} leads ${runnerUp?.[0] ?? '(nothing)'} by ${margin.toFixed(4)}`,
      categoryKey: winner,
    };
  }

  const confidence = confidenceFromMargin(margin);
  if (confidence < confidenceFloor) {
    return {
      kind: 'abstained',
      reason: `confidence ${confidence.toFixed(4)} is below the floor of ${confidenceFloor}`,
      categoryKey: winner,
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
    topFeatures,
  };
}

/**
 * How sure the model is, as a function of the **margin** — not of a softmax.
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
 * twenty other categories that both beat. A logistic maps it to 0–1:
 *
 *     margin 0.00 -> 0.50   a coin flip; the two leaders are indistinguishable
 *     margin 0.19 -> 0.60   the default floor
 *     margin 0.50 -> 0.75
 *     margin 1.50 -> 0.96
 *
 * Capped at 0.99: a model trained on a few hundred of one household's
 * transactions is never entitled to say "certain", and 1.0 is reserved for the
 * tiers that are instructions rather than estimates — a user's edit and a user's
 * rule.
 */
const MARGIN_SCALE = 2.2;

export function confidenceFromMargin(margin: number): number {
  if (!Number.isFinite(margin)) return 0.99;
  return Math.min(0.99, 1 / (1 + Math.exp(-MARGIN_SCALE * margin)));
}
