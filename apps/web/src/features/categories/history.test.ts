// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { historyWire, withOneCompleteMonth } from './fixtures.ts';
import {
  comparisonSentence,
  domainOf,
  historyOf,
  indexOfMonth,
  monthFilter,
  monthSentence,
  moveSelection,
  shownAverage,
  tableAmount,
  versusAverage,
} from './history.ts';

describe('the comparison sentence (WP 10.14)', () => {
  it('says this month against the average in money, with a direction word and both amounts', () => {
    const sentence = comparisonSentence(historyOf(historyWire()));
    expect(sentence.heading).toBe('This month vs. average month (last 12 months)');
    expect(sentence.withheld).toBe(false);
    // 21 000 − 35 667 = −14 667: "$146.67 less than your average month of $356.67".
    expect(sentence.text).toBe(
      'So far this month, $146.67 less than your average month of $356.67.',
    );
  });

  it('says "more" when this month is above the average', () => {
    const base = historyWire();
    const wire = {
      ...base,
      months: base.months.map((month) =>
        month.isCurrent ? { ...month, amountMinor: '40000' } : month,
      ),
    };
    expect(comparisonSentence(historyOf(wire)).text).toBe(
      'So far this month, $43.33 more than your average month of $356.67.',
    );
  });

  it('says "the same as" when they are equal, never "$0.00 more"', () => {
    expect(versusAverage(35667n, 35667n, 'USD')).toBe('the same as your average month of $356.67');
  });

  it('is withheld, with the reason, when there is one complete month of history', () => {
    const sentence = comparisonSentence(historyOf(withOneCompleteMonth()));
    expect(sentence.withheld).toBe(true);
    expect(sentence.text).toBe(
      'Not enough history for an average yet: it needs at least 2 complete months, and your ledger has 1.',
    );
  });

  it('is withheld even if a server said "available" over one complete month', () => {
    const wire = withOneCompleteMonth();
    const lying = {
      ...wire,
      average: { available: true, withheld: null, amountMinor: '39000', monthsAveraged: 1 },
    };
    expect(shownAverage(historyOf(lying))).toBeNull();
    expect(comparisonSentence(historyOf(lying)).withheld).toBe(true);
  });

  it('says there is nothing to compare when the category has no transactions at all', () => {
    const wire = historyWire({
      currency: null,
      average: { available: false, withheld: 'no_data', amountMinor: null, monthsAveraged: 0 },
    });
    expect(comparisonSentence(historyOf(wire)).text).toBe(
      'No transactions in this category yet, so there is nothing to compare.',
    );
  });
});

describe('months in words', () => {
  const view = historyOf(historyWire());

  it('names a zero month as "no spend", never a blank', () => {
    expect(monthSentence(view, 2)).toBe(
      'December 2025: no spend; $356.67 less than your average month of $356.67.',
    );
    expect(tableAmount(view, view.months[2]!)).toBe('No spend');
  });

  it('marks the current month "so far"', () => {
    expect(monthSentence(view, 12)).toMatch(/^October 2026 \(so far\): \$210\.00 spent; /u);
  });

  it('says a month before the ledger began is before its history', () => {
    const early = historyOf(withOneCompleteMonth());
    expect(monthSentence(early, 0)).toBe("October 2025: before your ledger's first transaction.");
    expect(tableAmount(early, early.months[0]!)).toBe("Before your ledger's first transaction");
  });
});

describe('selection', () => {
  it('moves with the arrow keys and jumps with Home and End, clamped', () => {
    expect(moveSelection(13, 12, 'ArrowLeft')).toBe(11);
    expect(moveSelection(13, 12, 'ArrowRight')).toBe(12);
    expect(moveSelection(13, 0, 'ArrowDown')).toBe(0);
    expect(moveSelection(13, 3, 'ArrowUp')).toBe(4);
    expect(moveSelection(13, 5, 'Home')).toBe(0);
    expect(moveSelection(13, 5, 'End')).toBe(12);
    expect(moveSelection(13, 5, 'a')).toBeNull();
  });

  it('starts on the current month and follows the URL month', () => {
    const view = historyOf(historyWire());
    expect(indexOfMonth(view, undefined)).toBe(12);
    expect(indexOfMonth(view, '2026-03')).toBe(5);
    expect(indexOfMonth(view, '1999-01')).toBe(12);
  });

  it('filters the transactions to the category and exactly the selected month', () => {
    const view = historyOf(historyWire());
    expect(monthFilter(['c1', 'c2'], view.months[4]!)).toEqual({
      categoryIds: ['c1', 'c2'],
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });
});

describe('the y-domain', () => {
  it('holds zero, every bar and the average', () => {
    const [lo, hi] = domainOf(historyOf(historyWire()));
    expect(lo).toBe(0);
    expect(hi).toBe(52000);
  });
});
