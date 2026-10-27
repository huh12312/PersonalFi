// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { buildTransaction } from '../../test-support/api-test-utils.ts';
import {
  autoCategory,
  buildAssignedExplanation,
  buildAutoTransaction,
} from '../../test-support/provenance-fixtures.ts';
import {
  autoPlacementOf,
  chipLabelOf,
  chipNameOf,
  percentOf,
  revealHeadlineOf,
} from './provenance.ts';

describe('the provenance chip’s words (WP 11.2b)', () => {
  it('names the tier: Plaid, Learned, Classifier with the calibrated percent', () => {
    expect(chipLabelOf(autoCategory('provider', 0.85))).toBe('Plaid');
    expect(chipLabelOf(autoCategory('merchant_default', 0.75))).toBe('Learned');
    expect(chipLabelOf(autoCategory('classifier', 0.9234))).toBe('Classifier 92 %');
    expect(percentOf(0.605)).toBe('61 %');
  });

  it('has an accessible name that says it was placed automatically', () => {
    for (const tier of ['provider', 'merchant_default', 'classifier'] as const) {
      expect(chipNameOf(autoCategory(tier, 0.8))).toMatch(/^Placed automatically/);
    }
  });

  it('reads “from N confirmations” off the stored chain, never invents it', () => {
    const learned = autoCategory('merchant_default', 0.75);
    expect(revealHeadlineOf(learned, buildAssignedExplanation('t', 'merchant_default'))).toBe(
      'Learned from 4 confirmations',
    );
    const one = buildAssignedExplanation('t', 'merchant_default', {
      tiers: [
        { source: 'merchant_default', won: true, detail: '', facts: { locked: false, support: 1 } },
      ],
    });
    expect(revealHeadlineOf(learned, one)).toBe('Learned from 1 confirmation');
    const pinned = buildAssignedExplanation('t', 'merchant_default', {
      tiers: [
        { source: 'merchant_default', won: true, detail: '', facts: { locked: true, support: 0 } },
      ],
    });
    expect(revealHeadlineOf(learned, pinned)).toBe('Pinned for this merchant');
    // A chain stored without figures, or not yet loaded: no number is made up.
    expect(revealHeadlineOf(learned, undefined)).toBe('Learned from your earlier picks');
    expect(revealHeadlineOf(autoCategory('classifier', 0.92), undefined)).toBe(
      'Classifier, 92 % confident',
    );
  });

  it('only an automatic placement has a chip: a holder’s or a rule’s category has none', () => {
    expect(autoPlacementOf(buildAutoTransaction('a', 'provider', 0.85))).not.toBeNull();
    expect(
      autoPlacementOf(buildTransaction({ id: 'u', categoryId: 'cat_dining_coffee' })),
    ).toBeNull();
    expect(
      autoPlacementOf(
        buildTransaction({ id: 'r', categoryId: 'cat_dining_coffee', categorySource: 'rule' }),
      ),
    ).toBeNull();
    expect(autoPlacementOf(buildTransaction({ id: 'n' }))).toBeNull();
  });
});
