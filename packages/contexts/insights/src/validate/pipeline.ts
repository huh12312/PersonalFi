// SPDX-License-Identifier: MIT
/**
 * The seven-step validation pipeline (08 §4.4) — the only door into the feed.
 *
 * Nothing an advisor produces reaches `insights` except through
 * `validateResponse`. That is the single most load-bearing sentence in this
 * package, and it is structural rather than a convention: `store.ts`'s insert
 * takes a `ValidatedInsight`, a type this module is the sole constructor of and
 * whose `status` is the literal `'pending_review'`. There is no exported way to
 * build one from an `Insight`, so a caller that wanted to skip validation would
 * have to edit this file — a reviewable diff — rather than forget a call.
 *
 * ## The seven steps
 *
 * | # | Step | What it refuses |
 * | --- | --- | --- |
 * | 1 | `transport` | a body over the resolved byte limit, or that is not JSON |
 * | 2 | `schema` | anything `AdvisorResponseSchema` does not accept — `requires_review: false`, a `status` property, a fifth `proposed_actions[].kind`, empty `evidence` |
 * | 3 | `envelope` | an unsupported `contract_version`, a `request_id` that does not echo, a different `advisor_id`, more insights than the limits allow |
 * | 4 | `capability` | `confidence_basis: 'deterministic'` from a non-`builtin` or an advisor that never claimed it; `impact` from one that declared `produces_impact: false`; a new finding from a `narrates_only` advisor. Severity above the ceiling is **clamped**, not refused |
 * | 5 | `evidence` | a `source_ref` that does not resolve into the snapshot we sent; a label that disagrees with what it resolved to; a link outside the advisor's own allow-list |
 * | 6 | `derivations` | arithmetic that does not produce the value it claims, a literal outside the allow-list, an `impact.derivation_id` naming a derivation that failed |
 * | 7 | `numerals` | a figure in any rendered field that is in neither the snapshot nor an accepted derivation; Markdown outside the permitted subset |
 *
 * ## A narrator is held to its finding (WP 5.3)
 *
 * For a `narrates_only` advisor three steps change what they measure against,
 * and each change is narrower, never wider:
 *
 *   * **Step 4** resolves the narration to exactly one finding in the request's
 *     `findings` envelope — the same `key`, `type` and `period`
 *     (`narratedFindingFor`, 1:1) — and refuses a narration that has none, is
 *     not `confidence_basis: 'model'`, declares a derivation, proposes an
 *     action, or sits above its finding's severity. A severity above the
 *     finding's is **refused**, not clamped: the clamp exists so a real finding
 *     is not lost for shouting, and a narration is not a finding.
 *   * **Step 5** resolves every citation *through the finding*: a narration may
 *     cite only refs its finding cited, and each value must equal what the
 *     finding said was there. The snapshot is not consulted.
 *   * **Step 7** traces every numeral against the finding's own rendered
 *     figures, verbatim (`findingTraceContext`) — not every number in the
 *     snapshot under six renderings, which is 05 §1's hole.
 *
 * There is no retry. A narration refused here is refused; the built-in's text
 * stands (07 §7.5 rule 1) and the run records the step. Re-asking until the
 * validator agrees would launder the very rate the ≥95% criterion measures.
 *
 * Steps 1–3 reject the **response**: there is nothing partial to keep when the
 * envelope is wrong, and half-trusting a payload whose `request_id` does not
 * match is how a stale run lands in this run's queue. Steps 4–7 reject the
 * **insight**: one bad figure should cost one insight, not the whole run, and
 * counting per-insight rejections per step is what makes "advisor X keeps
 * inventing numbers" a number on a dashboard instead of a hunch.
 *
 * ## Totality
 *
 * Every function reachable from `validateResponse` is total over arbitrary
 * input: it returns a verdict, it never throws, and it never loops on
 * attacker-chosen length. `test/validation-totality.test.ts` is a `fast-check`
 * property over arbitrary JSON that asserts exactly that, and asserts the second
 * half too — that two calls on the same input produce the same verdict, because
 * a validator that is not deterministic is a validator whose failures cannot be
 * reproduced from the stored `input_digest`.
 *
 * ## What this does *not* do
 *
 * It does not decide whether an insight is worth showing. Ranking, the alert
 * budget and the cooldown ladder are `policy/`'s, and they run *after* this and
 * on rows that are already `pending_review`. Keeping "is it true?" and "is it
 * worth saying?" in different modules is what lets the second one change on a
 * product argument without anybody touching the first.
 */
