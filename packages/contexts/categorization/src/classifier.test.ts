// SPDX-License-Identifier: MIT
/**
 * The classifier, and the three gates that keep it quiet.
 *
 * 04 §5.2 hedges this tier heavily — "optional, off by default", "below a
 * threshold it stays uncategorized rather than guessing", "**never silently
 * apply**" — so most of this file is about the cases where it must say nothing.
 * The two tests worth reading before the rest are:
 *
 *   * *"a cold model abstains on everything"*, which is the state the app ships
 *     in and the sabotage check on the whole waterfall; and
 *   * *"confidence does not move when the taxonomy grows"*, which is the
 *     regression test for the softmax-over-categories bug described in
 *     `classifier.ts`'s header. A confidence that falls because an unrelated
 *     picklist gained a row is not a confidence, and every downstream number —
 *     the review queue's sort, a budget's "how much of this is guessed?" — is
 *     computed from it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  COLD_MODEL,
  MIN_EXAMPLES_PER_CATEGORY,
  CONTEXT_ONLY_CEILING,
  MIN_MARGIN,
  PAYEE_MARGIN_SCALE,
  amountBucket,
  confidenceFromMargin,
  dayOfMonthBucket,
  featuresOf,
  predict,
  train,
  type ClassifierModel,
  type TrainingExample,
} from './classifier.ts';

/** `count` identical examples of one category. The corpus shape a user produces. */
function examples(
  count: number,
  categoryKey: string,
  features: readonly string[],
): TrainingExample[] {
  return Array.from({ length: count }, () => ({ features: [...features], categoryKey }));
}

/**
 * Two well-separated categories: the happy path every other test deviates from.
 *
 * Everything except the payee token is deliberately *shared* — same bucket, same
 * direction, same account type — so exactly one feature separates the two
 * categories and the explanation has a single correct answer.
 */
const BASE_CORPUS: readonly TrainingExample[] = [
  ...examples(6, 'family.pets', ['t:chewy', 'b:2', 'd:out', 'a:credit']),
  ...examples(6, 'transport.fuel', ['t:chevron', 'b:2', 'd:out', 'a:credit']),
];

const SEPARATED: ClassifierModel = train(BASE_CORPUS);

const CHEWY = ['t:chewy', 'b:2', 'd:out', 'a:credit'];

describe('features', () => {
  it('tokenises the cleaned payee through the fingerprint', () => {
    const features = featuresOf({
      cleanedPayee: 'CHEWY.COM',
      amountMinor: -6_500n,
      accountType: 'credit',
    });
    expect(features).toContain('t:chewy');
    expect(features).toContain('t:com');
  });

  it('adds the amount bucket, the direction and the account type', () => {
    const features = featuresOf({
      cleanedPayee: 'CHEWY',
      amountMinor: -6_500n,
      accountType: 'credit',
    });
    expect(features).toContain('d:out');
    expect(features).toContain('a:credit');
    expect(features.some((feature) => feature.startsWith('b:'))).toBe(true);
  });

  it('adds the MCC’s category when an import carried one', () => {
    const features = featuresOf({
      cleanedPayee: 'UNKNOWN PAYEE',
      amountMinor: -4_200n,
      accountType: 'credit',
      mcc: '5411',
    });
    expect(features).toContain('m:groceries.supermarkets');
  });

  it('omits the account-type feature rather than inventing an empty one', () => {
    // `a:` with nothing after it would be a feature every account-less row
    // shared, which is a feature that means nothing and dilutes the vocabulary.
    for (const accountType of [null, '']) {
      const features = featuresOf({ cleanedPayee: 'CHEWY', amountMinor: -1n, accountType });
      expect(features.some((feature) => feature.startsWith('a:'))).toBe(false);
    }
  });

  it('counts a repeated word once', () => {
    const features = featuresOf({
      cleanedPayee: 'SAFEWAY SAFEWAY',
      amountMinor: -1n,
      accountType: null,
    });
    expect(features.filter((feature) => feature === 't:safeway')).toHaveLength(1);
    expect(new Set(features).size).toBe(features.length);
  });

  it('reads the direction off the sign, house convention', () => {
    expect(featuresOf({ cleanedPayee: 'X', amountMinor: -1n, accountType: null })).toContain(
      'd:out',
    );
    expect(featuresOf({ cleanedPayee: 'X', amountMinor: 1n, accountType: null })).toContain('d:in');
  });
});

