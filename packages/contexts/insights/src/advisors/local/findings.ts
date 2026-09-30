// SPDX-License-Identifier: MIT
/**
 * The findings envelope (contract 1.5.0): what a narrator is shown, and the
 * two rules that decide whether a finding may be shown at all.
 *
 * ## The laundering rule
 *
 * A finding enters a narrator's request only if **every scope its source run
 * emitted is one the narrator's own effective grant covers**. Without it, a
 * narrator granted `cash.summary` alone could read a `holdings.detail`
 * position — symbol, value, cost basis — through the text of a finding the
 * investing rules built from it: the grant table would say one thing and the
 * prompt another. The source scopes are the run's `emitted_scopes` — the
 * blocks that actually existed in the snapshot the built-in saw — not its
 * manifest's request, which can be wider than what was sourced. A finding
 * whose run row is gone (`insights.run_id` is `SET NULL` when runs are pruned)
 * has no provable source and is excluded: fail closed.
 *
 * ## `redactDigits`, implemented where free text reaches a model
 *
 * The scope catalogue declares `redactDigits` on every row and, until this
 * package, nothing read it (05 §2; wp4.9 §12 item 5). The only free text the
 * holder writes that crosses any scope is a **goal name** (`goals.list`,
 * ≤ 96 characters, quoted into R6's copy): descriptors and memos cross no
 * scope, merchants are tokens, category slugs are taxonomy, and a ticker or a
 * token symbol is an identifier the finding's key is built from. Phase 5 is the
 * first phase in which a *model* reads that text, and the narrator reads it only
 * through this envelope (its snapshot is empty), so this is where the flag is
 * applied: for a `local_model` or `external` reader, every digit run in a goal
 * name is removed — from the evidence value that cites it and from every place
 * the finding quoted it — before the envelope is built. "Pay off Visa 4532" is
 * how an account fragment ends up in a prompt; "Pay off Visa" is not. The
 * built-in path (`kind: 'builtin'`) is unchanged: a rule is our code, not a
 * reader of text. **Not closed here, and named:** `SnapshotBuilder` still
 * emits goal names unredacted to any kind that receives the `goals.list`
 * block itself — no production `local_model` advisor does (the narrator's
 * snapshot is empty), and Phase 6's `external` advisor must not until the
 * builder reads the flag too.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { advisorRuns, insightEvidence, insights } from '../../../schema/index.ts';
import type { NarratedFinding } from '../../contract/request.ts';
import { MAX_NARRATED_FINDINGS } from '../../contract/request.ts';
import type { Severity } from '../../contract/response.ts';
import { scopeDefinition, type AdvisorKind, type AdvisorScope } from '../../contract/scopes.ts';
import type { MoneyJson } from '../../contract/snapshot.ts';
import type { InsightsExecutor } from '../../db.ts';
import { insightFeed } from '../../read.ts';
import type { AdvisorRegistry } from '../../registry.ts';
import type { ValidatedInsight } from '../../validate/pipeline.ts';
import { formatMoneyJson } from '../support.ts';

/** What a finding is built from, whichever side (a validated insight or a stored row) supplies it. */
export interface FindingSource {
  readonly key: string;
  readonly period: string;
  readonly type: string;
  readonly severity: Severity;
  readonly title: string;
  readonly summaryMd: string;
  readonly evidence: readonly {
    readonly label: string;
    readonly value: string | null;
    readonly sourceRef: string | null;
  }[];
  /** `derivations[].id` → value. Declared and re-computed agree, or step 6 refused it. */
  readonly derived: readonly { readonly id: string; readonly value: string }[];
  readonly impact: {
    readonly annualized: MoneyJson | null;
    readonly oneTime: MoneyJson | null;
    readonly basis: string;
  };
}

/** `22788.000000` → `22788`; `0.500000` → `0.5`. The value, without the validator's padding. */
function canonicalDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

