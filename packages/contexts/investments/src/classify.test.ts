// SPDX-License-Identifier: MIT
/**
 * 07 §4.3's waterfall: the rung that answered, the look-through that decomposes
 * a multi-asset fund, and the two ways a look-through is allowed to give up.
 */
import { describe, expect, it } from 'vitest';
import { CLASSIFICATION_SOURCES, type ClassificationSource } from '../schema/index.ts';
import {
  MAX_LOOK_THROUGH_DEPTH,
  classify,
  effectiveClassificationOf,
  loadSeedTable,
  seedTableOf,
  type ClassifiableSecurity,
  type SeedFund,
} from './classify.ts';

function securityOf(fields: Partial<ClassifiableSecurity>): ClassifiableSecurity {
  return {
    ticker: null,
    name: null,
    type: null,
    providerType: null,
    isCashEquivalent: null,
    chain: null,
    sicCode: null,
    ...fields,
  };
}

function fundOf(ticker: string, fields: Partial<SeedFund> = {}): SeedFund {
  return {
    ticker,
    name: `${ticker} fund`,
    type: 'etf',
    assetClass: 'US_EQUITY',
    region: 'US',
    sector: 'UNKNOWN',
    ...fields,
  };
}

describe('the waterfall', () => {
  it('every classified row records its classification_source', () => {
    // One input per rung that WP 3.1 can reach, plus the fall-through. 07 §4.3
    // states the requirement normatively — "always record
    // `classification_source`" — so the assertion is over *every* answer this
    // function can produce, not over a happy path.
    const cases: readonly (readonly [ClassificationSource, ClassifiableSecurity])[] = [
      ['LOCAL_SEED_TABLE', securityOf({ ticker: 'VTI' })],
      ['SEC_EDGAR', securityOf({ ticker: 'EDGARONLY' })],
      ['ISSUER_HOLDINGS', securityOf({ ticker: 'ISSUERONLY' })],
      ['PROVIDER', securityOf({ ticker: 'ETH', chain: 'ethereum' })],
      ['PROVIDER', securityOf({ ticker: 'XYZ', isCashEquivalent: true })],
      ['NAME_HEURISTIC', securityOf({ ticker: 'ZZZZ', name: 'Acme Total Bond Market Index' })],
      ['SIC_SECTOR_MAP', securityOf({ ticker: 'ZZZZ', sicCode: '3674' })],
      ['UNCLASSIFIED', securityOf({ ticker: 'ZZZZ', name: 'Northwind Holdings' })],
    ];

    for (const [expected, security] of cases) {
      const classification = classify(security, {
        lookups: {
          edgar: (ticker) => (ticker === 'EDGARONLY' ? fundOf('EDGARONLY') : null),
          issuer: (ticker) => (ticker === 'ISSUERONLY' ? fundOf('ISSUERONLY') : null),
        },
      });
      expect(classification.source, `${security.ticker ?? '?'} → ${expected}`).toBe(expected);
      expect(CLASSIFICATION_SOURCES).toContain(classification.source);
    }
  });

  it('classifies every row of the shipped seed table, and none as UNCLASSIFIED', () => {
    // The seed is rung 2's whole content: a row in it that does not classify is
    // a typo nobody would otherwise see until an allocation chart had a hole.
    const seed = loadSeedTable();
    expect(seed.byTicker.size).toBeGreaterThan(40);
    for (const [ticker] of seed.byTicker) {
      const classification = classify(securityOf({ ticker }), { seed });
      expect(classification.source, ticker).toBe('LOCAL_SEED_TABLE');
      expect(classification.assetClass, ticker).not.toBe('UNCLASSIFIED');
    }
  });

  it('a user override always wins and is never re-derived', () => {
    const derived = classify(securityOf({ ticker: 'VTI' }));
    expect(derived.assetClass).toBe('US_EQUITY');

    const effective = effectiveClassificationOf(
      {
        assetClass: derived.assetClass,
        region: derived.region,
        sector: derived.sector,
        expenseRatio: derived.expenseRatio,
        classificationSource: derived.source,
      },
      {
        assetClass: 'REAL_ESTATE',
        region: null,
        sector: null,
        expenseRatio: null,
        lockedFields: ['asset_class'],
      },
    );
    expect(effective.assetClass).toBe('REAL_ESTATE');
    expect(effective.source).toBe('USER_OVERRIDE');
    expect(effective.overridden).toEqual(['asset_class']);
    // An unlocked field still comes from the waterfall: the overlay is sparse
    // (04 §2.2) and a NULL in it means "the user did not say", not "clear this".
    expect(effective.region).toBe('US');
  });

  it('an overlay value that was never locked does not win', () => {
    const effective = effectiveClassificationOf(
      {
        assetClass: 'US_EQUITY',
        region: 'US',
        sector: 'UNKNOWN',
        expenseRatio: null,
        classificationSource: 'LOCAL_SEED_TABLE',
      },
      { assetClass: 'CRYPTO', region: null, sector: null, expenseRatio: null, lockedFields: [] },
    );
    expect(effective.assetClass).toBe('US_EQUITY');
    expect(effective.source).toBe('LOCAL_SEED_TABLE');
  });
});

