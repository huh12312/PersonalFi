// SPDX-License-Identifier: MIT
/**
 * The gold-set replay, on a fixture small enough to grade by hand.
 *
 * Eight confirmations, each placed so exactly one tier should decide it (or
 * none), so every figure below is arithmetic a reader can redo on paper:
 *
 *   ex1  BLUE BOTTLE  → dining.coffee            rule "BLUE → coffee": right
 *   ex2  BLUE APRON   → groceries.supermarkets   rule "BLUE → coffee": wrong
 *   ex3–6 SAFEWAY ×4  → groceries.supermarkets   merchant default (3 others agree)
 *   ex7  MYSTERY AIR  → travel.flights           provider (TRAVEL_FLIGHTS)
 *   ex8  ODDITY       → shopping.other_shopping  nothing knows it: every tier abstains
 */
import { DateOnly } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { train } from '../classifier.ts';
import type { DecisionInput } from '../engine.ts';
import type { Rule } from '../rules/schema.ts';
import {
  EVAL_SCHEMA,
  formatReplayReport,
  replayGoldSet,
  withoutExamples,
  type GoldExample,
} from './replay.ts';

let counter = 0;
function example(
  payee: string,
  expectedKey: string,
  merchantKey: string,
  overrides: Partial<DecisionInput> = {},
): GoldExample {
  counter += 1;
  return {
    input: {
      transactionId: `00000000-0000-7000-8000-${String(counter).padStart(12, '0')}`,
      payee,
      cleanedPayee: payee,
      amountMinor: -2_500n,
      currency: 'USD',
      accountId: '00000000-0000-7000-8000-00000000b001',
      accountType: 'credit',
      date: DateOnly.parse('2026-05-12'),
      providerCategory: null,
      mcc: null,
      isTransfer: false,
      // Set on purpose: the replay must clear it, or tier 1 would grade itself.
      userCategoryId: '00000000-0000-7000-8000-0000000000ff',
      ...overrides,
    },
    expectedKey,
    merchantKey,
  };
}

const BLUE_RULE: Rule = {
  id: '00000000-0000-7000-8000-00000000c001',
  userId: '00000000-0000-7000-8000-00000000e001',
  name: 'BLUE is coffee',
  priority: 100,
  enabled: true,
  conditions: { all: [{ type: 'payee', match: 'contains', value: 'BLUE' }], any: [] },
  actions: [{ type: 'set_category', categoryKey: 'dining.coffee' }],
  runOnSync: true,
  stopProcessing: false,
  createdFromTransactionId: null,
};

const FIXTURE: readonly GoldExample[] = [
  example('BLUE BOTTLE', 'dining.coffee', 'm-bluebottle'),
  example('BLUE APRON', 'groceries.supermarkets', 'm-blueapron'),
  example('SAFEWAY', 'groceries.supermarkets', 'm-safeway'),
  example('SAFEWAY', 'groceries.supermarkets', 'm-safeway'),
  example('SAFEWAY', 'groceries.supermarkets', 'm-safeway'),
  example('SAFEWAY', 'groceries.supermarkets', 'm-safeway'),
  example('MYSTERY AIR', 'travel.flights', 'm-mystery', {
    providerCategory: { primary: 'TRAVEL', detailed: 'TRAVEL_FLIGHTS', confidence_level: 'HIGH' },
  }),
  example('ODDITY', 'shopping.other_shopping', 'm-oddity'),
];

