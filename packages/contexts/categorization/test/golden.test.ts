// SPDX-License-Identifier: MIT
/**
 * The accuracy gate.
 *
 * Phase 1's exit criterion is "≥85% auto-categorization on seeded data" (master
 * plan §5, rung v0.3). This suite is where that number comes from, and it asserts
 * the threshold rather than printing it — a metric nobody fails on is a metric
 * that drifts.
 *
 * Four configurations, because one number hides which tier earned it. The one
 * that matters for the gate is `full`; the other three exist so that a regression
 * can be attributed. A drop in `full` with `classifier-only` unchanged is a
 * plumbing bug; a drop in both is a normalisation bug.
 *
 * Needs no database.
 */
import { describe, expect, it } from 'vitest';
import {
  buildGoldenDataset,
  evaluate,
  sampleRules,
  GROUND_TRUTH,
  SYNTHETIC_PFC,
  evaluateColdMerchants,
  type EvaluationResult,
} from './golden-harness.ts';
import { isAssignableKey } from '../src/taxonomy.ts';

const USER_ID = '00000000-0000-7000-8000-00000000f001';

const dataset = buildGoldenDataset({ seed: 1, withProviderCategory: true });

const CONFIGS = [
  { name: 'classifier-only', useClassifier: true },
  { name: 'provider-only', useProvider: true },
  { name: 'rules-off-provider-off', useClassifier: true, useMerchantDefaults: true },
  {
    name: 'full',
    rules: sampleRules(USER_ID),
    useClassifier: true,
    useMerchantDefaults: true,
    useProvider: true,
  },
] as const;

const results = new Map<string, EvaluationResult>(
  CONFIGS.map((config) => [config.name, evaluate(dataset, config)]),
);

describe('the golden set', () => {
  it('labels every merchant in the seed catalogue', () => {
    // If `@core/seed` grows a merchant and nobody labels it, the graded set
    // silently shrinks and every rate below is computed over a different
    // denominator. This is the tripwire for that.
    expect(dataset.merchantCount).toBe(GROUND_TRUTH.size);
  });

  it('has a label for every synthetic provider code and vice versa', () => {
    expect([...SYNTHETIC_PFC.keys()].sort()).toEqual([...GROUND_TRUTH.keys()].sort());
  });

  it('only ever expects a leaf category', () => {
    for (const key of GROUND_TRUTH.values()) expect(isAssignableKey(key)).toBe(true);
  });

  it('splits a usable amount of history each side', () => {
    expect(dataset.train.length).toBeGreaterThan(200);
    expect(dataset.test.length).toBeGreaterThan(100);
  });
});

describe('accuracy', () => {
  it('reports every configuration', () => {
    // Printed, not just asserted: the evidence document quotes these numbers and
    // they have to be reproducible from a test run rather than from a spreadsheet
    // somebody kept.
    const table = CONFIGS.map((config) => {
      const result = results.get(config.name) as EvaluationResult;
      return {
        config: result.config,
        n: result.total,
        correct: result.correct,
        precision: result.precision.toFixed(4),
        recall: result.recall.toFixed(4),
        abstain: result.abstainRate.toFixed(4),
      };
    });
    console.table(table);
    expect(table).toHaveLength(CONFIGS.length);
  });

  it('reports the cold-merchant case, which is the honest hard one', () => {
    const cold = [
      evaluateColdMerchants(dataset, { name: 'provider-only', useProvider: true }),
      evaluateColdMerchants(dataset, {
        name: 'full',
        rules: sampleRules(USER_ID),
        useClassifier: true,
        useMerchantDefaults: true,
        useProvider: true,
      }),
    ].map((result) => ({
      config: result.config,
      n: result.total,
      correct: result.correct,
      precision: result.precision.toFixed(4),
      recall: result.recall.toFixed(4),
      abstain: result.abstainRate.toFixed(4),
    }));
    console.table(cold);
    expect(cold).toHaveLength(2);
  });

  it('meets the Phase 1 gate of >= 85% with the full stack', () => {
    const full = results.get('full') as EvaluationResult;
    expect(full.recall).toBeGreaterThanOrEqual(0.85);
  });

  it('is at least as precise as it is complete, with the full stack', () => {
    // Precision above recall is the shape we want: 07 §2.12's operating-point
    // rule is "precision weighted far above recall", and a categoriser that
    // abstains rather than guessing wrong is the one a user keeps trusting.
    const full = results.get('full') as EvaluationResult;
    expect(full.precision).toBeGreaterThanOrEqual(full.recall);
  });

  it('does better with the full stack than with any single tier', () => {
    const full = results.get('full') as EvaluationResult;
    for (const name of ['classifier-only', 'provider-only']) {
      expect(full.recall).toBeGreaterThan((results.get(name) as EvaluationResult).recall);
    }
  });

  it('abstains rather than guessing when it has nothing to go on', () => {
    // A cold model with no rules, no merchant memory and no provider data must
    // categorise *nothing*. This is the sabotage check on the whole waterfall:
    // if this number is not 1.0, some tier is inventing an answer.
    const cold = evaluate(dataset, { name: 'cold' });
    expect(cold.abstainRate).toBe(1);
    expect(cold.decided).toBe(0);
  });

  it('never returns a category that is not a leaf', () => {
    for (const result of results.values()) {
      for (const error of result.topErrors) expect(isAssignableKey(error.got)).toBe(true);
    }
  });
});

describe('per-tier behaviour', () => {
  it('lets a rule beat the merchant default and the provider', () => {
    const full = results.get('full') as EvaluationResult;
    // The four sample rules cover Amazon, Philz, iCloud and large Costco runs,
    // all of which also have a learned default and a provider code. If the rule
    // tier were not first, none of these would be attributed to it.
    expect(full.bySource['rule']?.decided ?? 0).toBeGreaterThan(0);
  });

  it('gets the cases the provider tier is structurally unable to get', () => {
    // `SYNTHETIC_PFC` deliberately sends a coarser code than the truth for Philz
    // (restaurant, not coffee) and for iCloud/Adobe (electronics, not software).
    // The provider-only configuration must therefore be visibly wrong on them,
    // and the full stack must fix them — which is the entire argument for having
    // tiers above the provider at all.
    const providerOnly = results.get('provider-only') as EvaluationResult;
    const full = results.get('full') as EvaluationResult;
    expect(providerOnly.incorrect).toBeGreaterThan(0);
    expect(full.incorrect).toBeLessThan(providerOnly.incorrect);
  });
});
