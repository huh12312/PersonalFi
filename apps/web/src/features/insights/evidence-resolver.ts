// SPDX-License-Identifier: MIT
import { formatMoney, parseWireMoney } from '../../lib/money.ts';

/**
 * The client-side half of master-plan decision D22: "an insight may not show
 * a number that is not in its evidence — the UI renders numbers FROM the
 * evidence refs, never recomputes." `@ctx/insights`' seven-step pipeline
 * (docs/evidence/phase-2/wp2.6-insights.md §3) already proved every numeral
 * in `summaryMd` traces to the snapshot it was given, server-side, before an
 * insight is ever written. This module is the discipline this screen keeps
 * on its own side of the wire: the evidence panel never prints a figure of
 * its own — it only ever displays a row that is *already* part of this
 * exact insight's `evidence[]`, looked up by the same `source_ref` the
 * advisor cited, resolved against nothing else.
 */
export interface EvidenceRefLike {
  readonly sourceRef: string | null;
  readonly label: string;
  readonly value: string | null;
  readonly resolvedDisplay: string | null;
}

export class UnresolvedEvidenceRefError extends Error {
  constructor(sourceRef: string) {
    super(
      `evidence ref "${sourceRef}" does not resolve to any evidence row on this insight — ` +
        'refusing to render a number that has no source (master plan D22)',
    );
    this.name = 'UnresolvedEvidenceRefError';
  }
}

/**
 * Finds the evidence row this insight itself carries for `sourceRef`.
 * Throws `UnresolvedEvidenceRefError` when no row cites it — the one thing
 * this function refuses to do is fall back to a guess, a blank string, or
 * a value from a different insight's evidence.
 */
export function resolveEvidenceRef<T extends EvidenceRefLike>(
  evidence: readonly T[],
  sourceRef: string,
): T {
  const row = evidence.find((candidate) => candidate.sourceRef === sourceRef);
  if (row === undefined) {
    throw new UnresolvedEvidenceRefError(sourceRef);
  }
  return row;
}

/** What `displayValueOf` may need to know about the insight a row belongs to. */
export interface DisplayContext {
  /** The insight's own currency (its impact's), for a snapshot leaf that is minor units. */
  readonly currency?: string | null;
}

/**
 * A snapshot leaf that is an amount in minor units: the ref ends `.minor`
 * (`snapshot:…amount.minor`), and the value is a whole number. The built-ins
 * cite such a leaf with `value: null` and the server stores the leaf as the
 * resolved display, so it arrives here as the bare string `129900` for a
 * $1,299.00 purchase (Phase 5 gate G5-9: a 100× figure on the panel the rung
 * calls "a full evidence panel").
 */
function isMinorUnitLeaf(row: EvidenceRefLike, shown: string): boolean {
  return row.sourceRef !== null && /\.minor$/u.test(row.sourceRef) && /^-?\d+$/u.test(shown);
}

/**
 * The exact text a row displays: the server's own resolved display,
 * falling back to the advisor's raw `value` — never invented when both are
 * `null` (some evidence rows, e.g. `kind: 'transaction'` citing a list rather
 * than a single figure, are legitimately numberless — that is `'—'`, not a
 * fabricated zero).
 *
 * One formatting step, and only for money: a minor-unit leaf is printed as
 * money in the insight's currency (`129900` → `$1,299.00`). It is formatting of
 * the figure the server resolved — never arithmetic on a different one — and
 * with no currency to print it in the raw figure is labelled as minor units
 * rather than shown bare as if it were dollars.
 */
export function displayValueOf(row: EvidenceRefLike, context: DisplayContext = {}): string {
  const shown = row.resolvedDisplay ?? row.value;
  if (shown === null) return '—';
  if (!isMinorUnitLeaf(row, shown)) return shown;
  const currency = context.currency ?? null;
  if (currency === null) return `${shown} minor units`;
  try {
    return formatMoney(parseWireMoney({ minor: shown, currency }), { signDisplay: 'auto' });
  } catch {
    return `${shown} minor units`;
  }
}

/**
 * Every `sourceRef` an insight's evidence actually carries — used to prove,
 * for a test or for a defensive assertion, that a number rendered elsewhere
 * on the card (e.g. the headline impact figure) is backed by *some* row in
 * this exact evidence array, not merely plausible-looking.
 */
export function citedSourceRefs(evidence: readonly EvidenceRefLike[]): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const row of evidence) {
    if (row.sourceRef !== null) refs.add(row.sourceRef);
  }
  return refs;
}
