// SPDX-License-Identifier: MIT
/**
 * The gold-set replay: how good is each tier on *this holder's own* answers?
 *
 * WP 11.1 (11 §5, §4 "Evaluation, per query type"). The gold set is the
 * holder's **confirmed** assignments — every transaction they filed by hand,
 * which `confirmAssignment` recorded with `confirmed_at` — and each one is
 * replayed through `decide()` as if the engine had never been told the answer:
 *
 *   * the classifier is trained on every *other* confirmation (leave-one-out);
 *   * the merchant's learned default is recounted from every *other*
 *     confirmation of the same merchant; a **locked** default is the holder's
 *     instruction rather than something learned from the held-out row, so it
 *     is kept as stored;
 *   * the holder's rules are used as they are today, every one of them
 *     (`runOnSync` or not — a rule is an instruction either way);
 *   * the user overlay is cleared, because the overlay *is* the answer.
 *
 * Two holdouts, because one number hides the hard case:
 *
 *   * `transaction` — hold out one confirmation at a time. The merchant is still
 *     known from its other confirmations, so this is "how good is the engine on
 *     merchants it has seen", and on a long history it saturates.
 *   * `merchant` — hold out every confirmation of a merchant at once. This is
 *     the residue's case: a merchant the engine has never been told about,
 *     which is exactly what 11.2's model suggestions will be asked to place,
 *     and so the figure 11.2's ≥ 85 % precision gate is measured on.
 *
 * ## Waterfall and isolation
 *
 * `waterfall` is the engine as it runs: tiers in order, the first to speak
 * wins, and each tier's precision is measured on the rows *it* decided.
 * `isolated` asks each tier alone, on every row, so a tier that the waterfall
 * starves (the classifier never runs where the provider spoke) can still be
 * measured. The isolated classifier is called with the very features `decide`
 * uses (`classifierFeaturesOf`) and the very `predict`; the other three
 * isolations are `decide` itself with the other tiers emptied.
 *
 * ## It never writes
 *
 * A pure function over values. The loader in `eval/load.ts` reads; nothing in
 * either file holds a write path, and `eval-harness.test.ts` asserts the shape
 * is stable and the replay deterministic.
 */
import { COLD_MODEL, predict, type ClassifierModel, type TrainingExample } from '../classifier.ts';
import {
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_MERCHANT_SUPPORT,
  classifierFeaturesOf,
  decide,
  type AssignmentSource,
  type Decision,
  type DecisionInput,
  type MerchantDefault,
} from '../engine.ts';
import type { Rule } from '../rules/schema.ts';
import { UNCATEGORISED_KEY } from '../taxonomy.ts';

/** Bumped on any change to the report's shape. 11.2 parses this. */
export const EVAL_SCHEMA = 'categorization-eval/1' as const;

/** The tiers a replay can grade. `user` is the answer; `none` is abstention. */
export const GRADED_TIERS = ['rule', 'merchant_default', 'provider', 'classifier'] as const;
export type GradedTier = (typeof GRADED_TIERS)[number];

export type Holdout = 'transaction' | 'merchant';

/** One confirmed assignment: what the engine saw, and what the holder said. */
export interface GoldExample {
  readonly input: DecisionInput;
  readonly expectedKey: string;
  /** The ledger merchant id (or any stable merchant key). `null` when nothing grouped. */
  readonly merchantKey: string | null;
}

export interface ReplayOptions {
  readonly rules: readonly Rule[];
  /** Locked merchant defaults by merchant key. Learned ones are recounted, never read. */
  readonly lockedMerchantDefaults?: ReadonlyMap<string, MerchantDefault>;
  readonly confidenceFloor?: number;
  readonly merchantSupportThreshold?: number;
  readonly holdout?: Holdout;
  /**
   * WP 11.2: told the waterfall's decision for every example, by index, in
   * order. Observation only — the report is identical with or without it. The
   * suggestion measurement uses it to find the residue (the rows every tier
   * abstained on) without a second, parallel replay that could drift.
   */
  readonly onDecision?: (index: number, decision: Decision) => void;
}

export interface WaterfallTierFigures {
  /** Rows on which this tier had its turn (every tier above it abstained). */
  readonly reached: number;
  /** Rows this tier won. */
  readonly decided: number;
  readonly correct: number;
  /** correct / decided; `null` when it decided nothing. */
  readonly precision: number | null;
  /** correct / total: this tier's share of the right answers. */
  readonly recall: number;
  /** (reached − decided) / reached; `null` when it was never reached. */
  readonly abstainRate: number | null;
}

