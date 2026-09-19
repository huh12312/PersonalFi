// SPDX-License-Identifier: MIT
/**
 * Declared arithmetic, re-computed by us.
 *
 * The anti-fabrication rule ("an advisor may not introduce a number absent from
 * the snapshot") would, taken literally, forbid the most useful sentence advice
 * can contain: *"$18.99 a month is $227.88 a year."* `227.88` is nowhere in the
 * snapshot. It is also not invented — it is arithmetic over something that is.
 *
 * A `derivation` is how an advisor says so: an expression, the `source_ref`
 * inputs it stands on, and the value it claims. We parse the expression, resolve
 * the inputs against the snapshot **we** sent, evaluate it ourselves in exact
 * fixed-scale decimal, and compare. The advisor therefore cannot introduce a
 * number; it can only introduce *arithmetic*, and arithmetic is checkable.
 *
 * ## The literal allow-list, and the hole it closes
 *
 * The obvious hole in "declare your arithmetic" is `$0 * 0 + 4999`: an
 * expression that references an input, computes nothing from it, and smuggles a
 * literal through as the answer. So literals are not free. Only the constants
 * below are accepted, every one of them a *unit* rather than a quantity — the
 * number of months in a year, weeks in a year, days in a cooldown, basis points
 * in a whole. `4999` is not on the list and there is no way to build it, because
 * an expression must also reference at least one input and a bare-literal
 * expression is refused outright.
 *
 * This is stricter than it first looks and deliberately so: the cost is that a
 * built-in rule needing an unusual constant must add it here, in a reviewed
 * diff, with a reason — which is exactly the review we want to force.
 *
 * ## No `eval`, no `Function`, no regex-and-hope
 *
 * A recursive-descent parser over a five-token grammar. 03 §8.1 rule 4: "output
 * is data, never instructions … the app never `eval`s". An expression that does
 * not parse is a rejected derivation, never a thrown worker.
 */
import type { Derivation } from '../contract/response.ts';
import type { AdvisorSnapshot } from '../contract/snapshot.ts';
import * as decimal from './decimal.ts';
import { resolveSourceRef } from './evidence.ts';

/**
 * Every literal an expression may name.
 *
 * | Literal | Why it is a unit and not a quantity |
 * | --- | --- |
 * | `0`, `1` | identity and zero; a `1 - x` complement is the common form |
 * | `0.5` | 07 §3.2 ranks a one-time saving at half a recurring one |
 * | `2`, `3`, `4`, `6` | bimonthly, quarterly, semiannual and their reciprocals |
 * | `7`, `14`, `30`, `90` | days: a week, a fortnight, and the two cooldown rungs |
 * | `12`, `24`, `26`, `52` | months, semimonthly, biweekly and weekly periods per year |
 * | `60`, `100`, `1000` | percent and per-mille scaling, and minutes where a rate is per hour |
 * | `365`, `366` | days in a year, and the leap year a daily rate must survive |
 */
export const DERIVATION_LITERALS: readonly string[] = Object.freeze([
  '0',
  '0.5',
  '1',
  '2',
  '3',
  '4',
  '6',
  '7',
  '12',
  '14',
  '24',
  '26',
  '30',
  '52',
  '60',
  '90',
  '100',
  '365',
  '366',
  '1000',
]);

const ALLOWED_LITERALS = new Set(DERIVATION_LITERALS);

export type DerivationFailure =
  | 'unparsable_expression'
  | 'forbidden_literal'
  | 'no_input_referenced'
  | 'input_out_of_range'
  | 'input_unresolvable'
  | 'input_not_numeric'
  | 'arithmetic_undefined'
  | 'claimed_value_unparsable'
  | 'value_mismatch';

export type DerivationOutcome =
  | { readonly ok: true; readonly value: decimal.Decimal }
  | { readonly ok: false; readonly reason: DerivationFailure; readonly detail: string };

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

