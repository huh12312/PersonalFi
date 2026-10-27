// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

import type { MockApiState } from './mock-api.ts';

/**
 * WP 11.2b's network layer: transactions an automatic tier placed, and the stored explanation behind each chip.
 *
 * - `seedAutoCategorised(api)` adds, to the general fixture (`mock-api.ts`, through `MockApiState.addTransaction`),
 *   three rows with `categorySource: 'auto'` (tier 4 "Plaid", tier 3 "Learned", tier 5 "Classifier 92 %"), one the
 *   holder picked and one a rule set (neither wears a chip). The two uncategorised rows the general fixture already
 *   has stay the Inbox's queue.
 * - `installAutoCategoryMocks(page)` is layered **on top of** `installApiMocks` / `installSweepMocks` (registered
 *   after them, so it runs first and `route.fallback()`s the rest): `GET /transactions/explanations`, answering the
 *   auto rows with an `assigned` explanation read from "storage" (the line, the winning tier's stored figures) and
 *   every other id `not_recorded`. It records the id batches it was asked for, so a test can assert the reveal reads
 *   the stored explanation and the list reads none.
 */

export const AUTO_PLAID = { id: 'txn_auto_plaid', name: "Trader Joe's", tier: 'provider' } as const;
export const AUTO_LEARNED = {
  id: 'txn_auto_learned',
  name: 'Philz Coffee',
  tier: 'merchant_default',
} as const;
export const AUTO_CLASSIFIER = {
  id: 'txn_auto_classifier',
  name: "Joe's Diner",
  tier: 'classifier',
} as const;
export const PICKED = { id: 'txn_picked', name: 'Corner Bakery' } as const;
export const RULED = { id: 'txn_ruled', name: 'Netflix' } as const;

export const CATEGORY_COFFEE = 'cat_dining_coffee';
export const CATEGORY_RESTAURANTS = 'cat_dining_restaurants';

export const PLAID_LINE =
  'Filed from your bank’s category: Your bank’s data service classified this as FOOD_AND_DRINK_GROCERIES.';
export const LEARNED_LINE =
  'Filed from this merchant’s history: 4 earlier transactions with this merchant are filed here.';
export const CLASSIFIER_LINE =
  'Filed by the classifier at 92 % (its floor is 60 %); strongest signals t:joes, t:diner.';

/**
 * The sweep's mocks put "today" at 17 March 2026 (the category detail screen's current month), so the rows are dated
 * in that month: they appear on `/transactions` (no date window) and on `/categories/:id` for March alike.
 */
const dateOf = (day: number): string => `2026-03-${String(day).padStart(2, '0')}`;

export function seedAutoCategorised(api: MockApiState): void {
  const decidedAt = new Date(Date.now() - 86_400_000).toISOString();
  const auto = (
    row: { id: string; name: string; tier: string },
    categoryId: string,
    confidence: number,
    day: number,
  ) =>
    api.addTransaction({
      id: row.id,
      accountId: 'acct_1',
      date: dateOf(day),
      amount: { minor: '-4200', currency: 'USD' },
      name: row.name,
      merchantId: `merch_${row.id}`,
      merchantName: row.name,
      categoryId,
      categorySource: 'auto',
      autoCategory: { tier: row.tier, confidence, decidedAt },
    });
  auto(AUTO_PLAID, CATEGORY_COFFEE, 0.85, 15);
  auto(AUTO_LEARNED, CATEGORY_COFFEE, 0.75, 14);
  auto(AUTO_CLASSIFIER, CATEGORY_RESTAURANTS, 0.9234, 13);
  api.addTransaction({
    id: PICKED.id,
    accountId: 'acct_1',
    date: dateOf(12),
    amount: { minor: '-900', currency: 'USD' },
    name: PICKED.name,
    merchantName: PICKED.name,
    categoryId: CATEGORY_RESTAURANTS,
    categorySource: 'user',
  });
  api.addTransaction({
    id: RULED.id,
    accountId: 'acct_1',
    date: dateOf(11),
    amount: { minor: '-1599', currency: 'USD' },
    name: RULED.name,
    merchantName: RULED.name,
    categoryId: CATEGORY_RESTAURANTS,
    categorySource: 'rule',
  });
}

function explanation(id: string) {
  const base = {
    transactionId: id,
    decidedAt: new Date(Date.now() - 86_400_000).toISOString(),
    suggestion: null,
  };
  const assigned = (
    tier: string,
    line: string,
    confidence: number,
    facts: Record<string, string | number | boolean | null> | null,
  ) => ({
    ...base,
    status: 'assigned',
    source: tier,
    categoryKey: 'dining.coffee',
    confidence,
    line,
    tiers: [
      {
        source: 'user',
        won: false,
        detail: 'You have not set a category on this one.',
        facts: null,
      },
      { source: tier, won: true, detail: line, facts },
    ],
  });
  if (id === AUTO_PLAID.id) return assigned('provider', PLAID_LINE, 0.85, null);
  if (id === AUTO_LEARNED.id) {
    return assigned('merchant_default', LEARNED_LINE, 0.75, { locked: false, support: 4 });
  }
  if (id === AUTO_CLASSIFIER.id) {
    return assigned('classifier', CLASSIFIER_LINE, 0.9234, {
      confidence: 0.9234,
      floor: 0.6,
      payeeEvidence: true,
      signals: 't:joes t:diner',
    });
  }
  return {
    ...base,
    status: 'not_recorded',
    source: null,
    categoryKey: null,
    confidence: null,
    decidedAt: null,
    line: 'No categorisation pass has recorded its working for this yet.',
    tiers: [],
  };
}

export interface AutoCategoryMocks {
  /** The `ids` of every `GET /transactions/explanations`, in order. */
  readonly explanationBatches: string[];
}

export async function installAutoCategoryMocks(page: Page): Promise<AutoCategoryMocks> {
  const state: AutoCategoryMocks = { explanationBatches: [] };
  await page.route('**/api/transactions/explanations**', async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'GET') return route.fallback();
    const ids = (new URL(request.url()).searchParams.get('ids') ?? '')
      .split(',')
      .filter((id) => id !== '');
    state.explanationBatches.push(ids.join(','));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: ids.map(explanation) }),
    });
  });
  return state;
}
