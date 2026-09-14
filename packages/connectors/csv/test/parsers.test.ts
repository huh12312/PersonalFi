// SPDX-License-Identifier: MIT
/**
 * Golden tests for the three parsers, against hand-written fixtures.
 *
 * Every fixture under `fixtures/` was written for this repository. None contains
 * a real account number, a real balance, or data from any real institution — see
 * `../NOTICE`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readCsv, resolveColumns } from '../src/csv.ts';
import { ImportError } from '../src/errors.ts';
import { importFile, type TargetAccount } from '../src/import.ts';
import { ofxDate, parseOfx, readOfxStatements } from '../src/ofx.ts';
import { presetById, type CsvProfile } from '../src/presets.ts';
import { parseQif } from '../src/qif.ts';

/** A preset by id, or a failure here rather than a confusing one downstream. */
function preset(id: string): CsvProfile {
  const found = presetById(id);
  if (found === null) throw new Error(`no preset ${id}`);
  return found;
}

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

const CHECKING: TargetAccount = {
  providerAccountId: 'acct-checking',
  name: 'Everyday Checking',
  type: 'depository',
  currency: 'USD',
};

describe('readCsv', () => {
  it('keeps a comma inside a quoted field', () => {
    const rows = readCsv('a,b\n"SMITH, J.",1\n');
    expect(rows[1]).toEqual(['SMITH, J.', '1']);
  });

  it('reads a doubled quote as one literal quote', () => {
    expect(readCsv('a\n"CAFE ""THE NOOK"""\n')[1]).toEqual(['CAFE "THE NOOK"']);
  });

  it('keeps a newline inside a quoted field', () => {
    const rows = readCsv('a,b\n"line one\nline two",2\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.[0]).toBe('line one\nline two');
  });

  it('handles CRLF, a trailing newline and a UTF-8 BOM', () => {
    const rows = readCsv('﻿Date,Amount\r\n2026-05-20,1.00\r\n');
    expect(rows[0]).toEqual(['Date', 'Amount']);
    expect(rows).toHaveLength(2);
  });

  it('refuses a file that ends inside a quoted field', () => {
    expect(() => readCsv('a\n"unterminated\n')).toThrow(ImportError);
  });
});

describe('resolveColumns', () => {
  it('matches a header regardless of case, spacing and punctuation', () => {
    const columns = resolveColumns(['Transaction Date', 'transaction_description'], {
      date: 'TRANSACTION DATE ',
      description: 'Transaction Description',
    });
    expect(columns.date).toBe(0);
    expect(columns.description).toBe(1);
  });

  it('accepts a positional reference for a headerless file', () => {
    expect(resolveColumns(null, { date: 0, description: 2 }).description).toBe(2);
  });

  it('says which column is missing rather than importing the wrong one', () => {
    expect(() => resolveColumns(['Date'], { date: 'Date', description: 'Payee' })).toThrow(
      /no column named "Payee"/,
    );
  });
});

describe('CSV import', () => {
  it('reads a US signed-amount export', () => {
    const result = importFile({
      name: 'us-signed.csv',
      content: fixture('us-signed.csv'),
      format: 'csv',
      profile: preset('us_signed'),
      account: CHECKING,
    });

    expect(result.transactions).toHaveLength(4);
    expect(result.transactions[0]).toMatchObject({
      postedDate: '2026-05-20',
      name: 'SQ *BLUE BOTTLE 4471',
      pending: false,
    });
    expect(result.transactions[0]?.amount.minor).toBe(-1_234n);
    // A quoted thousands separator inside the amount column.
    expect(result.transactions[1]?.amount.minor).toBe(-185_000n);
    expect(result.transactions[2]?.amount.minor).toBe(312_550n);
  });

  it('gives two identical rows in one file distinct, stable ids', () => {
    const read = (): readonly string[] =>
      importFile({
        name: 'us-signed.csv',
        content: fixture('us-signed.csv'),
        format: 'csv',
        profile: preset('us_signed'),
        account: CHECKING,
      }).transactions.map((t) => t.providerTransactionId);

    const first = read();
    expect(new Set(first).size).toBe(first.length);
    // Re-importing is a no-op precisely because these are equal.
    expect(read()).toEqual(first);
  });

  it('takes the sign from the column, not the digits, for a debit/credit pair', () => {
    const result = importFile({
      name: 'uk-debit-credit.csv',
      content: fixture('uk-debit-credit.csv'),
      format: 'csv',
      profile: preset('uk_dmy'),
      account: { ...CHECKING, currency: 'GBP' },
    });

    expect(result.transactions.map((t) => t.amount.minor)).toEqual([-4_219n, 215_000n, -360n]);
    expect(result.transactions[0]?.postedDate).toBe('2026-05-20');
  });

  it('reads semicolons, dotted dates and comma decimals', () => {
    const result = importFile({
      name: 'european.csv',
      content: fixture('european.csv'),
      format: 'csv',
      profile: preset('european_semicolon'),
      account: { ...CHECKING, currency: 'EUR' },
    });

    expect(result.transactions.map((t) => t.amount.minor)).toEqual([-2_345n, 123_456n]);
    expect(result.transactions[1]?.postedDate).toBe('2026-05-21');
  });

  it('refuses a CSV with no profile rather than guessing the columns', () => {
    expect(() =>
      importFile({ name: 'x.csv', content: 'a,b\n1,2\n', format: 'csv', account: CHECKING }),
    ).toThrow(/column mapping profile/);
  });

  it('refuses a CSV with no target account, because the file does not say', () => {
    expect(() =>
      importFile({
        name: 'x.csv',
        content: fixture('us-signed.csv'),
        format: 'csv',
        profile: preset('us_signed'),
      }),
    ).toThrow(/carries no account identity/);
  });

  it('points at the spreadsheet line when a row is malformed', () => {
    const broken = 'Date,Description,Amount\n05/20/2026,OK,-1.00\n05/21/2026,BAD,not-a-number\n';
    try {
      importFile({
        name: 'broken.csv',
        content: broken,
        format: 'csv',
        profile: preset('us_signed'),
        account: CHECKING,
      });
      expect.unreachable('the malformed row should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).line).toBe(3);
    }
  });
});

describe('OFX', () => {
  it('reads OFX 1.x SGML, closing leaf elements at the next tag', () => {
    const statements = readOfxStatements(parseOfx(fixture('sample.ofx')));
    expect(statements).toHaveLength(1);
    const statement = statements[0];
    expect(statement).toMatchObject({
      accountId: '000123454471',
      accountType: 'CHECKING',
      currency: 'USD',
    });
    expect(statement?.transactions).toHaveLength(2);
    expect(statement?.transactions[0]).toMatchObject({
      fitId: '2026052000012',
      postedOn: '2026-05-20',
      amount: '-12.34',
      name: 'SQ *BLUE BOTTLE 4471',
      // `&amp;` decoded, and the MEMO not swallowed by the NAME above it.
      memo: 'Flat white & a bun',
    });
    expect(statement?.ledgerBalance).toEqual({ amount: '4271.16', asOf: '2026-05-31' });
  });

  it('reads OFX 2.x XML through the same tokenizer, with no sniffing', () => {
    const statements = readOfxStatements(parseOfx(fixture('sample-v2.qfx')));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ accountType: 'CREDITCARD', currency: 'GBP' });
    expect(statements[0]?.transactions[0]?.fitId).toBe('cc-2026-05-20-001');
  });

  it("keeps the institution's calendar date and discards its clock and zone", () => {
    // Converting 20260520120000[-5:EST] through a Date is how a 2026-03-01
    // transaction becomes 2026-02-28 for a user west of UTC.
    expect(ofxDate('20260520120000[-5:EST]')).toBe('2026-05-20');
    expect(ofxDate('20260101000000.000[-8:PST]')).toBe('2026-01-01');
  });

  it('refuses a truncated date rather than inventing one', () => {
    expect(() => ofxDate('202605')).toThrow(ImportError);
  });

  it("maps a statement to canonical facts, with the file's own FITID as the id", () => {
    const result = importFile({ name: 'sample.ofx', content: fixture('sample.ofx') });
    expect(result.accounts[0]).toMatchObject({ type: 'depository', mask: '4471' });
    expect(result.transactions[0]?.providerTransactionId).toBe('2026052000012');
    expect(result.transactions[0]?.amount.minor).toBe(-1_234n);
    expect(result.balances[0]?.current.minor).toBe(427_116n);
  });

  it('classifies a credit-card statement as a liability account type', () => {
    const result = importFile({ name: 'sample-v2.qfx', content: fixture('sample-v2.qfx') });
    expect(result.accounts[0]?.type).toBe('credit');
    // No LEDGERBAL in this file, so no balance is claimed. Silence, not zero.
    expect(result.balances).toEqual([]);
  });

  it('refuses a document with no statement in it', () => {
    expect(() =>
      readOfxStatements(parseOfx('<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>')),
    ).toThrow(/no bank or credit-card statement/);
  });

  it('refuses something that is not OFX at all', () => {
    expect(() => parseOfx('Date,Amount\n2026-05-20,1.00')).toThrow(ImportError);
  });
});

