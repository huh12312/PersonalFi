// SPDX-License-Identifier: MIT
/**
 * WP 11.1 — every new classifier feature reaches the explanation by name, and
 * the Inbox's one-line "why" is composed from the stored chain's own facts.
 *
 * The chain `decide` returns is exactly what `category_assignments.evidence` /
 * `category_abstentions.evidence` store and `explainAssignment` /
 * `explainTransactions` return, so asserting on it here is asserting on what
 * the holder is shown (the db suite proves the store-and-read half).
 */
import { DateOnly } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { COLD_MODEL, train } from './classifier.ts';
import {
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_MERCHANT_SUPPORT,
  classifierFeaturesOf,
  decide,
  type DecisionContext,
  type DecisionInput,
} from './engine.ts';
import { explanationLineOf } from './explain-line.ts';

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    transactionId: '00000000-0000-7000-8000-00000000a001',
    payee: 'NEIGHBOURHOOD STORE',
    cleanedPayee: 'NEIGHBOURHOOD STORE',
    amountMinor: -2_500n,
    currency: 'USD',
    accountId: '00000000-0000-7000-8000-00000000b001',
    accountType: 'credit',
    date: DateOnly.parse('2026-05-20'),
    providerCategory: null,
    mcc: null,
    isTransfer: false,
    userCategoryId: null,
    ...overrides,
  };
}

function context(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    rules: [],
    merchantDefault: null,
    classifier: COLD_MODEL,
    confidenceFloor: DEFAULT_CONFIDENCE_FLOOR,
    merchantSupportThreshold: DEFAULT_MERCHANT_SUPPORT,
    ...overrides,
  };
}

/**
 * Two categories that share the payee word and everything else, and differ
 * only in the one feature under test — so that feature is what decides, and
 * must be what the explanation names.
 */
function modelSplitBy(a: DecisionInput, aKey: string, b: DecisionInput, bKey: string) {
  return train([
    ...Array.from({ length: 6 }, () => ({ features: classifierFeaturesOf(a), categoryKey: aKey })),
    ...Array.from({ length: 6 }, () => ({ features: classifierFeaturesOf(b), categoryKey: bKey })),
  ]);
}

function classifierTier(decision: ReturnType<typeof decide>) {
  const tier = decision.chain.find((entry) => entry.source === 'classifier');
  if (tier === undefined) throw new Error('no classifier tier in the chain');
  return tier;
}

describe('every WP 11.1 feature appears in the explanation by name', () => {
  it('mf: — the MCC family', () => {
    // 0742 (vets) and 5541 (fuel) sit in different families.
    const vet = input({ mcc: '0742' });
    const fuel = input({ mcc: '5541' });
    const decision = decide(
      vet,
      context({ classifier: modelSplitBy(vet, 'family.pet_medical', fuel, 'transport.fuel') }),
    );
    expect(decision.source).toBe('classifier');
    const tier = classifierTier(decision);
    expect(tier.detail).toContain('mf:family');
    expect(String(tier.facts?.['signals'])).toContain('mf:family');
  });

  it('p: — the provider primary', () => {
    // Primaries newer than our mapping table: the provider tier abstains and
    // the primary still counts, as a feature.
    const other = input({ providerCategory: { primary: 'SOMETHING_NEWER', detailed: null } });
    const newer = input({ providerCategory: { primary: 'ANOTHER_NEWER', detailed: null } });
    const decision = decide(
      other,
      context({
        classifier: modelSplitBy(other, 'shopping.other_shopping', newer, 'travel.flights'),
      }),
    );
    expect(decision.chain.find((entry) => entry.source === 'provider')?.won).toBe(false);
    expect(decision.source).toBe('classifier');
    expect(classifierTier(decision).detail).toContain('p:something_newer');
  });

  it('dm: — the day of the month', () => {
    const rent = input({ date: DateOnly.parse('2026-05-01') });
    const later = input({ date: DateOnly.parse('2026-05-25') });
    const decision = decide(
      rent,
      context({ classifier: modelSplitBy(rent, 'housing.rent', later, 'shopping.other_shopping') }),
    );
    expect(decision.source).toBe('classifier');
    expect(classifierTier(decision).detail).toContain('dm:early');
  });
});

describe('the one-line "why", from the stored chain', () => {
  it('names every tier that abstained, with its figures', () => {
    const decision = decide(input(), context());
    expect(decision.source).toBe('none');
    expect(explanationLineOf(decision.chain)).toBe(
      'Every tier abstained: no rules yet, merchant never confirmed, no bank category, ' +
        'classifier has no confirmed examples yet.',
    );
  });

  it('reports the classifier below its floor in percent, and a merchant short of support', () => {
    const coffee = input({ cleanedPayee: 'BLUE BOTTLE', payee: 'BLUE BOTTLE' });
    const shop = input({
      cleanedPayee: 'BLUE BOTTLE',
      payee: 'BLUE BOTTLE',
      amountMinor: -90_000n,
    });
    const decision = decide(
      coffee,
      context({
        classifier: modelSplitBy(coffee, 'dining.coffee', shop, 'shopping.other_shopping'),
        confidenceFloor: 0.995,
        merchantDefault: { categoryKey: 'dining.coffee', locked: false, supportCount: 1 },
      }),
    );
    expect(decision.source).toBe('none');
    expect(explanationLineOf(decision.chain)).toMatch(
      /^Every tier abstained: no rules yet, merchant confirmed 1 of 3 times needed, no bank category, classifier \d+ % below its 100 % floor\.$/u,
    );
  });

  it('says the payee is unseen when the classifier only had context to go on', () => {
    const known = input({ cleanedPayee: 'CHEWY', payee: 'CHEWY', amountMinor: -4_000n });
    const other = input({ cleanedPayee: 'CHEVRON', payee: 'CHEVRON', amountMinor: -90_000n });
    const decision = decide(
      input({ cleanedPayee: 'PETCO', payee: 'PETCO', amountMinor: -4_000n }),
      context({ classifier: modelSplitBy(known, 'family.pets', other, 'transport.fuel') }),
    );
    expect(decision.source).toBe('none');
    expect(explanationLineOf(decision.chain)).toContain('(no word of this payee seen before)');
  });

  it('describes a decided row by its winning tier', () => {
    const decision = decide(
      input(),
      context({ merchantDefault: { categoryKey: 'dining.coffee', locked: true, supportCount: 0 } }),
    );
    expect(explanationLineOf(decision.chain)).toBe(
      'Filed from this merchant’s history: You pinned this category for this merchant.',
    );
  });

  it('falls back to the stored prose for a chain written before WP 11.1', () => {
    const legacy = [
      { source: 'user', won: false, detail: 'You have not set a category on this one.' },
      { source: 'rule', won: false, detail: 'None of your 2 rule(s) matched.' },
      { source: 'classifier', won: false, detail: 'model is cold: no confirmed examples yet' },
      { source: 'none', won: true, detail: 'Nothing was confident enough.' },
    ];
    expect(explanationLineOf(legacy)).toBe(
      'Every tier abstained: None of your 2 rule(s) matched., model is cold: no confirmed examples yet.',
    );
  });

  it('is honest about a chain that was never recorded, and ignores junk', () => {
    expect(explanationLineOf([])).toBe(
      'No categorisation pass has recorded its working for this yet.',
    );
    expect(explanationLineOf([null, 4, 'x', { won: true }])).toBe(
      'No categorisation pass has recorded its working for this yet.',
    );
  });
});
