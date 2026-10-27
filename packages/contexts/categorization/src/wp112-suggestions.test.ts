// SPDX-License-Identifier: MIT
/**
 * WP 11.2, pure: the residue payload is the classifier's features and nothing
 * else; the precision gate opens at exactly 85 % over 20 rows; the
 * measurement scores the model on the replay's residue only.
 */
import { DateOnly } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import type { CategorizableTransaction } from './ledger-port.ts';
import { decisionInputOf } from './service.ts';
import {
  SUGGESTION_GATE,
  gateOf,
  measurementResidue,
  merchantKeyOf,
  residueFeaturesOf,
  scoreMeasurement,
  type SuggestionEval,
} from './suggestions.ts';
import type { GoldExample } from './eval/replay.ts';

const ACCOUNT_ID = '00000000-0000-7000-8000-b00000000777';
const TRANSACTION_ID = '00000000-0000-7000-8000-a00000000777';

function transaction(overrides: Partial<CategorizableTransaction> = {}): CategorizableTransaction {
  return {
    id: TRANSACTION_ID,
    accountId: ACCOUNT_ID,
    accountType: 'credit',
    payee: 'SQ *BLUE BOTTLE COFFEE',
    // A store number the normaliser drops; the descriptor's words are the payee tokens.
    rawDescriptor: 'SQ *BLUE BOTTLE COFFEE #4471 OAKLAND CA',
    providerMerchantName: 'Blue Bottle Coffee',
    merchantId: '00000000-0000-7000-8000-c00000000777',
    amountMinor: -1_250n,
    currency: 'USD',
    date: DateOnly.parse('2026-05-24'),
    providerCategory: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
    mcc: '5814',
    isTransfer: false,
    userCategoryId: null,
    ...overrides,
  };
}

describe('the residue payload (scope minimisation)', () => {
  it('is exactly the classifier features, and a snapshot of it holds no memo, no account or transaction id and no raw descriptor', () => {
    // The holder's note is not on the port at all; a row that somehow carried
    // one (an adapter widened carelessly) must still not leak it.
    const withNote = {
      ...transaction(),
      note: 'MEMO-SECRET-PHRASE',
      memo: 'MEMO-SECRET-PHRASE',
    } as CategorizableTransaction;
    const features = residueFeaturesOf(decisionInputOf(withNote));
    expect(Object.keys(features).sort()).toEqual([
      'account_kind',
      'amount_bucket',
      'day_bucket',
      'direction',
      'mcc_family',
      'payee_tokens',
      'pfc_primary',
    ]);
    const text = JSON.stringify(features);
    expect(text.toLowerCase()).not.toContain('memo');
    expect(text.toLowerCase()).not.toContain('secret');
    expect(text).not.toContain(ACCOUNT_ID);
    expect(text).not.toContain(TRANSACTION_ID);
    expect(text).not.toContain('SQ *BLUE BOTTLE COFFEE #4471');
    expect(text).not.toContain('Blue Bottle Coffee');
    expect(text).not.toContain('1250');
    expect(text).not.toContain('2026-05-24');
    expect(features).toMatchInlineSnapshot(`
      {
        "account_kind": "credit",
        "amount_bucket": "2",
        "day_bucket": "late",
        "direction": "out",
        "mcc_family": "dining",
        "payee_tokens": [
          "blue",
          "bottle",
          "coffee",
        ],
        "pfc_primary": "food_and_drink",
      }
    `);
  });

  it('keys the merchant cache on the payee tokens the model is shown, and has no key without tokens', () => {
    const features = residueFeaturesOf(decisionInputOf(transaction()));
    expect(merchantKeyOf(features)).toBe(features.payee_tokens.join(' '));
    expect(
      merchantKeyOf({ ...features, payee_tokens: [] }),
      'a row with no payee words is never sent',
    ).toBeNull();
  });
});

