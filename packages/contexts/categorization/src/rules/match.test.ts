// SPDX-License-Identifier: MIT
/**
 * The rule language: every condition kind, the `all`/`any` combination, the
 * evaluation order, and the schema that refuses to store a rule that could never
 * work.
 *
 * Two properties are asserted over and over here because the whole design rests
 * on them:
 *
 *   * **Nothing throws.** `matchRule` runs inside a sync consumer, over rules the
 *     user wrote. A rule that cannot be evaluated must not match, and must not
 *     take the other thirty-nine rules — or the sync — down with it.
 *   * **Every condition is evaluated even once the answer is known.** The
 *     outcomes are the evidence `explainAssignment` prints, and a short-circuited
 *     `all` would leave half the sentence blank.
 */
import { DateOnly } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluateCondition, matchRule, orderRules, type MatchSubject } from './match.ts';
import {
  MAX_PATTERN_LENGTH,
  MAX_SUBJECT_LENGTH,
  conditionSchema,
  conditionsSchema,
  ruleSchema,
  type Rule,
  type RuleCondition,
} from './schema.ts';

const USER = '00000000-0000-7000-8000-00000000e001';
const ACCOUNT_A = '00000000-0000-7000-8000-00000000b001';
const ACCOUNT_B = '00000000-0000-7000-8000-00000000b002';

function subject(overrides: Partial<MatchSubject> = {}): MatchSubject {
  return {
    payee: 'SQ *WHOLE FOODS MARKET #482 OAKLAND CA',
    cleanedPayee: 'WHOLE FOODS MARKET',
    amountMinor: -8_432n,
    currency: 'USD',
    accountId: ACCOUNT_A,
    date: DateOnly.parse('2026-05-20'),
    providerCodes: ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES'],
    isTransfer: false,
    ...overrides,
  };
}

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: '00000000-0000-7000-8000-00000000c001',
    userId: USER,
    name: 'Whole Foods is groceries',
    priority: 100,
    enabled: true,
    conditions: { all: [{ type: 'payee', match: 'contains', value: 'WHOLE FOODS' }], any: [] },
    actions: [{ type: 'set_category', categoryKey: 'groceries.supermarkets' }],
    runOnSync: true,
    stopProcessing: false,
    createdFromTransactionId: null,
    ...overrides,
  };
}

/** `evaluateCondition`, as a boolean, for the table-driven cases below. */
function holds(condition: RuleCondition, over: Partial<MatchSubject> = {}): boolean {
  return evaluateCondition(condition, subject(over)).matched;
}

describe('the payee condition', () => {
  it('supports all five match modes', () => {
    expect(holds({ type: 'payee', match: 'contains', value: 'FOODS' })).toBe(true);
    expect(holds({ type: 'payee', match: 'not_contains', value: 'FOODS' })).toBe(false);
    expect(holds({ type: 'payee', match: 'not_contains', value: 'CHEVRON' })).toBe(true);
    expect(holds({ type: 'payee', match: 'starts_with', value: 'WHOLE' })).toBe(true);
    expect(holds({ type: 'payee', match: 'ends_with', value: 'MARKET' })).toBe(true);
    expect(holds({ type: 'payee', match: 'equals', value: 'WHOLE FOODS MARKET' })).toBe(true);
    expect(holds({ type: 'payee', match: 'equals', value: 'WHOLE FOODS' })).toBe(false);
  });

  it('searches the raw descriptor and the cleaned name alike', () => {
    // A user who typed the noisy form is thinking of the detail drawer; one who
    // typed the clean form is thinking of the list. Both must work, or a rule
    // written from one screen silently fails on the other.
    expect(holds({ type: 'payee', match: 'contains', value: 'SQ *' })).toBe(true);
    expect(holds({ type: 'payee', match: 'contains', value: '#482' })).toBe(true);
    expect(holds({ type: 'payee', match: 'starts_with', value: 'SQ' })).toBe(true);
  });

  it('is case- and accent-insensitive, because a bank is neither', () => {
    expect(holds({ type: 'payee', match: 'contains', value: 'whole foods' })).toBe(true);
    expect(
      holds(
        { type: 'payee', match: 'contains', value: 'Cafe' },
        { payee: 'CAFÉ MONTMARTRE', cleanedPayee: 'CAFÉ MONTMARTRE' },
      ),
    ).toBe(true);
  });

  it('reads not_contains as "in neither form", not "in one of them"', () => {
    // `SQ *` is in the raw payee but not the cleaned one. If `not_contains` were
    // `some(...)` rather than `every(...)`, this would wrongly be true and a rule
    // saying "anything that is not a Square charge" would match every Square
    // charge.
    expect(holds({ type: 'payee', match: 'not_contains', value: 'SQ *' })).toBe(false);
  });
});

