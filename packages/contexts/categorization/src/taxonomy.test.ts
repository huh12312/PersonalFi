// SPDX-License-Identifier: MIT
/**
 * The taxonomy, the PFC map and the MCC table are *data*, and data gets edited
 * by hand. These are the tripwires for a hand edit that breaks an invariant the
 * engine relies on but does not check at runtime.
 */
import { CATEGORY_DEFAULT_EMOJI, defaultEmojiForKey, isSingleEmoji } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  FLAT_TAXONOMY,
  TAXONOMY,
  UNCATEGORISED_KEY,
  isAssignableKey,
  kindOf,
  taxonomyEntry,
} from './taxonomy.ts';
import {
  PFC_DETAILED_COUNT,
  PFC_DETAILED_TO_KEY,
  PFC_PRIMARY_COUNT,
  PFC_PRIMARY_TO_KEY,
  matchProviderCategory,
  readProviderCategory,
} from './pfc-map.ts';
import { MCC_CODES, MCC_CODE_COUNT, lookupMcc, mccTableIsWellFormed } from './mcc-codes.ts';

describe('the taxonomy', () => {
  it('is about twenty top-level categories', () => {
    // Master plan §5 Phase 1: "own taxonomy of ~20 top-level × 2 levels". A
    // range rather than an equality so adding one does not fail the build, but
    // doubling it does — at forty the picker stops being usable and nobody would
    // have noticed from a diff.
    expect(TAXONOMY.length).toBeGreaterThanOrEqual(18);
    expect(TAXONOMY.length).toBeLessThanOrEqual(24);
  });

  it('is exactly two levels deep', () => {
    for (const node of TAXONOMY) {
      expect(node.key).not.toContain('.');
      for (const child of node.children)
        expect(child.key).toBe(`${node.key}.${child.key.split('.')[1]}`);
    }
  });

  it('has a unique key for every node', () => {
    const keys = FLAT_TAXONOMY.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every node a label and a one-line description of its own', () => {
    const descriptions = FLAT_TAXONOMY.map((entry) => entry.description);
    for (const entry of FLAT_TAXONOMY) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(10);
      expect(entry.description.endsWith('.')).toBe(true);
    }
    // Duplicated prose is the tell-tale of a copy-paste from someone else's
    // taxonomy, which is exactly what 02 §4.4 forbids.
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('gives every top-level category an "other" escape hatch', () => {
    for (const node of TAXONOMY) {
      if (node.key === UNCATEGORISED_KEY) continue;
      const hasOther = node.children.some((child) => child.key.includes('other'));
      expect(hasOther, `${node.key} has nowhere to put an unclear transaction`).toBe(true);
    }
  });

  it('lets the engine assign a leaf but never a parent', () => {
    expect(isAssignableKey('dining.coffee')).toBe(true);
    expect(isAssignableKey('dining')).toBe(false);
    // The one exception, and it is the point: "we do not know" does not decompose.
    expect(isAssignableKey(UNCATEGORISED_KEY)).toBe(true);
  });

  it('keeps transfers and investments out of both spend and income', () => {
    expect(kindOf('transfers.credit_card_payment')).toBe('transfer');
    expect(kindOf('transfers.loan_proceeds')).toBe('transfer');
    expect(kindOf('investments.retirement')).toBe('investment');
    // The Phase 1 exit criterion in one assertion: paying a card bill is not spend.
    expect(kindOf('transfers.credit_card_payment')).not.toBe('expense');
  });

  it('gives a child the parent’s kind unless it says otherwise', () => {
    const coffee = taxonomyEntry('dining.coffee');
    expect(coffee?.kind).toBe('expense');
    expect(taxonomyEntry('dining')?.kind).toBe('expense');
  });
});

describe('the PFC v2 map', () => {
  it('covers exactly the published taxonomy: 18 primary, 127 detailed', () => {
    // Checked against plaid.com/documents/pfc-taxonomy-all.csv on 2026-09-13,
    // matching 01 §5.4's 2026-09-10 verification. If Plaid revises PFC, this
    // fails and the map is updated — which is the whole point of having a map.
    expect(PFC_PRIMARY_TO_KEY.size).toBe(PFC_PRIMARY_COUNT);
    expect(PFC_DETAILED_TO_KEY.size).toBe(PFC_DETAILED_COUNT);
    expect(PFC_PRIMARY_TO_KEY.size).toBe(18);
    expect(PFC_DETAILED_TO_KEY.size).toBe(127);
  });

  it('sends every code to a leaf the engine may assign', () => {
    for (const [code, key] of PFC_DETAILED_TO_KEY) {
      expect(isAssignableKey(key), `${code} -> ${key}`).toBe(true);
    }
    for (const [code, key] of PFC_PRIMARY_TO_KEY) {
      expect(isAssignableKey(key), `${code} -> ${key}`).toBe(true);
    }
  });

  it('gives every detailed code a primary that exists', () => {
    for (const code of PFC_DETAILED_TO_KEY.keys()) {
      const primary = [...PFC_PRIMARY_TO_KEY.keys()].find((candidate) =>
        code.startsWith(`${candidate}_`),
      );
      expect(primary, `${code} belongs to no known primary`).toBeDefined();
    }
  });

  it('files a credit-card payment as a transfer, not as spend', () => {
    // The deliberate disagreement with Plaid's filing. Counting it as spend
    // double-counts every card purchase.
    expect(PFC_DETAILED_TO_KEY.get('LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')).toBe(
      'transfers.credit_card_payment',
    );
    expect(kindOf('transfers.credit_card_payment')).toBe('transfer');
  });

  it('files loan proceeds as a transfer, not as income', () => {
    for (const code of PFC_DETAILED_TO_KEY.keys()) {
      if (!code.startsWith('LOAN_DISBURSEMENTS_')) continue;
      expect(kindOf(PFC_DETAILED_TO_KEY.get(code) as string)).toBe('transfer');
    }
  });

  it('prefers the detailed code and falls back to the primary', () => {
    const detailed = matchProviderCategory(
      readProviderCategory({
        primary: 'FOOD_AND_DRINK',
        detailed: 'FOOD_AND_DRINK_COFFEE',
        confidence_level: 'HIGH',
      }),
    );
    expect(detailed?.categoryKey).toBe('dining.coffee');
    expect(detailed?.matchedOn).toBe('detailed');

    const primaryOnly = matchProviderCategory(
      readProviderCategory({
        primary: 'FOOD_AND_DRINK',
        detailed: 'FOOD_AND_DRINK_SOMETHING_NEW',
        confidence_level: 'HIGH',
      }),
    );
    expect(primaryOnly?.matchedOn).toBe('primary');
    // Capped: "this is food and drink" is a weaker claim than "this is a coffee shop".
    expect(primaryOnly?.confidence).toBeLessThanOrEqual(0.6);
    expect(detailed?.confidence).toBeGreaterThan(primaryOnly?.confidence ?? 1);
  });

  it('returns null rather than guessing when it recognises nothing', () => {
    expect(
      matchProviderCategory(readProviderCategory({ primary: 'NOPE', detailed: 'NOPE_NOPE' })),
    ).toBeNull();
    expect(readProviderCategory(null)).toBeNull();
    expect(readProviderCategory('a string')).toBeNull();
    expect(readProviderCategory([])).toBeNull();
    expect(readProviderCategory({})).toBeNull();
  });
});

describe('the MCC table', () => {
  it('carries the whole Unlicense dataset', () => {
    expect(MCC_CODES.length).toBe(MCC_CODE_COUNT);
    expect(MCC_CODES.length).toBe(981);
  });

  it('maps every single code to a leaf — no catch-all', () => {
    // There is deliberately no fallback range in `mcc-codes.ts`: a catch-all to
    // `uncategorised` would make this assertion pass while proving nothing.
    expect(mccTableIsWellFormed()).toBe(true);
  });

  it('has no duplicate and no malformed code', () => {
    const codes = MCC_CODES.map((row) => row.mcc);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^\d{4}$/u);
  });

  it('tolerates a code whose leading zero was lost in a CSV', () => {
    expect(lookupMcc('0742')?.categoryKey).toBe('family.pet_medical');
    expect(lookupMcc('742')?.categoryKey).toBe('family.pet_medical');
    expect(lookupMcc(742)?.categoryKey).toBe('family.pet_medical');
    expect(lookupMcc(null)).toBeUndefined();
    expect(lookupMcc('nonsense')).toBeUndefined();
  });

  it('gets the codes a household actually sees right', () => {
    expect(lookupMcc('5411')?.categoryKey).toBe('groceries.supermarkets');
    expect(lookupMcc('5812')?.categoryKey).toBe('dining.restaurants');
    expect(lookupMcc('5541')?.categoryKey).toBe('transport.fuel');
    expect(lookupMcc('4121')?.categoryKey).toBe('transport.rideshare');
    expect(lookupMcc('5912')?.categoryKey).toBe('health.pharmacy');
    expect(lookupMcc('7011')?.categoryKey).toBe('travel.lodging');
    expect(lookupMcc('3000')?.categoryKey).toBe('travel.flights');
  });
});

