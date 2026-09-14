// SPDX-License-Identifier: MIT
/**
 * One file in, canonical facts out. Pure: no clock, no database, no I/O.
 *
 * ## Idempotent re-import, and why it needs no bookkeeping
 *
 * A CSV or QIF row has no provider id, so the id **is** a content hash of
 * `(provider, account, date, amount, normalised description, occurrence)`
 * (`importedTransactionIdOf`). Importing the same file twice therefore produces
 * the same `providerTransactionId` twice, and the ledger's natural-key upsert —
 * `UNIQUE (account_id, provider, provider_transaction_id)`, idempotency layer 1
 * of 04 §4.4 — makes the second import a no-op with no import-side state at all.
 *
 * That is not the same as the ledger's cross-provider dedup, and the difference
 * matters. `ledger_dedup_keys` deliberately **ignores** same-provider
 * fingerprint collisions, because two identical coffees on the same day at the
 * same shop are a real and common event. So a re-import cannot be deduplicated
 * by fingerprint; it is deduplicated by id, and `occurrence` is what keeps the
 * two genuine coffees distinct while still making them stable across re-imports.
 *
 * `fingerprint` is still computed on every row, because it is what reconciles
 * this import against a Plaid backfill of the same account (08 §2.5).
 */
import {
  fingerprintOf,
  importedTransactionIdOf,
  occurrencesOf,
  type ProviderAccountFact,
  type ProviderBalanceFact,
  type ProviderTransactionFact,
} from '@connector/port';
import { money, type DateOnly, type Money } from '@core/kernel';
import { cell, readCsv, resolveColumns } from './csv.ts';
import { ImportError } from './errors.ts';
import { parseOfx, readOfxStatements } from './ofx.ts';
import { parseQif } from './qif.ts';
import type { CsvProfile } from './presets.ts';
import { parseAmount, parseFileDate } from './scalars.ts';

export const IMPORT_PROVIDER = 'file_import';

