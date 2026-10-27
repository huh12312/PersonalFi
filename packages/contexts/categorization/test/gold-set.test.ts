// SPDX-License-Identifier: MIT
/**
 * WP 11.1 — the gold-set replay on the demo seed, as a CI regression, and the
 * calibration it re-derived, re-derived again on every run.
 *
 * ## The snapshot
 *
 * `replayGoldSet` over the demo seed's labelled set (`goldExamplesOf`, every
 * labelled row standing in for a confirmation) in three variants — bare (no
 * provider category, no MCC: the residue's case), with the synthetic PFC codes,
 * and with PFC plus synthetic MCCs — under both holdouts. The figures are fixed
 * below with a tolerance of `TOLERANCE`. A **drop** beyond it fails: that is the
 * regression this file exists for. A **rise** beyond it fails too, with a
 * message saying to raise the snapshot — a ratchet that is never tightened stops
 * guarding the level the engine has reached, and the next regression would hide
 * inside the slack. Precision is `null` where a tier decided nothing, and must
 * stay `null`.
 *
 * Needs no database (unit project).
 */
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_ONLY_CEILING,
  DEFAULT_CONFIDENCE_FLOOR,
  PAYEE_MARGIN_SCALE,
  classifierFeaturesOf,
  predict,
  replayGoldSet,
  train,
  withoutExamples,
  type Holdout,
  type ReplayReport,
} from '../src/index.ts';
import { buildGoldenDataset, goldExamplesOf, sampleRules } from './golden-harness.ts';

const USER_ID = '00000000-0000-7000-8000-00000000f001';

/** One percentage point. */
const TOLERANCE = 0.01;

const VARIANTS = {
  bare: {},
  pfc: { withProviderCategory: true },
  'pfc+mcc': { withProviderCategory: true, withMcc: true },
} as const;
type Variant = keyof typeof VARIANTS;

interface Figures {
  readonly precision: number | null;
  readonly recall: number;
  readonly abstainRate: number | null;
}

/** The figures as of WP 11.1 (docs/evidence/phase-11/wp11.1-classifier-and-gold-set.md §1). */
const SNAPSHOT: Readonly<
  Record<`${Variant}/${Holdout}`, { overall: Figures; classifier: Figures }>
> = {
  'bare/transaction': {
    overall: { precision: 0.9989, recall: 0.9966, abstainRate: 0.0023 },
    classifier: { precision: 0.9987, recall: 0.9048, abstainRate: 0.0941 },
  },
  'bare/merchant': {
    overall: { precision: 0.8996, recall: 0.254, abstainRate: 0.7177 },
    classifier: { precision: 0.8756, recall: 0.1995, abstainRate: 0.7721 },
  },
  'pfc/transaction': {
    overall: { precision: 0.9966, recall: 0.9966, abstainRate: 0 },
    classifier: { precision: 0.9988, recall: 0.9161, abstainRate: 0.0828 },
  },
  'pfc/merchant': {
    overall: { precision: 0.9694, recall: 0.9694, abstainRate: 0 },
    classifier: { precision: 0.8757, recall: 0.1757, abstainRate: 0.7993 },
  },
  'pfc+mcc/transaction': {
    overall: { precision: 0.9966, recall: 0.9966, abstainRate: 0 },
    classifier: { precision: 1, recall: 0.9671, abstainRate: 0.0329 },
  },
  'pfc+mcc/merchant': {
    overall: { precision: 0.9694, recall: 0.9694, abstainRate: 0 },
    classifier: { precision: 1, recall: 0.1984, abstainRate: 0.8016 },
  },
};

const reports = new Map<string, ReplayReport>();
for (const [variant, options] of Object.entries(VARIANTS)) {
  const examples = goldExamplesOf(buildGoldenDataset({ seed: 1, ...options }));
  for (const holdout of ['transaction', 'merchant'] as const) {
    reports.set(
      `${variant}/${holdout}`,
      replayGoldSet(examples, { rules: sampleRules(USER_ID), holdout }),
    );
  }
}

function compare(label: string, actual: number | null, fixed: number | null): void {
  if (fixed === null || actual === null) {
    expect(actual, `${label}: precision must stay null (decided nothing)`).toBe(fixed);
    return;
  }
  const delta = actual - fixed;
  expect(
    delta,
    `${label} fell from ${String(fixed)} to ${String(actual)} — beyond the ${String(TOLERANCE)} tolerance`,
  ).toBeGreaterThanOrEqual(-TOLERANCE);
  expect(
    delta,
    `${label} rose from ${String(fixed)} to ${String(actual)} — raise the snapshot in gold-set.test.ts`,
  ).toBeLessThanOrEqual(TOLERANCE);
}

