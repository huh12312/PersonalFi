// SPDX-License-Identifier: MIT
/**
 * Walks `GetAssumptionsResponse.file` (an opaque `AssumptionsFile` on the
 * wire — `packages/contexts/planning/data/assumptions.ts`'s own header:
 * "Every number sits in a cited node carrying a `source` and an `asOf`")
 * and flattens every cited leaf into one list the assumptions panel renders
 * without a click (`docs/plan/04-phase-4-dispatch.md` §3 "WP 4.10": "every
 * number with its `source` and `as_of` visible without a click — … a
 * disclosure that hides the citation behind a chevron satisfies two of
 * three").
 *
 * A leaf is any object carrying string `source` and `asOf` fields — that is
 * the server's own citation contract (`nominal`/`plainRate`'s shape in
 * `data/assumptions.ts`), not a UI-side guess at the schema. Everything
 * else (`format`, `label`, and every intermediate grouping object) is a
 * plain container and is recursed into, never rendered as a number itself.
 */

export interface CitedAssumption {
  /** Dot-joined, e.g. `capitalMarket.usEquity.expectedReturn` — the same spelling `AssumptionsAppliedOverride.path` and `overridablePaths` use. */
  readonly path: string;
  /** Human path, e.g. "Capital market → US equity → Expected return". */
  readonly label: string;
  readonly kind: string | null;
  readonly value: string;
  readonly basis: string | null;
  readonly source: string;
  readonly asOf: string;
  readonly note: string | null;
}

function isCitedLeaf(node: unknown): node is Record<string, unknown> {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
  const record = node as Record<string, unknown>;
  return typeof record.source === 'string' && typeof record.asOf === 'string';
}

/** `usEquity` → "US equity"; `expectedReturn` → "Expected return". A tiny, deterministic humaniser — no i18n library for seven-ish words. */
function humanizeSegment(segment: string): string {
  const spaced = segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
  const words = spaced.split(' ');
  const acronyms = new Set(['us', 'ss', 'hsa', 'ira', 'rmd', 'niit', 'ltcg', 'fra', 'cola']);
  return words
    .map((word, index) => {
      if (acronyms.has(word)) return word.toUpperCase();
      if (index === 0) return word.charAt(0).toUpperCase() + word.slice(1);
      return word;
    })
    .join(' ');
}

function humanizePath(segments: readonly string[]): string {
  return segments.map(humanizeSegment).join(' → ');
}

/**
 * Depth-first walk, sorted by path at each level for a stable render order
 * (object key order is not itself meaningful here, and a stable order is
 * what makes a screenshot and a "did this change" diff possible).
 */
export function walkCitedAssumptions(file: unknown): readonly CitedAssumption[] {
  const out: CitedAssumption[] = [];

  function visit(node: unknown, path: readonly string[]): void {
    if (isCitedLeaf(node)) {
      out.push({
        path: path.join('.'),
        label: humanizePath(path),
        kind: typeof node.kind === 'string' ? node.kind : null,
        value: typeof node.value === 'string' ? node.value : String(node.value ?? ''),
        basis: typeof node.basis === 'string' ? node.basis : null,
        source: node.source as string,
        asOf: node.asOf as string,
        note: typeof node.note === 'string' ? node.note : null,
      });
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, [...path, String(index)]));
      return;
    }
    for (const key of Object.keys(node as Record<string, unknown>).sort()) {
      visit((node as Record<string, unknown>)[key], [...path, key]);
    }
  }

  visit(file, []);
  return out;
}

/** Groups the flat list by its top-level key (`capitalMarket`, `usTax2026`, …) for the panel's sections, preserving each group's internal sort order. */
export function groupByTopLevel(
  assumptions: readonly CitedAssumption[],
): ReadonlyMap<string, readonly CitedAssumption[]> {
  const groups = new Map<string, CitedAssumption[]>();
  for (const assumption of assumptions) {
    const top = assumption.path.split('.')[0] ?? assumption.path;
    const group = groups.get(top);
    if (group === undefined) groups.set(top, [assumption]);
    else group.push(assumption);
  }
  return groups;
}
