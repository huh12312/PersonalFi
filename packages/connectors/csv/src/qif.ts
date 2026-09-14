// SPDX-License-Identifier: MIT
/**
 * QIF — Quicken Interchange Format.
 *
 * A line-oriented format where the first character of each line is the field and
 * `^` ends a record:
 *
 * ```text
 * !Type:Bank
 * D05/20/2026
 * T-12.34
 * PSQ *BLUE BOTTLE
 * MFlat white
 * ^
 * ```
 *
 * Two things are worth knowing before trusting it:
 *
 * 1. **QIF carries no transaction id and no account id.** Nothing in the format
 *    identifies a row across two exports, which is why the importer derives the
 *    id from a content hash (`importedTransactionIdOf`) and why the user must
 *    say which account the file belongs to. This is a property of the format,
 *    not a shortcut.
 * 2. **QIF dates are ambiguous by design.** Quicken wrote `05/20/2026` in the
 *    US and `20/05/2026` in the UK with no marker, and used `'` as the century
 *    separator (`05/20'26`). `parseFileDate` resolves what it can and demands an
 *    explicit format for the rest.
 *
 * Splits (`S`/`E`/`$` lines) are parsed into the memo and otherwise dropped: a
 * split is *user intent*, `transaction_splits` is written by the user and never
 * by sync (migration 0004), and importing someone else's split as our own would
 * be the import path writing to a table the ledger reserves for the user.
 */
import { ImportError } from './errors.ts';

export interface QifTransaction {
  readonly date: string;
  readonly amount: string;
  readonly payee: string | null;
  readonly memo: string | null;
  readonly checkNumber: string | null;
  readonly category: string | null;
  readonly cleared: string | null;
  /** 1-based line of the record's first field, for error messages. */
  readonly line: number;
}

export interface QifFile {
  /** `Bank`, `CCard`, `Cash`, `Oth A`, ... from the `!Type:` header. */
  readonly accountType: string;
  readonly transactions: readonly QifTransaction[];
}

export function parseQif(text: string): QifFile {
  const lines = text.split(/\r\n|\r|\n/);
  let accountType = 'Bank';

  const transactions: QifTransaction[] = [];
  let current: Record<string, string> = {};
  let startedAt = 0;
  let splits = 0;

  const flush = (): void => {
    if (Object.keys(current).length === 0) return;
    const date = current['D'];
    const amount = current['T'] ?? current['U'];
    if (date === undefined) throw new ImportError('QIF record has no date (D) line', startedAt);
    if (amount === undefined) {
      throw new ImportError('QIF record has no amount (T or U) line', startedAt);
    }
    transactions.push({
      date,
      amount,
      payee: current['P'] ?? null,
      memo:
        splits > 0
          ? `${current['M'] ?? ''}${current['M'] === undefined ? '' : ' '}(${splits} split lines in the source file)`.trim()
          : (current['M'] ?? null),
      checkNumber: current['N'] ?? null,
      category: current['L'] ?? null,
      cleared: current['C'] ?? null,
      line: startedAt,
    });
    current = {};
    splits = 0;
  };

  for (const [offset, raw] of lines.entries()) {
    const line = raw.trimEnd();
    const number = offset + 1;
    if (line === '') continue;

    if (line.startsWith('!')) {
      // `!Type:Bank`, `!Account`, `!Clear:AutoSwitch`. Only the type matters.
      const header = line.slice(1);
      if (header.toLowerCase().startsWith('type:')) accountType = header.slice(5).trim();
      continue;
    }

    if (line.startsWith('^')) {
      flush();
      continue;
    }

    const field = line[0] ?? '';
    const value = line.slice(1).trim();
    if (Object.keys(current).length === 0) startedAt = number;

    // Split lines. Counted, not imported — see the header note.
    if (field === 'S' || field === 'E' || field === '$') {
      if (field === 'S') splits += 1;
      continue;
    }

    // Repeated fields concatenate (multi-line memos are real), except for the
    // ones where a second value means a malformed file rather than a long one.
    const existing = current[field];
    current[field] =
      existing === undefined || field === 'D' || field === 'T' || field === 'U'
        ? value
        : `${existing} ${value}`;
  }

  // A file whose last record has no `^` is common enough to accept.
  flush();

  if (transactions.length === 0) throw new ImportError('the QIF file contains no transactions');
  return { accountType, transactions };
}