import type { AdvisorManifest, ResolvedLimits } from '../contract/manifest.ts';
import type { AdvisorRequest, NarratedFinding } from '../contract/request.ts';
import {
  AdvisorResponseSchema,
  severityRank,
  type AdvisorResponse,
  type Insight,
  type Severity,
} from '../contract/response.ts';
import type { AdvisorSnapshot } from '../contract/snapshot.ts';
import { SUPPORTED_CONTRACT_MAJORS } from '../contract/version.ts';
import * as decimal from './decimal.ts';
import { evaluateDerivation } from './derivations.ts';
import {
  displayValue,
  evidenceValueAgrees,
  isSnapshotRef,
  narratedFindingFor,
  narratedValueAgrees,
  resolveNarratedRef,
  resolveSourceRef,
} from './evidence.ts';
import { checkLink, externalUrlOf } from './links.ts';
import { markdownViolations, renderableStrings } from './markdown.ts';
import {
  findingTraceContext,
  traceContext,
  untraceableInFinding,
  untraceableNumerals,
} from './numerals.ts';

export const VALIDATION_STEPS = [
  'transport',
  'schema',
  'envelope',
  'capability',
  'evidence',
  'derivations',
  'numerals',
] as const;
export type ValidationStep = (typeof VALIDATION_STEPS)[number];

/** A rejection of the whole response. Steps 1–3 only. */
export interface ResponseRejection {
  readonly step: ValidationStep;
  readonly reason: string;
  readonly detail: string;
}

/** A rejection of one insight. Steps 4–7 only. */
export interface InsightRejection extends ResponseRejection {
  /** Position in `insights[]`. Stable; the key may be missing or duplicated. */
  readonly index: number;
  /** The advisor's `key`, when the insight got far enough to have a valid one. */
  readonly key: string | null;
}

/** One evidence row, with what its ref actually resolved to. */
export interface ResolvedEvidenceRow {
  readonly kind: string;
  readonly label: string;
  readonly value: string | null;
  readonly sourceRef: string | null;
  /** The normalised `https://` href for an `external:` ref; `null` otherwise. */
  readonly href: string | null;
  /** `displayValue` of the resolved snapshot value. Stored, so the evidence
   * panel can show what we sent even after the snapshot itself is gone. */
  readonly resolvedDisplay: string | null;
}

/**
 * An insight that passed all seven steps.
 *
 * `status` is a literal and this module is its only constructor. The plan's
 * sentence — "`status = 'pending_review'` always, with no field an advisor can
 * set to change it" — is therefore two mechanisms rather than one: the response
 * schema has no `status` property to send, and the validated shape has one the
 * advisor never touched.
 */
export interface ValidatedInsight {
  readonly status: 'pending_review';
  readonly insight: Insight;
  /** After the manifest's ceiling. Equal to `insight.severity` when not clamped. */
  readonly severity: Severity;
  readonly severityClamped: boolean;
  readonly evidence: readonly ResolvedEvidenceRow[];
  /** `derivations[].id` → the value *we* computed, rendered at scale 6. */
  readonly derived: ReadonlyMap<string, string>;
}

export type ValidationOutcome =
  | { readonly ok: false; readonly rejection: ResponseRejection }
  | {
      readonly ok: true;
      readonly response: AdvisorResponse;
      readonly accepted: readonly ValidatedInsight[];
      readonly rejected: readonly InsightRejection[];
    };

export interface ValidationInput {
  /** The request we sent. Its `snapshot` is what every ref resolves against. */
  readonly request: AdvisorRequest;
  readonly manifest: AdvisorManifest;
  readonly limits: ResolvedLimits;
  /**
   * The raw body, as text or as an already-parsed value.
   *
   * A `string` goes through step 1's byte check and `JSON.parse`; anything else
   * is taken as already-parsed and step 1 checks only its serialised size. A
   * `builtin` advisor returns an object and never a string, and making that the
   * same code path as a sidecar's HTTP body is what keeps the built-ins honest
   * about the contract they will be judged by in Phase 5.
   */
  readonly body: string | unknown;
  /**
   * Insight `type`s already proposed for this period, by any advisor.
   *
   * Only `narrates_only` advisors read it: a narrator that emits a `type`
   * nobody else found is introducing a finding. `service.ts` supplies it for a
   * narrator run — the types of the findings in the request's envelope (WP 5.3;
   * it never did before, so the narration path had never run once). It is the
   * coarse half of the check; the 1:1 key/type/period match against the
   * envelope (`narratedFindingFor`) is the fine half, and both must pass.
   */
  readonly knownFindingTypes?: ReadonlySet<string>;
}

