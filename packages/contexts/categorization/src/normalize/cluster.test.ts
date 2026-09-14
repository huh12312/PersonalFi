// SPDX-License-Identifier: MIT
/**
 * Clustering descriptors into merchants.
 *
 * The asymmetry 01 §5.2 states and this file exists to defend: **under-merging is
 * a UI annoyance, over-merging is data loss.** A user who sees two "Blue Bottle"
 * rows merges them in one click; a user whose "Shell" and "Shelby's" were merged
 * has a category history that is quietly wrong and no way to notice. So there are
 * more tests below about pairs that must *not* merge than about pairs that must.
 *
 * The property at the end is the one `cluster.ts`'s header promises: the answer
 * does not depend on the order the observations arrived in. Single-link merging
 * is order-sensitive by default, and a merchant list that reshuffles itself when
 * an unrelated query's `ORDER BY` changes is the worst kind of bug to chase.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_EDIT_DISTANCE,
  MIN_FUZZY_LENGTH,
  chooseCanonicalName,
  clusterDescriptors,
  editBudget,
  titleCase,
  type DescriptorObservation,
} from './cluster.ts';

function observed(
  cleaned: string,
  count = 1,
  providerName: string | null = null,
): DescriptorObservation {
  return { cleaned, count, providerName };
}

describe('the exact stage', () => {
  it('groups descriptors that differ only in word order, repetition or punctuation', () => {
    const clusters = clusterDescriptors([
      observed('WHOLE FOODS MARKET', 4),
      observed('MARKET WHOLE FOODS', 2),
      observed('WHOLE FOODS, MARKET!', 1),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({
      key: 'foods market whole',
      totalCount: 7,
      mergedBy: 'exact',
    });
    // Most common first, so the evidence panel leads with the shape the bank
    // actually sends.
    expect(clusters[0]?.descriptors[0]).toBe('WHOLE FOODS MARKET');
  });

  it('keeps two genuinely different merchants apart', () => {
    const clusters = clusterDescriptors([observed('CHEVRON', 3), observed('SAFEWAY', 3)]);
    expect(clusters).toHaveLength(2);
    for (const cluster of clusters) expect(cluster.mergedBy).toBe('exact');
  });

  it('never groups the unnameable rows together', () => {
    // An empty fingerprint means "no key". Grouping on emptiness would file every
    // punctuation-only descriptor in the history under one merchant.
    const clusters = clusterDescriptors([observed('***'), observed('###')]);
    expect(clusters).toHaveLength(2);
    for (const cluster of clusters) expect(cluster.key).toBe('');
  });

  it('sorts the busiest merchant first', () => {
    const clusters = clusterDescriptors([
      observed('CHEVRON', 2),
      observed('SAFEWAY', 9),
      observed('IKEA', 5),
    ]);
    expect(clusters.map((cluster) => cluster.totalCount)).toEqual([9, 5, 2]);
  });
});

describe('the fuzzy stage', () => {
  it('merges a merchant the bank spells with and without a space', () => {
    const clusters = clusterDescriptors([observed('PETSMART', 5), observed('PET SMART', 2)]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ totalCount: 7, mergedBy: 'fuzzy' });
  });

  it('refuses a short name, however close', () => {
    // `REI` and `KEI` are one edit apart and are not the same shop. Below
    // `MIN_FUZZY_LENGTH` the edit budget is zero and only an exact fingerprint
    // groups — which is the conservative half of the whole file.
    const clusters = clusterDescriptors([observed('REI', 4), observed('KEI', 4)]);
    expect(clusters).toHaveLength(2);
  });

  it('refuses a pair the n-gram fingerprint disagrees about', () => {
    // Within the edit budget and sharing a first letter, so distance alone would
    // have merged them. The second opinion is what keeps them apart.
    const clusters = clusterDescriptors([observed('MARRIOTT HOTELS'), observed('MARRIOTT HOTELT')]);
    expect(clusters.length).toBeGreaterThan(1);
  });

  it('refuses a pair that does not even share a first character', () => {
    const clusters = clusterDescriptors([observed('LYFT RIDES'), observed('GIFT RIDES')]);
    expect(clusters).toHaveLength(2);
  });

  it('leaves the unnameable rows out of the fuzzy pass entirely', () => {
    const clusters = clusterDescriptors([observed('***'), observed('***!'), observed('CHEVRON')]);
    // The two keyless rows stay separate from each other *and* from the merchant.
    expect(clusters).toHaveLength(3);
  });
});

describe('the edit budget', () => {
  it('gives a short name no slack at all', () => {
    for (let length = 0; length < MIN_FUZZY_LENGTH; length += 1) {
      expect(editBudget(length)).toBe(0);
    }
    expect(editBudget(MIN_FUZZY_LENGTH)).toBe(1);
  });

  it('never exceeds the cap, however long the name', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000 }), (length) => {
        expect(editBudget(length)).toBeLessThanOrEqual(MAX_EDIT_DISTANCE);
        expect(editBudget(length)).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 },
    );
  });

  it('never decreases as the name gets longer', () => {
    for (let length = 1; length <= 100; length += 1) {
      expect(editBudget(length)).toBeGreaterThanOrEqual(editBudget(length - 1));
    }
  });
});

describe('choosing what to call it', () => {
  it('prefers the provider’s name, capitalised the way the merchant capitalises it', () => {
    const clusters = clusterDescriptors([
      observed('SQ *BLUE BOTTLE COFFEE', 9),
      observed('SQ *BLUE BOTTLE COFFEE', 1, 'Blue Bottle Coffee'),
    ]);
    expect(clusters[0]?.canonicalName).toBe('Blue Bottle Coffee');
  });

  it('falls back to the most common descriptor', () => {
    expect(
      chooseCanonicalName(
        new Map([
          ['WHOLE FOODS MARKET', 9],
          ['WHOLE FOODS MARKET OAKLAND', 2],
        ]),
      ),
    ).toBe('Whole Foods Market');
  });

  it('breaks a tie toward the shorter name', () => {
    // The extra tokens in a longer variant are almost always residual noise a
    // cleaning step did not catch.
    expect(
      chooseCanonicalName(
        new Map([
          ['SAFEWAY STORE', 3],
          ['SAFEWAY', 3],
        ]),
      ),
    ).toBe('Safeway');
  });

  it('has an answer for a cluster with nothing in it', () => {
    expect(chooseCanonicalName(new Map())).toBe('');
  });
});

describe('titleCase', () => {
  it('stops a shouted descriptor shouting', () => {
    expect(titleCase('WHOLE FOODS MARKET')).toBe('Whole Foods Market');
    expect(titleCase('BLUE BOTTLE COFFEE')).toBe('Blue Bottle Coffee');
  });

  it('shouts a three-letter *word*, which is the rule’s known wart', () => {
    // `Delta AIR Lines`, not `Delta Air Lines`: the acronym rule is "three
    // letters or fewer keeps its case" and `AIR` is three letters. Pinned rather
    // than fixed, and pinned deliberately — the alternative is a dictionary of
    // short English words, which would be a second thing to maintain and would
    // still be wrong for somebody's merchant. It costs a capitalisation in a
    // fallback name: the provider's own name wins when there is one, and the
    // user can rename. Listed as deferred in the WP 1.4 evidence document.
    expect(titleCase('DELTA AIR LINES')).toBe('Delta AIR Lines');
  });

  it('leaves an acronym and an ampersand alone', () => {
    // `Pg&E` and `Rei` are worse than leaving them shouted.
    expect(titleCase('REI')).toBe('REI');
    expect(titleCase('CVS PHARMACY')).toBe('CVS Pharmacy');
    expect(titleCase('PG&E')).toBe('PG&E');
    expect(titleCase('AT&T WIRELESS')).toBe('AT&T Wireless');
  });

  it('does not touch a string somebody already capitalised on purpose', () => {
    expect(titleCase('iCloud')).toBe('iCloud');
    expect(titleCase("Trader Joe's")).toBe("Trader Joe's");
  });
});

describe('properties', () => {
  const descriptor = fc.constantFrom(
    'WHOLE FOODS MARKET',
    'MARKET WHOLE FOODS',
    'PETSMART',
    'PET SMART',
    'CHEVRON',
    'SAFEWAY',
    'REI',
    'BLUE BOTTLE COFFEE',
    '***',
  );

  const observations = fc.array(
    fc.record({
      cleaned: descriptor,
      count: fc.integer({ min: 1, max: 20 }),
      providerName: fc.constant(null),
    }),
    { minLength: 1, maxLength: 12 },
  );

  it('does not depend on the order the observations arrived in', () => {
    fc.assert(
      fc.property(observations, (entries) => {
        const forwards = clusterDescriptors(entries);
        const backwards = clusterDescriptors([...entries].reverse());
        expect(backwards).toEqual(forwards);
      }),
      { numRuns: 300 },
    );
  });

  it('loses no observation and invents none', () => {
    fc.assert(
      fc.property(observations, (entries) => {
        const clusters = clusterDescriptors(entries);
        const total = entries.reduce((sum, entry) => sum + entry.count, 0);
        expect(clusters.reduce((sum, cluster) => sum + cluster.totalCount, 0)).toBe(total);

        const seen = new Set(clusters.flatMap((cluster) => cluster.descriptors));
        for (const entry of entries) expect(seen.has(entry.cleaned)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('puts every descriptor in exactly one cluster', () => {
    fc.assert(
      fc.property(observations, (entries) => {
        const clusters = clusterDescriptors(entries);
        const all = clusters.flatMap((cluster) => cluster.descriptors);
        expect(new Set(all).size).toBe(all.length);
      }),
      { numRuns: 300 },
    );
  });

  it('always gives a cluster a name unless it had nothing to name it from', () => {
    fc.assert(
      fc.property(observations, (entries) => {
        for (const cluster of clusterDescriptors(entries)) {
          expect(cluster.canonicalName.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 200 },
    );
  });
});