describe('the replay, leave one transaction out', () => {
  const report = replayGoldSet(FIXTURE, { rules: [BLUE_RULE], holdout: 'transaction' });

  it('grades the waterfall exactly as the hand count says', () => {
    expect(report.schema).toBe(EVAL_SCHEMA);
    expect(report.total).toBe(8);
    expect(report.overall).toEqual({
      decided: 7,
      correct: 6,
      abstained: 1,
      precision: 0.8571,
      recall: 0.75,
      abstainRate: 0.125,
    });
    expect(report.waterfall.rule).toEqual({
      reached: 8,
      decided: 2,
      correct: 1,
      precision: 0.5,
      recall: 0.125,
      abstainRate: 0.75,
    });
    expect(report.waterfall.merchant_default).toEqual({
      reached: 6,
      decided: 4,
      correct: 4,
      precision: 1,
      recall: 0.5,
      abstainRate: 0.3333,
    });
    expect(report.waterfall.provider).toEqual({
      reached: 2,
      decided: 1,
      correct: 1,
      precision: 1,
      recall: 0.125,
      abstainRate: 0.5,
    });
    // ODDITY: no word of it was ever confirmed, so the classifier abstains
    // rather than guessing from the amount and the account alone.
    expect(report.waterfall.classifier).toEqual({
      reached: 1,
      decided: 0,
      correct: 0,
      precision: null,
      recall: 0,
      abstainRate: 1,
    });
  });

  it('lists the wrong answers as confusion pairs', () => {
    expect(report.confusion).toEqual([
      { expected: 'groceries.supermarkets', got: 'dining.coffee', count: 1 },
    ]);
  });

  it('measures each tier alone on every row', () => {
    expect(report.isolated.rule).toMatchObject({ decided: 2, correct: 1, precision: 0.5 });
    expect(report.isolated.provider).toMatchObject({ decided: 1, correct: 1, recall: 0.125 });
    expect(report.isolated.merchant_default).toMatchObject({ decided: 4, correct: 4 });
  });

  it('is deterministic and prints a stable table', () => {
    const again = replayGoldSet(FIXTURE, { rules: [BLUE_RULE], holdout: 'transaction' });
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
    const table = formatReplayReport(report);
    expect(table).toContain('waterfall (the engine as it runs)');
    expect(table).toContain('overall');
    expect(table).toContain('groceries.supermarkets -> dining.coffee');
    expect(formatReplayReport(again)).toBe(table);
  });

  it('does not touch its input', () => {
    expect(FIXTURE[0]?.input.userCategoryId).toBe('00000000-0000-7000-8000-0000000000ff');
  });
});

describe('the replay, leave one merchant out', () => {
  const report = replayGoldSet(FIXTURE, { rules: [BLUE_RULE], holdout: 'merchant' });

  it('takes away what the merchant taught, so only rules and the provider speak', () => {
    // SAFEWAY ×4 lose their merchant default and their payee evidence together.
    expect(report.overall).toMatchObject({ decided: 3, correct: 2, abstained: 5 });
    expect(report.waterfall.merchant_default.decided).toBe(0);
  });

  it('keeps a locked default: that is an instruction, not something it learned', () => {
    const locked = replayGoldSet(FIXTURE, {
      rules: [],
      holdout: 'merchant',
      lockedMerchantDefaults: new Map([
        ['m-safeway', { categoryKey: 'groceries.supermarkets', locked: true, supportCount: 0 }],
      ]),
    });
    expect(locked.waterfall.merchant_default).toMatchObject({ decided: 4, correct: 4 });
  });
});

describe('withoutExamples', () => {
  it('equals retraining on what remains', () => {
    const feature = fc.constantFrom('t:a', 't:b', 't:c', 'b:1', 'b:2', 'd:out', 'mf:x', 'dm:mid');
    const corpus = fc.array(
      fc.record({
        features: fc.uniqueArray(feature, { minLength: 1, maxLength: 5 }),
        categoryKey: fc.constantFrom('dining.coffee', 'groceries.supermarkets', 'travel.flights'),
      }),
      { minLength: 1, maxLength: 30 },
    );
    fc.assert(
      fc.property(corpus, fc.array(fc.nat(), { maxLength: 10 }), (examples, picks) => {
        const removeAt = new Set(picks.map((pick) => pick % examples.length));
        const removed = examples.filter((_, index) => removeAt.has(index));
        const remaining = examples.filter((_, index) => !removeAt.has(index));
        const subtracted = withoutExamples(train(examples), removed);
        expect(subtracted).toEqual(train(remaining));
      }),
      { numRuns: 300 },
    );
  });
});
