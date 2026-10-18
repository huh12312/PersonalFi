// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { BudgetLine, Category } from '../../api/generated/types.gen.ts';
import { variabilityViewOf } from './variability.ts';

const usd = (minor: number) => ({ minor: String(minor), currency: 'USD' });

function line(
  id: string,
  categoryId: string | null,
  c: number,
  a: number,
  spent: number,
): BudgetLine {
  return {
    id,
    kind: categoryId === null ? 'credit_card_payment' : 'category',
    categoryId,
    creditAccountId: null,
    name: null,
    carryover: usd(c),
    assigned: usd(a),
    activity: usd(-spent),
    available: usd(c + a - spent),
    cashOverspend: usd(0),
    creditOverspend: usd(0),
    rolloverPolicy: 'ROLLOVER',
    goalType: 'NONE',
    neededThisPeriod: usd(0),
    underfunded: usd(0),
    priority: 0,
    class: null,
    transferExcludedCount: 0,
    refundNettedCount: 0,
  };
}

/** A deterministic pseudo-random generator, so the property runs the same every time. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe('variabilityViewOf', () => {
  it('each section total equals the sum of its rows (200 generated budgets)', () => {
    const kinds: Category['kind'][] = ['expense', 'expense', 'expense', 'income', 'investment'];
    const values: Category['variability'][] = ['fixed', 'flexible', 'non_monthly', null];
    for (let seed = 1; seed <= 200; seed += 1) {
      const rand = lcg(seed);
      const categories = new Map<string, Pick<Category, 'kind' | 'variability'>>();
      const lines: BudgetLine[] = [];
      const count = 1 + Math.floor(rand() * 14);
      for (let i = 0; i < count; i += 1) {
        const id = `cat_${String(i)}`;
        categories.set(id, {
          kind: kinds[Math.floor(rand() * kinds.length)] ?? 'expense',
          variability: values[Math.floor(rand() * values.length)] ?? null,
        });
        lines.push(
          line(
            `l_${String(i)}`,
            rand() < 0.1 ? null : id,
            Math.floor(rand() * 5_000) - 1_000,
            Math.floor(rand() * 100_000),
            Math.floor(rand() * 120_000) - 10_000,
          ),
        );
      }
      const view = variabilityViewOf(lines, categories, 'USD');
      let seen = view.other.length;
      for (const section of view.sections) {
        seen += section.lines.length;
        const hand = (pick: (l: BudgetLine) => number) =>
          section.lines.reduce((acc, l) => acc + pick(l), 0);
        expect(Number(section.figures.budgeted.minor), `seed ${String(seed)} ${section.key}`).toBe(
          hand((l) => Number(l.carryover.minor) + Number(l.assigned.minor)),
        );
        expect(Number(section.figures.spent.minor)).toBe(hand((l) => -Number(l.activity.minor)));
        expect(Number(section.figures.remaining.minor)).toBe(
          hand((l) => Number(l.available.minor)),
        );
      }
      expect(seen, 'every line lands somewhere, once').toBe(lines.length);
    }
  });

  it('income and card-payment lines are not classified; a missing variability is Unclassified', () => {
    const categories = new Map<string, Pick<Category, 'kind' | 'variability'>>([
      ['rent', { kind: 'expense', variability: 'fixed' }],
      ['salary', { kind: 'income', variability: null }],
      ['coffee', { kind: 'expense', variability: null }],
    ]);
    const view = variabilityViewOf(
      [
        line('a', 'rent', 0, 100, 0),
        line('b', 'salary', 0, 0, -500),
        line('c', 'coffee', 0, 10, 2),
        line('d', null, 0, 0, 0),
        line('e', 'unknown', 0, 5, 0),
      ],
      categories,
      'USD',
    );
    const keyed = Object.fromEntries(view.sections.map((s) => [s.key, s.lines.map((l) => l.id)]));
    expect(keyed).toEqual({
      fixed: ['a'],
      flexible: [],
      non_monthly: [],
      unclassified: ['c', 'e'],
    });
    expect(view.other.map((l) => l.id)).toEqual(['b', 'd']);
  });
});
