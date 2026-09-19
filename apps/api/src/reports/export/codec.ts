// SPDX-License-Identifier: MIT
/**
 * One row ↔ one JSONL line, and the running hash each stream is checked
 * against.
 *
 * Generic on purpose: the registry names ~30 tables across five contexts, and a
 * hand-written serialiser per table is a second schema for each of them to
 * drift from. `@core/db`'s global type parsers (`installTypeParsers`, already
 * active on every pool this application opens) hand back `BIGINT` as a real
 * `bigint` and `DATE` as a plain `YYYY-MM-DD` string; this module's only job is
 * the two conversions `JSON.stringify` cannot do itself — `bigint` and
 * `Buffer` — done the same way in both directions so a round trip is exact.
 */
import { sha256 } from '@core/secretbox';

const BIGINT_MARKER = '__bigint__:';
const BUFFER_MARKER = '__bytes__:';

/** A row as `pg` hands it back: `bigint` for `BIGINT`, `Buffer` for `BYTEA`, `Date` for `TIMESTAMPTZ`. */
export type RawRow = Record<string, unknown>;

function encodeValue(value: unknown): unknown {
  if (typeof value === 'bigint') return `${BIGINT_MARKER}${value.toString()}`;
  if (value instanceof Buffer) return `${BUFFER_MARKER}${value.toString('base64')}`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(encodeValue);
  return value;
}

function decodeValue(value: unknown): unknown {
  if (typeof value === 'string' && value.startsWith(BIGINT_MARKER)) {
    return BigInt(value.slice(BIGINT_MARKER.length));
  }
  if (typeof value === 'string' && value.startsWith(BUFFER_MARKER)) {
    return Buffer.from(value.slice(BUFFER_MARKER.length), 'base64');
  }
  if (Array.isArray(value)) return value.map(decodeValue);
  return value;
}

/** One canonical, single-line JSON encoding of a row. No trailing newline. */
export function encodeRow(row: RawRow): string {
  const encoded: RawRow = {};
  for (const key of Object.keys(row).sort()) encoded[key] = encodeValue(row[key]);
  return JSON.stringify(encoded);
}

/** The inverse of `encodeRow`. Column order is not restored (object keys are unordered). */
export function decodeRow(line: string): RawRow {
  const parsed = JSON.parse(line) as RawRow;
  const decoded: RawRow = {};
  for (const [key, value] of Object.entries(parsed)) decoded[key] = decodeValue(value);
  return decoded;
}

/**
 * A sha256 over a stream's lines, `line + "\n"` each, in emission order.
 * Export and import both call this the same way, which is what makes a
 * tampered byte anywhere in a stream refuse to match (dispatch: "a tampered
 * stream hash is refused").
 *
 * `@core/secretbox`'s `sha256` is one-shot (`Uint8Array -> Uint8Array`), not an
 * incremental `Hash` — this application's one cryptography chokepoint
 * (`docs/CONVENTIONS.md`, `eslint.config.js`'s `no-restricted-imports` on
 * `node:crypto`) does not need a streaming digest anywhere else, so it does
 * not expose one. A stream here is one table's rows for one user, already
 * bounded in memory by `bundle.ts`'s own design note, so buffering the bytes
 * and hashing once costs nothing extra.
 */
export class StreamHasher {
  #chunks: string[] = [];

  add(line: string): void {
    this.#chunks.push(line, '\n');
  }

  digest(): string {
    const bytes = new TextEncoder().encode(this.#chunks.join(''));
    return Buffer.from(sha256(bytes)).toString('hex');
  }
}