describe('fund look-through', () => {
  it('decomposes a multi-asset fund rather than bucketing it', () => {
    // 07 §4.3: "Multi-asset funds (target-date, balanced) must be decomposed,
    // not bucketed as 'equity'."
    const classification = classify(securityOf({ ticker: 'VBIAX' }));
    expect(classification.weights.get('US_EQUITY')).toBe('0.600000');
    expect(classification.weights.get('US_BOND')).toBe('0.400000');
    expect(classification.assetClass).toBe('US_EQUITY'); // the 60% label
    expect(classification.residual).toBe('0.000000');
    expect(classification.flagged).toBe(false);
  });

  it('a fund whose component weights miss 1.0 by more than 5% is flagged', () => {
    const seed = seedTableOf([
      fundOf('EQ', { assetClass: 'US_EQUITY' }),
      fundOf('BD', { assetClass: 'US_BOND' }),
      // A derivatives overlay reports market value rather than notional, so the
      // classified weights genuinely do not add up. 07 §4.3 wants that said out
      // loud rather than absorbed into the nearest bucket.
      fundOf('OVERLAY', {
        components: [
          { ticker: 'EQ', weight: '0.600000' },
          { ticker: 'BD', weight: '0.300000' },
        ],
      }),
      // 4% short: inside the tolerance, and therefore not flagged. The pair is
      // what makes the threshold a threshold rather than an assertion that
      // anything imperfect is broken.
      fundOf('NEARLY', {
        components: [
          { ticker: 'EQ', weight: '0.600000' },
          { ticker: 'BD', weight: '0.360000' },
        ],
      }),
    ]);

    const flagged = classify(securityOf({ ticker: 'OVERLAY' }), { seed });
    expect(flagged.residual).toBe('0.100000');
    expect(flagged.flagged).toBe(true);
    expect(flagged.detail).toContain('weights miss 1.0');

    const fine = classify(securityOf({ ticker: 'NEARLY' }), { seed });
    expect(fine.residual).toBe('0.040000');
    expect(fine.flagged).toBe(false);
  });

  it('an unknown component counts against the residual rather than vanishing', () => {
    const seed = seedTableOf([
      fundOf('EQ', { assetClass: 'US_EQUITY' }),
      fundOf('MYSTERY_HOLDER', {
        components: [
          { ticker: 'EQ', weight: '0.800000' },
          { ticker: 'NOTINTABLE', weight: '0.200000' },
        ],
      }),
    ]);
    const classification = classify(securityOf({ ticker: 'MYSTERY_HOLDER' }), { seed });
    expect(classification.weights.get('US_EQUITY')).toBe('0.800000');
    expect(classification.residual).toBe('0.200000');
    expect(classification.flagged).toBe(true);
  });

  it('fund-of-funds recursion stops at depth 3 and detects a cycle', () => {
    const seed = seedTableOf([
      fundOf('LEAF', { assetClass: 'US_BOND' }),
      // A chain five levels deep. The cap is 3 (07 §4.3), so L3's own
      // components are never expanded and its label is used instead — a
      // coarser answer, flagged, rather than an unbounded walk.
      fundOf('L4', {
        assetClass: 'EM_EQUITY',
        components: [{ ticker: 'LEAF', weight: '1.000000' }],
      }),
      fundOf('L3', { assetClass: 'US_EQUITY', components: [{ ticker: 'L4', weight: '1.000000' }] }),
      fundOf('L2', { assetClass: 'OTHER', components: [{ ticker: 'L3', weight: '1.000000' }] }),
      fundOf('L1', { assetClass: 'OTHER', components: [{ ticker: 'L2', weight: '1.000000' }] }),
      // And a cycle: A holds B, B holds A.
      fundOf('CYCLE_A', { components: [{ ticker: 'CYCLE_B', weight: '1.000000' }] }),
      fundOf('CYCLE_B', { components: [{ ticker: 'CYCLE_A', weight: '1.000000' }] }),
    ]);

    const capped = classify(securityOf({ ticker: 'L1' }), { seed });
    expect(capped.depth).toBe(MAX_LOOK_THROUGH_DEPTH);
    expect(capped.flagged).toBe(true);
    expect(capped.detail).toContain(`depth ${String(MAX_LOOK_THROUGH_DEPTH)}`);
    // L3's *label* was used, so the answer is US_EQUITY rather than the
    // EM_EQUITY/US_BOND the full walk would have found. Coarse, and labelled.
    expect(capped.weights.get('US_EQUITY')).toBe('1.000000');

    const cyclic = classify(securityOf({ ticker: 'CYCLE_A' }), { seed });
    expect(cyclic.flagged).toBe(true);
    expect(cyclic.detail).toContain('ancestors');
    // Nothing was classified, so the residual is the whole fund. A cycle does
    // not produce a plausible-looking pie chart.
    expect(cyclic.residual).toBe('1.000000');
    expect(cyclic.weights.size).toBe(0);
  });

  it('does not treat a component appearing in two sleeves as a cycle', () => {
    const seed = seedTableOf([
      fundOf('EQ', { assetClass: 'US_EQUITY' }),
      fundOf('SLEEVE_A', { components: [{ ticker: 'EQ', weight: '1.000000' }] }),
      fundOf('SLEEVE_B', { components: [{ ticker: 'EQ', weight: '1.000000' }] }),
      fundOf('TOP', {
        components: [
          { ticker: 'SLEEVE_A', weight: '0.500000' },
          { ticker: 'SLEEVE_B', weight: '0.500000' },
        ],
      }),
    ]);
    const classification = classify(securityOf({ ticker: 'TOP' }), { seed });
    expect(classification.flagged).toBe(false);
    expect(classification.weights.get('US_EQUITY')).toBe('1.000000');
  });
});

describe('name heuristics', () => {
  it('reads bonds, TIPS, international and emerging out of a name', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['Acme Total Bond Market Index', 'US_BOND'],
      ['Acme Inflation-Protected Securities', 'TIPS'],
      ['Acme Emerging Markets Equity', 'EM_EQUITY'],
      ['Acme International Developed Equity', 'INTL_DEV_EQUITY'],
      ['Acme S&P 500 Index', 'US_EQUITY'],
      ['Acme Government Money Market', 'CASH'],
      ['Acme Gold Trust', 'COMMODITY'],
      ['Acme REIT Index', 'REAL_ESTATE'],
    ];
    for (const [name, assetClass] of cases) {
      const classification = classify(securityOf({ name }));
      expect(classification.assetClass, name).toBe(assetClass);
      expect(classification.source, name).toBe('NAME_HEURISTIC');
    }
  });

  it('leaves a name it cannot read UNCLASSIFIED rather than guessing US equity', () => {
    const classification = classify(securityOf({ name: 'Northwind Private Placement 2031' }));
    expect(classification.assetClass).toBe('UNCLASSIFIED');
    expect(classification.source).toBe('UNCLASSIFIED');
    expect(classification.detail).toContain('every rung abstained');
  });
});