describe('the amount bucket', () => {
  it('is zero for a zero amount', () => {
    expect(amountBucket(0n)).toBe('0');
  });

  it('ignores the sign: a $40 refund and a $40 charge are the same size', () => {
    expect(amountBucket(-4_000n)).toBe(amountBucket(4_000n));
  });

  it('puts a coffee and a lunch together and a coffee and a flight apart', () => {
    // Roughly one bucket per tripling. There are boundaries, and two amounts
    // either side of one land in different buckets however close they are — that
    // is true of every bucketing and is not what this feature is for. What it
    // must get right is the *scale*: $5 and $12 are the same kind of purchase,
    // $4 and $400 are not.
    expect(amountBucket(-500n)).toBe(amountBucket(-1_200n));
    expect(amountBucket(-400n)).not.toBe(amountBucket(-40_000n));
  });

  it('never decreases as the amount grows', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000_000n }),
        fc.bigInt({ min: 0n, max: 100_000_000n }),
        (a, b) => {
          const [small, large] = a <= b ? [a, b] : [b, a];
          expect(Number(amountBucket(small))).toBeLessThanOrEqual(Number(amountBucket(large)));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('training', () => {
  it('counts categories, features and the vocabulary', () => {
    const model = train([
      ...examples(3, 'dining.coffee', ['t:philz', 'b:1']),
      ...examples(2, 'transport.fuel', ['t:chevron', 'b:4']),
    ]);
    expect(model.totalExamples).toBe(5);
    expect(model.categoryCounts).toEqual({ 'dining.coffee': 3, 'transport.fuel': 2 });
    expect(model.featureCounts['t:philz']).toEqual({ 'dining.coffee': 3 });
    expect(model.vocabulary).toBe(4);
  });

  it('is a pure function of its examples', () => {
    // The claim `retrainClassifier` rests on: a bug in training is fixed by
    // re-running training, not by repairing accumulated state.
    const corpus = [...examples(4, 'a.x', ['t:one']), ...examples(4, 'b.y', ['t:two'])];
    expect(train(corpus)).toEqual(train([...corpus]));
    expect(train([...corpus].reverse())).toEqual(train(corpus));
  });

  it('produces the cold model’s shape from an empty corpus', () => {
    const model = train([]);
    expect(model.totalExamples).toBe(0);
    expect(predict(model, CHEWY, 0).kind).toBe('abstained');
  });
});

describe('abstaining', () => {
  it('a cold model abstains on everything, whatever the floor', () => {
    // The state the app ships in. If this ever predicts, the classifier is
    // inventing categories for a user who has confirmed nothing.
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 8 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (features, floor) => {
          const outcome = predict(COLD_MODEL, features, floor);
          expect(outcome.kind).toBe('abstained');
        },
      ),
      { numRuns: 300 },
    );
    expect(predict(COLD_MODEL, CHEWY, 0)).toMatchObject({ kind: 'abstained', categoryKey: null });
  });

  it('abstains when it has no features to reason from', () => {
    expect(predict(SEPARATED, [], 0)).toMatchObject({
      kind: 'abstained',
      reason: 'no usable features',
    });
  });

  it('abstains when only one category has ever been confirmed', () => {
    // One category is not a classifier, it is a constant. Predicting it would
    // look like learning and be worth nothing.
    const single = train(examples(20, 'dining.coffee', ['t:philz', 'b:1']));
    expect(predict(single, ['t:philz'], 0)).toMatchObject({
      kind: 'abstained',
      reason: 'fewer than two categories have confirmed examples',
    });
  });

  it('abstains when the winning category is under-supported', () => {
    const thin = train([
      ...examples(MIN_EXAMPLES_PER_CATEGORY - 1, 'shopping.gifts', [
        't:alpha',
        't:alphb',
        't:alphc',
      ]),
      ...examples(10, 'dining.coffee', ['t:beta', 'b:1', 'd:out']),
    ]);
    const outcome = predict(thin, ['t:alpha', 't:alphb', 't:alphc'], 0);
    expect(outcome.kind).toBe('abstained');
    expect(outcome).toMatchObject({ categoryKey: 'shopping.gifts' });
    if (outcome.kind === 'abstained') expect(outcome.reason).toMatch(/confirmed example/u);
  });

  it('abstains when two categories are indistinguishable', () => {
    // Identical evidence on both sides. A coin flip presented as an answer is
    // worse than no answer, because the user has no way to know which it was.
    const tied = train([
      ...examples(5, 'dining.coffee', ['t:generic', 'b:1', 'd:out']),
      ...examples(5, 'dining.fast_food', ['t:generic', 'b:1', 'd:out']),
    ]);
    const outcome = predict(tied, ['t:generic', 'b:1', 'd:out'], 0);
    expect(outcome.kind).toBe('abstained');
    if (outcome.kind === 'abstained') expect(outcome.reason).toMatch(/too close to call/u);
  });

  it('abstains below the caller’s floor, and names the number', () => {
    const outcome = predict(SEPARATED, CHEWY, 0.995);
    expect(outcome.kind).toBe('abstained');
    if (outcome.kind === 'abstained') {
      expect(outcome.reason).toMatch(/below the floor of 0\.995/u);
      // It still says which category it *would* have chosen: that is what the
      // review queue shows as a suggestion the user can accept in one tap.
      expect(outcome.categoryKey).toBe('family.pets');
    }
  });
});

