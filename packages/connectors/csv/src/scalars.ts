// SPDX-License-Identifier: MIT
/**
 * Turning the strings in a bank file into `Money` and `DateOnly`.
 *
 * Both conversions are where a file import quietly corrupts a ledger, and both
 * are done here without ever touching a float:
 *
 *   * **`parseAmount`** works on the digit string. `Number('0.1') + Number('0.2')`
 *     is the canonical example of why; a statement with 4,000 rows accumulates
 *     that error into something a user notices. The decimal point is found, the
 *     fraction is padded or rounded to the currency's scale, and the result is a
 *     `BigInt` of minor units.
 *   * **`parseFileDate`** never constructs a `Date`. A bank's posted date is a
 *     calendar date in the account's timezone; putting it through a `Date` and
 *     back is how 2026-03-01 becomes 2026-02-28 for a user in UTC-5
 *     (docs/CONVENTIONS.md, "Time"). It stays a `YYYY-MM-DD` string throughout.
 */
import { DateOnly, currency as currencyOf, minorUnitScale, money, type Money } from '@core/kernel';
import { ImportError } from './errors.ts';

export type DecimalSeparator = '.' | ',' | 'auto';

/**
 * Which way round a bank prints an outflow.
 *
 * `natural` is the house convention (negative = outflow). `inverted` is for the
 * exports — common on credit-card statements — that print a purchase as a
 * positive "charge". Getting this wrong inverts a user's entire spend history,
 * so it is an explicit field on the profile and never inferred.
 */
export type AmountSign = 'natural' | 'inverted';

const SIGN_TRAILING = /^(.*?)(CR|DR)$/i;

/**
 * `"$1,234.56"`, `"(12.34)"`, `"1.234,56"`, `"12.34 CR"` → minor units.
 *
 * When `separator` is `'auto'`: if both `.` and `,` appear, the **last** one is
 * the decimal separator and the other is grouping — that rule is correct for
 * both `1,234.56` and `1.234,56`. If only one appears, it is treated as a
 * decimal point when it is followed by one to (scale) digits and as grouping
 * otherwise, so `1,234` is one thousand two hundred and thirty-four and `1,23`
 * is one and twenty-three hundredths. A file where that guess is wrong is
 * exactly why the profile can state the separator outright.
 */
export function parseAmount(
  raw: string,
  currency: string,
  options: { readonly separator?: DecimalSeparator; readonly sign?: AmountSign } = {},
): Money {
  // Validated here rather than trusted: the currency comes from a CSV cell or a
  // profile default, and the scale it selects decides where the decimal point
  // goes. A three-decimal currency (KWD, BHD) read as two is a tenfold error.
  const code = currencyOf(currency);
  const scale = minorUnitScale(code);
  let text = raw.trim();
  if (text === '') throw new ImportError('amount is empty');

  let negative = false;

  // Accounting parentheses: (12.34) is -12.34.
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  // A trailing CR/DR marker, as UK and some AU exports print.
  const marker = SIGN_TRAILING.exec(text);
  if (marker?.[1] !== undefined && marker[2] !== undefined) {
    if (marker[2].toUpperCase() === 'DR') negative = !negative;
    text = marker[1].trim();
  }

  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1).trim();
  } else if (text.startsWith('+')) {
    text = text.slice(1).trim();
  }

  // Currency symbols, spaces, non-breaking spaces, apostrophe grouping.
  text = text.replaceAll(/[^\d.,]/g, '');
  if (text === '') throw new ImportError(`amount ${JSON.stringify(raw)} has no digits`);

  const { whole, fraction } = split(text, options.separator ?? 'auto', scale, raw);
  const minor = toMinor(whole, fraction, scale);
  return money(negative === ((options.sign ?? 'natural') === 'inverted') ? minor : -minor, code);
}