export const FILE_FORMATS = ['csv', 'ofx', 'qif', 'auto'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

/** The account a headerless format is being imported into. */
export interface TargetAccount {
  readonly providerAccountId: string;
  readonly name: string;
  readonly type: ProviderAccountFact['type'];
  readonly currency: string;
  readonly mask?: string | null;
}

export interface ImportFileInput {
  /** For error messages and provenance. Never parsed for meaning. */
  readonly name: string;
  readonly content: string;
  readonly format?: FileFormat;
  /** Required for CSV. A preset id is resolved by the caller. */
  readonly profile?: CsvProfile;
  /** Required for CSV and QIF, which carry no account identity. */
  readonly account?: TargetAccount;
}

export interface ImportResult {
  readonly accounts: readonly ProviderAccountFact[];
  readonly transactions: readonly ProviderTransactionFact[];
  readonly balances: readonly ProviderBalanceFact[];
}

/** An intermediate row, before it gets an id. */
interface Row {
  readonly providerAccountId: string;
  readonly postedDate: DateOnly;
  readonly amount: Money;
  readonly description: string;
  readonly memo: string | null;
  readonly merchantName: string | null;
  /** The file's own id, when it has one (OFX `FITID`, a CSV reference column). */
  readonly nativeId: string | null;
  readonly raw: Record<string, unknown>;
}

export function importFile(input: ImportFileInput): ImportResult {
  const format = input.format === undefined || input.format === 'auto' ? sniff(input) : input.format;
  switch (format) {
    case 'ofx':
      return finish(readOfx(input));
    case 'qif':
      return finish(readQif(input));
    case 'csv':
      return finish(readCsvFile(input));
    default:
      throw new ImportError(`${input.name}: cannot tell what kind of file this is`);
  }
}

/**
 * Format detection by content, not by extension.
 *
 * `.qfx` is OFX, `.csv` is sometimes tab-separated, and a browser download often
 * has no extension at all. What is reliable is the first non-blank line.
 */
function sniff(input: ImportFileInput): FileFormat {
  const head = input.content.slice(0, 2048);
  if (/OFXHEADER\s*[:=]|<OFX>|<\?OFX/i.test(head)) return 'ofx';
  if (/^\s*!Type:/im.test(head)) return 'qif';
  if (input.profile !== undefined) return 'csv';
  return 'auto';
}

// ---------------------------------------------------------------------------
// OFX
// ---------------------------------------------------------------------------

function readOfx(input: ImportFileInput): { rows: Row[]; result: ImportResult } {
  const statements = readOfxStatements(parseOfx(input.content));
  const accounts: ProviderAccountFact[] = [];
  const balances: ProviderBalanceFact[] = [];
  const rows: Row[] = [];

  for (const statement of statements) {
    const type = ofxAccountType(statement.accountType);
    accounts.push({
      providerAccountId: statement.accountId,
      // The file gives no friendly name. A mask is honest; a made-up name is not.
      name: `${labelOf(statement.accountType)} ••${statement.accountId.slice(-4)}`,
      officialName: null,
      type,
      subtype: statement.accountType.toLowerCase(),
      currency: statement.currency,
      mask: statement.accountId.slice(-4),
      closed: false,
      capabilities: ['accounts', 'transactions', ...(statement.ledgerBalance === null ? [] : (['balances'] as const))],
    });

    for (const transaction of statement.transactions) {
      rows.push({
        providerAccountId: statement.accountId,
        postedDate: parseFileDate(transaction.postedOn, 'iso'),
        // OFX already signs a debit negative, which is the house convention.
        amount: parseAmount(transaction.amount, statement.currency, { separator: '.' }),
        description: transaction.name,
        memo: transaction.memo,
        merchantName: transaction.name === '' ? null : transaction.name,
        nativeId: transaction.fitId,
        raw: {
          source: 'ofx',
          file: input.name,
          trnType: transaction.type,
          fitId: transaction.fitId,
          checkNumber: transaction.checkNumber,
        },
      });
    }

    if (statement.ledgerBalance !== null) {
      balances.push({
        providerAccountId: statement.accountId,
        current: parseAmount(statement.ledgerBalance.amount, statement.currency, { separator: '.' }),
        available: null,
        limit: null,
        // A calendar date with no time, promoted to the instant the column needs.
        // Noon UTC, not midnight: midnight in a westward zone is the previous day.
        asOf: new Date(`${statement.ledgerBalance.asOf}T12:00:00.000Z`),
      });
    }
  }

  return { rows, result: { accounts, transactions: [], balances } };
}

function ofxAccountType(raw: string): ProviderAccountFact['type'] {
  const type = raw.toUpperCase();
  if (type === 'CREDITCARD' || type === 'CREDITLINE') return 'credit';
  return 'depository';
}

function labelOf(raw: string): string {
  const type = raw.toUpperCase();
  if (type === 'CREDITCARD') return 'Credit card';
  if (type === 'SAVINGS') return 'Savings';
  if (type === 'MONEYMRKT') return 'Money market';
  return 'Checking';
}

// ---------------------------------------------------------------------------
// QIF
// ---------------------------------------------------------------------------

function readQif(input: ImportFileInput): { rows: Row[]; result: ImportResult } {
  const account = requireAccount(input, 'QIF');
  const file = parseQif(input.content);

  const rows = file.transactions.map((transaction) => {
    try {
      return {
        providerAccountId: account.providerAccountId,
        postedDate: parseFileDate(transaction.date, input.profile?.dateFormat ?? 'auto'),
        amount: parseAmount(transaction.amount, account.currency, {
          separator: input.profile?.decimalSeparator ?? 'auto',
          sign: input.profile?.amountSign ?? 'natural',
        }),
        description: transaction.payee ?? transaction.memo ?? '',
        memo: transaction.memo,
        merchantName: transaction.payee,
        nativeId: null,
        raw: {
          source: 'qif',
          file: input.name,
          accountType: file.accountType,
          category: transaction.category,
          cleared: transaction.cleared,
          checkNumber: transaction.checkNumber,
        },
      } satisfies Row;
    } catch (cause) {
      throw cause instanceof ImportError ? cause.at(transaction.line) : cause;
    }
  });

  return { rows, result: { accounts: [accountFactOf(account)], transactions: [], balances: [] } };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function readCsvFile(input: ImportFileInput): { rows: Row[]; result: ImportResult } {
  const account = requireAccount(input, 'CSV');
  const profile = input.profile;
  if (profile === undefined) {
    throw new ImportError(`${input.name}: a CSV import needs a column mapping profile`);
  }

  const table = readCsv(input.content, { delimiter: profile.delimiter }).slice(profile.skipRows);
  const header = profile.hasHeader ? (table[0] ?? null) : null;
  const body = profile.hasHeader ? table.slice(1) : table;
  const columns = resolveColumns(header, profile.mapping);

  if (columns.amount === null && columns.debit === null && columns.credit === null) {
    throw new ImportError(
      `${input.name}: the profile maps neither an amount column nor a debit/credit pair`,
    );
  }

  const rows: Row[] = [];
  for (const [offset, record] of body.entries()) {
    // 1-based, and counting the skipped preamble and the header, so the number
    // in the error is the number in the user's spreadsheet.
    const line = offset + 1 + profile.skipRows + (profile.hasHeader ? 1 : 0);
    // A trailing blank line, or a "total" row a bank appends. Skipping a row
    // with no date is safer than importing a row whose date we invented.
    if (record.every((field) => field.trim() === '')) continue;

    try {
      const currency = cell(record, columns.currency) || profile.defaultCurrency;
      const description = cell(record, columns.description);
      const payee = cell(record, columns.payee);
      const reference = cell(record, columns.reference);
      rows.push({
        providerAccountId: account.providerAccountId,
        postedDate: parseFileDate(cell(record, columns.date), profile.dateFormat),
        amount: amountOf(record, columns, profile, currency),
        description: description || payee,
        memo: cell(record, columns.memo) || null,
        merchantName: payee || null,
        nativeId: reference || null,
        raw: { source: 'csv', file: input.name, profile: profile.id, line },
      });
    } catch (cause) {
      throw cause instanceof ImportError ? cause.at(line) : cause;
    }
  }

  if (rows.length === 0) throw new ImportError(`${input.name}: no transaction rows found`);
  return { rows, result: { accounts: [accountFactOf(account)], transactions: [], balances: [] } };
}

/**
 * One signed column, or a debit/credit pair.
 *
 * The pair is the awkward shape: exactly one of the two cells holds a value and
 * both are printed as positive magnitudes, so the sign comes from *which column
 * it was in* and never from the number. A row with both filled is refused rather
 * than netted — a bank that prints both means something we do not understand.
 */
function amountOf(
  record: readonly string[],
  columns: ReturnType<typeof resolveColumns>,
  profile: CsvProfile,
  currency: string,
): Money {
  const options = { separator: profile.decimalSeparator, sign: profile.amountSign } as const;

  if (columns.amount !== null) {
    const raw = cell(record, columns.amount);
    if (raw === '') throw new ImportError('the amount cell is empty');
    return parseAmount(raw, currency, options);
  }

  const debit = cell(record, columns.debit);
  const credit = cell(record, columns.credit);
  if (debit !== '' && credit !== '') {
    throw new ImportError('both the debit and the credit column are filled');
  }
  if (debit === '' && credit === '') throw new ImportError('neither debit nor credit is filled');

  // `natural` here means "a debit is an outflow", which is the meaning of the
  // columns rather than the sign of the digits — so the magnitude is taken and
  // the sign is applied, whatever the file printed.
  const magnitude = parseAmount(debit !== '' ? debit : credit, currency, {
    separator: profile.decimalSeparator,
    sign: 'inverted',
  });
  const positive = magnitude.minor < 0n ? -magnitude.minor : magnitude.minor;
  return money(debit !== '' ? -positive : positive, currency);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function requireAccount(input: ImportFileInput, format: string): TargetAccount {
  if (input.account !== undefined) return input.account;
  throw new ImportError(
    `${input.name}: a ${format} file carries no account identity, so the import must name the ` +
      'account it belongs to',
  );
}

function accountFactOf(account: TargetAccount): ProviderAccountFact {
  return {
    providerAccountId: account.providerAccountId,
    name: account.name,
    officialName: null,
    type: account.type,
    subtype: null,
    currency: account.currency,
    mask: account.mask ?? null,
    closed: false,
    capabilities: ['accounts', 'transactions'],
  };
}

/** Give every row its id and its fingerprint. The one place that happens. */
function finish(parsed: { rows: Row[]; result: ImportResult }): ImportResult {
  const occurrences = occurrencesOf(parsed.rows);
  const transactions = parsed.rows.map((row, index) => {
    const fingerprint = fingerprintOf({
      providerAccountId: row.providerAccountId,
      postedDate: row.postedDate,
      amount: row.amount,
      description: row.description,
    });
    return {
      providerAccountId: row.providerAccountId,
      providerTransactionId:
        row.nativeId ??
        importedTransactionIdOf({
          provider: IMPORT_PROVIDER,
          providerAccountId: row.providerAccountId,
          postedDate: row.postedDate,
          amount: row.amount,
          description: row.description,
          occurrence: occurrences[index] ?? 1,
        }),
      pendingTransactionId: null,
      amount: row.amount,
      isoCurrency: row.amount.currency,
      postedDate: row.postedDate,
      authorizedDate: null,
      postedAt: null,
      authorizedAt: null,
      name: row.description,
      merchantName: row.merchantName,
      originalDescription: row.memo,
      paymentChannel: null,
      providerCategory: null,
      // A statement export is settled history. Nothing in CSV, OFX or QIF says
      // "pending", and inventing the flag would make the ledger's pending →
      // posted migration fire on a row that never had a pending phase.
      pending: false,
      location: null,
      counterparties: null,
      raw: row.raw,
      fingerprint,
    } satisfies ProviderTransactionFact;
  });

  return { ...parsed.result, transactions };
}
