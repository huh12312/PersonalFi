// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { ImportError } from './errors.ts';
import { parseAmount, parseFileDate } from './scalars.ts';

describe('parseAmount', () => {
  it('reads a plain signed decimal into minor units', () => {
    expect(parseAmount('-12.34', 'USD').minor).toBe(-1_234n);
    expect(parseAmount('3125.50', 'USD').minor).toBe(312_550n);
  });

  it('never goes through a float', () => {
    // 0.1 + 0.2 is the canonical demonstration; a statement of 4,000 rows
    // accumulates that error into something a user notices.
    const total = parseAmount('0.10', 'USD').minor + parseAmount('0.20', 'USD').minor;
    expect(total).toBe(30n);
  });

  it('strips currency symbols and grouping separators', () => {
    expect(parseAmount('$1,234.56', 'USD').minor).toBe(123_456n);
    expect(parseAmount('£1 234.56', 'GBP').minor).toBe(123_456n);
  });

  it('reads accounting parentheses as negative', () => {
    expect(parseAmount('(12.34)', 'USD').minor).toBe(-1_234n);
  });

  it('reads a trailing DR/CR marker', () => {
    expect(parseAmount('42.19 DR', 'GBP').minor).toBe(-4_219n);
    expect(parseAmount('42.19 CR', 'GBP').minor).toBe(4_219n);
  });

  it('resolves 1.234,56 and 1,234.56 by taking the last separator as the decimal', () => {
    expect(parseAmount('1.234,56', 'EUR').minor).toBe(123_456n);
    expect(parseAmount('1,234.56', 'USD').minor).toBe(123_456n);
  });

  it('reads a lone separator as grouping when three digits follow', () => {
    expect(parseAmount('1,234', 'USD').minor).toBe(123_400n);
    expect(parseAmount('1,23', 'USD').minor).toBe(123n);
  });

  it('obeys an explicit separator over the guess', () => {
    // The guess would read this as grouping (123400n); told the comma is the
    // decimal point, it is 1.234 dollars, rounded half-up to 123 cents.
    expect(parseAmount('1,234', 'USD', { separator: ',' }).minor).toBe(123n);
  });

  it('inverts the sign for a bank that prints a purchase as a positive charge', () => {
    expect(parseAmount('12.34', 'USD', { sign: 'inverted' }).minor).toBe(-1_234n);
    expect(parseAmount('-12.34', 'USD', { sign: 'inverted' }).minor).toBe(1_234n);
  });

  it('uses the currency\'s own scale, not two decimals for everything', () => {
    // KWD has three. Read as two, every Kuwaiti amount would be ten times wrong.
    expect(parseAmount('1.234', 'KWD').minor).toBe(1_234n);
    expect(parseAmount('1.23', 'JPY').minor).toBe(1n);
  });

  it('refuses an amount with two decimal separators', () => {
    expect(() => parseAmount('1.2.3', 'USD')).toThrow(ImportError);
  });

  it('refuses an empty or non-numeric amount', () => {
    expect(() => parseAmount('   ', 'USD')).toThrow(ImportError);
    expect(() => parseAmount('n/a', 'USD')).toThrow(ImportError);
  });
});

describe('parseFileDate', () => {
  it('reads ISO dates unchanged', () => {
    expect(parseFileDate('2026-05-20')).toBe('2026-05-20');
  });

  it('reads a compact YYYYMMDD', () => {
    expect(parseFileDate('20260520')).toBe('2026-05-20');
  });

  it('reads US and UK orders when told which', () => {
    expect(parseFileDate('05/20/2026', 'mdy')).toBe('2026-05-20');
    expect(parseFileDate('20/05/2026', 'dmy')).toBe('2026-05-20');
    expect(parseFileDate('20.05.2026', 'dmy')).toBe('2026-05-20');
  });

  it('resolves an unambiguous date on its own', () => {
    // 20 cannot be a month, so this can only be day-first.
    expect(parseFileDate('20/05/2026')).toBe('2026-05-20');
  });

  it('reads an ambiguous date as month-first, which is the documented default', () => {
    expect(parseFileDate('01/02/2026')).toBe('2026-01-02');
  });

  it('expands a two-digit year into this century', () => {
    expect(parseFileDate('05/20/26', 'mdy')).toBe('2026-05-20');
  });

  it('refuses a date that is not a real calendar date', () => {
    expect(() => parseFileDate('02/30/2026', 'mdy')).toThrow(ImportError);
  });

  it('refuses something that is not a date at all', () => {
    expect(() => parseFileDate('Opening balance')).toThrow(ImportError);
  });
});