function reject(step: ValidationStep, reason: string, detail: string): ValidationOutcome {
  return { ok: false, rejection: { step, reason, detail } };
}

/**
 * UTF-8 byte length without materialising a second copy of the body.
 *
 * `TextEncoder().encode(x).length` allocates the whole array to read one
 * number; for a limit check on a payload we have not decided to trust, the
 * allocation *is* the thing the limit exists to bound.
 */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Steps 1–3: the response
// ---------------------------------------------------------------------------

function parseBody(input: ValidationInput): { ok: true; value: unknown } | ValidationOutcome {
  if (typeof input.body === 'string') {
    if (utf8Length(input.body) > input.limits.maxResponseBytes) {
      return reject(
        'transport',
        'response_too_large',
        `limit ${String(input.limits.maxResponseBytes)}`,
      );
    }
    try {
      return { ok: true, value: JSON.parse(input.body) };
    } catch {
      return reject('transport', 'body_not_json', 'JSON.parse failed');
    }
  }
  let serialised: string;
  try {
    serialised = JSON.stringify(input.body) ?? '';
  } catch {
    // A cyclic object, or a `bigint`. Both are programming errors in a built-in
    // and are refused rather than thrown, because this function is on the
    // totality property's path like every other one.
    return reject('transport', 'body_not_serialisable', 'JSON.stringify failed');
  }
  if (utf8Length(serialised) > input.limits.maxResponseBytes) {
    return reject(
      'transport',
      'response_too_large',
      `limit ${String(input.limits.maxResponseBytes)}`,
    );
  }
  return { ok: true, value: input.body };
}

