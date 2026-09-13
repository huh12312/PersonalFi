// SPDX-License-Identifier: MIT

/**
 * What a boxed secret prints as, everywhere.
 *
 * Exported because the log redactor in `apps/api` censors with the same string:
 * an operator reading a log line should not have to work out whether
 * `[redacted]` came from the `Redacted` box or from pino's `redact` paths.
 */
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