export interface IsolatedTierFigures {
  readonly decided: number;
  readonly correct: number;
  readonly precision: number | null;
  readonly recall: number;
  readonly abstainRate: number | null;
}

export interface OverallFigures {
  readonly decided: number;
  readonly correct: number;
  /** Rows every tier abstained on: the residue. */
  readonly abstained: number;
  readonly precision: number | null;
  readonly recall: number;
  readonly abstainRate: number | null;
}

export interface ConfusionPair {
  readonly expected: string;
  readonly got: string;
  readonly count: number;
}

export interface ReplayReport {
  readonly schema: typeof EVAL_SCHEMA;
  readonly holdout: Holdout;
  readonly confidenceFloor: number;
  readonly merchantSupportThreshold: number;
  readonly total: number;
  readonly overall: OverallFigures;
  readonly waterfall: Readonly<Record<GradedTier, WaterfallTierFigures>>;
  readonly isolated: Readonly<Record<GradedTier, IsolatedTierFigures>>;
  /** The waterfall's wrong answers, most frequent first, at most ten. */
  readonly confusion: readonly ConfusionPair[];
}

/** Four decimals, so the JSON is byte-stable across platforms and runs. */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function share(numerator: number, denominator: number): number {
  return ratio(numerator, denominator) ?? 0;
}

// ---------------------------------------------------------------------------
// Leave-out training, without retraining from scratch every time
// ---------------------------------------------------------------------------

/**
 * `train(all minus these)`, computed by subtraction.
 *
 * Naive Bayes is counts, and counts subtract: removing an example decrements
 * its category's count and each of its features' counts, and a feature whose
 * total reaches zero leaves the vocabulary. The result is equal, field for
 * field, to retraining on the remaining examples — `eval-harness.test.ts`
 * asserts exactly that — at a cost proportional to the examples removed rather
 * than to the corpus. Copy-on-write: the input model is never touched.
 */
export function withoutExamples(
  model: ClassifierModel,
  removed: readonly TrainingExample[],
): ClassifierModel {
  if (removed.length === 0) return model;
  const categoryCounts: Record<string, number> = { ...model.categoryCounts };
  const featureCounts: Record<string, Record<string, number>> = {
    ...(model.featureCounts as Record<string, Record<string, number>>),
  };
  const cloned = new Set<string>();
  let vocabulary = model.vocabulary;

  for (const example of removed) {
    const left = (categoryCounts[example.categoryKey] ?? 0) - 1;
    if (left > 0) categoryCounts[example.categoryKey] = left;
    else delete categoryCounts[example.categoryKey];

    for (const feature of example.features) {
      const existing = featureCounts[feature];
      if (existing === undefined) continue;
      if (!cloned.has(feature)) {
        featureCounts[feature] = { ...existing };
        cloned.add(feature);
      }
      const perCategory = featureCounts[feature] as Record<string, number>;
      const count = (perCategory[example.categoryKey] ?? 0) - 1;
      if (count > 0) perCategory[example.categoryKey] = count;
      else delete perCategory[example.categoryKey];
      if (Object.keys(perCategory).length === 0) {
        delete featureCounts[feature];
        vocabulary -= 1;
      }
    }
  }

  return {
    version: model.version,
    totalExamples: model.totalExamples - removed.length,
    categoryCounts,
    featureCounts,
    vocabulary,
  };
}