/** Evidence refs that cite holder-written free text. Goal names only — see the header. */
const FREE_TEXT_REF = /^snapshot:goals_list\.goals\[\d{1,4}\]\.name$/;

/** Does a reader of this kind get `redactDigits` applied? The kinds that are not our own code. */
export function readsFreeText(kind: AdvisorKind): boolean {
  return kind !== 'builtin';
}

/** `Pay off Visa 4532` → `Pay off Visa`. Never empty: a name that was all digits becomes `a goal`. */
export function redactDigitRuns(text: string): string {
  const stripped = text
    .replace(/\p{Nd}+/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return stripped.length === 0 ? 'a goal' : stripped;
}

/**
 * Apply `goals.list`'s `redactDigits` to a finding for a free-text reader.
 * Every quotation of each cited goal name is replaced, so the finding's prose
 * and its evidence still agree — and so the narrow trace, which is built from
 * this envelope, never offers a digit the model was not shown.
 */
export function redactFreeText(source: FindingSource, kind: AdvisorKind): FindingSource {
  if (!readsFreeText(kind)) return source;
  if (!scopeDefinition('goals.list').minimisation.redactDigits) return source;
  const names = new Map<string, string>();
  for (const row of source.evidence) {
    if (row.sourceRef === null || row.value === null || !FREE_TEXT_REF.test(row.sourceRef))
      continue;
    const redacted = redactDigitRuns(row.value);
    if (redacted !== row.value) names.set(row.value, redacted);
  }
  if (names.size === 0) return source;
  // Longest first, so a name that contains another is replaced whole.
  const ordered = [...names.entries()].sort((left, right) => right[0].length - left[0].length);
  const scrub = (text: string): string => {
    let out = text;
    for (const [original, redacted] of ordered) out = out.split(original).join(redacted);
    return out;
  };
  return {
    ...source,
    title: scrub(source.title),
    summaryMd: scrub(source.summaryMd),
    evidence: source.evidence.map((row) => ({
      ...row,
      label: scrub(row.label),
      value: row.value === null ? null : scrub(row.value),
    })),
    impact: { ...source.impact, basis: scrub(source.impact.basis) },
  };
}

/** The wire form. Pure. */
export function narratedFindingOf(source: FindingSource): NarratedFinding {
  const display = (money: MoneyJson | null): string | null =>
    money === null ? null : formatMoneyJson(money);
  return {
    key: source.key,
    period: source.period,
    type: source.type,
    severity: source.severity,
    title: source.title,
    summary_md: source.summaryMd,
    evidence: source.evidence.map((row) => ({
      label: row.label,
      value: row.value,
      source_ref: row.sourceRef,
    })),
    derived: source.derived.map((entry) => canonicalDecimal(entry.value)),
    impact: {
      annualized: display(source.impact.annualized),
      one_time: display(source.impact.oneTime),
      basis: source.impact.basis,
    },
  };
}

/** A validated built-in insight as a finding source — the pure path tests and the eval use. */
export function findingSourceOf(validated: ValidatedInsight): FindingSource {
  const { insight } = validated;
  return {
    key: insight.key,
    period: insight.period,
    type: insight.type,
    severity: validated.severity,
    title: insight.title,
    summaryMd: insight.summary_md,
    evidence: insight.evidence.map((row) => ({
      label: row.label,
      value: row.value,
      sourceRef: row.source_ref,
    })),
    derived: [...validated.derived.entries()].map(([id, value]) => ({ id, value })),
    impact: {
      annualized: insight.impact.annualized,
      oneTime: insight.impact.one_time,
      basis: insight.impact.basis,
    },
  };
}

// ---------------------------------------------------------------------------
// The laundering rule
// ---------------------------------------------------------------------------

export interface LaunderingCandidate {
  readonly source: FindingSource;
  /** The source run's `emitted_scopes`, or `null` when the run row is gone. */
  readonly sourceScopes: readonly string[] | null;
}

export interface LaunderingVerdict {
  readonly admitted: readonly LaunderingCandidate[];
  readonly excluded: readonly {
    readonly key: string;
    /** The source scopes the grant does not cover; empty when the source is unknown. */
    readonly ungranted: readonly string[];
    readonly reason: 'scope_not_granted' | 'source_run_unknown';
  }[];
}

/**
 * Admit a finding only if its source scopes ⊆ the narrator's effective grant.
 * Pure; `test/narrator.test.ts` and the evidence table drive it directly.
 */
export function launderFindings(
  candidates: readonly LaunderingCandidate[],
  grant: readonly AdvisorScope[],
): LaunderingVerdict {
  const granted = new Set<string>(grant);
  const admitted: LaunderingCandidate[] = [];
  const excluded: {
    key: string;
    ungranted: readonly string[];
    reason: 'scope_not_granted' | 'source_run_unknown';
  }[] = [];
  for (const candidate of candidates) {
    if (candidate.sourceScopes === null) {
      excluded.push({ key: candidate.source.key, ungranted: [], reason: 'source_run_unknown' });
      continue;
    }
    const ungranted = candidate.sourceScopes.filter((scope) => !granted.has(scope));
    if (ungranted.length > 0) {
      excluded.push({ key: candidate.source.key, ungranted, reason: 'scope_not_granted' });
      continue;
    }
    admitted.push(candidate);
  }
  return { admitted, excluded };
}

/** The union of the admitted findings' source scopes: what actually reached the model. */
export function scopesReached(admitted: readonly LaunderingCandidate[]): readonly AdvisorScope[] {
  const union = new Set<string>();
  for (const candidate of admitted)
    for (const scope of candidate.sourceScopes ?? []) union.add(scope);
  return [...union].sort() as AdvisorScope[];
}

// ---------------------------------------------------------------------------
// Assembly from the database
// ---------------------------------------------------------------------------

export interface AssembleFindingsInput {
  readonly userId: string;
  /** The narrator's effective grant — the laundering bound. */
  readonly grant: readonly AdvisorScope[];
  readonly kind: AdvisorKind;
  readonly registry: AdvisorRegistry;
  readonly now: Date;
  readonly currency: string;
  /**
   * The built-in insights to narrate — the Brief's items (WP 5.6 / W-C pass
   * them). Absent ⇒ the feed's own top findings: pending, unexpired,
   * unsuppressed, ranked exactly as the feed ranks them.
   */
  readonly insightIds?: readonly string[];
}

export interface AssembledFindings {
  readonly findings: readonly NarratedFinding[];
  /** `finding.key` → the built-in insight row it came from. What a narration links to. */
  readonly insightIdByKey: ReadonlyMap<string, string>;
  /** Union of the admitted findings' source scopes. */
  readonly reached: readonly AdvisorScope[];
  readonly excluded: LaunderingVerdict['excluded'];
}

/**
 * Choose, launder and build the envelope for one narrator run. Reads only this
 * context's own tables. At most `MAX_NARRATED_FINDINGS` findings, and never a
 * narration (a narration is wording, not a finding) or a non-built-in's row.
 */
export async function assembleFindings(
  executor: InsightsExecutor,
  input: AssembleFindingsInput,
): Promise<AssembledFindings> {
  const isBuiltin = (advisorId: string): boolean =>
    input.registry.get(advisorId)?.manifest.kind === 'builtin';

  let orderedIds: readonly string[];
  if (input.insightIds !== undefined) {
    orderedIds = [...new Set(input.insightIds)];
  } else {
    // The feed already excludes narrations, expired and suppressed rows and
    // ranks by 07 §3.2; the narrator takes the same order.
    const feed = await insightFeed(executor, {
      userId: input.userId,
      now: input.now,
      currency: input.currency,
    });
    orderedIds = feed.list.filter((view) => isBuiltin(view.advisorId)).map((view) => view.id);
  }
  if (orderedIds.length === 0) {
    return { findings: [], insightIdByKey: new Map(), reached: [], excluded: [] };
  }

  const rows = await executor
    .select()
    .from(insights)
    .where(
      and(
        eq(insights.userId, input.userId),
        inArray(insights.id, [...orderedIds]),
        isNull(insights.narratesInsightId),
      ),
    );
  const byId = new Map(rows.filter((row) => isBuiltin(row.advisorId)).map((row) => [row.id, row]));
  const ids = orderedIds.filter((id) => byId.has(id));
  if (ids.length === 0)
    return { findings: [], insightIdByKey: new Map(), reached: [], excluded: [] };

  const [evidenceRows, runRows] = await Promise.all([
    executor
      .select()
      .from(insightEvidence)
      .where(
        and(eq(insightEvidence.userId, input.userId), inArray(insightEvidence.insightId, ids)),
      ),
    executor
      .select({ id: advisorRuns.id, emittedScopes: advisorRuns.emittedScopes })
      .from(advisorRuns)
      .where(
        and(
          eq(advisorRuns.userId, input.userId),
          inArray(
            advisorRuns.id,
            ids.flatMap((id) => {
              const runId = byId.get(id)?.runId ?? null;
              return runId === null ? [] : [runId];
            }),
          ),
        ),
      ),
  ]);
  const scopesByRun = new Map(runRows.map((row) => [row.id, row.emittedScopes]));
  const evidenceBy = new Map<string, typeof evidenceRows>();
  for (const row of evidenceRows) {
    const list = evidenceBy.get(row.insightId) ?? [];
    list.push(row);
    evidenceBy.set(row.insightId, list);
  }

  const candidates: (LaunderingCandidate & { readonly insightId: string })[] = [];
  const seenKeys = new Set<string>();
  for (const id of ids) {
    const row = byId.get(id);
    if (row === undefined) continue;
    // The envelope is keyed by finding key (a narration names its finding by
    // it). Two built-ins sharing a key would make that ambiguous; the second
    // is left out rather than guessed between.
    if (seenKeys.has(row.key)) continue;
    const evidence = (evidenceBy.get(id) ?? []).sort(
      (left, right) => left.position - right.position,
    );
    if (evidence.length === 0) continue;
    seenKeys.add(row.key);
    const currency = row.impactCurrency;
    const money = (minor: bigint | null): MoneyJson | null =>
      minor === null || currency === null ? null : { minor: minor.toString(), currency };
    candidates.push({
      insightId: id,
      sourceScopes: row.runId === null ? null : (scopesByRun.get(row.runId) ?? null),
      source: {
        key: row.key,
        period: row.period,
        type: row.type,
        severity: row.severity as Severity,
        title: row.title,
        summaryMd: row.summaryMd,
        evidence: evidence.map((entry) => ({
          label: entry.label,
          value: entry.value,
          sourceRef: entry.sourceRef,
        })),
        derived: row.derivations.flatMap((derivation) => {
          const derivationId = derivation['id'];
          const value = derivation['value'];
          return typeof derivationId === 'string' && typeof value === 'string'
            ? [{ id: derivationId, value }]
            : [];
        }),
        impact: {
          annualized: money(row.impactAnnualizedMinor),
          oneTime: money(row.impactOneTimeMinor),
          basis: row.impactBasis,
        },
      },
    });
  }

  const verdict = launderFindings(candidates, input.grant);
  const admitted = (verdict.admitted as typeof candidates).slice(0, MAX_NARRATED_FINDINGS);
  return {
    findings: admitted.map((candidate) =>
      narratedFindingOf(redactFreeText(candidate.source, input.kind)),
    ),
    insightIdByKey: new Map(
      admitted.map((candidate) => [candidate.source.key, candidate.insightId]),
    ),
    reached: scopesReached(admitted),
    excluded: verdict.excluded,
  };
}