type Token =
  | { readonly kind: 'number'; readonly text: string }
  | { readonly kind: 'input'; readonly index: number }
  | { readonly kind: 'op'; readonly text: '+' | '-' | '*' | '/' }
  | { readonly kind: 'paren'; readonly text: '(' | ')' };

function tokenise(expression: string): readonly Token[] | null {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < expression.length) {
    const character = expression[cursor] as string;
    if (character === ' ') {
      cursor += 1;
      continue;
    }
    if (character === '+' || character === '-' || character === '*' || character === '/') {
      tokens.push({ kind: 'op', text: character });
      cursor += 1;
      continue;
    }
    if (character === '(' || character === ')') {
      tokens.push({ kind: 'paren', text: character });
      cursor += 1;
      continue;
    }
    if (character === '$') {
      const match = /^\$(\d{1,2})/.exec(expression.slice(cursor));
      if (match === null) return null;
      tokens.push({ kind: 'input', index: Number(match[1]) });
      cursor += match[0].length;
      continue;
    }
    const numberMatch = /^\d{1,4}(?:\.\d{1,4})?/.exec(expression.slice(cursor));
    if (numberMatch === null) return null;
    tokens.push({ kind: 'number', text: numberMatch[0] });
    cursor += numberMatch[0].length;
    // A token count cap: the parser is linear, but an unbounded token stream is
    // still unbounded work for a payload we have not decided to trust yet.
    if (tokens.length > 128) return null;
  }
  return tokens.length === 0 || tokens.length > 128 ? null : tokens;
}

// ---------------------------------------------------------------------------
// Parser / evaluator
// ---------------------------------------------------------------------------

interface EvalState {
  readonly tokens: readonly Token[];
  position: number;
  readonly inputs: readonly decimal.Decimal[];
  usedInput: boolean;
  failure: DerivationFailure | null;
  detail: string;
}

function fail(state: EvalState, reason: DerivationFailure, detail: string): null {
  if (state.failure === null) {
    state.failure = reason;
    state.detail = detail;
  }
  return null;
}

function parseExpression(state: EvalState): decimal.Decimal | null {
  let left = parseTerm(state);
  if (left === null) return null;
  for (;;) {
    const token = state.tokens[state.position];
    if (token === undefined || token.kind !== 'op' || (token.text !== '+' && token.text !== '-')) {
      return left;
    }
    state.position += 1;
    const right = parseTerm(state);
    if (right === null) return null;
    const result = token.text === '+' ? decimal.add(left, right) : decimal.subtract(left, right);
    if (result === null) return fail(state, 'arithmetic_undefined', `overflow at '${token.text}'`);
    left = result;
  }
}

function parseTerm(state: EvalState): decimal.Decimal | null {
  let left = parseFactor(state);
  if (left === null) return null;
  for (;;) {
    const token = state.tokens[state.position];
    if (token === undefined || token.kind !== 'op' || (token.text !== '*' && token.text !== '/')) {
      return left;
    }
    state.position += 1;
    const right = parseFactor(state);
    if (right === null) return null;
    const result = token.text === '*' ? decimal.multiply(left, right) : decimal.divide(left, right);
    if (result === null) {
      return fail(
        state,
        'arithmetic_undefined',
        token.text === '/' ? 'division by zero' : 'overflow at *',
      );
    }
    left = result;
  }
}

function parseFactor(state: EvalState): decimal.Decimal | null {
  const token = state.tokens[state.position];
  if (token === undefined) return fail(state, 'unparsable_expression', 'unexpected end');
  if (token.kind === 'op' && token.text === '-') {
    state.position += 1;
    const inner = parseFactor(state);
    return inner === null ? null : decimal.negate(inner);
  }
  if (token.kind === 'paren' && token.text === '(') {
    state.position += 1;
    const inner = parseExpression(state);
    if (inner === null) return null;
    const close = state.tokens[state.position];
    if (close === undefined || close.kind !== 'paren' || close.text !== ')') {
      return fail(state, 'unparsable_expression', 'unbalanced parenthesis');
    }
    state.position += 1;
    return inner;
  }
  if (token.kind === 'number') {
    if (!ALLOWED_LITERALS.has(token.text)) {
      return fail(state, 'forbidden_literal', token.text);
    }
    state.position += 1;
    const parsed = decimal.parseDecimal(token.text);
    return parsed ?? fail(state, 'unparsable_expression', token.text);
  }
  if (token.kind === 'input') {
    const value = state.inputs[token.index];
    if (value === undefined) return fail(state, 'input_out_of_range', `$${token.index}`);
    state.position += 1;
    state.usedInput = true;
    return value;
  }
  return fail(state, 'unparsable_expression', 'unexpected token');
}

