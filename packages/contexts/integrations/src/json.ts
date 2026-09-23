// SPDX-License-Identifier: MIT
/**
 * JSON parsing that does not turn a price into a float.
 *
 * ## The bug this prevents
 *
 * The Phase 3 risk table's first row: *"A float reaches a quantity or a price.
 * D3 is irreversible and Phase 1 already caught `toFixed(18)` manufacturing
 * seventeen digits of garbage from `268.4`."* A price arrives as JSON, and
 * `JSON.parse` produces an IEEE double. `232.35` becomes
 * `232.34999999999999432…`, and every later `String(value)` prints `232.35`
 * again — so the loss is invisible until it is multiplied by a quantity and
 * summed across a portfolio, which is precisely "where nobody looks".
 *
 * The fix is to never let the literal become a double at all. `JSON.parse`'s
 * reviver receives a third argument carrying `context.source`, **the original
 * text of the number** (V8 12.4+, Node 22+; this repo pins Node 26). So every
 * number in a provider response comes out of `parseDecimalJson` as the exact
 * string the provider sent, and `Money`/`Quantity`/`NUMERIC(20,10)` take it
 * from there without an intermediate float ever existing.
 *
 * The fallback path — a runtime without `context.source` — is `String(value)`,
 * which *is* lossy past ~15 significant digits. It is here so the module cannot
 * crash on an unexpected runtime, and `supportsSourceText()` is exported so a
 * test can assert we are on the good path rather than silently on the fallback.
 *
 * ## Bounds
 *
 * The transport already caps the body while it arrives. This adds the two
 * structural bounds 08 §4.4's validation pipeline asks for — depth and node
 * count — because a 1 MiB body can still be a million-deep array, and the place
 * to refuse that is before it becomes objects.
 */

/** 08 §4.4: "JSON parse with depth and key-count limits." */
export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 200_000;

export class MalformedProviderResponse extends Error {
  constructor(detail: string) {
    super(`the provider's response could not be believed: ${detail}`);
    this.name = 'MalformedProviderResponse';
  }
}

interface ReviverContext {
  readonly source?: string;
}

/** Is the exact-literal path available? A test asserts this is `true` here. */
export function supportsSourceText(): boolean {
  let seen = false;
  JSON.parse('1.5', function reviver(_key: string, _value: unknown, context?: ReviverContext) {
    if (context !== undefined && typeof context.source === 'string') seen = true;
    return _value;
  } as never);
  return seen;
}

/**
 * Parse a provider body with **every number preserved as its exact decimal
 * string**.
 *
 * The return type is `unknown` on purpose: a provider's JSON is not a type
 * until something has checked it, and handing back `any` would let an adapter
 * dot its way into a field the provider never sent.
 */
export function parseDecimalJson(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, function reviver(
      _key: string,
      value: unknown,
      context?: ReviverContext,
    ): unknown {
      if (typeof value !== 'number') return value;
      const source = context?.source;
      // `source` is the literal exactly as it appeared: "232.35", "1e-9",
      // "0.000000010000000000". Handing it on as a string is the whole point.
      return typeof source === 'string' ? source : String(value);
    } as never);
  } catch (error) {
    throw new MalformedProviderResponse(error instanceof Error ? error.message : 'not valid JSON');
  }
  assertBounded(parsed);
  return parsed;
}

function assertBounded(value: unknown): void {
  let nodes = 0;
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) {
      throw new MalformedProviderResponse(`nested deeper than ${String(MAX_JSON_DEPTH)} levels`);
    }
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      throw new MalformedProviderResponse(`more than ${String(MAX_JSON_NODES)} nodes`);
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const child of Object.values(node)) walk(child, depth + 1);
    }
  };
  walk(value, 0);
}

/** A record, or `null` if the provider sent something else. No throwing, no casting. */
export function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function arrayOf(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function stringAt(value: unknown, key: string): string | null {
  const record = recordOf(value);
  const field = record?.[key];
  return typeof field === 'string' ? field : null;
}

/**
 * A decimal field, as the string the provider sent.
 *
 * Accepts a string (which is what `parseDecimalJson` produces for every number)
 * and validates it is a decimal literal before it is allowed anywhere near a
 * `NUMERIC` column. `1e-9` is legal JSON and legal Postgres, so it passes;
 * `NaN`, `Infinity` and `"about 3"` do not.
 */
export function decimalAt(value: unknown, key: string): string | null {
  const record = recordOf(value);
  const field = record?.[key];
  if (typeof field !== 'string') return null;
  return isDecimalLiteral(field) ? field : null;
}

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

export function isDecimalLiteral(value: string): boolean {
  return DECIMAL.test(value);
}

/**
 * Normalise a decimal literal into the plain form `NUMERIC` takes without
 * surprises, expanding exponents.
 *
 * Postgres accepts `1e-9` in a `NUMERIC` literal, but a value that has passed
 * through here reads the same in a log, a test failure and a column, which is
 * worth more than the two lines it costs. Implemented on the string, with no
 * intermediate `Number`.
 */
export function plainDecimal(literal: string): string {
  if (!isDecimalLiteral(literal)) {
    throw new MalformedProviderResponse(`${literal} is not a decimal literal`);
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?$/.exec(literal);
  if (match === null) return literal;
  const sign = match[1] ?? '';
  const whole = match[2] ?? '0';
  const fraction = match[3] ?? '';
  const exponent = match[4] === undefined ? 0 : Number.parseInt(match[4], 10);
  if (exponent === 0) return fraction === '' ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;

  const digits = `${whole}${fraction}`;
  // Where the point sits after shifting by `exponent`.
  const point = whole.length + exponent;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`.replace(/0+$/, '0');
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
