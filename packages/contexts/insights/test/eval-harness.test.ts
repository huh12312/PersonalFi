// SPDX-License-Identifier: MIT
/**
 * The evaluation harness's own control (WP 5.3).
 *
 * `scripts/advisor-eval.ts` reports the third exit criterion's number, and a
 * number is only as good as the instrument that counted it. So the instrument
 * is run here against a scripted model whose answer is known before it runs:
 * a narrator that quotes its finding faithfully nine times in ten and invents a
 * figure the tenth. The harness must read **exactly 90%** on steps 1–7 and
 * **100%** on steps 1–5 (a fabricated figure is a step-7 refusal; its citations
 * are fine) — and it must read that on the first attempt, because a harness
 * that re-asked a refused narration would read higher than the model deserves
 * (the retry sabotage in the evidence file's log is this test going red).
 *
 * The findings are real: the built-in catalogue over the `drift` seed's real
 * snapshot, validated, laundered against the narrator's bound and redacted for
 * a `local_model` reader (`findingsFromSnapshot`) — the same path the script
 * takes.
 *
 * The second case replays the **recorded live replies** — what the pinned
 * model actually said on this host, `scripts/advisor-eval.recorded.json` —
 * through today's validator, and asserts the per-step counts recorded with
 * them still come out. That is CI's recorded-reply fake: the live number is
 * reproducible without a model, and a validator change that moves it fails
 * here rather than silently changing what the evidence claims.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findingsFromSnapshot,
  judgeReply,
  evalRequest,
  planRequests,
  runNarratorEval,
  summarise,
  type EvalReport,
  type EvalRequestSpec,
  type NarrationVerdict,
} from '../src/advisors/local/eval.ts';
import { createNarratorAdvisor, type NarratorModelPort } from '../src/advisors/local/narrator.ts';
import type { AdvisorRequest, NarratedFinding } from '../src/contract/request.ts';
import { TODAY, seedSnapshot } from './advisors/seed.ts';

const RECORDED = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'advisor-eval.recorded.json',
);

/**
 * A narration of `finding` in the B shape (contract 1.6.0): it places the
 * finding's first citable figure by its slot — or writes `figure` as a digit
 * instead — and names its finding by number. No key and no evidence: the
 * narrator writes the identity and the citations, as it does in production.
 */
function narration(finding: NarratedFinding, number: number, figure: string | null) {
  const slotted = finding.evidence.find((row) => row.slot !== undefined && row.source_ref !== null);
  const placed = slotted?.slot === undefined ? null : `{{${slotted.slot}}}`;
  const quoted = figure ?? placed;
  return {
    finding: number,
    severity: finding.severity,
    title: 'In plain words',
    summary_md:
      quoted === null ? 'This finding stands as written.' : `The figure here is ${quoted}.`,
    confidence: 0.7,
    confidence_basis: 'model',
    horizon: 'this_period',
    requires_review: true,
    impact: { annualized: null, one_time: null, basis: '', derivation_id: null },
    derivations: [],
    proposed_actions: [],
    caveats: [],
    expires_at: null,
  };
}

/** A scripted model's reply envelope around `insights`. */
function replyTo(request: AdvisorRequest, insights: unknown[]) {
  return {
    contract_version: 1,
    request_id: request.request_id,
    advisor_id: request.advisor_id,
    advisor_version: request.advisor_version,
    produced_at: request.generated_at,
    diagnostics: { runtime_ms: 0, model: 'scripted', warnings: [] },
    insights,
  };
}

/**
 * Faithful nine times in ten, by narration count; the tenth writes `$9,999.99`
 * where its slot belongs. Wrapped by the real narrator, as the script wraps
 * the adapter (`createNarratorAdvisor`).
 */
function oneInTenFabricator(): NarratorModelPort & { readonly calls: () => number } {
  let narrated = 0;
  let calls = 0;
  const model: NarratorModelPort = {
    run(request: AdvisorRequest) {
      calls += 1;
      const insights = (request.findings ?? []).map((finding, index) => {
        narrated += 1;
        return narration(finding, index + 1, narrated % 10 === 0 ? '$9,999.99' : null);
      });
      return Promise.resolve(replyTo(request, insights));
    },
  };
  const narrator = createNarratorAdvisor({ model });
  return { calls: () => calls, run: (request, signal) => narrator.run(request, signal) };
}

