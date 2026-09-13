// SPDX-License-Identifier: MIT

export const REDACTED_MARKER = '[redacted]';
declare const redactedTag: unique symbol;

/**
 * A secret that cannot be logged by accident.
 *
 * `toString()`, `toJSON()` and Node's inspect hook all yield `[redacted]`, so a
 * secret that reaches `console.log`, a pino serializer, a template literal, or an
 * error message prints the marker rather than the value. Reading the real value
 * requires calling `reveal()`, which is greppable in review.
 */
export interface Redacted<T = string> {
  readonly [redactedTag]: true;
  reveal(): T;
  toString(): string;
  toJSON(): string;
}

const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');

export function redact<T>(value: T): Redacted<T> {
  const box = {
    reveal: () => value,
    toString: () => REDACTED_MARKER,
    toJSON: () => REDACTED_MARKER,
    [inspectSymbol]: () => REDACTED_MARKER,
  };
  return Object.freeze(box) as unknown as Redacted<T>;
}

export function isRedacted(value: unknown): value is Redacted<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { reveal?: unknown }).reveal === 'function' &&
    String(value) === REDACTED_MARKER
  );
}