/**
 * A resolved input as a number.
 *
 * Money resolves to `{ minor, currency }` and is taken at its **minor units**,
 * which is what makes `$0 * 12` mean what an author expects: the operands stay
 * in the ledger's own integer units and never become dollars-as-floats halfway
 * through. A string operand must be a decimal string; a boolean, a date, an
 * array or an object with no `minor` is not a number and is refused rather than
 * coerced.
 */
export function numericValueOf(value: unknown): decimal.Decimal | null {
  if (typeof value === 'number') return decimal.fromNumber(value);
  if (typeof value === 'string') return decimal.parseDecimal(value);
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const minor = (value as Record<string, unknown>)['minor'];
    if (typeof minor === 'string') return decimal.parseDecimal(minor);
  }
  return null;
}

/**
 * Evaluate one derivation against the snapshot, and compare with what it claims.
 *
 * The comparison allows the claim to be the computed value **rounded to the
 * claim's own number of decimal places**, half-even. `227.88` for a computed
 * `227.880000` is display rounding and is fine; `230` for the same figure is
 * not, because `230` has zero decimals and the computed value rounds to `228`.
 */
export function evaluateDerivation(
  snapshot: AdvisorSnapshot,
  derivation: Derivation,
): DerivationOutcome {
  const inputs: decimal.Decimal[] = [];
  for (const ref of derivation.inputs) {
    const resolution = resolveSourceRef(snapshot, ref);
    if (!resolution.ok) {
      return { ok: false, reason: 'input_unresolvable', detail: `${ref}: ${resolution.reason}` };
    }
    const numeric = numericValueOf(resolution.value);
    if (numeric === null) return { ok: false, reason: 'input_not_numeric', detail: ref };
    inputs.push(numeric);
  }

  const tokens = tokenise(derivation.expression);
  if (tokens === null) {
    return { ok: false, reason: 'unparsable_expression', detail: derivation.expression };
  }

  const state: EvalState = {
    tokens,
    position: 0,
    inputs,
    usedInput: false,
    failure: null,
    detail: '',
  };
  const computed = parseExpression(state);
  if (computed === null || state.failure !== null) {
    return {
      ok: false,
      reason: state.failure ?? 'unparsable_expression',
      detail: state.detail === '' ? derivation.expression : state.detail,
    };
  }
  if (state.position !== tokens.length) {
    return { ok: false, reason: 'unparsable_expression', detail: 'trailing tokens' };
  }
  if (!state.usedInput) {
    return { ok: false, reason: 'no_input_referenced', detail: derivation.expression };
  }

  const claimed = decimal.parseDecimal(derivation.value);
  if (claimed === null) {
    return { ok: false, reason: 'claimed_value_unparsable', detail: derivation.value };
  }
  const decimals = derivation.value.includes('.')
    ? derivation.value.length - derivation.value.indexOf('.') - 1
    : 0;
  const rendered = decimal.render(computed, Math.min(decimals, 6));
  const claimedRendered = decimal.render(claimed, Math.min(decimals, 6));
  if (rendered === null || claimedRendered === null || rendered !== claimedRendered) {
    return {
      ok: false,
      reason: 'value_mismatch',
      detail: `claimed ${derivation.value}, computed ${decimal.render(computed, 6) ?? '?'}`,
    };
  }
  return { ok: true, value: computed };
}