describe('the payee_regex condition', () => {
  it('matches a pattern the user wrote, case-insensitively', () => {
    expect(holds({ type: 'payee_regex', pattern: 'whole\\s+foods' })).toBe(true);
    expect(holds({ type: 'payee_regex', pattern: '^CHEVRON' })).toBe(false);
  });

  it('does not match, and says why, when the pattern will not compile', () => {
    // Unreachable through `ruleSchema` — `safePattern` rejects it on write — but
    // reachable from a row written by an older schema, which is exactly the case
    // that must not throw on the read path.
    const outcome = evaluateCondition({ type: 'payee_regex', pattern: '([a-' }, subject());
    expect(outcome.matched).toBe(false);
    expect(outcome.error).toBe('pattern did not compile');
  });

  it('truncates the subject rather than rejecting a long descriptor', () => {
    const long = `${'X'.repeat(MAX_SUBJECT_LENGTH)}NEEDLE`;
    expect(holds({ type: 'payee_regex', pattern: 'NEEDLE' }, { payee: long })).toBe(false);
    expect(holds({ type: 'payee_regex', pattern: '^X+$' }, { payee: long })).toBe(true);
  });

  it('runs against the raw payee only', () => {
    // Deliberate and worth pinning: a regex is an exact instrument and a user
    // debugging one against the descriptor they can see should not have it
    // silently also tried against a string the UI never showed them.
    expect(holds({ type: 'payee_regex', pattern: '#482' })).toBe(true);
  });
});

describe('the amount condition', () => {
  const between = (
    minMinor: string | null,
    maxMinor: string | null,
    absolute = false,
  ): RuleCondition => ({
    type: 'amount',
    minMinor,
    maxMinor,
    absolute,
  });

  it('compares signed minor units, so "under -$50" means "spent more than $50"', () => {
    expect(holds(between(null, '-5000'))).toBe(true); // -84.32 <= -50.00
    expect(holds(between('-5000', null))).toBe(false);
  });

  it('treats a null bound as unbounded on that side', () => {
    expect(holds(between(null, null))).toBe(true);
    expect(holds(between('-1000000', '1000000'))).toBe(true);
  });

  it('is inclusive at both ends', () => {
    expect(holds(between('-8432', '-8432'))).toBe(true);
  });

  it('compares the magnitude when absolute is set', () => {
    expect(holds(between('5000', null, true))).toBe(true);
    expect(holds(between('5000', null, true), { amountMinor: 8_432n })).toBe(true);
    expect(holds(between('9000', null, true))).toBe(false);
  });

  it('handles an amount no Number could hold', () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    expect(holds(between('9007199254740993', null), { amountMinor: huge })).toBe(true);
    expect(holds(between('9007199254740994', null), { amountMinor: huge })).toBe(false);
  });
});

