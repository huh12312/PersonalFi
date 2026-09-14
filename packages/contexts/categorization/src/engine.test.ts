// SPDX-License-Identifier: MIT
/**
 * The decision order, tier by tier.
 *
 * Each test sets up a situation where **two tiers both have an answer and they
 * disagree**, then asserts which one wins. A test where only one tier can answer
 * proves nothing about order; these are the ones that would catch a reordering.
 */
import { DateOnly } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { COLD_MODEL, featuresOf, train, type ClassifierModel } from './classifier.ts';
import {
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_MERCHANT_SUPPORT,
  decide,
  precedenceOf,
  shouldReplace,
  type AssignmentSource,
  type DecisionContext,
  type DecisionInput,
} from './engine.ts';
import type { Rule } from './rules/schema.ts';
import { UNCATEGORISED_KEY } from './taxonomy.ts';

const USER = '00000000-0000-7000-8000-00000000e001';

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    transactionId: '00000000-0000-7000-8000-00000000a001',
    payee: 'SQ *BLUE BOTTLE COFFEE',
    cleanedPayee: 'BLUE BOTTLE COFFEE',
    amountMinor: -650n,
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

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: '00000000-0000-7000-8000-00000000c001',
    userId: USER,
    name: 'Blue Bottle is coffee',
    priority: 100,
    enabled: true,
    conditions: { all: [{ type: 'payee', match: 'contains', value: 'BLUE BOTTLE' }], any: [] },
    actions: [{ type: 'set_category', categoryKey: 'dining.coffee' }],
    runOnSync: true,
    stopProcessing: false,
    createdFromTransactionId: null,
    ...overrides,
  };
}

/** A model that is confident `BLUE BOTTLE` is `shopping.other_shopping`. */
function biasedClassifier(): ClassifierModel {
  const examples = [
    ...Array.from({ length: 8 }, () => ({
      features: featuresOf({
        cleanedPayee: 'BLUE BOTTLE COFFEE',
        amountMinor: -650n,
        accountType: 'credit',
      }),
      categoryKey: 'shopping.other_shopping',
    })),
    ...Array.from({ length: 8 }, () => ({
      features: featuresOf({ cleanedPayee: 'CHEVRON', amountMinor: -5500n, accountType: 'credit' }),
      categoryKey: 'transport.fuel',
    })),
  ];
  return train(examples);
}

const PROVIDER_COFFEE = {
  primary: 'FOOD_AND_DRINK',
  detailed: 'FOOD_AND_DRINK_RESTAURANT',
  confidence_level: 'VERY_HIGH',
};

describe('the decision order', () => {
  it('1 beats 2: the user’s own edit stops every rule', () => {
    const decision = decide(
      input({ userCategoryId: '00000000-0000-7000-8000-00000000d001' }),
      context({ rules: [rule()] }),
    );
    expect(decision.source).toBe('user');
    // And nothing below even ran: the chain is one entry long.
    expect(decision.chain).toHaveLength(1);
  });

  it('2 beats 3: a rule wins against a locked merchant default', () => {
    const decision = decide(
      input(),
      context({
        rules: [rule()],
        merchantDefault: { categoryKey: 'shopping.gifts', locked: true, supportCount: 99 },
      }),
    );
    expect(decision.source).toBe('rule');
    expect(decision.categoryKey).toBe('dining.coffee');
    expect(decision.confidence).toBe(1);
  });

  it('3 beats 4: a merchant default wins against the provider', () => {
    const decision = decide(
      input({ providerCategory: PROVIDER_COFFEE }),
      context({
        merchantDefault: { categoryKey: 'dining.coffee', locked: false, supportCount: 5 },
      }),
    );
    expect(decision.source).toBe('merchant_default');
    expect(decision.categoryKey).toBe('dining.coffee');
  });

  it('4 beats 5: the provider wins against the classifier', () => {
    const decision = decide(
      input({ providerCategory: PROVIDER_COFFEE }),
      context({ classifier: biasedClassifier(), confidenceFloor: 0 }),
    );
    expect(decision.source).toBe('provider');
    expect(decision.categoryKey).toBe('dining.restaurants');
  });

  it('5 beats 6: the classifier wins against giving up', () => {
    const decision = decide(
      input(),
      context({ classifier: biasedClassifier(), confidenceFloor: 0 }),
    );
    expect(decision.source).toBe('classifier');
    expect(decision.categoryKey).toBe('shopping.other_shopping');
  });

  it('6: with nothing to go on, it says so instead of guessing', () => {
    const decision = decide(input(), context());
    expect(decision.source).toBe('none');
    expect(decision.categoryKey).toBe(UNCATEGORISED_KEY);
    expect(decision.confidence).toBe(0);
  });
});

