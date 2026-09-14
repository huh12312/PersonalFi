// SPDX-License-Identifier: MIT
/**
 * Import profiles: how to read one institution's export.
 *
 * A profile is **user data** (08 §2.6: "Mapping profiles are user data, stored
 * per institution"), which means it belongs in the database, in the export and
 * in the backup — not in this file. What is here is a small set of starting
 * points, so that the common cases need no mapping UI at all and the uncommon
 * ones start from something close.
 *
 * The five were written from the column headings of the fixtures in
 * `test/fixtures/`, which are themselves hand-written. Firefly III ships a large
 * library of real import configurations and it is **CC-BY-SA-4.0**
 * (`docs/research/02-ecosystem-vibe-trading.md` §3.1) — copying from it would
 * put a share-alike obligation on an MIT repository, so it was not opened.
 */
import type { CsvColumnMapping } from './csv.ts';
import type { AmountSign, DateFormat, DecimalSeparator } from './scalars.ts';

export interface CsvProfile {
  readonly id: string;
  readonly label: string;
  readonly delimiter: string;
  readonly hasHeader: boolean;
  /** Preamble rows before the header. Some exports print an account summary first. */
  readonly skipRows: number;
  readonly dateFormat: DateFormat;
  readonly decimalSeparator: DecimalSeparator;
  readonly amountSign: AmountSign;
  /** Used when the file carries no currency column. */
  readonly defaultCurrency: string;
  readonly mapping: CsvColumnMapping;
}

const BASE = {
  delimiter: ',',
  hasHeader: true,
  skipRows: 0,
  decimalSeparator: 'auto',
  amountSign: 'natural',
  defaultCurrency: 'USD',
} as const satisfies Partial<CsvProfile>;

export const CSV_PRESETS: readonly CsvProfile[] = Object.freeze([
  Object.freeze({
    ...BASE,
    id: 'iso_signed',
    label: 'Date / Description / Amount, ISO dates',
    dateFormat: 'iso',
    mapping: { date: 'Date', description: 'Description', amount: 'Amount' },
  }),
  Object.freeze({
    ...BASE,
    id: 'us_signed',
    label: 'US bank: MM/DD/YYYY, one signed amount column',
    dateFormat: 'mdy',
    mapping: {
      date: 'Date',
      description: 'Description',
      amount: 'Amount',
      memo: 'Memo',
    },
  }),
  Object.freeze({
    ...BASE,
    id: 'us_debit_credit',
    label: 'US bank: separate Debit and Credit columns',
    dateFormat: 'mdy',
    mapping: {
      date: 'Date',
      description: 'Description',
      debit: 'Debit',
      credit: 'Credit',
    },
  }),
  Object.freeze({
    ...BASE,
    id: 'uk_dmy',
    label: 'UK bank: DD/MM/YYYY, GBP',
    dateFormat: 'dmy',
    defaultCurrency: 'GBP',
    mapping: {
      date: 'Transaction Date',
      description: 'Transaction Description',
      debit: 'Debit Amount',
      credit: 'Credit Amount',
    },
  }),
  Object.freeze({
    ...BASE,
    id: 'european_semicolon',
    label: 'European bank: semicolons, DD.MM.YYYY, comma decimals',
    delimiter: ';',
    dateFormat: 'dmy',
    decimalSeparator: ',',
    defaultCurrency: 'EUR',
    mapping: { date: 'Datum', description: 'Verwendungszweck', amount: 'Betrag' },
  }),
]);

export function presetById(id: string): CsvProfile | null {
  return CSV_PRESETS.find((preset) => preset.id === id) ?? null;
}