describe('the remaining condition kinds', () => {
  it('direction: outflow is strictly negative, inflow strictly positive', () => {
    expect(holds({ type: 'direction', direction: 'outflow' })).toBe(true);
    expect(holds({ type: 'direction', direction: 'inflow' })).toBe(false);
    expect(holds({ type: 'direction', direction: 'inflow' }, { amountMinor: 1n })).toBe(true);
    // A zero-amount transaction is neither, and matching both would put it in
    // two mutually exclusive rules at once.
    expect(holds({ type: 'direction', direction: 'inflow' }, { amountMinor: 0n })).toBe(false);
    expect(holds({ type: 'direction', direction: 'outflow' }, { amountMinor: 0n })).toBe(false);
  });

  it('account: matches any of the listed accounts', () => {
    expect(holds({ type: 'account', accountIds: [ACCOUNT_A] })).toBe(true);
    expect(holds({ type: 'account', accountIds: [ACCOUNT_B] })).toBe(false);
    expect(holds({ type: 'account', accountIds: [ACCOUNT_B, ACCOUNT_A] })).toBe(true);
  });

  it('day_of_month: an ordinary range', () => {
    expect(holds({ type: 'day_of_month', from: 15, to: 25 })).toBe(true);
    expect(holds({ type: 'day_of_month', from: 20, to: 20 })).toBe(true);
    expect(holds({ type: 'day_of_month', from: 1, to: 5 })).toBe(false);
  });

  it('day_of_month: a wrapped range means "around the turn of the month"', () => {
    // Rent and payroll land there, so reading `from: 28, to: 3` as an empty range
    // would break the most useful case this condition has.
    const wrapped: RuleCondition = { type: 'day_of_month', from: 28, to: 3 };
    expect(holds(wrapped, { date: DateOnly.parse('2026-05-29') })).toBe(true);
    expect(holds(wrapped, { date: DateOnly.parse('2026-06-02') })).toBe(true);
    expect(holds(wrapped, { date: DateOnly.parse('2026-06-15') })).toBe(false);
  });

  it('provider_category: either level, either case', () => {
    expect(holds({ type: 'provider_category', codes: ['FOOD_AND_DRINK_GROCERIES'] })).toBe(true);
    expect(holds({ type: 'provider_category', codes: ['FOOD_AND_DRINK'] })).toBe(true);
    expect(holds({ type: 'provider_category', codes: ['food_and_drink'] })).toBe(true);
    expect(holds({ type: 'provider_category', codes: ['TRAVEL_FLIGHTS'] })).toBe(false);
    expect(holds({ type: 'provider_category', codes: ['TRAVEL'] }, { providerCodes: [] })).toBe(
      false,
    );
  });

  it('currency: trimmed and case-folded', () => {
    expect(holds({ type: 'currency', currency: 'USD' })).toBe(true);
    expect(holds({ type: 'currency', currency: 'usd' })).toBe(true);
    expect(holds({ type: 'currency', currency: 'EUR' })).toBe(false);
    expect(holds({ type: 'currency', currency: 'USD' }, { currency: ' usd ' })).toBe(true);
  });

  it('is_transfer: both polarities', () => {
    expect(holds({ type: 'is_transfer', value: false })).toBe(true);
    expect(holds({ type: 'is_transfer', value: true })).toBe(false);
    expect(holds({ type: 'is_transfer', value: true }, { isTransfer: true })).toBe(true);
  });
});

describe('combining conditions', () => {
  it('needs every condition in `all`', () => {
    const conditions = {
      all: [
        { type: 'payee', match: 'contains', value: 'WHOLE FOODS' },
        { type: 'direction', direction: 'outflow' },
      ],
      any: [],
    } as Rule['conditions'];
    expect(matchRule(rule({ conditions }), subject()).matched).toBe(true);
    expect(matchRule(rule({ conditions }), subject({ amountMinor: 500n })).matched).toBe(false);
  });

  it('needs one condition in `any`', () => {
    const conditions = {
      all: [],
      any: [
        { type: 'payee', match: 'contains', value: 'CHEVRON' },
        { type: 'payee', match: 'contains', value: 'WHOLE FOODS' },
      ],
    } as Rule['conditions'];
    expect(matchRule(rule({ conditions }), subject()).matched).toBe(true);
    expect(
      matchRule(rule({ conditions }), subject({ payee: 'IKEA', cleanedPayee: 'IKEA' })).matched,
    ).toBe(false);
  });

  it('needs both halves when both are populated', () => {
    const conditions = {
      all: [{ type: 'direction', direction: 'outflow' }],
      any: [{ type: 'payee', match: 'contains', value: 'CHEVRON' }],
    } as Rule['conditions'];
    // `all` holds, `any` does not.
    expect(matchRule(rule({ conditions }), subject()).matched).toBe(false);
  });

  it('evaluates every condition even once the answer is settled', () => {
    const conditions = {
      all: [
        { type: 'payee', match: 'contains', value: 'NOTHING LIKE THIS' },
        { type: 'direction', direction: 'outflow' },
        { type: 'currency', currency: 'USD' },
      ],
      any: [{ type: 'is_transfer', value: false }],
    } as Rule['conditions'];
    const match = matchRule(rule({ conditions }), subject());
    expect(match.matched).toBe(false);
    // Four outcomes, not one: the first `all` condition failed, and the other
    // three were still evaluated because the explanation needs them.
    expect(match.outcomes).toHaveLength(4);
    expect(match.outcomes.map((outcome) => outcome.matched)).toEqual([false, true, true, true]);
  });

  it('reports the rule id it was asked about', () => {
    expect(matchRule(rule(), subject()).ruleId).toBe(rule().id);
  });
});

