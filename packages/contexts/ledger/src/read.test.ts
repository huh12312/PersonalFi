// SPDX-License-Identifier: MIT
/**
 * The cursor is the one part of the read path that can be tested without a
 * database, and it is the part an attacker reaches first: it arrives in a query
 * string and ends up in a SQL comparison. So it round-trips, and everything that
 * is not a position in this feed is refused by code rather than by the database.
 */
import { DateOnly } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './read.ts';
import { isLedgerError } from './errors.ts';

describe('the keyset cursor', () => {
  it('round-trips any position in the feed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40_000 }).map((day) => DateOnly.fromEpochDay(day)),
        fc.uuid(),
        (date, id) => {
          expect(decodeCursor(encodeCursor(date, id))).toEqual({ date, id });
        },
      ),
    );
  });

  it('treats absent, null and empty as "start at the beginning"', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it.each([
    ['not base64 at all', '!!!!'],
    ['base64 of nonsense', Buffer.from('hello', 'utf8').toString('base64url')],
    ['a valid date but no id', Buffer.from('2026-03-01|', 'utf8').toString('base64url')],
    ['an id that is not a uuid', Buffer.from('2026-03-01|../etc', 'utf8').toString('base64url')],
    [
      'a SQL fragment where the date goes',
      Buffer.from("2026-03-01'; DROP TABLE transactions --|x", 'utf8').toString('base64url'),
    ],
    [
      'a real uuid with an impossible date',
      Buffer.from('2026-02-30|01920000-0000-7000-8000-000000000001', 'utf8').toString('base64url'),
    ],
  ])('refuses %s', (_label, cursor) => {
    try {
      decodeCursor(cursor);
      throw new Error('expected the cursor to be refused');
    } catch (error) {
      expect(isLedgerError(error)).toBe(true);
      if (isLedgerError(error)) expect(error.code).toBe('ledger.cursor_invalid');
    }
  });
});
