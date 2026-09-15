// SPDX-License-Identifier: MIT
import { DateOnly, money } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  fingerprintOf,
  importedTransactionIdOf,
  normaliseDescription,
  occurrencesOf,
} from './fingerprint.ts';
import { windowStart } from './connector.ts';
import type { ConnectorCapabilities } from './capabilities.ts';

// A word made of letters/digits, joined with runs of whitespace and/or
// punctuation noise — the shape of a real bank descriptor's variation between
// two sightings of one purchase ("SQ *Blue Bottle 4471" vs "SQ  *BLUE  BOTTLE
// 4471"), not arbitrary Unicode.
const wordArb = fc.stringMatching(/^[a-zA-Z0-9]{1,10}$/);
const noiseArb = fc.stringMatching(/^[ \t*#.,-]{1,4}$/);

/** Interleave a fixed word list with one noise array: `n0 w0 n1 w1 n2 ...`. */
function assemble(words: readonly string[], noise: readonly string[]): string {
  let out = '';
  for (let i = 0; i < words.length; i += 1) out += (noise[i] ?? '') + words[i];
  out += noise[words.length] ?? '';
  return out;
}

function applyCase(value: string, upperBits: readonly boolean[]): string {
  return [...value]
    .map((ch, i) => (upperBits[i] === true ? ch.toUpperCase() : ch.toLowerCase()))
    .join('');
}

const base = {
  providerAccountId: 'acct-1',
  postedDate: DateOnly.parse('2026-05-20'),
  amount: money(-1_234n, 'USD'),
  description: 'SQ *BLUE BOTTLE 4471',
};

describe('normaliseDescription', () => {
  it('folds the noise two sightings of one purchase will disagree about', () => {
    expect(normaliseDescription('AMZN Mktp US*2H4LK')).toBe(
      normaliseDescription('AMZN  MKTP  US *2H4LK'),
    );
  });

  it('keeps what distinguishes two different purchases', () => {
    // Deliberately cruder than the ledger's merchant normaliser: that one strips
    // store numbers to group a payee, which here would collide two real charges.
    expect(normaliseDescription('SQ *COFFEE 1')).not.toBe(normaliseDescription('SQ *COFFEE 2'));
  });
});

describe('fingerprintOf', () => {
  it('is a sha256 hex digest', () => {
    expect(fingerprintOf(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across descriptor noise, so a CSV import meets a Plaid backfill', () => {
    expect(fingerprintOf({ ...base, description: 'SQ  *Blue  Bottle   4471' })).toBe(
      fingerprintOf(base),
    );
  });

  it('changes when the amount, the date or the account does', () => {
    const variants = [
      { ...base, amount: money(-1_235n, 'USD') },
      { ...base, postedDate: DateOnly.parse('2026-05-21') },
      { ...base, providerAccountId: 'acct-2' },
      { ...base, amount: money(-1_234n, 'EUR') },
    ];
    for (const variant of variants) expect(fingerprintOf(variant)).not.toBe(fingerprintOf(base));
  });

  it('does not include the provider, because that is what differs between sightings', () => {
    // There is no provider input at all — asserted by construction: the same
    // four fields from two different adapters must fingerprint identically.
    expect(fingerprintOf({ ...base })).toBe(fingerprintOf({ ...base }));
  });

  // wp1.7: the four example-based cases above pin one base fixture. These
  // generalise them across the input space fast-check explores, rather than
  // the one descriptor and the one set of amounts someone thought to type.
  it('property: is stable under independent whitespace/punctuation noise and case, for the same words', () => {
    fc.assert(
      fc.property(
        fc.array(wordArb, { minLength: 1, maxLength: 6 }),
        fc.array(noiseArb, { minLength: 7, maxLength: 7 }),
        fc.array(noiseArb, { minLength: 7, maxLength: 7 }),
        fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
        fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
        (words, noiseA, noiseB, caseA, caseB) => {
          const a = applyCase(assemble(words, noiseA.slice(0, words.length + 1)), caseA);
          const b = applyCase(assemble(words, noiseB.slice(0, words.length + 1)), caseB);
          expect(fingerprintOf({ ...base, description: a })).toBe(
            fingerprintOf({ ...base, description: b }),
          );
        },
      ),
    );
  });

  it('property: changes when the amount, the date, the currency or the account changes', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000n, max: 1_000_000n }),
        fc.integer({ min: 15_000, max: 25_000 }).map((d) => DateOnly.fromEpochDay(d)),
        fc.constantFrom('USD', 'EUR', 'GBP'),
        fc.stringMatching(/^acct-[0-9]{1,4}$/),
        (minor, postedDate, currency, providerAccountId) => {
          const varied = {
            providerAccountId,
            postedDate,
            amount: money(minor, currency),
            description: base.description,
          };
          const changedAnyField =
            varied.providerAccountId !== base.providerAccountId ||
            varied.postedDate !== base.postedDate ||
            varied.amount.minor !== base.amount.minor ||
            varied.amount.currency !== base.amount.currency;
          fc.pre(changedAnyField);
          expect(fingerprintOf(varied)).not.toBe(fingerprintOf(base));
        },
      ),
    );
  });
});