describe('predicting', () => {
  it('gets a well-separated case right, above the default floor', () => {
    const outcome = predict(SEPARATED, CHEWY, 0.6);
    expect(outcome.kind).toBe('predicted');
    if (outcome.kind !== 'predicted') return;
    expect(outcome.categoryKey).toBe('family.pets');
    expect(outcome.runnerUp).toBe('transport.fuel');
    expect(outcome.confidence).toBeGreaterThanOrEqual(0.6);
    expect(outcome.margin).toBeGreaterThan(MIN_MARGIN);
  });

  it('explains itself with the features that actually separated the answer', () => {
    const outcome = predict(SEPARATED, CHEWY, 0.6);
    if (outcome.kind !== 'predicted') throw new Error('expected a prediction');
    expect(outcome.topFeatures).toHaveLength(3);
    // `t:chewy` is the only token the two categories disagree about. `b:2`,
    // `d:out` and `a:credit` are shared, so they are equally likely under both
    // and explain nothing — ranked by absolute weight they would still look
    // large, which is exactly the mistake `predict` avoids by ranking on the
    // difference against the runner-up.
    expect(outcome.topFeatures[0]?.feature).toBe('t:chewy');
    expect(outcome.topFeatures[0]?.weight).toBeGreaterThan(0);
    for (const contribution of outcome.topFeatures.slice(1)) {
      expect(contribution.weight).toBeCloseTo(0, 10);
    }
  });

  it('does not let a big category swallow a small one', () => {
    // The bug this pins shipped in the first draft of `classifier.ts`: tempering
    // the likelihood while leaving the prior at full strength made the model
    // predict whichever category the user spends in most, regardless of payee.
    const lopsided = train([
      ...examples(40, 'groceries.supermarkets', ['t:alpha', 'b:2', 'd:out']),
      ...examples(4, 'health.pharmacy', ['t:beta', 't:betb', 't:betc']),
    ]);

    const small = predict(lopsided, ['t:beta', 't:betb', 't:betc'], 0.6);
    expect(small).toMatchObject({ kind: 'predicted', categoryKey: 'health.pharmacy' });

    // ...and the majority category still wins on its own evidence.
    const large = predict(lopsided, ['t:alpha', 'b:2', 'd:out'], 0.6);
    expect(large).toMatchObject({ kind: 'predicted', categoryKey: 'groceries.supermarkets' });
  });

  it('confidence does not move when the taxonomy grows', () => {
    // The regression test for the softmax-over-categories bug. Twenty unrelated
    // categories are added to the corpus; the evidence about Chewy is unchanged,
    // so the confidence about Chewy must be too. Under a softmax it would fall
    // below the 0.6 floor and the tier would go silent for no reason a user
    // could ever discover.
    const crowded = train([
      ...BASE_CORPUS,
      ...Array.from({ length: 20 }, (_unused, index) =>
        examples(3, `filler.category_${String(index)}`, [`t:filler${String(index)}`, 'b:9']),
      ).flat(),
    ]);

    const before = predict(SEPARATED, CHEWY, 0.6);
    const after = predict(crowded, CHEWY, 0.6);
    expect(before.kind).toBe('predicted');
    expect(after.kind).toBe('predicted');
    if (before.kind !== 'predicted' || after.kind !== 'predicted') return;
    expect(after.categoryKey).toBe('family.pets');
    expect(Math.abs(after.confidence - before.confidence)).toBeLessThan(0.05);
    expect(after.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('breaks a perfect tie the same way every time', () => {
    // Scores sort by value then by key, so two categories that genuinely tie
    // resolve deterministically — and then abstain on the margin gate anyway.
    const tied = train([
      ...examples(5, 'b.second', ['t:generic']),
      ...examples(5, 'a.first', ['t:generic']),
    ]);
    expect(predict(tied, ['t:generic'], 0)).toEqual(predict(tied, ['t:generic'], 0));
  });
});

describe('confidence', () => {
  it('is a logistic of the margin, not of the category count (WP 11.1 slope)', () => {
    // The curve WP 11.1 re-derived (classifier.ts, "The calibration"):
    // logistic(PAYEE_MARGIN_SCALE × margin) for a payee-evidenced prediction.
    expect(PAYEE_MARGIN_SCALE).toBe(7);
    expect(confidenceFromMargin(0)).toBeCloseTo(0.5, 10);
    expect(confidenceFromMargin(MIN_MARGIN)).toBeCloseTo(0.636, 2);
    expect(confidenceFromMargin(0.19)).toBeCloseTo(0.791, 2);
    expect(confidenceFromMargin(0.5)).toBeCloseTo(0.971, 2);
  });

  it('caps a context-only prediction at a coin flip, below the default floor', () => {
    expect(CONTEXT_ONLY_CEILING).toBe(0.5);
    for (const margin of [0, 0.1, 0.5, 2, Number.POSITIVE_INFINITY]) {
      expect(confidenceFromMargin(margin, false)).toBeLessThanOrEqual(CONTEXT_ONLY_CEILING);
      expect(confidenceFromMargin(margin, false)).toBeLessThan(0.6);
    }
  });

  it('is monotone in the margin within each segment, and payee evidence never lowers it', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 5, noNaN: true }),
        fc.double({ min: 0, max: 5, noNaN: true }),
        fc.boolean(),
        (a, b, payee) => {
          const [small, large] = a <= b ? [a, b] : [b, a];
          expect(confidenceFromMargin(small, payee)).toBeLessThanOrEqual(
            confidenceFromMargin(large, payee),
          );
          expect(confidenceFromMargin(a, false)).toBeLessThanOrEqual(confidenceFromMargin(a, true));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('is monotone in the margin', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 5, noNaN: true }),
        fc.double({ min: 0, max: 5, noNaN: true }),
        (a, b) => {
          const [small, large] = a <= b ? [a, b] : [b, a];
          expect(confidenceFromMargin(small)).toBeLessThanOrEqual(confidenceFromMargin(large));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never claims certainty', () => {
    // 1.0 is reserved for the tiers that are instructions rather than estimates:
    // a user's own edit, and a user's own rule.
    expect(confidenceFromMargin(Number.POSITIVE_INFINITY)).toBe(0.99);
    expect(confidenceFromMargin(1000)).toBeLessThanOrEqual(0.99);
    fc.assert(
      fc.property(fc.double({ min: -50, max: 50, noNaN: true }), (margin) => {
        const confidence = confidenceFromMargin(margin);
        expect(confidence).toBeGreaterThan(0);
        expect(confidence).toBeLessThanOrEqual(0.99);
      }),
      { numRuns: 300 },
    );
  });
});

describe('properties', () => {
  const corpus = fc
    .array(
      fc.record({
        categoryKey: fc.constantFrom(
          'dining.coffee',
          'transport.fuel',
          'family.pets',
          'shopping.gifts',
        ),
        features: fc.array(fc.constantFrom('t:a', 't:b', 't:c', 'b:1', 'b:4', 'd:out', 'd:in'), {
          minLength: 1,
          maxLength: 5,
        }),
      }),
      { maxLength: 40 },
    )
    .map((entries) => train(entries));

  const query = fc.array(fc.constantFrom('t:a', 't:b', 't:c', 'b:1', 'b:4', 'd:out'), {
    maxLength: 5,
  });

  it('every prediction clears all three gates', () => {
    fc.assert(
      fc.property(
        corpus,
        query,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (model, features, floor) => {
          const outcome = predict(model, features, floor);
          if (outcome.kind !== 'predicted') return;
          expect(model.categoryCounts[outcome.categoryKey] ?? 0).toBeGreaterThanOrEqual(
            MIN_EXAMPLES_PER_CATEGORY,
          );
          expect(outcome.margin).toBeGreaterThanOrEqual(MIN_MARGIN);
          expect(outcome.confidence).toBeGreaterThanOrEqual(floor);
          expect(outcome.confidence).toBeLessThanOrEqual(0.99);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('raising the floor can only ever remove predictions', () => {
    // The operating point 07 §2.12 asks for: precision weighted far above
    // recall, tunable by one number, with no surprises in between.
    fc.assert(
      fc.property(corpus, query, (model, features) => {
        const loose = predict(model, features, 0);
        const strict = predict(model, features, 0.9);
        if (strict.kind === 'predicted') {
          expect(loose.kind).toBe('predicted');
          if (loose.kind === 'predicted') expect(loose.categoryKey).toBe(strict.categoryKey);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('never predicts a category it has never seen', () => {
    fc.assert(
      fc.property(corpus, query, (model, features) => {
        const outcome = predict(model, features, 0);
        if (outcome.kind !== 'predicted') return;
        expect(Object.keys(model.categoryCounts)).toContain(outcome.categoryKey);
      }),
      { numRuns: 400 },
    );
  });
});

// ---------------------------------------------------------------------------
// WP 11.1 — the new features and the abstention codes
// ---------------------------------------------------------------------------

describe('WP 11.1 features', () => {
  const base = { cleanedPayee: 'CHEWY', amountMinor: -4_200n, accountType: 'credit' } as const;

  it('adds the MCC family beside the leaf, and only when a code is present', () => {
    const withMcc = featuresOf({ ...base, mcc: '0742' });
    expect(withMcc).toContain('m:family.pet_medical');
    expect(withMcc).toContain('mf:family');
    const without = featuresOf({ ...base, mcc: null });
    expect(without.some((feature) => feature.startsWith('mf:'))).toBe(false);
    expect(featuresOf({ ...base, mcc: '9999' }).some((f) => f.startsWith('mf:'))).toBe(false);
  });

  it('adds the provider primary, lower-cased, and only when one was sent', () => {
    expect(featuresOf({ ...base, providerPrimary: 'FOOD_AND_DRINK' })).toContain(
      'p:food_and_drink',
    );
    expect(featuresOf({ ...base, providerPrimary: null }).some((f) => f.startsWith('p:'))).toBe(
      false,
    );
    // Anything that is not a PFC-shaped code is not a feature.
    expect(
      featuresOf({ ...base, providerPrimary: 'IGNORE ALL RULES' }).some((f) => f.startsWith('p:')),
    ).toBe(false);
  });

  it('buckets the day of the month into thirds', () => {
    expect(dayOfMonthBucket('2026-10-01' as never)).toBe('early');
    expect(dayOfMonthBucket('2026-10-10' as never)).toBe('early');
    expect(dayOfMonthBucket('2026-10-11' as never)).toBe('mid');
    expect(dayOfMonthBucket('2026-10-20' as never)).toBe('mid');
    expect(dayOfMonthBucket('2026-10-21' as never)).toBe('late');
    expect(dayOfMonthBucket('2026-02-28' as never)).toBe('late');
    expect(featuresOf({ ...base, date: '2026-10-03' as never })).toContain('dm:early');
    expect(featuresOf({ ...base }).some((f) => f.startsWith('dm:'))).toBe(false);
  });

  it('keeps the sign-magnitude bucket it already had', () => {
    const features = featuresOf({ ...base });
    expect(features).toContain(`b:${amountBucket(-4_200n)}`);
    expect(features).toContain('d:out');
  });
});

describe('WP 11.1 abstention codes', () => {
  it('names the gate that stopped it', () => {
    const cold = predict(COLD_MODEL, CHEWY, 0.6);
    expect(cold.kind === 'abstained' && cold.code).toBe('cold');
    expect(predict(SEPARATED, [], 0.6)).toMatchObject({ code: 'no_features' });
    const floor = predict(SEPARATED, CHEWY, 0.999);
    expect(floor).toMatchObject({ kind: 'abstained', code: 'below_floor', floor: 0.999 });
    expect(floor.kind === 'abstained' && typeof floor.confidence).toBe('number');
  });

  it('abstains on a context-only answer at the default floor (the classifier does not guess)', () => {
    // A payee no confirmation has ever carried, sharing only context with one
    // category: the model leads with that category but has no payee evidence.
    const model = train([
      ...examples(6, 'family.pets', ['t:chewy', 'b:2', 'd:out', 'a:credit', 'dm:early']),
      ...examples(6, 'transport.fuel', ['t:chevron', 'b:5', 'd:out', 'a:depository', 'dm:late']),
    ]);
    const outcome = predict(model, ['t:petco', 'b:2', 'd:out', 'a:credit', 'dm:early'], 0.6);
    expect(outcome).toMatchObject({ kind: 'abstained', code: 'below_floor', payeeEvidence: false });
    // ...and the same shape with the payee's word known predicts.
    const known = predict(model, ['t:chewy', 'b:2', 'd:out', 'a:credit', 'dm:early'], 0.6);
    expect(known).toMatchObject({
      kind: 'predicted',
      categoryKey: 'family.pets',
      payeeEvidence: true,
    });
  });

  it('abstains at the floor exactly: confidence below it never predicts', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.5, max: 0.99, noNaN: true }), (floor) => {
        const outcome = predict(SEPARATED, CHEWY, floor);
        if (outcome.kind === 'predicted') expect(outcome.confidence).toBeGreaterThanOrEqual(floor);
        else expect(['below_floor', 'too_close']).toContain(outcome.code);
      }),
      { numRuns: 200 },
    );
  });
});
