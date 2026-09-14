// SPDX-License-Identifier: MIT
/**
 * CSV: RFC 4180 reading, then a user-supplied column mapping.
 *
 * The reader is deliberately a hand-written state machine rather than a regex
 * or a `split(',')`. A bank descriptor contains commas ("SMITH, J."), quotes
 * ("3\" PIPE"), and — on at least one UK bank's export — a literal newline
 * inside a quoted memo field. Every one of those breaks `split`, and breaks it
 * *silently*: the row still parses, it just has the wrong number of fields and
 * the amount column becomes the date column.
 */
import { ImportError } from './errors.ts';

export interface CsvReadOptions {
  /** One character. `,`, `;` and `\t` cover every export seen in the wild. */
  readonly delimiter?: string;
}

/**
 * Split CSV text into rows of fields.
 *
 * Handles: quoted fields, `""` as an escaped quote, embedded delimiters, CR, LF
 * and CRLF line endings, a UTF-8 BOM, and a trailing newline. Does **not**
 * handle a file whose rows have inconsistent field counts — that is the
 * mapping's problem, and it produces a better error message there because it
 * knows which column it wanted.
 */
export function readCsv(text: string, options: CsvReadOptions = {}): string[][] {
  const delimiter = options.delimiter ?? ',';
  if (delimiter.length !== 1) throw new ImportError('the CSV delimiter must be one character');

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let sawAnyChar = false;

  // A BOM at the head of the file becomes part of the first header name
  // otherwise, and then `mapping.date === 'Date'` stops matching for reasons
  // nobody can see in a diff.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    // A file ending in a newline must not produce a final empty row.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    sawAnyChar = false;
  };

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? '';

    if (quoted) {
      if (char !== '"') {
        field += char;
        continue;
      }
      if (body[index + 1] === '"') {
        field += '"';
        index += 1;
        continue;
      }
      quoted = false;
      continue;
    }

    if (char === '"' && field === '' && !sawAnyChar) {
      quoted = true;
      sawAnyChar = true;
      continue;
    }
    if (char === delimiter) {
      endField();
      sawAnyChar = false;
      continue;
    }
    if (char === '\n') {
      endRow();
      continue;
    }
    if (char === '\r') {
      if (body[index + 1] === '\n') index += 1;
      endRow();
      continue;
    }
    field += char;
    sawAnyChar = true;
  }

  if (field !== '' || row.length > 0) endRow();
  if (quoted) throw new ImportError('the file ends inside a quoted field');
  return rows;
}

/**
 * Which column holds what.
 *
 * A column is named by header text (case- and whitespace-insensitive) or by
 * 0-based index, so a headerless export is as mappable as a labelled one.
 */
export type ColumnRef = string | number;

export interface CsvColumnMapping {
  readonly date: ColumnRef;
  readonly description: ColumnRef;
  /** One signed column. Mutually exclusive with `debit`/`credit`. */
  readonly amount?: ColumnRef;
  /** Two magnitude columns, one of which is blank per row. The other shape. */
  readonly debit?: ColumnRef;
  readonly credit?: ColumnRef;
  readonly payee?: ColumnRef;
  readonly memo?: ColumnRef;
  readonly currency?: ColumnRef;
  /** The provider's own id, when the export carries one. Rare, and worth using. */
  readonly reference?: ColumnRef;
}

/**
 * Resolve a column reference against the header row.
 *
 * Header matching folds case, collapses whitespace and strips punctuation, so
 * `"Transaction Date"`, `"transaction_date"` and `"TRANSACTION DATE "` are the
 * same column. That leniency is worth it: a bank changing `Date` to `Date ` in a
 * minor release is a real thing that has happened, and the alternative is the
 * user re-doing their mapping.
 */
export function resolveColumns(
  header: readonly string[] | null,
  mapping: CsvColumnMapping,
): Readonly<Record<keyof CsvColumnMapping, number | null>> {
  const index = new Map<string, number>();
  header?.forEach((name, position) => {
    const key = foldHeader(name);
    if (key !== '' && !index.has(key)) index.set(key, position);
  });

  const resolve = (ref: ColumnRef | undefined, required: boolean): number | null => {
    if (ref === undefined) return null;
    if (typeof ref === 'number') return ref;
    const position = index.get(foldHeader(ref));
    if (position !== undefined) return position;
    // A *required* column that is missing means the profile does not describe
    // this file, and importing it would silently read the wrong column as the
    // amount. An *optional* one missing is routine: the same bank's export gains
    // and loses a Memo column between releases, and a preset that hard-failed on
    // that would be a preset nobody could use twice.
    if (!required) return null;
    throw new ImportError(
      `the file has no column named ${JSON.stringify(ref)}` +
        (header === null ? ' (and no header row to look in)' : ''),
    );
  };

  return Object.freeze({
    date: resolve(mapping.date, true),
    description: resolve(mapping.description, true),
    // One of these three must resolve; which one is the caller's business, and
    // `importFile` refuses a profile that maps none of them.
    amount: resolve(mapping.amount, false),
    debit: resolve(mapping.debit, false),
    credit: resolve(mapping.credit, false),
    payee: resolve(mapping.payee, false),
    memo: resolve(mapping.memo, false),
    currency: resolve(mapping.currency, false),
    reference: resolve(mapping.reference, false),
  });
}

function foldHeader(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Field at `position`, or `''`. Never `undefined`: a short row is a blank cell. */
export function cell(row: readonly string[], position: number | null): string {
  if (position === null) return '';
  return (row[position] ?? '').trim();
}