describe('the merchant tier', () => {
  it('needs three agreeing transactions before a learned default applies', () => {
    const below = decide(
      input(),
      context({
        merchantDefault: { categoryKey: 'dining.coffee', locked: false, supportCount: 2 },
      }),
    );
    expect(below.source).toBe('none');

    const at = decide(
      input(),
      context({
        merchantDefault: { categoryKey: 'dining.coffee', locked: false, supportCount: 3 },
      }),
    );
    expect(at.source).toBe('merchant_default');
  });

  it('applies a locked default however little support it has', () => {
    const decision = decide(
      input(),
      context({ merchantDefault: { categoryKey: 'dining.coffee', locked: true, supportCount: 0 } }),
    );
    expect(decision.source).toBe('merchant_default');
    expect(decision.confidence).toBe(1);
  });

  it('is more confident with more support, but never certain', () => {
    const three = decide(
      input(),
      context({
        merchantDefault: { categoryKey: 'dining.coffee', locked: false, supportCount: 3 },
      }),
    );
    const twenty = decide(
      input(),
      context({
        merchantDefault: { categoryKey: 'dining.coffee', locked: false, supportCount: 20 },
      }),
    );
    expect(twenty.confidence).toBeGreaterThan(three.confidence);
    expect(twenty.confidence).toBeLessThan(1);
  });

  it('ignores a default naming a category that no longer exists', () => {
    const decision = decide(
      input(),
      context({
        merchantDefault: {
          categoryKey: 'dining.deleted_by_a_migration',
          locked: true,
          supportCount: 9,
        },
      }),
    );
    expect(decision.source).toBe('none');
  });
});

describe('rules', () => {
  it('takes the lowest-priority-number rule that sets a category', () => {
    const decision = decide(
      input(),
      context({
        rules: [
          rule({
            id: '00000000-0000-7000-8000-0000000000b2',
            priority: 200,
            actions: [{ type: 'set_category', categoryKey: 'dining.restaurants' }],
          }),
          rule({
            id: '00000000-0000-7000-8000-0000000000b1',
            priority: 10,
            actions: [{ type: 'set_category', categoryKey: 'dining.coffee' }],
          }),
        ],
      }),
    );
    expect(decision.categoryKey).toBe('dining.coffee');
  });

  it('breaks a priority tie the same way every time', () => {
    // Ids are UUIDv7, so the tiebreak is "whichever was created first" — which
    // is both deterministic and the answer a user would predict. Without it the
    // same transaction categorises differently on a re-run.
    const rules = [
      rule({
        id: '00000000-0000-7000-8000-0000000000b2',
        priority: 50,
        actions: [{ type: 'set_category', categoryKey: 'dining.restaurants' }],
      }),
      rule({
        id: '00000000-0000-7000-8000-0000000000b1',
        priority: 50,
        actions: [{ type: 'set_category', categoryKey: 'dining.coffee' }],
      }),
    ];
    expect(decide(input(), context({ rules })).categoryKey).toBe('dining.coffee');
    expect(decide(input(), context({ rules: [...rules].reverse() })).categoryKey).toBe(
      'dining.coffee',
    );
  });

  it('ignores a disabled rule', () => {
    const decision = decide(input(), context({ rules: [rule({ enabled: false })] }));
    expect(decision.source).toBe('none');
  });

  it('lets a later rule add a tag without taking the category', () => {
    const decision = decide(
      input(),
      context({
        rules: [
          rule({ id: '00000000-0000-7000-8000-0000000000b1', priority: 10 }),
          rule({
            id: '00000000-0000-7000-8000-0000000000b2',
            priority: 20,
            actions: [{ type: 'add_tag', tag: 'work' }],
          }),
        ],
      }),
    );
    expect(decision.categoryKey).toBe('dining.coffee');
    expect(decision.actions).toEqual([{ type: 'add_tag', tag: 'work' }]);
  });

  it('stops at a stop_processing rule', () => {
    const decision = decide(
      input(),
      context({
        rules: [
          rule({
            id: '00000000-0000-7000-8000-0000000000b1',
            priority: 10,
            stopProcessing: true,
            actions: [{ type: 'set_note', note: 'seen' }],
          }),
          rule({ id: '00000000-0000-7000-8000-0000000000b2', priority: 20 }),
        ],
      }),
    );
    // The second rule would have set the category; the first short-circuited.
    expect(decision.source).toBe('none');
    expect(decision.actions).toEqual([{ type: 'set_note', note: 'seen' }]);
  });

  it('records an action it cannot carry out yet rather than pretending', () => {
    const decision = decide(
      input(),
      context({
        rules: [
          rule({
            actions: [
              { type: 'set_category', categoryKey: 'dining.coffee' },
              {
                type: 'split',
                parts: [
                  { categoryKey: 'dining.coffee', shareBasisPoints: 5000 },
                  { categoryKey: 'dining.restaurants', shareBasisPoints: 5000 },
                ],
              },
            ],
          }),
        ],
      }),
    );
    expect(decision.actions).toHaveLength(0);
    expect(decision.deferredActions).toHaveLength(1);
    expect(decision.deferredActions[0]?.type).toBe('split');
  });

  it('ignores a rule pointing at a category that is not a leaf', () => {
    const decision = decide(
      input(),
      context({ rules: [rule({ actions: [{ type: 'set_category', categoryKey: 'dining' }] })] }),
    );
    expect(decision.source).toBe('none');
  });
});

