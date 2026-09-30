// SPDX-License-Identifier: MIT
/**
 * The narrator evaluation harness — the instrument behind 05 §1's third exit
 * criterion: *"≥95% of generated insights pass evidence-ref validation on
 * first attempt"*.
 *
 * `scripts/advisor-eval.ts` is the CLI; this is the part that counts, kept
 * pure and in the package so `test/eval-harness.test.ts` can prove the
 * counting against a scripted model whose rate is known in advance.
 *
 * ## What it measures, and what it refuses to measure
 *
 *   * **First attempt only.** One request, one model call, one verdict per
 *     narration. There is no retry here and there must never be one: a harness
 *     that re-asked until the validator agreed would report the rate of the
 *     *loop*, and the criterion is about the model. The harness's own control
 *     (a one-in-ten fabricator must read exactly 90%) is what goes red if a
 *     retry is added (the evidence file's sabotage log).
 *   * **Per step, cumulatively.** For each narration, how far through the seven
 *     steps it got. The criterion's "evidence-ref validation" is steps 1–5, and
 *     it is reported **beside** steps 1–7, because a narrator that cites
 *     correctly and invents numbers 40% of the time passes the letter of the
 *     criterion and is useless (05 §3 WP 5.3).
 *   * **Per finding, not per reply.** A request carries one to five findings
 *     (the production shape: the Brief narrates at most five). Each finding is
 *     one narration to judge. A reply that skips a finding scores that finding
 *     as `no_narration` — it passed the response-level steps 1–3 and produced
 *     nothing for step 4 to accept. A reply that fails steps 1–3 fails every
 *     finding it carried, at that step. A narration under a key nobody asked
 *     for is counted as an `extra` and cannot stand in for a missing one.
 */
import { BUILTIN_CATALOGUE } from '../catalogue.ts';
import { resolveLimits } from '../../contract/manifest.ts';
import type { AdvisorRequest, NarratedFinding } from '../../contract/request.ts';
import { scopeDefinition, type AdvisorScope } from '../../contract/scopes.ts';
import type { AdvisorSnapshot } from '../../contract/snapshot.ts';
import { ADVISOR_CONTRACT_MAJOR } from '../../contract/version.ts';
import { inputDigest } from '../../snapshot/tokens.ts';
import {
  VALIDATION_STEPS,
  validateResponse,
  type ValidationStep,
} from '../../validate/pipeline.ts';
import {
  findingSourceOf,
  launderFindings,
  narratedFindingOf,
  redactFreeText,
  type LaunderingCandidate,
} from './findings.ts';
import { NARRATOR_MANIFEST, NARRATOR_SCOPES } from './manifest.ts';
import type { NarratorModelPort } from './narrator.ts';

export interface EvalCase {
  /** Stable: `<seed>:<finding key>`. */
  readonly id: string;
  /** Which dataset the finding came from — `drift`, `tight`, `scale`. */
  readonly seed: string;
  readonly finding: NarratedFinding;
}

export interface EvalRequestSpec {
  /** `sha256:` over the findings it carries — stable while the seeds and rules are. */
  readonly id: string;
  readonly caseIds: readonly string[];
  readonly findings: readonly NarratedFinding[];
}

/**
 * Every finding the built-in catalogue makes over `snapshot`, as the narrator
 * would be shown it: each built-in run through the real `validateResponse`,
 * its source scopes the blocks it asked for that the snapshot actually carries
 * (what `advisor_runs.emitted_scopes` records in production), laundered
 * against the narrator's full bound, `redactDigits` applied for the
 * `local_model` reader. Findings built from `transactions.raw` therefore never
 * appear — the narrator does not ask for it.
 */
export async function findingsFromSnapshot(
  seed: string,
  snapshot: AdvisorSnapshot,
  today: string,
): Promise<readonly EvalCase[]> {
  const candidates: LaunderingCandidate[] = [];
  for (const entry of BUILTIN_CATALOGUE) {
    const { manifest } = entry.advisor;
    // A built-in's request: the same fixed envelope, its own identity and
    // grant, the whole snapshot, and no findings envelope (it narrates nothing).
    const { findings: _none, ...envelope } = evalRequest(
      { id: inputDigest({ advisor: manifest.advisor_id }), caseIds: [], findings: [] },
      today,
    );
    const request: AdvisorRequest = {
      ...envelope,
      advisor_id: manifest.advisor_id,
      advisor_version: manifest.version,
      kind: manifest.kind,
      granted_scopes: [...manifest.requires_scopes],
      limits: {
        max_insights: manifest.limits.max_insights,
        max_response_bytes: manifest.limits.max_response_bytes,
        deadline: '2099-01-01T00:00:00.000Z',
      },
      snapshot,
    };
    const body = await entry.advisor.run(request, new AbortController().signal);
    const outcome = validateResponse({ request, manifest, limits: resolveLimits(manifest), body });
    if (!outcome.ok) continue;
    const emitted = manifest.requires_scopes.filter(
      (scope: AdvisorScope) => scopeDefinition(scope).key in snapshot,
    );
    for (const validated of outcome.accepted) {
      candidates.push({ source: findingSourceOf(validated), sourceScopes: emitted });
    }
  }
  const seen = new Set<string>();
  const cases: EvalCase[] = [];
  for (const candidate of launderFindings(candidates, NARRATOR_SCOPES).admitted) {
    if (seen.has(candidate.source.key)) continue;
    seen.add(candidate.source.key);
    cases.push({
      id: `${seed}:${candidate.source.key}`,
      seed,
      finding: narratedFindingOf(redactFreeText(candidate.source, 'local_model')),
    });
  }
  return cases;
}