function evalOf(scored: number, correct: number, status: 'completed' | 'failed' = 'completed') {
  return {
    id: 'e',
    modelChoice: 'narrator',
    model: 'm',
    modelDigest: null,
    status,
    failure: null,
    goldTotal: 100,
    residue: scored,
    asked: scored,
    scored,
    correct,
    abstained: 0,
    refused: 0,
    precision: scored === 0 ? null : correct / scored,
    coverage: 1,
    confusions: [],
    batchDigests: [],
    durationMs: 1,
    measuredAt: new Date(0),
  } satisfies SuggestionEval;
}

describe('the precision gate (11 §6 item 4)', () => {
  it('is pinned at 85 % over at least 20 scored rows', () => {
    expect(SUGGESTION_GATE).toEqual({ minPrecision: 0.85, minScored: 20 });
  });

  it('opens at exactly 85 % and stays shut at 84 %', () => {
    expect(gateOf(evalOf(20, 17))).toEqual({ open: true });
    expect(gateOf(evalOf(100, 85))).toEqual({ open: true });
    expect(gateOf(evalOf(100, 84))).toEqual({ open: false, reason: 'below_precision' });
    expect(gateOf(evalOf(20, 16))).toEqual({ open: false, reason: 'below_precision' });
  });

  it('stays shut below twenty scored rows however precise, with no measurement, and on a failed one', () => {
    expect(gateOf(evalOf(19, 19))).toEqual({ open: false, reason: 'too_few_rows' });
    expect(gateOf(null)).toEqual({ open: false, reason: 'not_measured' });
    expect(gateOf(evalOf(40, 40, 'failed'))).toEqual({ open: false, reason: 'measurement_failed' });
  });
});

describe('the measurement: the model as a seventh tier on the residue only', () => {
  const gold = (key: string, payee: string, id: string, merchantId: string): GoldExample => ({
    input: decisionInputOf(
      transaction({
        id,
        payee,
        rawDescriptor: payee,
        merchantId,
        providerCategory: null,
        mcc: null,
      }),
    ),
    expectedKey: key,
    merchantKey: merchantId,
  });

  it('asks only about rows every tier abstains on, and scores every row of a merchant against its pick', () => {
    const examples = [
      gold('food.groceries', 'FRESH MARKET', '00000000-0000-7000-8000-a00000000001', 'm1'),
      gold('food.groceries', 'FRESH MARKET', '00000000-0000-7000-8000-a00000000002', 'm1'),
      gold('shopping.pets', 'PAWS DEPOT', '00000000-0000-7000-8000-a00000000003', 'm2'),
    ];
    const residue = measurementResidue(examples, { rules: [] });
    // A cold classifier with every merchant held out: everything is residue.
    expect(residue.rows).toHaveLength(3);
    expect(residue.merchants.map((merchant) => merchant.merchantKey)).toEqual(
      ['fresh market', 'depot paws'].sort(),
    );
    const figures = scoreMeasurement(
      residue,
      new Map([
        ['fresh market', { verdict: 'suggested', categoryKey: 'food.groceries' }],
        ['depot paws', { verdict: 'suggested', categoryKey: 'food.groceries' }],
      ]),
    );
    expect(figures).toMatchObject({
      goldTotal: 3,
      residue: 3,
      asked: 3,
      scored: 3,
      correct: 2,
      precision: 0.6667,
      coverage: 1,
      confusions: [{ expected: 'shopping.pets', got: 'food.groceries', count: 1 }],
    });
  });

  it('counts abstentions and refusals as asked and never as scored', () => {
    const examples = [
      gold('food.groceries', 'FRESH MARKET', '00000000-0000-7000-8000-a00000000011', 'm1'),
      gold('shopping.pets', 'PAWS DEPOT', '00000000-0000-7000-8000-a00000000012', 'm2'),
    ];
    const residue = measurementResidue(examples, { rules: [] });
    const figures = scoreMeasurement(
      residue,
      new Map([
        ['fresh market', { verdict: 'abstained', categoryKey: null }],
        ['depot paws', { verdict: 'refused', categoryKey: null }],
      ]),
    );
    expect(figures).toMatchObject({
      asked: 2,
      scored: 0,
      abstained: 1,
      refused: 1,
      precision: null,
    });
  });
});
