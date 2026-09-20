// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { BudgetLine, BudgetPeriod } from '../../api/generated/types.gen.ts';
import {
  availableToneOf,
  goalProgressOf,
  groupKeyOf,
  neededHintOf,
  overspendToneOf,
  periodCategoryTotals,
  readyToAssignToneOf,
} from './envelope-display.ts';

function usd(minor: string) {
  return { minor, currency: 'USD' };
}

function buildLine(overrides: Partial<BudgetLine> = {}): BudgetLine {
  return {
    id: 'line_1',
    kind: 'category',
    categoryId: 'cat_groceries',
    creditAccountId: null,
    name: null,
    carryover: usd('0'),
    assigned: usd('10000'),
    activity: usd('-4000'),
    available: usd('6000'),
    cashOverspend: usd('0'),
    creditOverspend: usd('0'),
    rolloverPolicy: 'ROLLOVER',
    goalType: 'NONE',
    neededThisPeriod: usd('0'),
    underfunded: usd('0'),
    priority: 0,
    class: null,
    transferExcludedCount: 0,
    refundNettedCount: 0,
    ...overrides,
  };
}

describe('overspendToneOf', () => {
  it('reads cashOverspend/creditOverspend, never the sign of available', () => {
    expect(overspendToneOf(buildLine())).toBe('none');
    expect(overspendToneOf(buildLine({ available: usd('-500'), cashOverspend: usd('500') }))).toBe(
      'cash',
    );
    expect(
      overspendToneOf(
        buildLine({
          kind: 'credit_card_payment',
          available: usd('-500'),
          creditOverspend: usd('500'),
        }),
      ),
    ).toBe('credit');
    // A line can be negative for reasons other than either overspend field
    // (e.g. a rollover-allowed-negative carryover) — tone stays 'none'.
    expect(overspendToneOf(buildLine({ available: usd('-1') }))).toBe('none');
  });
});

describe('availableToneOf', () => {
  it('colours by the exact sign of available, bigint compared', () => {
    expect(availableToneOf(buildLine({ available: usd('1') }))).toBe('positive');
    expect(availableToneOf(buildLine({ available: usd('-1') }))).toBe('negative');
    expect(availableToneOf(buildLine({ available: usd('0') }))).toBe('zero');
  });
});

describe('readyToAssignToneOf', () => {
  it('is an opportunity when positive, the one hard alert when negative, settled at zero', () => {
    expect(readyToAssignToneOf({ readyToAssign: usd('100') })).toBe('opportunity');
    expect(readyToAssignToneOf({ readyToAssign: usd('-100') })).toBe('alert');
    expect(readyToAssignToneOf({ readyToAssign: usd('0') })).toBe('settled');
  });
});

describe('neededHintOf', () => {
  it('shows only when the server reports a positive underfunded amount on a goal line', () => {
    expect(neededHintOf(buildLine({ goalType: 'NONE', underfunded: usd('500') }))).toBeNull();
    expect(
      neededHintOf(buildLine({ goalType: 'MONTHLY_TARGET', underfunded: usd('0') })),
    ).toBeNull();
    const hint = neededHintOf(buildLine({ goalType: 'MONTHLY_TARGET', underfunded: usd('1234') }));
    expect(hint?.amount.minor).toBe(1234n);
  });
});

describe('goalProgressOf', () => {
  it('is null with no goal or nothing left needed this period', () => {
    expect(goalProgressOf(buildLine({ goalType: 'NONE' }))).toBeNull();
    expect(
      goalProgressOf(
        buildLine({ goalType: 'TARGET_BY_DATE', neededThisPeriod: usd('0'), assigned: usd('100') }),
      ),
    ).toBeNull();
  });

  it('is assigned / neededThisPeriod, clamped to [0, 1]', () => {
    expect(
      goalProgressOf(
        buildLine({
          goalType: 'TARGET_BY_DATE',
          neededThisPeriod: usd('20000'),
          assigned: usd('5000'),
        }),
      ),
    ).toBeCloseTo(0.25);
    expect(
      goalProgressOf(
        buildLine({
          goalType: 'TARGET_BY_DATE',
          neededThisPeriod: usd('20000'),
          assigned: usd('90000'),
        }),
      ),
    ).toBe(1);
  });
});

describe('groupKeyOf', () => {
  it('sorts a credit-card-payment line into its own group regardless of category kind', () => {
    expect(groupKeyOf(buildLine({ kind: 'credit_card_payment' }), 'expense')).toBe(
      'credit_card_payment',
    );
  });

  it('otherwise groups by the category kind, falling back to other', () => {
    expect(groupKeyOf(buildLine(), 'expense')).toBe('expense');
    expect(groupKeyOf(buildLine(), 'income')).toBe('income');
    expect(groupKeyOf(buildLine(), undefined)).toBe('other');
    expect(groupKeyOf(buildLine(), 'not-a-real-kind')).toBe('other');
  });
});

describe('periodCategoryTotals', () => {
  const period: Pick<BudgetPeriod, 'lines'> = {
    lines: [
      buildLine({
        id: 'l1',
        assigned: usd('10000'),
        activity: usd('-4000'),
        available: usd('6000'),
      }),
      buildLine({ id: 'l2', assigned: usd('5000'), activity: usd('-5000'), available: usd('0') }),
      buildLine({
        id: 'l3',
        kind: 'credit_card_payment',
        assigned: usd('999999'),
        activity: usd('999999'),
        available: usd('999999'),
      }),
    ],
  };

  it('sums exactly over category lines only, excluding credit_card_payment (WP 2.1 §1.5 identity)', () => {
    const totals = periodCategoryTotals(period);
    expect(totals.assigned.minor).toBe(15000n);
    expect(totals.activity.minor).toBe(-9000n);
    expect(totals.available.minor).toBe(6000n);
  });
});
