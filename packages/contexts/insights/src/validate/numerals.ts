// SPDX-License-Identifier: MIT
/**
 * "Every number a human will read came from somewhere we can point at."
 *
 * §5 of the Phase 2 dispatch names the risk plainly: *an advisor invents a
 * number*. The built-ins are deterministic today, so today this check costs
 * nothing and proves little — which is exactly why it has to exist now. The
 * contract it guards is the one Phase 5's local model and Phase 6's sidecar will
 * use, and a defence added after the first non-deterministic advisor is a
 * defence designed around whatever that advisor happened to do.
 *
 * The check: extract every numeral from the text a human will actually see
 * (after sanitisation, before rendering), and require each one to be traceable
 * to a value in the snapshot we sent, or to a `derivation` we re-computed
 * ourselves. Anything else rejects the insight.
 *
 * ## The three steps, and why masking comes first
 *
 * 1. **Strip URLs.** A link's digits are not a claim about the user's money, and
 *    links are validated separately against the advisor's egress allow-list. An
 *    unstripped `https://example.com/2024/guide` would otherwise demand that
 *    `2024` be in the snapshot.
 * 2. **Mask snapshot string literals.** `2026-10-01`, `50-200`, `MERCHANT_A7F3`
 *    and `food.dining` are values we sent; an advisor quoting one verbatim is
 *    citing, not inventing. Masking them whole, longest first, is what stops
 *    their digits being torn into numerals that then have to be traced
 *    individually — `2026-10-01` is not a claim that `2026`, `10` and `1` are
 *    figures. Only literals that contain a digit *and* a non-digit are masked,
 *    so a bare `"1899"` (money, minor units) is left for the numeric check where
 *    it belongs.
 * 3. **Trace what is left.** Each remaining numeral must equal some candidate
 *    under one of six renderings (below).
 *
 * ## The six renderings
 *
 * A snapshot value and the way it is written are not the same string. `0.62`
 * is written `62%`; `1899` minor units is written `$18.99`; a `-4500` outflow
 * is written `$45.00`. So a candidate `v` matches a numeral printed to `d`
 * decimals if any of `v`, `|v|`, `v × 100`, `|v| × 100`, `v ÷ 100`, `|v| ÷ 100`
 * renders to it at `d` decimals, half-even.
 *
 * That set is enumerable, documented, and each member corresponds to a real
 * formatting decision the UI makes. It is deliberately not "within 1%": a
 * tolerance would let a fabricated number pass by being close to a real one,
 * which is the failure mode of every plausible-sounding hallucination.
 */
import type { NarratedFinding } from '../contract/request.ts';
import type { AdvisorSnapshot } from '../contract/snapshot.ts';
import * as decimal from './decimal.ts';

export interface Numeral {
  /** As written, including any thousands separators and a trailing `%`. */
  readonly raw: string;
  /** Digits only, sign preserved, separators removed. `-1,234.50` → `-1234.50`. */
  readonly normalized: string;
  readonly decimals: number;
  readonly isPercent: boolean;
}

const URL_PATTERN = /\bhttps?:\/\/\S+/gi;
const NUMERAL_PATTERN = /-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/g;

/** Replace every URL with a space. Links are the allow-list's problem, not this one's. */
export function stripUrls(text: string): string {
  return text.replace(URL_PATTERN, ' ');
}

/**
 * Fold every Unicode decimal digit to its ASCII value (F-2).
 *
 * `NUMERAL_PATTERN` is `\d`, ASCII-only. NFKC folds the *compatibility*
 * digit forms — fullwidth (`５`) and mathematical (`𝟓`) — to ASCII on its
 * own; it deliberately leaves every other `\p{Nd}` block alone (Arabic-Indic
 * `٥`, Devanagari `५`, …), because those are canonical digits of a real
 * script, not a compatibility spelling of one. A fabricated figure written in
 * one of those renders to the holder exactly as `$5,400.00` does, so it has
 * to fold too: walk each remaining decimal-digit code point to the start of
 * its contiguous ten-digit run and take the offset. Applied before
 * extraction, never before masking: a literal we sent (a date, a pseudonym)
 * is always ASCII already, so folding first and masking second would change
 * nothing about what a literal matches and everything about what a digit
 * does.
 */
function foldDigits(text: string): string {
  const folded = text.normalize('NFKC');
  let out = '';
  for (const character of folded) {
    if (character >= '0' && character <= '9') {
      out += character;
      continue;
    }
    if (!/\p{Nd}/u.test(character)) {
      out += character;
      continue;
    }
    let start = character.codePointAt(0) ?? 0;
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    const offset = ((character.codePointAt(0) ?? 0) - start) % 10;
    out += String((offset + 10) % 10);
  }
  return out;
}