function split(
  text: string,
  separator: DecimalSeparator,
  scale: number,
  raw: string,
): { whole: string; fraction: string } {
  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');

  let decimalAt: number;
  if (separator === '.') decimalAt = lastDot;
  else if (separator === ',') decimalAt = lastComma;
  else if (lastDot >= 0 && lastComma >= 0) decimalAt = Math.max(lastDot, lastComma);
  else if (lastDot >= 0 || lastComma >= 0) {
    const only = Math.max(lastDot, lastComma);
    const trailing = text.length - only - 1;
    decimalAt = trailing >= 1 && trailing <= Math.max(scale, 2) ? only : -1;
  } else decimalAt = -1;

  const wholeText = decimalAt < 0 ? text : text.slice(0, decimalAt);
  const fraction = decimalAt < 0 ? '' : text.slice(decimalAt + 1);
  // The decimal separator appearing *again* in the integer part is not grouping:
  // no locale groups with the same character it uses for the point. `1.2.3` is a
  // malformed amount, and reading it as 12.3 would be a silent tenfold error.
  if (/[.,]/.test(fraction) || (decimalAt >= 0 && wholeText.includes(text[decimalAt] ?? ''))) {
    throw new ImportError(`amount ${JSON.stringify(raw)} has more than one decimal separator`);
  }
  return { whole: wholeText.replaceAll(/[.,]/g, ''), fraction };
}

/** Half-up on the digit string. Explicit, and never via a float. */
function toMinor(whole: string, fraction: string, scale: number): bigint {
  const kept = fraction.slice(0, scale).padEnd(scale, '0');
  // `charCodeAt` past the end is NaN, and `NaN >= 53` is false: no extra digit,
  // no rounding. 53 is '5'.
  const roundUp = fraction.charCodeAt(scale) >= 53;
  const base = BigInt(`${whole === '' ? '0' : whole}${kept}`);
  return roundUp ? base + 1n : base;
}

export const DATE_FORMATS = [
  'iso', // 2026-05-20, and anything else already YYYY-MM-DD
  'mdy', // 05/20/2026, 5/20/26
  'dmy', // 20/05/2026, 20.05.2026
  'ymd', // 2026/05/20, 20260520
  'auto',
] as const;

export type DateFormat = (typeof DATE_FORMATS)[number];

const PARTS = /^(\d{1,4})\D(\d{1,2})\D(\d{2,4})$/;
const COMPACT = /^(\d{4})(\d{2})(\d{2})$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * A calendar date from whatever the bank printed.
 *
 * `'auto'` resolves the `01/02/2026` ambiguity the only way that is ever safe:
 * it does not. It reads it as `mdy` **unless** the first field exceeds 12, in
 * which case it can only be a day. A file of purely ambiguous dates must state
 * its format in the profile — and the connector says so in the error rather than
 * guessing, because a silently wrong month is a whole budget in the wrong place.
 */
export function parseFileDate(raw: string, format: DateFormat = 'auto'): DateOnly {
  const text = raw.trim();
  if (text === '') throw new ImportError('date is empty');

  const iso = ISO.exec(text);
  if (iso !== null && (format === 'iso' || format === 'auto' || format === 'ymd')) {
    return assemble(iso[1], iso[2], iso[3], text);
  }

  const compact = COMPACT.exec(text);
  if (compact !== null) return assemble(compact[1], compact[2], compact[3], text);

  const parts = PARTS.exec(text);
  if (parts === null) throw new ImportError(`date ${JSON.stringify(raw)} is not a date`);
  const [a, b, c] = [parts[1] ?? '', parts[2] ?? '', parts[3] ?? ''];

  if (a.length === 4) return assemble(a, b, c, text);

  const effective = format === 'auto' ? (Number(a) > 12 ? 'dmy' : 'mdy') : format;
  if (effective === 'dmy') return assemble(expandYear(c), b, a, text);
  if (effective === 'mdy') return assemble(expandYear(c), a, b, text);
  throw new ImportError(
    `date ${JSON.stringify(raw)} is ambiguous; set dateFormat to 'mdy' or 'dmy' on the profile`,
  );
}

/**
 * `26` → `2026`. A two-digit year is a lie the file tells; this is the least-bad
 * reading of it, and a 1900s transaction in a personal-finance app does not exist.
 */
function expandYear(year: string): string {
  if (year.length === 4) return year;
  return `20${year.padStart(2, '0')}`;
}

function assemble(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined,
  raw: string,
): DateOnly {
  const text = `${(year ?? '').padStart(4, '0')}-${(month ?? '').padStart(2, '0')}-${(day ?? '').padStart(2, '0')}`;
  try {
    // `DateOnly.parse` rejects 2026-02-30, which a hand-rolled check would not.
    return DateOnly.parse(text);
  } catch {
    throw new ImportError(`date ${JSON.stringify(raw)} is not a real calendar date`);
  }
}