/** The full model over the gold set, as `retrainClassifier` would build it. */
function trainAll(examples: readonly TrainingExample[]): ClassifierModel {
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

/**
 * The merchant's learned default from the confirmations that remain.
 *
 * The most-confirmed category and its count, ties broken by key so the replay
 * is deterministic. An approximation of production's accumulator, which resets
 * to one on a disagreement (`confirmAssignment`): order is not preserved in a
 * gold set, so the replay counts agreement instead of runs. It errs towards the
 * merchant tier speaking slightly more often than it would live.
 */
function learnedDefault(
  counts: ReadonlyMap<string, number> | undefined,
  held: GoldExample | null,
): MerchantDefault | null {
  if (counts === undefined) return null;
  let best: [string, number] | null = null;
  for (const [key, raw] of counts) {
    const count = held !== null && held.expectedKey === key ? raw - 1 : raw;
    if (count <= 0) continue;
    if (best === null || count > best[1] || (count === best[1] && key < best[0])) {
      best = [key, count];
    }
  }
  return best === null ? null : { categoryKey: best[0], locked: false, supportCount: best[1] };
}

// ---------------------------------------------------------------------------
// The replay
// ---------------------------------------------------------------------------

interface Tally {
  reached: number;
  decided: number;
  correct: number;
}

function emptyTallies(): Record<GradedTier, Tally> {
  return {
    rule: { reached: 0, decided: 0, correct: 0 },
    merchant_default: { reached: 0, decided: 0, correct: 0 },
    provider: { reached: 0, decided: 0, correct: 0 },
    classifier: { reached: 0, decided: 0, correct: 0 },
  };
}

function isGraded(source: AssignmentSource): source is GradedTier {
  return (GRADED_TIERS as readonly string[]).includes(source);
}

export function replayGoldSet(
  examples: readonly GoldExample[],
  options: ReplayOptions,
): ReplayReport {
  const holdout = options.holdout ?? 'transaction';
  const confidenceFloor = options.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
  const merchantSupportThreshold = options.merchantSupportThreshold ?? DEFAULT_MERCHANT_SUPPORT;
  const locked = options.lockedMerchantDefaults ?? new Map<string, MerchantDefault>();

  // The overlay is the answer; a replay that left it set would grade tier 1
  // against itself and score 100 %.
  const cleared = examples.map((example) => ({
    ...example,
    input: { ...example.input, userCategoryId: null },
  }));
  const training: TrainingExample[] = cleared.map((example) => ({
    features: classifierFeaturesOf(example.input),
    categoryKey: example.expectedKey,
  }));
  const full = trainAll(training);

  const byMerchant = new Map<string, number[]>();
  const merchantCounts = new Map<string, Map<string, number>>();
  cleared.forEach((example, index) => {
    if (example.merchantKey === null) return;
    const list = byMerchant.get(example.merchantKey) ?? [];
    list.push(index);
    byMerchant.set(example.merchantKey, list);
    const counts = merchantCounts.get(example.merchantKey) ?? new Map<string, number>();
    counts.set(example.expectedKey, (counts.get(example.expectedKey) ?? 0) + 1);
    merchantCounts.set(example.merchantKey, counts);
  });

  const waterfall = emptyTallies();
  const isolated = emptyTallies();
  let decided = 0;
  let correct = 0;
  let abstained = 0;
  const confusion = new Map<string, ConfusionPair>();

  // Merchant holdout removes a whole merchant at once; the model for it is
  // shared by all of that merchant's rows, so compute it once per merchant.
  const merchantModels = new Map<string, ClassifierModel>();

  cleared.forEach((example, index) => {
    let classifier: ClassifierModel;
    let merchantDefault: MerchantDefault | null;
    const lockedDefault =
      example.merchantKey === null ? undefined : locked.get(example.merchantKey);

    if (holdout === 'merchant' && example.merchantKey !== null) {
      const key = example.merchantKey;
      let model = merchantModels.get(key);
      if (model === undefined) {
        const indices = byMerchant.get(key) ?? [];
        model = withoutExamples(
          full,
          indices.map((at) => training[at] as TrainingExample),
        );
        merchantModels.set(key, model);
      }
      classifier = model;
      merchantDefault = lockedDefault ?? null;
    } else {
      classifier = withoutExamples(full, [training[index] as TrainingExample]);
      merchantDefault =
        lockedDefault ??
        (example.merchantKey === null
          ? null
          : learnedDefault(merchantCounts.get(example.merchantKey), example));
    }
    if (classifier.totalExamples === 0) classifier = COLD_MODEL;

    const context = {
      rules: options.rules,
      merchantDefault,
      classifier,
      confidenceFloor,
      merchantSupportThreshold,
    };

    // --- the waterfall ----------------------------------------------------
    const decision = decide(example.input, context);
    options.onDecision?.(index, decision);
    for (const outcome of decision.chain) {
      if (!isGraded(outcome.source)) continue;
      const tally = waterfall[outcome.source];
      tally.reached += 1;
      if (outcome.won) {
        tally.decided += 1;
        if (decision.categoryKey === example.expectedKey) tally.correct += 1;
      }
    }
    if (decision.source === 'none' || decision.categoryKey === UNCATEGORISED_KEY) {
      abstained += 1;
    } else {
      decided += 1;
      if (decision.categoryKey === example.expectedKey) correct += 1;
      else {
        const pairKey = `${example.expectedKey}\u0000${decision.categoryKey}`;
        const existing = confusion.get(pairKey);
        confusion.set(pairKey, {
          expected: example.expectedKey,
          got: decision.categoryKey,
          count: (existing?.count ?? 0) + 1,
        });
      }
    }

    // --- each tier alone --------------------------------------------------
    const withoutProvider = { ...example.input, providerCategory: null };
    const empty = { ...context, rules: [], merchantDefault: null, classifier: COLD_MODEL };
    const alone: Record<Exclude<GradedTier, 'classifier'>, ReturnType<typeof decide>> = {
      rule: decide(withoutProvider, { ...empty, rules: options.rules }),
      merchant_default: decide(withoutProvider, { ...empty, merchantDefault }),
      provider: decide(example.input, empty),
    };
    for (const tier of ['rule', 'merchant_default', 'provider'] as const) {
      const result = alone[tier];
      isolated[tier].reached += 1;
      if (result.source === tier) {
        isolated[tier].decided += 1;
        if (result.categoryKey === example.expectedKey) isolated[tier].correct += 1;
      }
    }
    const prediction = predict(classifier, classifierFeaturesOf(example.input), confidenceFloor);
    isolated.classifier.reached += 1;
    if (prediction.kind === 'predicted') {
      isolated.classifier.decided += 1;
      if (prediction.categoryKey === example.expectedKey) isolated.classifier.correct += 1;
    }
  });

  const total = cleared.length;
  const waterfallFigures = {} as Record<GradedTier, WaterfallTierFigures>;
  const isolatedFigures = {} as Record<GradedTier, IsolatedTierFigures>;
  for (const tier of GRADED_TIERS) {
    const w = waterfall[tier];
    waterfallFigures[tier] = {
      reached: w.reached,
      decided: w.decided,
      correct: w.correct,
      precision: ratio(w.correct, w.decided),
      recall: share(w.correct, total),
      abstainRate: ratio(w.reached - w.decided, w.reached),
    };
    const i = isolated[tier];
    isolatedFigures[tier] = {
      decided: i.decided,
      correct: i.correct,
      precision: ratio(i.correct, i.decided),
      recall: share(i.correct, total),
      abstainRate: ratio(i.reached - i.decided, i.reached),
    };
  }

  return {
    schema: EVAL_SCHEMA,
    holdout,
    confidenceFloor,
    merchantSupportThreshold,
    total,
    overall: {
      decided,
      correct,
      abstained,
      precision: ratio(correct, decided),
      recall: share(correct, total),
      abstainRate: ratio(abstained, total),
    },
    waterfall: waterfallFigures,
    isolated: isolatedFigures,
    confusion: [...confusion.values()]
      .sort(
        (a, b) =>
          b.count - a.count || a.expected.localeCompare(b.expected) || a.got.localeCompare(b.got),
      )
      .slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// The text table
// ---------------------------------------------------------------------------

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)} %`;
}

/**
 * The human half of the output. Fixed columns, no colour, no locale: the same
 * report prints the same bytes, so a diff of two runs is a diff of two results.
 */
export function formatReplayReport(report: ReplayReport): string {
  const lines: string[] = [];
  lines.push(
    `holdout: ${report.holdout}   examples: ${String(report.total)}   ` +
      `floor: ${String(report.confidenceFloor)}   merchant support: ${String(report.merchantSupportThreshold)}`,
  );
  const header = `${'tier'.padEnd(18)}${'reached'.padStart(9)}${'decided'.padStart(9)}${'correct'.padStart(9)}${'precision'.padStart(11)}${'recall'.padStart(10)}${'abstain'.padStart(10)}`;
  lines.push('', 'waterfall (the engine as it runs)', header);
  for (const tier of GRADED_TIERS) {
    const row = report.waterfall[tier];
    lines.push(
      `${tier.padEnd(18)}${String(row.reached).padStart(9)}${String(row.decided).padStart(9)}${String(row.correct).padStart(9)}${percent(row.precision).padStart(11)}${percent(row.recall).padStart(10)}${percent(row.abstainRate).padStart(10)}`,
    );
  }
  const o = report.overall;
  lines.push(
    `${'overall'.padEnd(18)}${String(report.total).padStart(9)}${String(o.decided).padStart(9)}${String(o.correct).padStart(9)}${percent(o.precision).padStart(11)}${percent(o.recall).padStart(10)}${percent(o.abstainRate).padStart(10)}`,
  );
  lines.push('', 'isolated (each tier alone, on every example)', header);
  for (const tier of GRADED_TIERS) {
    const row = report.isolated[tier];
    lines.push(
      `${tier.padEnd(18)}${String(report.total).padStart(9)}${String(row.decided).padStart(9)}${String(row.correct).padStart(9)}${percent(row.precision).padStart(11)}${percent(row.recall).padStart(10)}${percent(row.abstainRate).padStart(10)}`,
    );
  }
  lines.push('', 'confusion (expected -> got, waterfall, top 10)');
  if (report.confusion.length === 0) lines.push('  none');
  for (const pair of report.confusion) {
    lines.push(`  ${String(pair.count).padStart(5)}  ${pair.expected} -> ${pair.got}`);
  }
  return lines.join('\n');
}
