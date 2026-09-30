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
import type { NarratedFinding } from '../contract/request.ts';
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

/** `$1,234.50` and `1234.5` are the same claim. Formatting is not a figure. */
function normalise(text: string): string {
  return text.replace(/[\s$,%()]/g, '').toLowerCase();
}

/**
 * Does `evidence.value` agree with what the ref actually resolved to?
 *
 * The answer depends on what came back, and the split is the whole design:
 *
 *   * **A primitive** — a slug, a date, a bucket label, a count, a ratio. The
 *     advisor is quoting something atomic, so the claim must *contain* it or be
 *     contained by it once formatting is stripped. `'food.dining'` labelled as
 *     `'Dining'` is a fabrication wearing a citation and is refused here.
 *   * **An object or an array** — in practice `{ minor, currency }`. There is no
 *     string form of that a human would write, and demanding one would force
 *     every advisor to print `{"minor":"1899","currency":"USD"}` instead of
 *     `$18.99`. So this returns `true` and the *numeral* check carries the
 *     weight: `18.99` still has to be traceable to a snapshot value or to a
 *     derivation we recomputed, which is the stronger of the two checks anyway.
 *
 * An advisor that cites money and labels it with a number we never sent is
 * therefore caught, just one step later and by a check that cannot be argued
 * with. An advisor that cites a category slug and renames it is caught here,
 * where a numeral check would have had nothing to look at.
 */
export function evidenceValueAgrees(claimed: string | null, resolved: unknown): boolean {
  if (claimed === null) return true;
  if (resolved !== null && typeof resolved === 'object') return true;
  const left = normalise(claimed);
  const right = normalise(displayValue(resolved));
  if (left.length === 0 || right.length === 0) return left === right;
  return left.includes(right) || right.includes(left);
}

// ---------------------------------------------------------------------------
// The `finding:` namespace (contract 1.5.0, WP 5.3)
// ---------------------------------------------------------------------------
//
// A `narrates_only` advisor's citations are resolved **through the finding it
// narrates**, never through a snapshot. `finding:<key>` names one entry of the
// request's `findings` envelope; a narration's `snapshot:` ref is then valid
// only if that finding cited exactly the same ref, and it resolves to what the
// finding said was there. Two consequences are the point:
//
//   * a narration cannot cite anything its finding did not — a real snapshot
//     path the finding never used is refused even though it resolves, which is
//     "cite a subset of the finding's own evidence refs" made mechanical;
//   * the narrator's own snapshot (empty in production) is never consulted, so
//     nothing about a narration's validity depends on what else was sent.
//
// The prefix is a resolution namespace rather than a string a narration
// writes: `SourceRefSchema` accepts `snapshot:` and `external:` only, and the
// narration names its finding by `key`, which the 1:1 check pins.

export const FINDING_REF_PREFIX = 'finding:';

/** `finding:<key>` — the handle a narration's key resolves through. */
export function findingRef(key: string): string {
  return `${FINDING_REF_PREFIX}${key}`;
}

/** The envelope entry `finding:<key>` names, or `null`. Exact key match; no prefix games. */
export function resolveFindingRef(
  findings: readonly NarratedFinding[] | undefined,
  ref: string,
): NarratedFinding | null {
  if (findings === undefined || !ref.startsWith(FINDING_REF_PREFIX)) return null;
  const key = ref.slice(FINDING_REF_PREFIX.length);
  for (const finding of findings) {
    if (finding.key === key) return finding;
  }
  return null;
}

/**
 * The finding a narration narrates — **1:1**: the same key, the same type and
 * the same period, or none. A narration whose key names no finding, or names
 * one under a different type or period, narrates nothing the built-ins made.
 */
export function narratedFindingFor(
  narration: { readonly key: string; readonly type: string; readonly period: string },
  findings: readonly NarratedFinding[] | undefined,
): NarratedFinding | null {
  const finding = resolveFindingRef(findings, findingRef(narration.key));
  if (finding === null) return null;
  if (finding.type !== narration.type || finding.period !== narration.period) return null;
  return finding;
}

export type NarratedRefResolution =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly reason: 'not_in_finding' };

/** Resolve a narration's `snapshot:` ref through its finding's own evidence rows. */
export function resolveNarratedRef(finding: NarratedFinding, ref: string): NarratedRefResolution {
  for (const row of finding.evidence) {
    if (row.source_ref === ref) return { ok: true, value: row.value };
  }
  return { ok: false, reason: 'not_in_finding' };
}

/**
 * A narration's evidence `value` against its finding's. **Equality after
 * formatting**, not `evidenceValueAgrees`' containment: containment would let
 * `$5` stand for `$5,400.00`, and a narrator is quoting, not summarising. A
 * `null` claim is always fine (the row is a citation without a restatement);
 * a claim where the finding stated nothing is not — there is nothing to quote.
 */
export function narratedValueAgrees(claimed: string | null, stated: string | null): boolean {
  if (claimed === null) return true;
  if (stated === null) return false;
  return normalise(claimed) === normalise(stated);
}