/**
 * Replace verbatim snapshot string literals with spaces.
 *
 * Longest first, so `2026-10-01` is consumed before `2026-10` could be. Capped
 * at 512 literals and 96 characters each: the masking loop is O(literals ×
 * text), and the snapshot is ours but the *count* of rows in it is the user's
 * data, so it gets a bound like every other loop over user-sized input.
 */
export function maskLiterals(text: string, literals: readonly string[]): string {
  let masked = text;
  for (const literal of literals) {
    if (literal.length < 3 || literal.length > 96) continue;
    if (!/\d/.test(literal) || !/\D/.test(literal)) continue;
    masked = masked.split(literal).join(' ');
  }
  return masked;
}

export function extractNumerals(text: string): readonly Numeral[] {
  const folded = foldDigits(text);
  const found: Numeral[] = [];
  for (const match of folded.matchAll(NUMERAL_PATTERN)) {
    const raw = match[0];
    const normalized = raw.replace(/,/g, '');
    const dot = normalized.indexOf('.');
    const after = folded.slice((match.index ?? 0) + raw.length);
    found.push({
      raw,
      normalized,
      decimals: dot === -1 ? 0 : normalized.length - dot - 1,
      isPercent: after.startsWith('%'),
    });
    if (found.length >= 256) break;
  }
  return found;
}

/**
 * Every numeric value anywhere in the snapshot, as decimals.
 *
 * Both JSON numbers (ratios, weights, counts) and numeric *strings* (money's
 * minor units, quantities) are harvested, because both are figures we sent.
 * Strings that are not numbers are harvested separately, by `stringLiteralsOf`,
 * for masking.
 */
export function collectNumericCandidates(root: unknown): readonly decimal.Decimal[] {
  const seen = new Set<string>();
  const output: decimal.Decimal[] = [];
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length > 0 && visited < 100_000) {
    const current = stack.pop();
    visited += 1;
    if (typeof current === 'number') {
      const value = decimal.fromNumber(current);
      if (value !== null && !seen.has(value.toString())) {
        seen.add(value.toString());
        output.push(value);
      }
      continue;
    }
    if (typeof current === 'string') {
      const value = decimal.parseDecimal(current);
      if (value !== null && !seen.has(value.toString())) {
        seen.add(value.toString());
        output.push(value);
      }
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (typeof current === 'object' && current !== null) {
      for (const value of Object.values(current as Record<string, unknown>)) stack.push(value);
    }
  }
  return output;
}

/** Every string value in the snapshot, longest first. The masking vocabulary. */
export function stringLiteralsOf(root: unknown): readonly string[] {
  const seen = new Set<string>();
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length > 0 && visited < 100_000 && seen.size < 512) {
    const current = stack.pop();
    visited += 1;
    if (typeof current === 'string') {
      seen.add(current);
      continue;
    }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (typeof current === 'object' && current !== null) {
      for (const value of Object.values(current as Record<string, unknown>)) stack.push(value);
    }
  }
  return [...seen].sort((left, right) => right.length - left.length);
}

/** The six renderings. Exported so the evidence doc can print them from the code. */
export function renderingsOf(value: decimal.Decimal, decimals: number): readonly string[] {
  const absolute = decimal.absolute(value);
  const hundred = decimal.parseDecimal('100') as decimal.Decimal;
  const forms = [
    value,
    absolute,
    decimal.multiply(value, hundred),
    decimal.multiply(absolute, hundred),
    decimal.divide(value, hundred),
    decimal.divide(absolute, hundred),
  ];
  const rendered: string[] = [];
  for (const form of forms) {
    if (form === null) continue;
    const text = decimal.render(form, decimals);
    if (text !== null) rendered.push(text);
  }
  return rendered;
}

export function isTraceable(numeral: Numeral, candidates: readonly decimal.Decimal[]): boolean {
  if (numeral.decimals > decimal.DECIMAL_SCALE) return false;
  for (const candidate of candidates) {
    if (renderingsOf(candidate, numeral.decimals).includes(numeral.normalized)) return true;
  }
  return false;
}

export interface TraceInput {
  readonly snapshot: AdvisorSnapshot;
  /** Values from `derivations` we re-computed and accepted. Never the claims. */
  readonly derived: readonly decimal.Decimal[];
}

export interface TraceContext {
  readonly candidates: readonly decimal.Decimal[];
  readonly literals: readonly string[];
}

