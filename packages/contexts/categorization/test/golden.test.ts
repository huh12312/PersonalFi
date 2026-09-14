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

/**
 * The four configurations the work package asks for, plus two diagnostics.
 *
 * `merchant-memory-off` and `provider-only` are not decoration: they are the only
 * configurations here whose number means what it appears to mean. See
 * "the merchant-memory tautology" below.
 */
const CONFIGS = [
  { name: 'classifier-only', useClassifier: true },
  { name: 'provider-only', useProvider: true },
  {
    name: 'rules-off',
    useClassifier: true,
    useMerchantDefaults: true,
    useProvider: true,
  },
  {
    name: 'provider-off',
    rules: sampleRules(USER_ID),
    useClassifier: true,
    useMerchantDefaults: true,
  },
  {
    name: 'merchant-memory-off',
    rules: sampleRules(USER_ID),
    useClassifier: true,
    useProvider: true,
  },
  {
    name: 'full',
    rules: sampleRules(USER_ID),
    useClassifier: true,
    useMerchantDefaults: true,
    useProvider: true,
  },
] as const;

/**
 * Configurations whose score is *not* circular, and which therefore carry the gate.
 *
 * Every configuration with `useMerchantDefaults` is excluded, for the reason set
 * out in "the merchant-memory tautology" test below.
 */
const HONEST_CONFIGS = ['classifier-only', 'provider-only', 'merchant-memory-off'] as const;

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

  it('the merchant-memory tautology: `full` is saturated and cannot carry the gate', () => {
    // READ THIS BEFORE QUOTING THE HEADLINE NUMBER.
    //
    // `evaluate` builds each merchant default out of `entry.expectedKey` — the
    // answer key — and keys it on a fingerprint of the descriptor. Ground truth
    // in this harness is a pure function of the merchant, and the seed's
    // descriptor families converge to one fingerprint per merchant. So for any
    // merchant present in `train`, the merchant-default tier returns the label
    // *by construction*. It is a dictionary lookup of the answers, and it decides
    // roughly nine rows in ten.
    //
    // That is not a bug in the engine — in production a merchant default is
    // learned from the user's own confirmations and is *supposed* to be right.
    // It is a limit on what this dataset can prove: `full` scoring 100% is
    // evidence that the plumbing works, and evidence of nothing else.
    //
    // This test pins the tautology in place so nobody later reads 1.0000 as an
    // accuracy claim. If the harness is ever changed to stop deriving merchant
    // defaults from the labels, this test fails and the comment above comes down.
    const full = results.get('full') as EvaluationResult;
    expect(full.recall).toBe(1);

    const decidedByMerchant = full.bySource['merchant_default'];
    expect(decidedByMerchant).toBeDefined();
    // Never wrong, because it cannot be.
    expect(decidedByMerchant?.correct).toBe(decidedByMerchant?.decided);
    expect(decidedByMerchant?.decided ?? 0).toBeGreaterThan(full.total * 0.8);
  });

  it('clears the 85% gate on configurations that cannot leak the labels', () => {
    // The gate that actually means something. None of these three lets the
    // merchant-default tier see a label, so each number is earned: the
    // classifier generalising from its own training split, the PFC map, and the
    // two of them plus rules with merchant memory switched off entirely.
    for (const name of HONEST_CONFIGS) {
      const result = results.get(name) as EvaluationResult;
      expect(
        result.recall,
        `${name} recall ${result.recall.toFixed(4)} is below the 0.85 gate`,
      ).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('still clears the gate on a merchant it has never seen', () => {
    // Leave-one-merchant-out with the full stack. Merchant memory is empty for
    // the merchant being graded, so this is the honest full-stack figure and the
    // strongest evidence in this file.
    const cold = evaluateColdMerchants(dataset, {
      name: 'full',
      rules: sampleRules(USER_ID),
      useClassifier: true,
      useMerchantDefaults: true,
      useProvider: true,
    });
    expect(cold.recall).toBeGreaterThanOrEqual(0.85);
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