describe('the demo seed’s gold set, replayed (regression snapshot)', () => {
  for (const [key, fixed] of Object.entries(SNAPSHOT)) {
    it(`${key}: overall and the classifier alone stay within ${String(TOLERANCE)}`, () => {
      const report = reports.get(key);
      if (report === undefined) throw new Error(`no report for ${key}`);
      for (const field of ['precision', 'recall', 'abstainRate'] as const) {
        compare(`${key} overall ${field}`, report.overall[field], fixed.overall[field]);
        compare(
          `${key} classifier ${field}`,
          report.isolated.classifier[field],
          fixed.classifier[field],
        );
      }
    });
  }

  it('holds the tolerance at one percentage point (loosening it is a reviewed change)', () => {
    expect(TOLERANCE).toBe(0.01);
  });

  it('reports a stable JSON shape (11.2 parses it)', () => {
    const report = reports.get('pfc/merchant') as ReplayReport;
    expect(Object.keys(report)).toEqual([
      'schema',
      'holdout',
      'confidenceFloor',
      'merchantSupportThreshold',
      'total',
      'overall',
      'waterfall',
      'isolated',
      'confusion',
    ]);
    expect(Object.keys(report.waterfall)).toEqual([
      'rule',
      'merchant_default',
      'provider',
      'classifier',
    ]);
    expect(report.confusion.length).toBeLessThanOrEqual(10);
    expect(report.total).toBe(882);
  });
});

// ---------------------------------------------------------------------------
// The calibration, re-derived
// ---------------------------------------------------------------------------

/**
 * Every prediction the classifier would make with no floor at all, under both
 * holdouts and all three variants, split by whether a payee word backed it.
 */
function predictionsWithoutAFloor(): {
  payee: [number, boolean][];
  context: [number, boolean][];
} {
  const payee: [number, boolean][] = [];
  const context: [number, boolean][] = [];
  for (const options of Object.values(VARIANTS)) {
    const examples = goldExamplesOf(buildGoldenDataset({ seed: 1, ...options }));
    const corpus = examples.map((entry) => ({
      features: classifierFeaturesOf({ ...entry.input, userCategoryId: null }),
      categoryKey: entry.expectedKey,
    }));
    const full = train(corpus);
    for (const holdout of ['transaction', 'merchant'] as const) {
      examples.forEach((entry, index) => {
        const removed =
          holdout === 'merchant'
            ? corpus.filter((_, at) => examples[at]?.merchantKey === entry.merchantKey)
            : [corpus[index] as (typeof corpus)[number]];
        const outcome = predict(
          withoutExamples(full, removed),
          (corpus[index] as (typeof corpus)[number]).features,
          0,
        );
        if (outcome.kind !== 'predicted') return;
        const point: [number, boolean] = [
          outcome.margin,
          outcome.categoryKey === entry.expectedKey,
        ];
        (outcome.payeeEvidence ? payee : context).push(point);
      });
    }
  }
  return { payee, context };
}

/** The maximum-likelihood slope of `P(right) = logistic(k × margin)`, by grid search. */
function fitSlope(points: readonly [number, boolean][]): number {
  let best = { slope: 0, logLikelihood: Number.NEGATIVE_INFINITY };
  for (let step = 1; step <= 400; step += 1) {
    const slope = step * 0.05;
    let logLikelihood = 0;
    for (const [margin, right] of points) {
      const p = Math.min(1 - 1e-12, Math.max(1e-12, 1 / (1 + Math.exp(-slope * margin))));
      logLikelihood += right ? Math.log(p) : Math.log(1 - p);
    }
    if (logLikelihood > best.logLikelihood) best = { slope, logLikelihood };
  }
  return best.slope;
}

describe('the calibration WP 11.1 re-derived', () => {
  const { payee, context } = predictionsWithoutAFloor();

  it('ships the payee-evidenced slope the demo seed fits, within 10 %', () => {
    const fitted = fitSlope(payee);
    expect(Math.abs(PAYEE_MARGIN_SCALE - fitted) / fitted).toBeLessThanOrEqual(0.1);
  });

  it('keeps context-only answers below the floor because they are mostly wrong', () => {
    const right = context.filter(([, ok]) => ok).length / Math.max(1, context.length);
    expect(context.length).toBeGreaterThan(500);
    expect(right).toBeLessThan(CONTEXT_ONLY_CEILING);
    expect(CONTEXT_ONLY_CEILING).toBeLessThan(DEFAULT_CONFIDENCE_FLOOR);
  });

  it('is right at least as often as the floor promises, on merchants it has never seen', () => {
    for (const variant of Object.keys(VARIANTS)) {
      const classifier = (reports.get(`${variant}/merchant`) as ReplayReport).isolated.classifier;
      if (classifier.precision === null) continue;
      expect(classifier.precision, `${variant} cold-merchant precision`).toBeGreaterThanOrEqual(
        DEFAULT_CONFIDENCE_FLOOR,
      );
    }
  });
});