describe('evaluation order', () => {
  it('drops disabled rules entirely', () => {
    const ordered = orderRules([
      rule({ enabled: false }),
      rule({ id: '00000000-0000-7000-8000-00000000c002' }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['00000000-0000-7000-8000-00000000c002']);
  });

  it('sorts by ascending priority: lower number wins', () => {
    const ordered = orderRules([
      rule({ id: '00000000-0000-7000-8000-00000000c003', priority: 300 }),
      rule({ id: '00000000-0000-7000-8000-00000000c001', priority: 10 }),
      rule({ id: '00000000-0000-7000-8000-00000000c002', priority: 100 }),
    ]);
    expect(ordered.map((entry) => entry.priority)).toEqual([10, 100, 300]);
  });

  it('breaks a priority tie by id, and therefore identically on every run', () => {
    const rules = [
      rule({ id: '00000000-0000-7000-8000-00000000c009', priority: 50 }),
      rule({ id: '00000000-0000-7000-8000-00000000c001', priority: 50 }),
    ];
    const forwards = orderRules(rules).map((entry) => entry.id);
    const backwards = orderRules([...rules].reverse()).map((entry) => entry.id);
    expect(forwards).toEqual(backwards);
    expect(forwards[0]).toBe('00000000-0000-7000-8000-00000000c001');
  });

  it('does not mutate the list it was handed', () => {
    const rules = [
      rule({ id: '00000000-0000-7000-8000-00000000c009', priority: 300 }),
      rule({ id: '00000000-0000-7000-8000-00000000c001', priority: 10 }),
    ];
    const before = rules.map((entry) => entry.id);
    orderRules(rules);
    expect(rules.map((entry) => entry.id)).toEqual(before);
  });
});

describe('the schema, on the way in', () => {
  it('refuses a rule with no conditions at all', () => {
    // A rule that matches everything is a footgun with no legitimate use, and it
    // would take the category of every transaction in the account.
    expect(conditionsSchema.safeParse({ all: [], any: [] }).success).toBe(false);
    expect(
      conditionsSchema.safeParse({ all: [{ type: 'is_transfer', value: true }], any: [] }).success,
    ).toBe(true);
  });

  it('refuses an amount range that can never match', () => {
    // The check `rules.ts`, OWNERSHIP.md and migration 0006 all cite as the
    // reason conditions are validated jsonb rather than two child tables. It is
    // asserted here because a control nobody has watched fail is not a control.
    const inverted = conditionSchema.safeParse({
      type: 'amount',
      minMinor: '5000',
      maxMinor: '-5000',
      absolute: false,
    });
    expect(inverted.success).toBe(false);
    expect(inverted.error?.issues[0]?.message).toMatch(/never match/u);

    expect(
      conditionSchema.safeParse({ type: 'amount', minMinor: '-5000', maxMinor: '5000' }).success,
    ).toBe(true);
    expect(
      conditionSchema.safeParse({ type: 'amount', minMinor: '5000', maxMinor: null }).success,
    ).toBe(true);
  });

  it('refuses an amount that is not an integer string', () => {
    expect(
      conditionSchema.safeParse({ type: 'amount', minMinor: '12.34', maxMinor: null }).success,
    ).toBe(false);
    expect(
      conditionSchema.safeParse({ type: 'amount', minMinor: 1234, maxMinor: null }).success,
    ).toBe(false);
  });

  it('refuses the regex shapes that make ReDoS possible', () => {
    for (const pattern of ['(a+)+', '(a*)*', '(ab+)+$', '(x+)*']) {
      const parsed = conditionSchema.safeParse({ type: 'payee_regex', pattern });
      expect(parsed.success, pattern).toBe(false);
    }
    expect(conditionSchema.safeParse({ type: 'payee_regex', pattern: '([a-' }).success).toBe(false);
    expect(
      conditionSchema.safeParse({
        type: 'payee_regex',
        pattern: 'A'.repeat(MAX_PATTERN_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      conditionSchema.safeParse({ type: 'payee_regex', pattern: 'WHOLE\\s+FOODS' }).success,
    ).toBe(true);
  });

  it('refuses a rule with no actions, and one with too many', () => {
    expect(ruleSchema.safeParse({ ...rule(), actions: [] }).success).toBe(false);
    expect(
      ruleSchema.safeParse({
        ...rule(),
        actions: Array.from({ length: 9 }, () => ({ type: 'add_tag', tag: 'x' })),
      }).success,
    ).toBe(false);
  });

  it('accepts the round trip a stored rule makes', () => {
    // Validated on write *and* on read (`loadRules`), so what the schema accepts
    // must survive `JSON.parse(JSON.stringify(...))` unchanged — a `bigint` in a
    // condition would not, which is why the amounts are strings.
    const parsed = ruleSchema.parse(rule());
    expect(ruleSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
});

describe('properties', () => {
  const anySubject = fc.record({
    payee: fc.string({ maxLength: 80 }),
    cleanedPayee: fc.string({ maxLength: 80 }),
    amountMinor: fc.bigInt({ min: -10_000_000n, max: 10_000_000n }),
    currency: fc.constantFrom('USD', 'EUR', 'GBP', ''),
    accountId: fc.constantFrom(ACCOUNT_A, ACCOUNT_B),
    date: fc.constantFrom(
      ...['2026-01-01', '2026-02-28', '2026-05-20', '2026-12-31'].map((value) =>
        DateOnly.parse(value),
      ),
    ),
    providerCodes: fc.array(fc.string({ maxLength: 20 }), { maxLength: 3 }),
    isTransfer: fc.boolean(),
  });

  const anyCondition = fc.oneof(
    fc.record({
      type: fc.constant('payee' as const),
      match: fc.constantFrom(
        'contains' as const,
        'not_contains' as const,
        'starts_with' as const,
        'ends_with' as const,
        'equals' as const,
      ),
      value: fc.string({ minLength: 1, maxLength: 20 }),
    }),
    fc.record({
      type: fc.constant('payee_regex' as const),
      pattern: fc.string({ minLength: 1, maxLength: 20 }),
    }),
    fc.record({
      type: fc.constant('amount' as const),
      minMinor: fc.option(fc.bigInt({ min: -1_000_000n, max: 1_000_000n }).map(String), {
        nil: null,
      }),
      maxMinor: fc.option(fc.bigInt({ min: -1_000_000n, max: 1_000_000n }).map(String), {
        nil: null,
      }),
      absolute: fc.boolean(),
    }),
    fc.record({
      type: fc.constant('direction' as const),
      direction: fc.constantFrom('inflow' as const, 'outflow' as const),
    }),
    fc.record({ type: fc.constant('account' as const), accountIds: fc.constant([ACCOUNT_A]) }),
    fc.record({
      type: fc.constant('day_of_month' as const),
      from: fc.integer({ min: 1, max: 31 }),
      to: fc.integer({ min: 1, max: 31 }),
    }),
    fc.record({
      type: fc.constant('provider_category' as const),
      codes: fc.array(fc.string({ minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 3 }),
    }),
    fc.record({ type: fc.constant('currency' as const), currency: fc.constantFrom('USD', 'EUR') }),
    fc.record({ type: fc.constant('is_transfer' as const), value: fc.boolean() }),
  ) as fc.Arbitrary<RuleCondition>;

  it('never throws, whatever the rule and whatever the transaction', () => {
    // Including on a pattern that does not compile, an unreachable day range and
    // an empty currency. One bad rule must cost the user that rule, not the sync.
    fc.assert(
      fc.property(
        fc.array(anyCondition, { minLength: 1, maxLength: 4 }),
        anySubject,
        (conditions, over) => {
          const match = matchRule(
            rule({ conditions: { all: conditions, any: [] } }),
            over as MatchSubject,
          );
          expect(typeof match.matched).toBe('boolean');
          expect(match.outcomes).toHaveLength(conditions.length);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(
        fc.array(anyCondition, { minLength: 1, maxLength: 4 }),
        anySubject,
        (conditions, over) => {
          const candidate = rule({ conditions: { all: conditions, any: [] } });
          expect(matchRule(candidate, over as MatchSubject)).toEqual(
            matchRule(candidate, over as MatchSubject),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never matches on an empty condition set', () => {
    // `conditionsSchema` makes this unreachable through the API; asserted anyway,
    // because the matcher is also called with rules assembled in code.
    expect(matchRule(rule({ conditions: { all: [], any: [] } }), subject()).matched).toBe(true);
    // ...which is precisely why the schema, not the matcher, is the guard: an
    // empty `all` is vacuously true and that cannot be fixed here without making
    // "match everything" unexpressible for a caller that genuinely wants it.
  });
});