describe('QIF', () => {
  it('reads records, fields and the type header', () => {
    const file = parseQif(fixture('sample.qif'));
    expect(file.accountType).toBe('Bank');
    expect(file.transactions).toHaveLength(4);
    expect(file.transactions[0]).toMatchObject({
      date: '05/20/2026',
      amount: '-12.34',
      payee: 'SQ *BLUE BOTTLE 4471',
      memo: 'Flat white',
      cleared: 'X',
      category: 'Dining',
    });
  });

  it('prefers T over U when both are present', () => {
    expect(parseQif(fixture('sample.qif')).transactions[2]?.amount).toBe('3,125.50');
  });

  it('counts split lines and imports none of them', () => {
    // `transaction_splits` is written by the user and never by sync (migration
    // 0004). Importing someone else's split as our own would have the import
    // path writing to a table the ledger reserves for user intent.
    const split = parseQif(fixture('sample.qif')).transactions[3];
    expect(split?.memo).toContain('2 split lines');
    expect(split?.amount).toBe('-60.00');
  });

  it('maps to canonical facts with content-hash ids', () => {
    const result = importFile({
      name: 'sample.qif',
      content: fixture('sample.qif'),
      account: CHECKING,
    });
    expect(result.transactions).toHaveLength(4);
    expect(result.transactions[0]?.providerTransactionId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.transactions[1]?.amount.minor).toBe(-185_000n);
    for (const transaction of result.transactions) {
      expect(transaction.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('says which record is broken', () => {
    try {
      parseQif('!Type:Bank\nD05/20/2026\nPNO AMOUNT LINE\n^\n');
      expect.unreachable('a record with no amount should have thrown');
    } catch (error) {
      expect((error as ImportError).line).toBe(2);
    }
  });

  it('refuses a file with no transactions', () => {
    expect(() => parseQif('!Type:Bank\n')).toThrow(/no transactions/);
  });
});

describe('format sniffing', () => {
  it('reads content, not the extension: a .qfx is OFX', () => {
    expect(
      importFile({ name: 'anything', content: fixture('sample-v2.qfx') }).transactions,
    ).toHaveLength(1);
  });

  it('recognises QIF by its type header', () => {
    const result = importFile({
      name: 'download',
      content: fixture('sample.qif'),
      account: CHECKING,
    });
    expect(result.transactions).toHaveLength(4);
  });

  it('refuses a file it cannot identify rather than guessing', () => {
    expect(() => importFile({ name: 'mystery.bin', content: 'nothing useful here' })).toThrow(
      /cannot tell what kind of file/,
    );
  });
});
