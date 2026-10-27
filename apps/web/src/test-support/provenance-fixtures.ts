// SPDX-License-Identifier: MIT
/**
 * WP 11.2b's unit-test fixtures: a transaction an automatic tier placed (the api's `categorySource: 'auto'` plus its
 * `autoCategory`), and the stored explanation behind its chip, in the api's shapes.
 */
import type { AutoCategory, CategoryExplanation, Transaction } from '../api/generated/types.gen.ts';
import { buildTransaction } from './api-test-utils.ts';

export const LEARNED_LINE =
  'Filed from this merchant’s history: 4 earlier transactions with this merchant are filed here.';
export const PLAID_LINE =
  'Filed from your bank’s category: Your bank’s data service classified this as FOOD_AND_DRINK_COFFEE.';
export const CLASSIFIER_LINE =
  'Filed by the classifier at 92 % (its floor is 60 %); strongest signals t:blue, t:bottle.';

export function autoCategory(
  tier: AutoCategory['tier'],
  confidence: number,
  overrides: Partial<AutoCategory> = {},
): AutoCategory {
  return { tier, confidence, decidedAt: '2026-10-20T08:00:00.000Z', ...overrides };
}

/** A transaction whose effective category came from an automatic tier. */
export function buildAutoTransaction(
  id: string,
  tier: AutoCategory['tier'],
  confidence: number,
  overrides: Partial<Transaction> = {},
): Transaction {
  return buildTransaction({
    id,
    categoryId: 'cat_dining_coffee',
    categorySource: 'auto',
    autoCategory: autoCategory(tier, confidence),
    ...overrides,
  });
}

/** The stored explanation of an assigned row, with the winning tier's stored figures. */
export function buildAssignedExplanation(
  transactionId: string,
  tier: AutoCategory['tier'],
  overrides: Partial<CategoryExplanation> = {},
): CategoryExplanation {
  const line =
    tier === 'merchant_default' ? LEARNED_LINE : tier === 'provider' ? PLAID_LINE : CLASSIFIER_LINE;
  return {
    transactionId,
    status: 'assigned',
    source: tier,
    categoryKey: 'dining.coffee',
    confidence: tier === 'classifier' ? 0.92 : 0.75,
    decidedAt: '2026-10-20T08:00:00.000Z',
    line,
    tiers: [
      {
        source: 'user',
        won: false,
        detail: 'You have not set a category on this one.',
        facts: null,
      },
      {
        source: tier,
        won: true,
        detail: line,
        facts: tier === 'merchant_default' ? { locked: false, support: 4 } : null,
      },
    ],
    suggestion: null,
    ...overrides,
  };
}