function checkEnvelope(
  response: AdvisorResponse,
  input: ValidationInput,
): ValidationOutcome | null {
  if (!SUPPORTED_CONTRACT_MAJORS.includes(response.contract_version)) {
    return reject('envelope', 'unsupported_contract_version', String(response.contract_version));
  }
  // 08 §4.4 step 4. Without this, a response from the *previous* nightly run,
  // arriving late, lands in this run's review queue against this run's digest —
  // an insight attributed to a snapshot it never saw.
  if (response.request_id !== input.request.request_id) {
    return reject('envelope', 'request_id_mismatch', response.request_id);
  }
  if (response.advisor_id !== input.request.advisor_id) {
    return reject('envelope', 'advisor_id_mismatch', response.advisor_id);
  }
  if (response.advisor_id !== input.manifest.advisor_id) {
    return reject('envelope', 'advisor_id_not_registered', response.advisor_id);
  }
  if (response.insights.length > input.limits.maxInsights) {
    return reject(
      'envelope',
      'too_many_insights',
      `${String(response.insights.length)} > ${String(input.limits.maxInsights)}`,
    );
  }
  const keys = new Set<string>();
  for (const insight of response.insights) {
    const identity = `${insight.key} ${insight.period}`;
    if (keys.has(identity)) {
      // The upsert key is `(advisor_id, key, period)`. Two insights sharing it
      // in one response is not a duplicate row, it is a *lost* row — the second
      // silently overwrites the first — so it is refused where it is visible.
      return reject('envelope', 'duplicate_insight_key', identity.replace(' ', '@'));
    }
    keys.add(identity);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 4: capability
// ---------------------------------------------------------------------------

interface CapabilityVerdict {
  readonly severity: Severity;
  readonly clamped: boolean;
  /** For a `narrates_only` advisor, the one finding this narration narrates. */
  readonly finding: NarratedFinding | null;
}

function checkCapability(
  insight: Insight,
  input: ValidationInput,
): CapabilityVerdict | { readonly reason: string; readonly detail: string } {
  const { manifest } = input;
  // 08 §4.3 reserves `deterministic`, and reserves it twice: a manifest must
  // claim it *and* the advisor must be a builtin. A registration row edited to
  // `deterministic: true` on an external sidecar buys nothing.
  if (insight.confidence_basis === 'deterministic') {
    if (!manifest.capabilities.deterministic) {
      return { reason: 'deterministic_not_claimed', detail: manifest.advisor_id };
    }
    if (manifest.kind !== 'builtin') {
      return { reason: 'deterministic_reserved_for_builtin', detail: manifest.kind };
    }
  }
  if (
    !manifest.capabilities.produces_impact &&
    (insight.impact.annualized !== null || insight.impact.one_time !== null)
  ) {
    return { reason: 'impact_not_claimed', detail: manifest.advisor_id };
  }
  let finding: NarratedFinding | null = null;
  if (manifest.capabilities.narrates_only) {
    const known = input.knownFindingTypes ?? new Set<string>();
    if (!known.has(insight.type)) {
      return { reason: 'narrator_introduced_finding', detail: insight.type };
    }
    // 1:1 — the same key, type and period as one finding we sent, or nothing.
    finding = narratedFindingFor(insight, input.request.findings);
    if (finding === null) {
      return { reason: 'narration_finding_mismatch', detail: `${insight.key}@${insight.period}` };
    }
    if (insight.confidence_basis !== 'model') {
      return { reason: 'narration_basis_not_model', detail: insight.confidence_basis };
    }
    if (insight.proposed_actions.length > 0) {
      return { reason: 'narrator_proposed_action', detail: manifest.advisor_id };
    }
    if (insight.derivations.length > 0) {
      // A narrator computes nothing: every figure it may write is one its
      // finding already rendered. A derivation of its own would be a new
      // candidate for step 7 — exactly the door the narrow trace closes.
      return { reason: 'narrator_declared_derivation', detail: manifest.advisor_id };
    }
    if (severityRank(insight.severity) > severityRank(finding.severity)) {
      return {
        reason: 'narration_above_finding_severity',
        detail: `${insight.severity} > ${finding.severity}`,
      };
    }
  }

  const ceiling = manifest.capabilities.max_severity;
  const clamped = severityRank(insight.severity) > severityRank(ceiling);
  // Clamped rather than refused, deliberately: 08 §4.4 makes graceful
  // degradation a requirement, and dropping a real finding because it shouted
  // is worse than showing it quietly. The clamp is recorded on the row, so
  // "this advisor keeps trying to shout" stays answerable.
  return { severity: clamped ? ceiling : insight.severity, clamped, finding };
}

// ---------------------------------------------------------------------------
// Step 5: evidence
// ---------------------------------------------------------------------------

function resolveEvidence(
  insight: Insight,
  snapshot: AdvisorSnapshot,
  manifest: AdvisorManifest,
):
  | { readonly ok: true; readonly rows: readonly ResolvedEvidenceRow[] }
  | { readonly ok: false; readonly reason: string; readonly detail: string } {
  const rows: ResolvedEvidenceRow[] = [];
  for (const [position, row] of insight.evidence.entries()) {
    const where = `evidence[${String(position)}]`;
    if (row.source_ref === null) {
      // A row with no ref is a row nothing can be clicked through to, which is
      // 04 §5.1's requirement inverted. The only shape that is allowed to have
      // no snapshot ref is an external link, and it must then have the link.
      if (row.kind !== 'external' || row.url === null) {
        return { ok: false, reason: 'evidence_without_ref', detail: where };
      }
    }

    let href: string | null = null;
    let resolvedDisplay: string | null = null;

    if (row.source_ref !== null && isSnapshotRef(row.source_ref)) {
      const resolution = resolveSourceRef(snapshot, row.source_ref);
      if (!resolution.ok) {
        return {
          ok: false,
          reason: 'source_ref_unresolvable',
          detail: `${where} ${row.source_ref}: ${resolution.reason}`,
        };
      }
      if (!evidenceValueAgrees(row.value, resolution.value)) {
        return {
          ok: false,
          reason: 'evidence_value_disagrees',
          detail: `${where} claimed ${row.value ?? 'null'}`,
        };
      }
      resolvedDisplay = displayValue(resolution.value);
    } else if (row.source_ref !== null) {
      const external = externalUrlOf(row.source_ref);
      if (external === null) {
        return { ok: false, reason: 'source_ref_malformed', detail: `${where} ${row.source_ref}` };
      }
      const verdict = checkLink(external, manifest.egress_allowlist);
      if (!verdict.ok) {
        return { ok: false, reason: `link_${verdict.reason}`, detail: `${where} ${external}` };
      }
      href = verdict.href;
    }

    if (row.url !== null) {
      const verdict = checkLink(row.url, manifest.egress_allowlist);
      if (!verdict.ok) {
        return { ok: false, reason: `link_${verdict.reason}`, detail: `${where} ${row.url}` };
      }
      href = verdict.href;
    }

    rows.push({
      kind: row.kind,
      label: row.label,
      value: row.value,
      sourceRef: row.source_ref,
      href,
      resolvedDisplay,
    });
  }

  for (const [position, action] of insight.proposed_actions.entries()) {
    if (action.url === null) continue;
    const verdict = checkLink(action.url, manifest.egress_allowlist);
    if (!verdict.ok) {
      return {
        ok: false,
        reason: `link_${verdict.reason}`,
        detail: `proposed_actions[${String(position)}] ${action.url}`,
      };
    }
  }

  return { ok: true, rows };
}

/**
 * Step 5 for a narrator: every citation through its finding (`finding:<key>`),
 * never through a snapshot. A subset of the finding's own refs, each value
 * equal to what the finding said, no URL (a narrator has no egress and its
 * wording links to nothing).
 */
function resolveNarratedEvidence(
  insight: Insight,
  finding: NarratedFinding,
):
  | { readonly ok: true; readonly rows: readonly ResolvedEvidenceRow[] }
  | { readonly ok: false; readonly reason: string; readonly detail: string } {
  const rows: ResolvedEvidenceRow[] = [];
  for (const [position, row] of insight.evidence.entries()) {
    const where = `evidence[${String(position)}]`;
    if (row.source_ref === null) {
      return { ok: false, reason: 'evidence_without_ref', detail: where };
    }
    if (row.url !== null) {
      return { ok: false, reason: 'narration_carries_url', detail: where };
    }
    const resolution = resolveNarratedRef(finding, row.source_ref);
    if (!resolution.ok) {
      return {
        ok: false,
        reason: 'narration_ref_not_in_finding',
        detail: `${where} ${row.source_ref}`,
      };
    }
    if (!narratedValueAgrees(row.value, resolution.value)) {
      return {
        ok: false,
        reason: 'narration_value_disagrees',
        detail: `${where} claimed ${row.value ?? 'null'}`,
      };
    }
    rows.push({
      kind: row.kind,
      label: row.label,
      value: row.value,
      sourceRef: row.source_ref,
      href: null,
      resolvedDisplay: resolution.value,
    });
  }
  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// Step 6: derivations
// ---------------------------------------------------------------------------

function checkDerivations(
  insight: Insight,
  snapshot: AdvisorSnapshot,
):
  | { readonly ok: true; readonly derived: Map<string, decimal.Decimal> }
  | { readonly ok: false; readonly reason: string; readonly detail: string } {
  const derived = new Map<string, decimal.Decimal>();
  for (const derivation of insight.derivations) {
    if (derived.has(derivation.id)) {
      return { ok: false, reason: 'duplicate_derivation_id', detail: derivation.id };
    }
    const outcome = evaluateDerivation(snapshot, derivation);
    if (!outcome.ok) {
      return {
        ok: false,
        reason: `derivation_${outcome.reason}`,
        detail: `${derivation.id}: ${outcome.detail}`,
      };
    }
    derived.set(derivation.id, outcome.value);
  }
  const id = insight.impact.derivation_id;
  if (id !== null && !derived.has(id)) {
    // An impact that names a derivation it did not declare is a headline figure
    // with nothing behind it. The numeral check below would catch the number
    // itself; this catches the *claim of provenance*, which is what the UI
    // renders in "how was this computed?".
    return { ok: false, reason: 'impact_derivation_missing', detail: id };
  }
  return { ok: true, derived };
}

// ---------------------------------------------------------------------------
// Step 7: numerals and markdown
// ---------------------------------------------------------------------------

function checkNumerals(
  insight: Insight,
  snapshot: AdvisorSnapshot,
  derived: ReadonlyMap<string, decimal.Decimal>,
  finding: NarratedFinding | null,
): { readonly reason: string; readonly detail: string } | null {
  const fields = {
    title: insight.title,
    summaryMd: insight.summary_md,
    impactBasis: insight.impact.basis,
    evidenceLabels: insight.evidence.map((row) => row.label),
    evidenceValues: insight.evidence.flatMap((row) => (row.value === null ? [] : [row.value])),
    actionLabels: insight.proposed_actions.map((action) => action.label),
    actionRationales: insight.proposed_actions.map((action) => action.rationale_md),
    caveats: [...insight.caveats],
  };

  for (const violation of markdownViolations(insight.summary_md)) {
    return { reason: `markdown_${violation}`, detail: 'summary_md' };
  }
  for (const [position, action] of insight.proposed_actions.entries()) {
    for (const violation of markdownViolations(action.rationale_md)) {
      return { reason: `markdown_${violation}`, detail: `proposed_actions[${String(position)}]` };
    }
  }

  // The impact money is a figure the UI shows on its own, outside any prose, so
  // it is traced explicitly rather than by happening to appear in `basis`.
  const impactStrings = [insight.impact.annualized, insight.impact.one_time].flatMap((money) =>
    money === null ? [] : [money.minor],
  );

  if (finding !== null) {
    // The narrow trace. A narrator's candidates are its finding's rendered
    // figures, verbatim — never the snapshot, whatever the request carried.
    const narrow = findingTraceContext(finding);
    for (const text of [...renderableStrings(fields), ...impactStrings]) {
      const first = untraceableInFinding(text, narrow)[0];
      if (first !== undefined) {
        return { reason: 'numeral_not_in_finding', detail: `${first.raw} in ${text.slice(0, 80)}` };
      }
    }
    return null;
  }

  const context = traceContext({ snapshot, derived: [...derived.values()] });
  for (const text of [...renderableStrings(fields), ...impactStrings]) {
    const untraceable = untraceableNumerals(text, context);
    const first = untraceable[0];
    if (first !== undefined) {
      return {
        reason: 'numeral_not_in_snapshot',
        detail: `${first.raw} in ${text.slice(0, 80)}`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export function validateResponse(input: ValidationInput): ValidationOutcome {
  // Step 1 — transport.
  const parsed = parseBody(input);
  if (!('value' in parsed)) return parsed;

  // Step 2 — schema. `safeParse`, never `parse`: a throw here would make the
  // worker's failure mode depend on what an advisor sent, which is the opposite
  // of what a validator is for.
  const schema = AdvisorResponseSchema.safeParse(parsed.value);
  if (!schema.success) {
    const issue = schema.error.issues[0];
    return reject(
      'schema',
      'schema_violation',
      issue === undefined ? 'invalid' : `${issue.path.join('.')}: ${issue.message}`,
    );
  }
  const response = schema.data;

  // Step 3 — envelope.
  const envelope = checkEnvelope(response, input);
  if (envelope !== null) return envelope;

  const snapshot = input.request.snapshot;
  const accepted: ValidatedInsight[] = [];
  const rejected: InsightRejection[] = [];

  for (const [index, insight] of response.insights.entries()) {
    // Step 4 — capability.
    const capability = checkCapability(insight, input);
    if (!('severity' in capability)) {
      rejected.push({ step: 'capability', index, key: insight.key, ...capability });
      continue;
    }

    // Step 5 — evidence. A narrator's citations resolve through its finding.
    const evidence =
      capability.finding === null
        ? resolveEvidence(insight, snapshot, input.manifest)
        : resolveNarratedEvidence(insight, capability.finding);
    if (!evidence.ok) {
      rejected.push({
        step: 'evidence',
        index,
        key: insight.key,
        reason: evidence.reason,
        detail: evidence.detail,
      });
      continue;
    }

    // Step 6 — derivations.
    const derivations = checkDerivations(insight, snapshot);
    if (!derivations.ok) {
      rejected.push({
        step: 'derivations',
        index,
        key: insight.key,
        reason: derivations.reason,
        detail: derivations.detail,
      });
      continue;
    }

    // Step 7 — numerals.
    const numerals = checkNumerals(insight, snapshot, derivations.derived, capability.finding);
    if (numerals !== null) {
      rejected.push({ step: 'numerals', index, key: insight.key, ...numerals });
      continue;
    }

    const rendered = new Map<string, string>();
    for (const [id, value] of derivations.derived) {
      rendered.set(id, decimal.render(value, decimal.DECIMAL_SCALE) ?? '0');
    }

    accepted.push({
      status: 'pending_review',
      insight,
      severity: capability.severity,
      severityClamped: capability.clamped,
      evidence: evidence.rows,
      derived: rendered,
    });
  }

  return { ok: true, response, accepted, rejected };
}