/**
 * Build the candidate set once per insight.
 *
 * Harvesting the snapshot is the expensive half and it is identical for every
 * field of every insight in a run, so it is hoisted here rather than repeated
 * per string. `derived` is per-insight, because a derivation another insight
 * declared is not a number *this* one may use — that would let two insights
 * launder a number between them.
 */
export function traceContext(input: TraceInput): TraceContext {
  return {
    candidates: [...collectNumericCandidates(input.snapshot), ...input.derived],
    literals: stringLiteralsOf(input.snapshot),
  };
}

/** The numerals in `text` that nothing in the snapshot can account for. */
export function untraceableNumerals(text: string, context: TraceContext): readonly Numeral[] {
  const masked = maskLiterals(stripUrls(text), context.literals);
  return extractNumerals(masked).filter((numeral) => !isTraceable(numeral, context.candidates));
}

// ---------------------------------------------------------------------------
// The narrow trace (WP 5.3): a narrator's figures are its finding's, verbatim
// ---------------------------------------------------------------------------
//
// Everything above is the right check for an advisor that computes, and the
// wrong one for an advisor that narrates. 05 §1 states the failure: a
// language model that writes "you could save $1,899 a year", where 1899 is
// some other row's minor units, passes a snapshot-wide trace — and under the
// six renderings almost any small integer it invents does too, because a
// snapshot of a few hundred values times six renderings covers most of them.
// The Phase 2 ceiling finding was the same shape (wp2.7: a poisoned figure
// passed all seven steps *because it was faithfully traceable*).
//
// For a `narrates_only` advisor, therefore, the candidates are **the figures
// its narrated finding rendered** — and only the fields that are structured
// enough for a figure in them to mean something: its evidence *values*, its
// re-computed derivation values, and its impact display strings. A numeral
// matches only if it is one of them **as written** — same digits, same
// number of decimals, same percent sign. No `×100`, no `÷100`, no absolute
// value, no derivation of the narrator's own (step 4 refuses those).
//
// `title`, `summary_md` and `impact.basis` are deliberately **not** a figure
// source (F-1). A built-in quotes an attacker-chosen string there verbatim —
// a category slug, a crypto token symbol — with no evidence row behind it,
// so a digit run inside one (`C98`'s `98`, a slug's `401k` or its
// `$5,400.00`) is not a figure the finding computed; it is a string the
// finding printed. A narrator may still quote that prose whole — the built-in
// already validated it, word for word, when it proposed the finding — so a
// narration's prose is compared against the finding's own prose **as a
// literal quotation** (`maskFindingProse`) before what is left of it is held
// to the narrow figure set. What a narration copies verbatim needs no figure
// of its own to justify; what it adds or rewrites does.

/** Tokens a finding quotes whole: dates, months and `MERCHANT_…`-style pseudonyms. */
const DATE_TOKEN = /\b\d{4}-\d{2}(?:-\d{2})?\b/g;
const PSEUDONYM_TOKEN = /\b[A-Z]{2,}_[0-9A-Za-z]{6,}\b/g;

export interface FindingTraceContext {
  /** `normalized` + `%` when a percentage: the exact forms the finding wrote. */
  readonly figures: ReadonlySet<string>;
  /** Masked whole before extraction, longest first — the `maskLiterals` vocabulary. */
  readonly literals: readonly string[];
  /**
   * The finding's own prose — title, summary, impact basis — masked out whole
   * (no length cap: three fixed strings, not the snapshot-sized list above).
   * Never a figure source; always a legitimate whole quotation.
   */
  readonly prose: readonly string[];
}

function figureId(numeral: Numeral): string {
  return numeral.isPercent ? `${numeral.normalized}%` : numeral.normalized;
}

/**
 * Every text of the finding a figure can be quoted from: its rendered
 * *values* only — evidence values, derived values, impact display strings.
 * Never `title`, `summary_md`, `impact.basis` or an evidence *label* (F-1) —
 * see the header above. Exported for the evidence count.
 */
export function findingFigureTexts(finding: NarratedFinding): readonly string[] {
  return [
    ...(finding.impact.annualized === null ? [] : [finding.impact.annualized]),
    ...(finding.impact.one_time === null ? [] : [finding.impact.one_time]),
    ...finding.evidence.flatMap((row) => (row.value === null ? [] : [row.value])),
    ...finding.derived,
  ];
}