describe('the narrator evaluation harness', () => {
  it('the harness counts first-attempt acceptance per step, and a scripted one-in-ten fabricator reads 90%', async () => {
    const cases = (await findingsFromSnapshot('drift', await seedSnapshot('drift'), TODAY)).slice(
      0,
      20,
    );
    expect(cases).toHaveLength(20);
    // Every finding alone, then in threes: 20 + 7 requests, 40 narrations.
    const specs = planRequests(cases, [1, 3]);
    expect(specs).toHaveLength(27);

    const model = oneInTenFabricator();
    const { report } = await runNarratorEval({
      specs,
      cases: cases.length,
      model,
      today: TODAY,
    });

    // One call per request — first attempt, nothing re-asked.
    expect(model.calls()).toBe(27);
    expect(report.narrations).toBe(40);
    expect(report.requests).toBe(27);
    // Every narration clears steps 1–6; the four fabrications stop at 7 —
    // a digit where a slot belongs is a figure the app did not place.
    expect(report.passedThrough).toEqual([40, 40, 40, 40, 40, 40, 40, 36]);
    expect(report.firstAttempt.steps1to5).toEqual({ accepted: 40, total: 40, rate: 1 });
    expect(report.firstAttempt.steps1to7).toEqual({ accepted: 36, total: 40, rate: 0.9 });
    expect(report.failures).toEqual({ 'numerals:numeral_not_placed': 4 });
    expect(report.extras).toBe(0);
  });

  it('a reply that skips a finding, breaks the envelope or throws is counted, never dropped', async () => {
    const cases = (await findingsFromSnapshot('drift', await seedSnapshot('drift'), TODAY)).slice(
      0,
      3,
    );
    const [spec] = planRequests(cases, [3]) as [EvalRequestSpec];
    const request = evalRequest(spec, TODAY);
    const reply = (insights: unknown[]) => replyTo(request, insights);
    const findings = spec.findings;
    // Two of three narrated; the third skipped: 2 accepted, 1 `no_narration` at 3.
    // Through the real narrator, which writes identity and citations.
    const narrator = createNarratorAdvisor({
      model: {
        run: () => Promise.resolve(reply([0, 1].map((n) => narration(findings[n]!, n + 1, null)))),
      },
    });
    const skipped = judgeReply(
      spec,
      request,
      await narrator.run(request, new AbortController().signal),
    );
    expect(skipped.verdicts.map((verdict) => verdict.passedThrough)).toEqual([7, 7, 3]);
    expect(skipped.verdicts[2]?.failure).toBe('no_narration');
    // A forged request_id: every finding fails at step 3.
    const forged = judgeReply(spec, request, {
      ...reply([]),
      request_id: '01930000-0000-7000-8000-00000000dead',
    });
    expect(
      forged.verdicts.map(
        (verdict) => `${String(verdict.passedThrough)}:${String(verdict.failure)}`,
      ),
    ).toEqual(['2:envelope', '2:envelope', '2:envelope']);
    // Not JSON at all: step 1.
    expect(judgeReply(spec, request, '{not json').verdicts[0]?.passedThrough).toBe(0);
    // A model that throws: every finding a model_error, 0 steps passed.
    const { report } = await runNarratorEval({
      specs: [spec],
      cases: 3,
      model: {
        run: () => Promise.reject(Object.assign(new Error('x'), { code: 'model_timeout' })),
      },
      today: TODAY,
    });
    expect(report.passedThrough[1]).toBe(0);
    expect(report.failures).toEqual({ 'model_error:model_timeout': 3 });
  });

  it.skipIf(!existsSync(RECORDED))(
    'the recorded live replies still produce the recorded per-step counts',
    () => {
      const recorded = JSON.parse(readFileSync(RECORDED, 'utf8')) as {
        readonly today: string;
        readonly cases: number;
        readonly summary: EvalReport;
        readonly requests: readonly {
          readonly spec: EvalRequestSpec;
          readonly error: string | null;
          readonly insights: unknown;
        }[];
      };
      const verdicts: NarrationVerdict[] = [];
      let extras = 0;
      for (const entry of recorded.requests) {
        const request = evalRequest(entry.spec, recorded.today);
        if (entry.error !== null) {
          verdicts.push(
            ...entry.spec.caseIds.map((caseId) => ({
              caseId,
              specId: entry.spec.id,
              passedThrough: 0,
              failure: 'model_error' as const,
              reason: entry.error,
            })),
          );
          continue;
        }
        // The adapter's wrap: the envelope from the request, `insights` from the model.
        const judged = judgeReply(entry.spec, request, {
          contract_version: request.contract_version,
          request_id: request.request_id,
          advisor_id: request.advisor_id,
          advisor_version: request.advisor_version,
          produced_at: request.generated_at,
          diagnostics: { runtime_ms: 0, model: null, warnings: [] },
          insights: entry.insights,
        });
        verdicts.push(...judged.verdicts);
        extras += judged.extras;
      }
      const replayed = summarise(recorded.cases, recorded.requests.length, verdicts, extras);
      expect(replayed).toEqual(recorded.summary);
      expect(replayed.narrations).toBeGreaterThanOrEqual(100);
    },
  );
});
