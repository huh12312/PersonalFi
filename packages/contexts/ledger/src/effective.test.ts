// SPDX-License-Identifier: MIT
/**
 * `resolveEffective` is the one function every read path goes through, so it gets
 * property tests rather than a handful of examples: the failure it exists to
 * prevent — a list page and a budget total disagreeing about what a transaction
 * says — shows up in the cases nobody thought to write down.
 */
import { DateOnly, money, type DateOnly as DateOnlyType } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolveCategoryId, resolveEffective, withinDays } from './effective.ts';
import { dedupKeyOf, normaliseMerchantName } from './normalise.ts';
import {
  EMPTY_OVERLAY,
  NO_RULE,
  type RuleResolution,
  type TransactionFact,
  type TransactionOverlay,
} from './types.ts';

const dateArb = fc
  .integer({ min: 15_000, max: 25_000 })
  .map((epochDay) => DateOnly.fromEpochDay(epochDay));

const nameArb = fc.oneof(
  fc.constantFrom(
    'SQ *BLUE BOTTLE 4471',
    'TST* THE FRENCH LAUNDRY',
    'AMZN Mktp US*2K4TT1FF2',
    'COSTCO WHSE #1234 SEATTLE WA',
    'SHELL OIL 57443021 PORTLAND OR',
    'WHOLEFDS MKT #10259',
    'PG&E',
    'TRANSFER TO HIGH-YIELD SAVINGS',
  ),
  fc.string({ minLength: 1, maxLength: 40 }),
);

const factArb: fc.Arbitrary<TransactionFact> = fc.record({
  amount: fc.bigInt({ min: -100_000_000n, max: 100_000_000n }).map((minor) => money(minor, 'USD')),
  postedDate: dateArb,
  authorizedDate: fc.option(dateArb, { nil: null }),
  name: nameArb,
  merchantName: fc.option(nameArb, { nil: null }),
  pending: fc.boolean(),
});

const overlayArb: fc.Arbitrary<TransactionOverlay> = fc.record({
  userNote: fc.option(fc.string({ maxLength: 30 }), { nil: null }),
  userExcluded: fc.boolean(),
  userCategoryId: fc.option(fc.uuid(), { nil: null }),
  userMerchantName: fc.option(fc.string({ maxLength: 30 }), { nil: null }),
});

const ruleArb: fc.Arbitrary<RuleResolution> = fc.record({
  ruleCategoryId: fc.option(fc.uuid(), { nil: null }),
});