/**
 * Build the narrow context for one narrated finding.
 *
 * Dates, months and pseudonyms are masked whole in the finding's own texts
 * **before** its figures are harvested, exactly as they are in the narration:
 * `2026-06-01` is a date the finding quoted, not three figures `2026`, `-06`
 * and `-01` a narrator may scatter. A narration may repeat the date; it may
 * not lift its year out as a number.
 */
export function findingTraceContext(finding: NarratedFinding): FindingTraceContext {
  const texts = findingFigureTexts(finding);
  const prose = [finding.title, finding.summary_md, finding.impact.basis].filter(
    (text) => text.length >= 3,
  );
  const tokens = new Set<string>([finding.key, finding.period]);
  for (const text of [finding.key, ...texts, ...prose]) {
    for (const match of text.matchAll(DATE_TOKEN)) tokens.add(match[0]);
    for (const match of text.matchAll(PSEUDONYM_TOKEN)) tokens.add(match[0]);
  }
  const tokenList = [...tokens].sort((left, right) => right.length - left.length);
  const figures = new Set<string>();
  for (const text of texts) {
    const masked = maskLiterals(stripUrls(text), tokenList);
    for (const numeral of extractNumerals(masked)) figures.add(figureId(numeral));
  }
  const literals = new Set<string>(tokenList);
  for (const row of finding.evidence) {
    if (row.value !== null) literals.add(row.value);
    literals.add(row.label);
  }
  return {
    figures,
    literals: [...literals].sort((left, right) => right.length - left.length).slice(0, 512),
    prose,
  };
}

/**
 * Split at sentence/clause/quotation boundaries — `;`, `!`, `?`, a straight or
 * curly quote mark, a `,` only when it is not a thousands separator (not
 * immediately between two digits — `$2,500.00` stays one token), and a `.`
 * only when it ends a sentence (followed by whitespace or the end of the
 * string, never a decimal point) — keeping only chunks long enough to be
 * meaningful. Quote marks matter because a finding often quotes
 * holder-written text mid-sentence (`The goal "${name}" needs …`): that is
 * exactly where a flagged pattern inside the quoted text (I-13's "Ignore
 * previous instructions") sits, and splitting there isolates the surrounding
 * template text — unaffected by sanitisation — into its own, still-matchable
 * chunk. The digit-adjacency guard on `,` exists because naive splitting once
 * cut `$2,500.00 of $3,734.00` into `500.00 of $3` and `734.00`, and those
 * fragments then partially, wrongly matched a differently-worded quotation of
 * the same two figures (found writing this fix's own test).
 */
const PROSE_CHUNK_SPLIT = /[;!?"'‘’“”]|(?<!\d),(?!\d)|\.(?=\s|$)/g;
const MIN_PROSE_CHUNK = 6;

function proseChunks(text: string): readonly string[] {
  return text
    .split(PROSE_CHUNK_SPLIT)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= MIN_PROSE_CHUNK);
}

/**
 * Remove every quotation of the finding's own prose from `text` — the whole
 * phrase where it survives untouched, and clause-sized chunks of it where it
 * does not. The second half matters because the *validator's* view of a
 * finding is never sanitised and a faithful model's view of the prompt
 * always is: a flagged span (an `</untrusted_data>` fence close, a zero-width
 * character, "ignore previous instructions") is removed from what the model
 * reads but not from `finding.summary_md` as this module sees it, so an
 * honest echo of the sanitised prompt is not a byte-for-byte match of the raw
 * finding. A narration that quotes the surviving clauses is still quoting;
 * one that pastes a new sentence after them — the obedient model's directive,
 * appended — matches no clause of the original and is held to the figure set
 * like anything else it wrote.
 */
function maskFindingProse(text: string, prose: readonly string[]): string {
  let masked = text;
  for (const phrase of prose) {
    masked = masked.split(phrase).join(' ');
    for (const chunk of proseChunks(phrase)) masked = masked.split(chunk).join(' ');
  }
  return masked;
}

function maskForFinding(text: string, context: FindingTraceContext): string {
  return maskLiterals(stripUrls(maskFindingProse(text, context.prose)), context.literals);
}

/** The numerals in `text` that are not, verbatim, a figure the finding rendered. */
export function untraceableInFinding(
  text: string,
  context: FindingTraceContext,
): readonly Numeral[] {
  const masked = maskForFinding(text, context);
  return extractNumerals(masked).filter((numeral) => !context.figures.has(figureId(numeral)));
}