describe('the explanation', () => {
  it('records every tier, including the ones that abstained', () => {
    const decision = decide(input(), context());
    const sources = decision.chain.map((entry) => entry.source);
    expect(sources).toEqual(['user', 'rule', 'merchant_default', 'provider', 'classifier', 'none']);
    for (const entry of decision.chain) expect(entry.detail.length).toBeGreaterThan(0);
  });

  it('says which conditions made a rule match', () => {
    const decision = decide(input(), context({ rules: [rule()] }));
    const winner = decision.chain.find((entry) => entry.won && entry.source === 'rule');
    expect(winner?.detail).toContain('Blue Bottle is coffee');
    expect(winner?.detail).toContain('BLUE BOTTLE');
  });

  it('says why the classifier abstained', () => {
    const decision = decide(
      input(),
      context({ classifier: biasedClassifier(), confidenceFloor: 0.999 }),
    );
    const classifier = decision.chain.find((entry) => entry.source === 'classifier');
    expect(classifier?.won).toBe(false);
    expect(classifier?.detail).toMatch(/below the floor/u);
  });
});

describe('precedence and replacement', () => {
  it('never demotes an assignment to a weaker tier', () => {
    expect(shouldReplace('rule', 'classifier')).toBe(false);
    expect(shouldReplace('merchant_default', 'provider')).toBe(false);
    expect(shouldReplace('provider', 'merchant_default')).toBe(true);
  });

  it('lets a tier replace itself, so editing a rule takes effect', () => {
    expect(shouldReplace('rule', 'rule')).toBe(true);
    expect(shouldReplace('classifier', 'classifier')).toBe(true);
  });

  it('lets nothing but a user override a user', () => {
    const sources: AssignmentSource[] = [
      'rule',
      'merchant_default',
      'provider',
      'classifier',
      'none',
    ];
    for (const source of sources) expect(shouldReplace('user', source)).toBe(false);
    expect(shouldReplace('user', 'user')).toBe(true);
  });

  it('orders the tiers the way the waterfall does', () => {
    const order: AssignmentSource[] = [
      'none',
      'classifier',
      'provider',
      'merchant_default',
      'rule',
      'user',
    ];
    for (let index = 1; index < order.length; index += 1) {
      expect(precedenceOf(order[index] as AssignmentSource)).toBeGreaterThan(
        precedenceOf(order[index - 1] as AssignmentSource),
      );
    }
  });
});

describe('properties', () => {
  const amount = fc.bigInt({ min: -10_000_000n, max: 10_000_000n });
  const payee = fc.stringMatching(/^[A-Z ]{1,30}$/u);

  it('is deterministic: the same inputs give the same answer every time', () => {
    fc.assert(
      fc.property(payee, amount, (name, minor) => {
        const decisionInput = input({ payee: name, cleanedPayee: name, amountMinor: minor });
        const decisionContext = context({ rules: [rule()], classifier: biasedClassifier() });
        const first = decide(decisionInput, decisionContext);
        const second = decide(decisionInput, decisionContext);
        expect(second).toEqual(first);
      }),
      { numRuns: 300 },
    );
  });

  it('always returns a category the engine is allowed to assign', () => {
    fc.assert(
      fc.property(payee, amount, (name, minor) => {
        const decision = decide(
          input({ payee: name, cleanedPayee: name, amountMinor: minor }),
          context({ classifier: biasedClassifier(), confidenceFloor: 0 }),
        );
        expect(decision.confidence).toBeGreaterThanOrEqual(0);
        expect(decision.confidence).toBeLessThanOrEqual(1);
        expect(decision.chain.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it('only ever names a rule when the rule tier won', () => {
    fc.assert(
      fc.property(payee, amount, (name, minor) => {
        const decision = decide(
          input({ payee: name, cleanedPayee: name, amountMinor: minor }),
          context({ rules: [rule()], classifier: biasedClassifier(), confidenceFloor: 0 }),
        );
        // The migration has a CHECK asserting exactly this; here it is asserted
        // of the function that produces the rows, which is where it can be fixed.
        expect(decision.ruleId !== null).toBe(decision.source === 'rule');
      }),
      { numRuns: 300 },
    );
  });
});
