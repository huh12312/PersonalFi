// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { mulberry32, pick, randomInt, randomUuid, shuffle } from './prng.ts';

describe('mulberry32', () => {
  it('is deterministic: the same seed produces the same sequence', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const a = mulberry32(seed);
        const b = mulberry32(seed);
        const seqA = Array.from({ length: 20 }, () => a());
        const seqB = Array.from({ length: 20 }, () => b());
        expect(seqA).toEqual(seqB);
      }),
    );
  });

  it('always returns a value in [0, 1)', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const rng = mulberry32(seed);
        for (let i = 0; i < 50; i += 1) {
          const value = rng();
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(1);
        }
      }),
    );
  });

  it('different seeds diverge within a handful of draws', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });
});

describe('randomInt', () => {
  it('stays within [min, max] inclusive', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (seed, min, span) => {
          const rng = mulberry32(seed);
          const max = min + span;
          const value = randomInt(rng, min, max);
          expect(value).toBeGreaterThanOrEqual(min);
          expect(value).toBeLessThanOrEqual(max);
        },
      ),
    );
  });
});

describe('pick / shuffle', () => {
  it('pick always returns an element of the input', () => {
    const rng = mulberry32(7);
    const items = ['a', 'b', 'c', 'd'];
    for (let i = 0; i < 20; i += 1) {
      expect(items).toContain(pick(rng, items));
    }
  });

  it('shuffle is a permutation: same elements, same length', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(fc.integer(), { minLength: 1, maxLength: 30 }),
        (seed, items) => {
          const rng = mulberry32(seed);
          const shuffled = shuffle(rng, items);
          expect(shuffled).toHaveLength(items.length);
          expect([...shuffled].sort()).toEqual([...items].sort());
        },
      ),
    );
  });

  it('shuffle does not mutate its input', () => {
    const rng = mulberry32(3);
    const items = [1, 2, 3, 4, 5];
    const copy = [...items];
    shuffle(rng, items);
    expect(items).toEqual(copy);
  });
});

describe('randomUuid', () => {
  it('produces a well-formed, deterministic v4-shaped uuid', () => {
    const a = randomUuid(mulberry32(42));
    const b = randomUuid(mulberry32(42));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('draws distinct ids across successive calls on one rng', () => {
    const rng = mulberry32(99);
    const ids = Array.from({ length: 50 }, () => randomUuid(rng));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
