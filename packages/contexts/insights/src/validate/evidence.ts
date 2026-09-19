// SPDX-License-Identifier: MIT
/**
 * `source_ref` resolution — "did we actually send this?"
 *
 * 08 §4.3 calls it "the single most effective anti-hallucination check
 * available, and it's pure validation, not a model". The whole of it is: an
 * insight cites `snapshot:recurring_list.streams[3].typical_amount.minor`, and
 * either that path resolves to a defined value in the snapshot **we** built and
 * **we** sent, or the insight is rejected. There is no partial credit, no
 * nearest-match, and no "the advisor probably meant".
 *
 * ## Why resolution is against the emitted snapshot, not the read models
 *
 * The obvious mistake would be to resolve a ref by going back to the database.
 * That would make a ref citing data the advisor never received *resolve* — the
 * exact fabrication the check exists to catch, since an advisor that guessed a
 * plausible path would be rewarded for guessing. The snapshot object the builder
 * produced is the only thing a ref is measured against, which is also why
 * `advisor_runs` stores the `input_digest` of precisely that object.
 *
 * ## The path grammar is tiny on purpose
 *
 * `identifier` (`.identifier`)* with `[n]` for array indices, where `n` is at
 * most four digits. No wildcards, no slices, no filters, no `..` descent, no
 * quoted keys. A grammar with any of those needs an evaluator; this one needs a
 * loop. The regex in `SourceRefSchema` accepts exactly what this parses, and
 * `resolveSourceRef` re-parses rather than trusting that, because it is also
 * called on refs that arrived inside a `derivation`.
 *
 * ## Prototype pollution
 *
 * `__proto__`, `constructor` and `prototype` are refused as segments before any
 * lookup happens. A ref of `snapshot:__proto__.polluted` against a plain object
 * would otherwise resolve to something, and "something" is what a check like
 * this must never return.
 */
import type { AdvisorSnapshot } from '../contract/snapshot.ts';

export type RefResolution =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: RefFailure };

export type RefFailure =
  | 'malformed'
  | 'not_a_snapshot_ref'
  | 'unknown_key'
  | 'missing_path'
  | 'index_out_of_range'
  | 'forbidden_segment'
  | 'undefined_value';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const SEGMENT = /^[A-Za-z0-9_]+$/;

interface Segment {
  readonly kind: 'key' | 'index';
  readonly key: string;
  readonly index: number;
}

/** Split `a.b[2].c` into segments. `null` when the path is not that shape. */
export function parsePath(path: string): readonly Segment[] | null {
  if (path.length === 0 || path.length > 480) return null;
  const segments: Segment[] = [];
  let cursor = 0;
  let expectKey = true;
  while (cursor < path.length) {
    if (path[cursor] === '[') {
      const close = path.indexOf(']', cursor);
      if (close === -1) return null;
      const digits = path.slice(cursor + 1, close);
      if (!/^\d{1,4}$/.test(digits)) return null;
      segments.push({ kind: 'index', key: digits, index: Number(digits) });
      cursor = close + 1;
      expectKey = false;
      continue;
    }
    if (!expectKey) {
      if (path[cursor] !== '.') return null;
      cursor += 1;
    }
    let end = cursor;
    while (end < path.length && path[end] !== '.' && path[end] !== '[') end += 1;
    const key = path.slice(cursor, end);
    if (!SEGMENT.test(key)) return null;
    segments.push({ kind: 'key', key, index: -1 });
    cursor = end;
    expectKey = false;
  }
  return segments.length === 0 ? null : segments;
}

/** `true` for a ref this module owns. `external:` refs are `links.ts`'s. */
export function isSnapshotRef(ref: string): boolean {
  return ref.startsWith('snapshot:');
}

/**
 * Walk a `snapshot:` ref into the snapshot we sent.
 *
 * `undefined` at the end is a failure, not a value: a scope that was not granted
 * produces no key, so a ref into it resolving to `undefined` is precisely the
 * case `'an ungranted scope yields no key in the snapshot'` is about.
 */
export function resolveSourceRef(snapshot: AdvisorSnapshot, ref: string): RefResolution {
  if (!isSnapshotRef(ref)) return { ok: false, reason: 'not_a_snapshot_ref' };
  const segments = parsePath(ref.slice('snapshot:'.length));
  if (segments === null) return { ok: false, reason: 'malformed' };

  let current: unknown = snapshot;
  let first = true;
  for (const segment of segments) {
    if (segment.kind === 'key') {
      if (FORBIDDEN.has(segment.key)) return { ok: false, reason: 'forbidden_segment' };
      if (current === null || typeof current !== 'object' || Array.isArray(current)) {
        return { ok: false, reason: first ? 'unknown_key' : 'missing_path' };
      }
      if (!Object.hasOwn(current, segment.key)) {
        return { ok: false, reason: first ? 'unknown_key' : 'missing_path' };
      }
      current = (current as Record<string, unknown>)[segment.key];
    } else {
      if (!Array.isArray(current)) return { ok: false, reason: 'missing_path' };
      if (segment.index >= current.length) return { ok: false, reason: 'index_out_of_range' };
      current = current[segment.index];
    }
    first = false;
  }
  if (current === undefined) return { ok: false, reason: 'undefined_value' };
  return { ok: true, value: current };
}

/**
 * The display form of a resolved value, for comparing against `evidence.value`.
 *
 * Money resolves to an object; a reviewer reading the evidence panel sees a
 * figure. Rather than teach the comparison about every shape, anything that is
 * not a primitive is rendered as its canonical JSON, and the comparison is a
 * *containment* check (`evidenceValueAgrees`) rather than equality — an advisor
 * is allowed to label `{ minor: "1899", currency: "USD" }` as `$18.99`, and the
 * numeral check is what proves the `18.99` came from somewhere real.
 */
export function displayValue(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
      return String(value);
    default:
      return JSON.stringify(value) ?? '';
  }
}