describe('resolveEffective', () => {
  it('is pure: the same fact and overlay always resolve identically', () => {
    fc.assert(
      fc.property(factArb, overlayArb, (fact, overlay) => {
        expect(resolveEffective(fact, overlay)).toEqual(resolveEffective(fact, overlay));
      }),
    );
  });

  it('never lets the overlay change the money or the pending flag', () => {
    fc.assert(
      fc.property(factArb, overlayArb, (fact, overlay) => {
        const effective = resolveEffective(fact, overlay);
        // The overlay is *intent*, not truth. A user may rename a payee; a user
        // may not quietly make a charge smaller, and no code path here should
        // ever make that possible by accident.
        expect(effective.amount).toEqual(fact.amount);
        expect(effective.pending).toBe(fact.pending);
      }),
    );
  });

  it('dates the transaction to the swipe when there was one (04 §2.4)', () => {
    fc.assert(
      fc.property(factArb, overlayArb, (fact, overlay) => {
        expect(resolveEffective(fact, overlay).date).toBe(fact.authorizedDate ?? fact.postedDate);
      }),
    );
  });

  it('passes the overlay through for the fields the user owns', () => {
    fc.assert(
      fc.property(factArb, overlayArb, (fact, overlay) => {
        const effective = resolveEffective(fact, overlay);
        expect(effective.excluded).toBe(overlay.userExcluded);
        expect(effective.categoryId).toBe(overlay.userCategoryId);
      }),
    );
  });

  it('defaults the rule argument to NO_RULE, so every existing call site is unaffected', () => {
    fc.assert(
      fc.property(factArb, overlayArb, (fact, overlay) => {
        expect(resolveEffective(fact, overlay)).toEqual(resolveEffective(fact, overlay, NO_RULE));
      }),
    );
  });

  it('the category tier order: user beats rule beats neither (04 §2.2)', () => {
    fc.assert(
      fc.property(factArb, overlayArb, ruleArb, (fact, overlay, rule) => {
        const effective = resolveEffective(fact, overlay, rule);
        expect(effective.categoryId).toBe(overlay.userCategoryId ?? rule.ruleCategoryId);
      }),
    );
  });

  it('a rule answers when the user has not spoken', () => {
    const fact: TransactionFact = {
      amount: money(-500n, 'USD'),
      postedDate: DateOnly.parse('2026-05-20'),
      authorizedDate: null,
      name: 'SQ *BLUE BOTTLE 4471',
      merchantName: null,
      pending: false,
    };
    const ruleCategoryId = '01920000-0000-7000-8000-0000000000aa';
    const effective = resolveEffective(fact, EMPTY_OVERLAY, { ruleCategoryId });
    expect(effective.categoryId).toBe(ruleCategoryId);
  });

  it('the user always beats a rule, even a rule set after the user spoke', () => {
    const fact: TransactionFact = {
      amount: money(-500n, 'USD'),
      postedDate: DateOnly.parse('2026-05-20'),
      authorizedDate: null,
      name: 'SQ *BLUE BOTTLE 4471',
      merchantName: null,
      pending: false,
    };
    const userCategoryId = '01920000-0000-7000-8000-0000000000bb';
    const ruleCategoryId = '01920000-0000-7000-8000-0000000000cc';
    const effective = resolveEffective(
      fact,
      { ...EMPTY_OVERLAY, userCategoryId },
      { ruleCategoryId },
    );
    expect(effective.categoryId).toBe(userCategoryId);
    expect(effective.categoryId).not.toBe(ruleCategoryId);
  });

  it('neither user nor rule leaves the category unset — the provider and classifier tiers live in @ctx/categorization, never here', () => {
    const fact: TransactionFact = {
      amount: money(-500n, 'USD'),
      postedDate: DateOnly.parse('2026-05-20'),
      authorizedDate: null,
      name: 'SQ *BLUE BOTTLE 4471',
      merchantName: null,
      pending: false,
    };
    expect(resolveEffective(fact, EMPTY_OVERLAY, NO_RULE).categoryId).toBeNull();
    expect(resolveCategoryId(EMPTY_OVERLAY)).toBeNull();
  });

  it('never resolves to an empty name', () => {
    fc.assert(
      fc.property(factArb, overlayArb, (fact, overlay) => {
        expect(resolveEffective(fact, overlay).name.length).toBeGreaterThan(0);
      }),
    );
  });

  it('produces a merchant key that is safe to group on', () => {
    fc.assert(
      fc.property(factArb, overlayArb, (fact, overlay) => {
        const { merchantKey } = resolveEffective(fact, overlay);
        if (merchantKey === null) return;
        // The key is what the database groups by and what the heuristics match
        // on, so it must be free of case, punctuation and whitespace.
        expect(merchantKey).toMatch(/^[a-z0-9]+$/u);
      }),
    );
  });

  it('treats a blank overlay string as "the user has not spoken"', () => {
    fc.assert(
      fc.property(factArb, fc.constantFrom('', ' ', '\t', '  \n '), (fact, blank) => {
        const blanked = resolveEffective(fact, {
          ...EMPTY_OVERLAY,
          userMerchantName: blank,
          userNote: blank,
        });
        expect(blanked).toEqual(resolveEffective(fact, EMPTY_OVERLAY));
        expect(blanked.note).toBeNull();
      }),
    );
  });

  it('lets a user rename a payee, and the rename wins over the provider', () => {
    fc.assert(
      fc.property(factArb, fc.string({ minLength: 3, maxLength: 20 }), (fact, rename) => {
        const normalised = normaliseMerchantName(rename);
        fc.pre(normalised.key !== '');
        const effective = resolveEffective(fact, { ...EMPTY_OVERLAY, userMerchantName: rename });
        expect(effective.merchantKey).toBe(normalised.key);
      }),
    );
  });

  it('is stable: resolving a resolved name does not move the key again', () => {
    fc.assert(
      fc.property(factArb, (fact) => {
        const once = resolveEffective(fact, EMPTY_OVERLAY);
        if (once.merchantKey === null) return;
        const twice = resolveEffective(fact, {
          ...EMPTY_OVERLAY,
          userMerchantName: once.merchantDisplayName,
        });
        // If normalisation were not idempotent, a user accepting the name we
        // showed them would silently split their history across two merchants.
        expect(twice.merchantKey).toBe(once.merchantKey);
      }),
    );
  });

  it('resolves the worked example from the schema comments', () => {
    const fact: TransactionFact = {
      amount: money(-1234n, 'USD'),
      postedDate: DateOnly.parse('2026-03-02'),
      authorizedDate: DateOnly.parse('2026-02-28'),
      name: 'SQ *BLUE BOTTLE 4471',
      merchantName: null,
      pending: false,
    };
    const effective = resolveEffective(fact, EMPTY_OVERLAY);
    expect(effective.date).toBe('2026-02-28');
    expect(effective.name).toBe('Blue Bottle');
    expect(effective.merchantKey).toBe('bluebottle');
    expect(effective.amount.minor).toBe(-1234n);
  });

  it("prefers the provider's cleaned merchant name over the raw descriptor", () => {
    const fact: TransactionFact = {
      amount: money(-500n, 'USD'),
      postedDate: DateOnly.parse('2026-03-02'),
      authorizedDate: null,
      name: 'WHOLEFDS MKT #10259',
      merchantName: 'Whole Foods Market',
      pending: false,
    };
    expect(resolveEffective(fact, EMPTY_OVERLAY).name).toBe('Whole Foods Market');
  });
});