describe('importedTransactionIdOf', () => {
  it('is stable, which is what makes re-importing a file a no-op', () => {
    const input = { ...base, provider: 'file_import', occurrence: 1 };
    expect(importedTransactionIdOf(input)).toBe(importedTransactionIdOf({ ...input }));
  });

  it('separates two genuinely identical rows by occurrence', () => {
    const first = importedTransactionIdOf({ ...base, provider: 'file_import', occurrence: 1 });
    const second = importedTransactionIdOf({ ...base, provider: 'file_import', occurrence: 2 });
    expect(first).not.toBe(second);
  });

  it('scopes to the provider, so a CSV row and a Plaid row keep separate ids', () => {
    const csv = importedTransactionIdOf({ ...base, provider: 'file_import', occurrence: 1 });
    const manual = importedTransactionIdOf({ ...base, provider: 'manual', occurrence: 1 });
    expect(csv).not.toBe(manual);
  });
});

describe('occurrencesOf', () => {
  it('numbers within the (date, amount, description) group, not by position', () => {
    const rows = [
      { ...base },
      { ...base, description: 'GROCERY' },
      { ...base },
      { ...base, amount: money(-500n, 'USD') },
    ];
    expect(occurrencesOf(rows)).toEqual([1, 1, 2, 1]);
  });

  it('is stable when an unrelated row is prepended by a later export', () => {
    // The reason occurrence is not the line number: a re-export with one extra
    // row at the top would otherwise shift every id and re-import everything.
    const rows = [{ ...base }, { ...base }];
    const withPrefix = [{ ...base, description: 'NEW ROW' }, ...rows];
    expect(occurrencesOf(withPrefix).slice(1)).toEqual(occurrencesOf(rows));
  });
});

describe('windowStart', () => {
  const capabilities = (historyWindowDays: number | 'unbounded'): ConnectorCapabilities => ({
    supports: ['transactions'],
    historyWindowDays,
    minSyncIntervalSeconds: 0,
    refreshBudgetPerDay: null,
    supportsWebhooks: false,
    reconnectFlow: 'none',
    consentWindowDays: null,
    currencies: 'multi',
  });

  it("clamps a 730-day request to SimpleFIN's 90-day window (01 §2.2)", () => {
    const start = windowStart(capabilities(90), 730, DateOnly.parse('2026-06-01'));
    expect(start).toBe('2026-03-03');
  });

  it('honours the full request when the provider allows it', () => {
    expect(windowStart(capabilities(730), 730, DateOnly.parse('2026-06-01'))).toBe('2024-06-01');
  });

  it('has no floor for a file import or manual entry', () => {
    expect(windowStart(capabilities('unbounded'), 730, DateOnly.parse('2026-06-01'))).toBeNull();
  });
});