/**
 * Deterministic request plan: the cases, in order, chunked into groups of each
 * size in `groupSizes`. `[1, 3]` narrates every finding twice — once alone and
 * once beside two others — which is two different prompts per finding, so a
 * temperature-0 model is not asked the same question twice.
 */
export function planRequests(
  cases: readonly EvalCase[],
  groupSizes: readonly number[] = [1, 3],
): readonly EvalRequestSpec[] {
  const specs: EvalRequestSpec[] = [];
  for (const size of groupSizes) {
    const width = Math.max(1, Math.min(5, Math.trunc(size)));
    for (let start = 0; start < cases.length; start += width) {
      const group = cases.slice(start, start + width);
      const findings = group.map((entry) => entry.finding);
      specs.push({
        id: inputDigest({ findings }),
        caseIds: group.map((entry) => entry.id),
        findings,
      });
    }
  }
  return specs;
}

/** A v4-shaped UUID from a digest, so a replayed request is byte-identical to the recorded one. */
function uuidFrom(digest: string): string {
  const hex = digest.replace(/^sha256:/, '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The request production would send for these findings: the narrator's
 * manifest, the laundering bound as `granted_scopes`, an empty snapshot and
 * the envelope. Fixed clock values, so the rendered prompt — and therefore a
 * recorded reply — is reproducible.
 */
export function evalRequest(spec: EvalRequestSpec, today: string): AdvisorRequest {
  return {
    contract_version: ADVISOR_CONTRACT_MAJOR,
    request_id: uuidFrom(spec.id),
    advisor_id: NARRATOR_MANIFEST.advisor_id,
    advisor_version: NARRATOR_MANIFEST.version,
    kind: 'local_model',
    generated_at: `${today}T10:00:00.000Z`,
    base_currency: 'USD',
    time_zone: 'America/New_York',
    today,
    granted_scopes: [...NARRATOR_SCOPES],
    input_digest: inputDigest({}),
    limits: {
      max_insights: NARRATOR_MANIFEST.limits.max_insights,
      max_response_bytes: NARRATOR_MANIFEST.limits.max_response_bytes,
      // Far enough that the adapter's own timeout, not this, bounds a call.
      deadline: '2099-01-01T00:00:00.000Z',
    },
    snapshot: {},
    findings: [...spec.findings],
  };
}

export type EvalFailure = ValidationStep | 'no_narration' | 'model_error';

export interface NarrationVerdict {
  readonly caseId: string;
  readonly specId: string;
  /** How many of the seven steps this narration passed, in order: 0–7. 7 is accepted. */
  readonly passedThrough: number;
  readonly failure: EvalFailure | null;
  readonly reason: string | null;
}

export interface EvalRate {
  readonly accepted: number;
  readonly total: number;
  /** `accepted / total`, or `null` for an empty run. */
  readonly rate: number | null;
}

export interface EvalReport {
  readonly cases: number;
  readonly requests: number;
  readonly narrations: number;
  /** `[k]` = narrations that passed steps 1..k, for k = 1..7 (index 0 unused, always `narrations`). */
  readonly passedThrough: readonly number[];
  /** The criterion's number — steps 1–5 — and the one beside it that matters. */
  readonly firstAttempt: { readonly steps1to5: EvalRate; readonly steps1to7: EvalRate };
  /** `<step>:<reason>` → count, for every narration that did not pass all seven. */
  readonly failures: Readonly<Record<string, number>>;
  /** Narrations under keys nobody asked for. Never counted as accepted. */
  readonly extras: number;
}

function rateOf(accepted: number, total: number): EvalRate {
  return { accepted, total, rate: total === 0 ? null : accepted / total };
}

/** Aggregate verdicts. Pure; the script re-runs it over recorded verdicts. */
export function summarise(
  cases: number,
  requests: number,
  verdicts: readonly NarrationVerdict[],
  extras = 0,
): EvalReport {
  const passedThrough = Array.from({ length: VALIDATION_STEPS.length + 1 }, (_value, step) =>
    step === 0
      ? verdicts.length
      : verdicts.filter((verdict) => verdict.passedThrough >= step).length,
  );
  const failures: Record<string, number> = {};
  for (const verdict of verdicts) {
    if (verdict.failure === null) continue;
    const label = `${verdict.failure}:${verdict.reason ?? ''}`;
    failures[label] = (failures[label] ?? 0) + 1;
  }
  return {
    cases,
    requests,
    narrations: verdicts.length,
    passedThrough,
    firstAttempt: {
      steps1to5: rateOf(passedThrough[5] ?? 0, verdicts.length),
      steps1to7: rateOf(passedThrough[7] ?? 0, verdicts.length),
    },
    failures,
    extras,
  };
}

/** Judge one reply to one request: a verdict per finding it carried. */
export function judgeReply(
  spec: EvalRequestSpec,
  request: AdvisorRequest,
  body: unknown,
): { readonly verdicts: readonly NarrationVerdict[]; readonly extras: number } {
  const outcome = validateResponse({
    request,
    manifest: NARRATOR_MANIFEST,
    limits: resolveLimits(NARRATOR_MANIFEST),
    body,
    knownFindingTypes: new Set(spec.findings.map((finding) => finding.type)),
  });
  if (!outcome.ok) {
    const at = VALIDATION_STEPS.indexOf(outcome.rejection.step);
    return {
      verdicts: spec.caseIds.map((caseId) => ({
        caseId,
        specId: spec.id,
        passedThrough: at,
        failure: outcome.rejection.step,
        reason: outcome.rejection.reason,
      })),
      extras: 0,
    };
  }
  const asked = new Set(spec.findings.map((finding) => finding.key));
  const acceptedKeys = new Set(outcome.accepted.map((entry) => entry.insight.key));
  const verdicts = spec.findings.map((finding, position): NarrationVerdict => {
    const caseId = spec.caseIds[position] ?? finding.key;
    if (acceptedKeys.has(finding.key)) {
      return { caseId, specId: spec.id, passedThrough: 7, failure: null, reason: null };
    }
    const rejected = outcome.rejected.find((entry) => entry.key === finding.key);
    if (rejected !== undefined) {
      return {
        caseId,
        specId: spec.id,
        passedThrough: VALIDATION_STEPS.indexOf(rejected.step),
        failure: rejected.step,
        reason: rejected.reason,
      };
    }
    // Steps 1–3 passed for the reply as a whole; nothing reached step 4.
    return {
      caseId,
      specId: spec.id,
      passedThrough: 3,
      failure: 'no_narration',
      reason: 'the reply carried no narration under this finding key',
    };
  });
  const extras =
    outcome.accepted.filter((entry) => !asked.has(entry.insight.key)).length +
    outcome.rejected.filter((entry) => entry.key === null || !asked.has(entry.key)).length;
  return { verdicts, extras };
}

export interface EvalRunInput {
  readonly specs: readonly EvalRequestSpec[];
  readonly cases: number;
  readonly model: NarratorModelPort;
  readonly today: string;
  readonly signal?: AbortSignal;
  /** Called once per request, after its one call: for recording replies and progress. */
  readonly onReply?: (entry: {
    readonly spec: EvalRequestSpec;
    readonly request: AdvisorRequest;
    readonly body: unknown;
    readonly error: string | null;
    readonly verdicts: readonly NarrationVerdict[];
    readonly extras: number;
  }) => void | Promise<void>;
}

/** One call per request, one verdict per finding. First attempt, and nothing else. */
export async function runNarratorEval(input: EvalRunInput): Promise<{
  readonly report: EvalReport;
  readonly verdicts: readonly NarrationVerdict[];
}> {
  const signal = input.signal ?? new AbortController().signal;
  const all: NarrationVerdict[] = [];
  let extras = 0;
  for (const spec of input.specs) {
    const request = evalRequest(spec, input.today);
    let body: unknown = null;
    let error: string | null = null;
    try {
      body = await input.model.run(request, signal);
    } catch (caught) {
      error = caught instanceof Error ? (caught.name === 'Error' ? 'error' : caught.name) : 'error';
      const code = (caught as { code?: unknown } | null)?.code;
      if (typeof code === 'string') error = code;
    }
    const judged =
      error === null
        ? judgeReply(spec, request, body)
        : {
            verdicts: spec.caseIds.map((caseId) => ({
              caseId,
              specId: spec.id,
              passedThrough: 0,
              failure: 'model_error' as const,
              reason: error,
            })),
            extras: 0,
          };
    all.push(...judged.verdicts);
    extras += judged.extras;
    await input.onReply?.({
      spec,
      request,
      body,
      error,
      verdicts: judged.verdicts,
      extras: judged.extras,
    });
  }
  return { report: summarise(input.cases, input.specs.length, all, extras), verdicts: all };
}
