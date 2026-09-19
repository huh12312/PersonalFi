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
  const found: Numeral[] = [];
  for (const match of text.matchAll(NUMERAL_PATTERN)) {
    const raw = match[0];
    const normalized = raw.replace(/,/g, '');
    const dot = normalized.indexOf('.');
    const after = text.slice((match.index ?? 0) + raw.length);
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