describe('normaliseMerchantName', () => {
  it.each([
    ['SQ *BLUE BOTTLE 4471', 'bluebottle'],
    ['SQ *BLUE BOTTLE COFFE', 'bluebottlecoffe'],
    ['TST* THE FRENCH LAUNDRY', 'thefrenchlaundry'],
    ['AMZN Mktp US*2K4TT1FF2', 'amazon'],
    ['COSTCO WHSE #1234 SEATTLE WA', 'costcowhse'],
    ['SHELL OIL 57443021 PORTLAND OR', 'shelloil'],
    ['PG&E', 'pge'],
    ['', ''],
    ['   ', ''],
    ['#1234', ''],
  ])('normalises %j to %j', (input, expected) => {
    expect(normaliseMerchantName(input).key).toBe(expected);
  });

  it('keeps a short all-caps name shouting, because that is its name', () => {
    expect(normaliseMerchantName('REI').display).toBe('REI');
    expect(normaliseMerchantName('AT&T WIRELESS').display).toBe('AT&T Wireless');
  });

  it('is idempotent on its own display output', () => {
    fc.assert(
      fc.property(nameArb, (raw) => {
        const once = normaliseMerchantName(raw);
        expect(normaliseMerchantName(once.display).key).toBe(once.key);
      }),
    );
  });
});

describe('dedupKeyOf', () => {
  it('is deterministic and provider-agnostic', () => {
    const input = {
      postedDate: DateOnly.parse('2026-03-02'),
      amount: money(-1234n, 'USD'),
      nameKey: 'bluebottle',
    };
    expect(dedupKeyOf(input)).toBe(dedupKeyOf(input));
    expect(dedupKeyOf(input)).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('separates two charges that differ in any component', () => {
    const base = {
      postedDate: DateOnly.parse('2026-03-02'),
      amount: money(-1234n, 'USD'),
      nameKey: 'bluebottle',
    };
    const keys = new Set([
      dedupKeyOf(base),
      dedupKeyOf({ ...base, postedDate: DateOnly.parse('2026-03-03') }),
      dedupKeyOf({ ...base, amount: money(-1235n, 'USD') }),
      dedupKeyOf({ ...base, amount: money(-1234n, 'EUR') }),
      dedupKeyOf({ ...base, nameKey: 'bluebottlecoffee' }),
    ]);
    expect(keys.size).toBe(5);
  });
});

describe('withinDays', () => {
  it('is symmetric and inclusive', () => {
    fc.assert(
      fc.property(dateArb, fc.integer({ min: -10, max: 10 }), (a: DateOnlyType, offset) => {
        const b = DateOnly.addDays(a, offset);
        const days = Math.abs(offset);
        expect(withinDays(a, b, days)).toBe(true);
        expect(withinDays(b, a, days)).toBe(true);
        if (days > 0) expect(withinDays(a, b, days - 1)).toBe(false);
      }),
    );
  });
});
