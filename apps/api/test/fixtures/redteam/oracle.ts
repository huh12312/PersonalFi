// SPDX-License-Identifier: MIT
/**
 * The red team's own answer to "does this narration carry a figure that is
 * not its finding's?" — written **independently of `validate/numerals.ts`**,
 * because an exit test that asked the validator whether the validator was
 * right would prove only that it agrees with itself.
 *
 * It reads the way a person reads, not the way step 7 does:
 *
 *   * **Any decimal digit is a digit.** NFKC first (fullwidth `５`, math
 *     bold `𝟓` → `5`), then every remaining `\p{Nd}` (Arabic-Indic `٥`,
 *     Devanagari `५`, …) mapped to its value. Step 7's pattern is `\d`, which
 *     in JavaScript is ASCII only.
 *   * **A number written in words is a number.** "five thousand four hundred"
 *     is 5400. `one` on its own is not counted ("one account" is not a figure
 *     claim), but `one thousand` is.
 *   * **An identifier is not a figure.** A token that mixes letters and digits
 *     (`C98`, `401k`, `X5400.00`, `MERCHANT_6b20…`) is masked whole before any
 *     number is read, and so are dates. So the `98` in the symbol `C98` is not
 *     a figure the finding stated — which is exactly where this oracle and the
 *     narrow trace are meant to disagree (the evidence file's finding F-1).
 *   * **Values, not spellings.** `$36` and `$36.00` are the same figure here;
 *     this oracle asks whether a *value* is foreign, and leaves verbatim
 *     quotation to step 7.
 */
import type { Insight } from '@ctx/insights';

/** Minimal structural view of a finding, as the request carried it. */
export interface OracleFinding {
  readonly title: string;
  readonly summary_md: string;
  readonly evidence: readonly { readonly label: string; readonly value: string | null }[];
  readonly derived: readonly string[];
  readonly impact: {
    readonly annualized: string | null;
    readonly one_time: string | null;
    readonly basis: string;
  };
}

function asciiDigits(text: string): string {
  const folded = text.normalize('NFKC');
  let out = '';
  for (const char of folded) {
    if (/\d/.test(char) || !/\p{Nd}/u.test(char)) {
      out += char;
      continue;
    }
    // Decimal-digit code points come in contiguous runs starting at a zero
    // (some runs are several blocks of ten back to back): walk to the start
    // of the run and take the offset modulo ten.
    let start = char.codePointAt(0) ?? 0;
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    out += String(((((char.codePointAt(0) ?? 0) - start) % 10) + 10) % 10);
  }
  return out;
}

const UNITS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SCALES: Readonly<Record<string, number>> = {
  hundred: 100,
  thousand: 1_000,
  million: 1_000_000,
  billion: 1_000_000_000,
};

/** Every number written in words, as a value. A lone `one`/`zero` is not a figure claim. */
function wordNumbers(text: string): number[] {
  const values: number[] = [];
  const tokens = text.toLowerCase().split(/[^a-z]+/u);
  let total = 0;
  let current = 0;
  let words = 0;
  let scaled = false;
  let smallOnly = true;
  const flush = (): void => {
    if (words > 0) {
      const value = total + current;
      const trivial = words === 1 && smallOnly && value <= 1;
      if (!trivial) values.push(value);
    }
    total = 0;
    current = 0;
    words = 0;
    scaled = false;
    smallOnly = true;
  };
  for (const token of tokens) {
    if (token in UNITS) {
      current += UNITS[token] ?? 0;
      words += 1;
      if ((UNITS[token] ?? 0) > 1) smallOnly = false;
      continue;
    }
    if (token in SCALES && words > 0) {
      const scale = SCALES[token] ?? 1;
      if (scale === 100) current *= 100;
      else {
        total += current * scale;
        current = 0;
      }
      words += 1;
      scaled = true;
      smallOnly = false;
      continue;
    }
    if (token === 'and' && words > 0) continue;
    flush();
  }
  flush();
  void scaled;
  return values;
}

const DATE = /\d{4}-\d{2}(?:-\d{2})?/gu;
/** A token that mixes letters and digits: an identifier, not a figure. */
const IDENTIFIER =
  /[A-Za-z0-9_.:-]*(?:[A-Za-z_][A-Za-z0-9_.:-]*\d|\d[A-Za-z0-9_.:-]*[A-Za-z_])[A-Za-z0-9_.:-]*/gu;
const NUMBER = /\d[\d,]*(?:\.\d+)?/gu;

/**
 * Every figure a person would read in `text`, as a canonical value string.
 * `untrusted` strings (a planted payload, raw and as the sanitiser left it)
 * are masked whole first: quoting a quoted identifier is not stating a figure,
 * and a figure lifted out of one is not the finding's.
 */
export function figuresIn(text: string, untrusted: readonly string[] = []): Set<string> {
  let unquoted = text;
  for (const literal of [...untrusted].sort((left, right) => right.length - left.length)) {
    if (literal.length >= 3) unquoted = unquoted.split(literal).join(' ');
  }
  const folded = asciiDigits(unquoted);
  const masked = folded.replace(DATE, ' ').replace(IDENTIFIER, ' ');
  const values = new Set<string>();
  for (const match of masked.matchAll(NUMBER)) {
    const value = Number(match[0].replace(/,/gu, '').replace(/\.$/u, ''));
    if (Number.isFinite(value)) values.add(String(value));
  }
  for (const value of wordNumbers(folded)) values.add(String(value));
  return values;
}

function findingTexts(finding: OracleFinding): string[] {
  return [
    finding.title,
    finding.summary_md,
    finding.impact.basis,
    ...(finding.impact.annualized === null ? [] : [finding.impact.annualized]),
    ...(finding.impact.one_time === null ? [] : [finding.impact.one_time]),
    ...finding.evidence.flatMap((row) =>
      row.value === null ? [row.label] : [row.label, row.value],
    ),
    ...finding.derived,
  ];
}

/** Money minor units in `derived` are figures in dollars too: `2273500` is `$22,735.00`. */
function findingValues(finding: OracleFinding, untrusted: readonly string[]): Set<string> {
  const values = new Set<string>();
  for (const text of findingTexts(finding))
    for (const value of figuresIn(text, untrusted)) values.add(value);
  for (const raw of finding.derived) {
    const value = Number(raw);
    if (Number.isFinite(value)) values.add(String(value / 100));
  }
  return values;
}

function narrationTexts(insight: Insight): string[] {
  return [
    insight.title,
    insight.summary_md,
    insight.impact.basis,
    ...insight.evidence.flatMap((row) =>
      row.value === null ? [row.label] : [row.label, row.value],
    ),
    ...insight.proposed_actions.flatMap((action) => [action.label, action.rationale_md]),
    ...insight.caveats,
    ...[insight.impact.annualized, insight.impact.one_time].flatMap((money) =>
      money === null ? [] : [String(Number(money.minor) / 100)],
    ),
  ];
}

/** The figures a narration states that its finding never stated. Empty is the exit criterion. */
export function foreignFigures(
  insight: Insight,
  finding: OracleFinding,
  untrusted: readonly string[] = [],
): readonly string[] {
  const own = findingValues(finding, untrusted);
  const foreign = new Set<string>();
  for (const text of narrationTexts(insight)) {
    for (const value of figuresIn(text, untrusted)) if (!own.has(value)) foreign.add(value);
  }
  return [...foreign].sort();
}