describe('the default emoji (WP 10.14)', () => {
  // `CATEGORY_DEFAULT_EMOJI` lives in @core/kernel (the web reads the same table) and is keyed by taxonomy key, so a
  // key added to or renamed in `taxonomy.ts` without an emoji would quietly fall back to initials. A display
  // fallback only: nothing writes it to `categories.emoji` (migration 0050).
  it('has an entry for every key of the taxonomy', () => {
    const missing = FLAT_TAXONOMY.map((entry) => entry.key).filter(
      (key) => !Object.hasOwn(CATEGORY_DEFAULT_EMOJI, key),
    );
    expect(missing).toEqual([]);
  });

  it('has no key the taxonomy lacks', () => {
    const keys = new Set(FLAT_TAXONOMY.map((entry) => entry.key));
    expect(Object.keys(CATEGORY_DEFAULT_EMOJI).filter((key) => !keys.has(key))).toEqual([]);
  });

  it('gives every key exactly one emoji', () => {
    for (const [key, emoji] of Object.entries(CATEGORY_DEFAULT_EMOJI)) {
      expect(isSingleEmoji(emoji), `${key}: ${emoji}`).toBe(true);
      expect(defaultEmojiForKey(key)).toBe(emoji);
    }
    expect(defaultEmojiForKey('my_custom_category'), 'a custom key keeps its initials').toBeNull();
  });
});