// ---------------------------------------------------------------------------
// Number words (F-4): a figure need not be a digit to be a figure
// ---------------------------------------------------------------------------
//
// "About five thousand four hundred dollars" renders exactly as
// "$5,400.00" does, and step 7's digit-only pattern never sees it. A
// conservative detector: units, teens, tens, and `hundred`/`thousand`/
// `million`, counted only when the span itself contains a scale word
// (`hundred`, `thousand`, `million` — a magnitude claim on its own) or a
// currency word sits beside it (`dollars`, `cents`, `percent`). A bare small
// number word with neither — "three months", "two accounts" — is never a
// claim, so a finding's own template prose is never mistaken for one.

const WORD_UNITS: Readonly<Record<string, number>> = {
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
const WORD_SCALES: Readonly<Record<string, number>> = {
  hundred: 100,
  thousand: 1_000,
  million: 1_000_000,
};
const WORD_NUMBER_TOKENS = [...Object.keys(WORD_UNITS), ...Object.keys(WORD_SCALES)].join('|');
const WORD_NUMBER_PATTERN = new RegExp(
  `\\b(?:${WORD_NUMBER_TOKENS})(?:[\\s-]+(?:and[\\s-]+)?(?:${WORD_NUMBER_TOKENS}))*\\b`,
  'giu',
);
const SCALE_WORD = /\b(?:hundred|thousand|million)\b/iu;
const CURRENCY_CUE = /\b(?:dollars?|cents?|percent(?:age)?)\b/iu;
const CONTEXT_WINDOW = 24;

/**
 * A spelled-out English number as an integer **string** — never a `number`:
 * this is a figure a model wrote, and D3 (08 §6.5) keeps every magnitude out
 * of the float type even on the way to a comparison. `bigint` arithmetic;
 * the result is only ever compared, as text, with the finding's own figures.
 */
function wordNumberDigits(phrase: string): string {
  const tokens = phrase
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter((token) => token.length > 0);
  let total = 0n;
  let current = 0n;
  for (const token of tokens) {
    if (token === 'and') continue;
    if (token in WORD_UNITS) {
      current += BigInt(WORD_UNITS[token] ?? 0);
      continue;
    }
    const scale = WORD_SCALES[token];
    if (scale === undefined) continue;
    if (scale === 100) current = (current === 0n ? 1n : current) * 100n;
    else {
      total += (current === 0n ? 1n : current) * BigInt(scale);
      current = 0n;
    }
  }
  return (total + current).toString();
}

export interface WordFigure {
  readonly raw: string;
  /** The spelled figure as a canonical integer string (`"5400"`). */
  readonly digits: string;
}

/**
 * Spelled-out figures with a scale or currency cue — "five thousand four
 * hundred dollars", not "three months". Exported so the evidence doc can
 * demonstrate the false-positive guard directly.
 */
export function extractWordFigures(text: string): readonly WordFigure[] {
  const found: WordFigure[] = [];
  for (const match of text.matchAll(WORD_NUMBER_PATTERN)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - CONTEXT_WINDOW), index);
    const after = text.slice(index + raw.length, index + raw.length + CONTEXT_WINDOW);
    const triggered = SCALE_WORD.test(raw) || CURRENCY_CUE.test(before) || CURRENCY_CUE.test(after);
    if (!triggered) continue;
    const digits = wordNumberDigits(raw);
    if (digits !== '0') found.push({ raw, digits });
    if (found.length >= 64) break;
  }
  return found;
}

/**
 * A rendered figure (`"5,400.00"`, `"36.00"`, `"12%"`) reduced to its canonical
 * integer-string form when it has no fractional part (`"5400"`, `"36"`), so a
 * spelled figure can be matched against it as text. A figure with a non-zero
 * fraction has no spelled-out integer form and is left out.
 */
function canonicalIntegerFigures(figures: ReadonlySet<string>): ReadonlySet<string> {
  const canonical = new Set<string>();
  for (const figure of figures) {
    const bare = (figure.endsWith('%') ? figure.slice(0, -1) : figure).replaceAll(',', '');
    const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(bare);
    if (match === null) continue;
    const [, sign, whole, fraction] = match;
    if (fraction !== undefined && /[1-9]/u.test(fraction)) continue;
    const trimmed = (whole ?? '0').replace(/^0+(?=\d)/u, '');
    canonical.add(`${sign ?? ''}${trimmed}`);
  }
  return canonical;
}

/** The spelled-out figures in `text` that are not, by value, a figure the finding rendered. */
export function untraceableWordFiguresInFinding(
  text: string,
  context: FindingTraceContext,
): readonly WordFigure[] {
  const masked = maskForFinding(text, context);
  const allowed = canonicalIntegerFigures(context.figures);
  return extractWordFigures(masked).filter((figure) => !allowed.has(figure.digits));
}
