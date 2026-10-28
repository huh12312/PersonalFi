// SPDX-License-Identifier: MIT
/**
 * WP 10.16 — the GenAI controls self-test's catalogue, check by check, against
 * fakes: each check with a pass, a fail and a skipped path. The worker's
 * probes go through the narrator's own advisor and the real `validateResponse`
 * (the fakes stand in for the model, never for the validator, except where a
 * test says it simulates a broken one to reach a fail branch).
 */
import { systemClock } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_CHECK_IDS,
  CONTROL_CHECKS,
  CONTROL_PROBE_FINDING,
  CONTROL_PROBE_NUMBER,
  checkApprovalGate,
  checkBudgetWindow,
  checkCancelInFlight,
  checkConsentWithdrawal,
  checkEgressAllowlist,
  checkInspectorDigest,
  checkModelPin,
  checkModuleSwitch,
  checkNarrationBadge,
  checkNumeralsRefusal,
  checkSchemaRefusal,
  controlProbeRequest,
  overallOf,
  type AdvisorRequest,
  type ApprovalGatePort,
  type ConsentWithdrawalPort,
  type ControlCheckRow,
  type ControlProbeId,
  type ControlProbeModel,
  type InspectorPort,
  type ModuleSwitchPort,
  type NarrationBadgePort,
  type WorkerCheckContext,
  checkExplainGrounding,
  checkBriefNarrationGrounding,
  checkAskGrounding,
  ASK_PROBE_RESULTS,
  type AskProbeModel,
  BRIEF_NARRATE_PROBE_TARGET,
  type BriefNarrateProbeModel,
  checkSuggestEnumRefusal,
  SUGGEST_PROBE_TAXONOMY,
  type ExplainProbeModel,
  type SuggestProbeModel,
} from '../src/index.ts';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** One narration in the B reply grammar (what a model writes). */
function narration(summary: string): Record<string, unknown> {
  return {
    severity: 'info',
    title: 'A control check',
    summary_md: summary,
    confidence: 0.8,
    confidence_basis: 'model',
    horizon: 'next_quarter',
    requires_review: true,
    impact: { annualized: null, one_time: null, basis: '', derivation_id: null },
    derivations: [],
    proposed_actions: [],
    caveats: [],
    expires_at: null,
  };
}

/** What an adapter returns: the envelope from the request, `insights` from the model. */
function wrapped(request: AdvisorRequest, insights: unknown): unknown {
  return {
    contract_version: request.contract_version,
    request_id: request.request_id,
    advisor_id: request.advisor_id,
    advisor_version: request.advisor_version,
    produced_at: request.generated_at,
    diagnostics: { runtime_ms: 0, model: 'fake:model', warnings: [] },
    insights,
  };
}

interface FakeModelOptions {
  readonly provider?: ControlProbeModel['provider'];
  readonly replies?: Partial<Record<ControlProbeId, (request: AdvisorRequest) => unknown>>;
  /** The cancel probe: honour the signal (close the "socket") or not. */
  readonly honourAbort?: boolean;
  /** The cancel probe answers at once instead of waiting. */
  readonly answerAtOnce?: boolean;
  /** The adapter rejects on the abort but its counter never moves (no connection was closed). */
  readonly countAborts?: boolean;
  readonly fail?: ControlProbeId;
  readonly budget?: ControlProbeModel['budget'];
  readonly egress?: ControlProbeModel['egress'];
  readonly pin?: { readonly pinned: string; readonly served: string | null } | 'unreachable';
}

function fakeModel(options: FakeModelOptions = {}): ControlProbeModel & {
  readonly sent: ControlProbeId[];
} {
  let aborts = 0;
  const sent: ControlProbeId[] = [];
  const provider = options.provider ?? 'anthropic';
  const model: ControlProbeModel & { sent: ControlProbeId[] } = {
    provider,
    label: provider === 'ollama' ? 'qwen@sha256:abc' : `${provider}:claude-sonnet-5-5`,
    sent,
    probe: (id) => ({
      run: (request, signal) => {
        sent.push(id);
        if (options.fail === id) {
          return Promise.reject(Object.assign(new Error('x'), { code: 'model_unavailable' }));
        }
        if (id === 'cancel') {
          if (options.answerAtOnce === true) return Promise.resolve(wrapped(request, []));
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(wrapped(request, [])), 10_000);
            if (options.honourAbort !== false) {
              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                if (options.countAborts !== false) aborts += 1;
                reject(Object.assign(new Error('aborted'), { code: 'aborted' }));
              });
            }
          });
        }
        const reply = options.replies?.[id];
        return Promise.resolve(reply === undefined ? wrapped(request, []) : reply(request));
      },
    }),
    aborts: () => aborts,
    budget: options.budget ?? null,
    egress: options.egress ?? {
      kind: 'hosted',
      url: 'https://api.anthropic.com/v1/messages',
      classify: (url) =>
        new URL(url).host === 'api.anthropic.com'
          ? { allowed: true, code: null }
          : { allowed: false, code: 'host_not_allowed' },
    },
    ...(options.pin === undefined
      ? {}
      : {
          modelPin: () =>
            options.pin === 'unreachable'
              ? Promise.reject(Object.assign(new Error('x'), { code: 'model_unavailable' }))
              : Promise.resolve(options.pin as { pinned: string; served: string | null }),
        }),
  };
  return model;
}

function workerContext(
  model: ControlProbeModel | null,
  overrides: Partial<WorkerCheckContext> = {},
): WorkerCheckContext {
  return {
    model,
    unavailable: model === null ? 'The narrator is Off: there is no model to probe.' : null,
    request: controlProbeRequest(systemClock),
    clock: systemClock,
    probesSent: 0,
    budgetBefore: model?.budget?.remaining(systemClock.nowMs()) ?? null,
    timing: { pollMs: 50, cancelAfterMs: 20, limitMs: 500, probeTimeoutMs: 2_000 },
    ...overrides,
  };
}

function budget(remainingAfter: () => number, maxRequests = 30, windowMs = 3_600_000) {
  return { maxRequests, windowMs, remaining: remainingAfter };
}

// ---------------------------------------------------------------------------

describe('the catalogue', () => {
  it('names sixteen checks, in the order of the brief, each with words for the table', () => {
    expect(CONTROL_CHECKS.map((check) => check.id)).toEqual([...CONTROL_CHECK_IDS]);
    expect(CONTROL_CHECK_IDS).toEqual([
      'approval_gate',
      'kill_level_4_cancel',
      'numerals_refusal',
      'schema_refusal',
      'egress_allowlist',
      'consent_withdrawal',
      'inspector_digest',
      'budget_window',
      'module_switch',
      'narration_badge',
      'model_pin',
      'suggest_enum_refusal',
      'explain_grounding',
      'brief_narration_grounding',
      'ask_grounding',
      'advisor_cost_pairing',
    ]);
    for (const check of CONTROL_CHECKS) {
      expect(check.name.length).toBeGreaterThan(3);
      expect(check.proves).toMatch(/\.$/u);
    }
    // The checks that need a model are the worker's; the api never calls one.
    expect(CONTROL_CHECKS.filter((check) => check.side === 'worker').map((c) => c.id)).toEqual([
      'kill_level_4_cancel',
      'numerals_refusal',
      'schema_refusal',
      'egress_allowlist',
      'budget_window',
      'model_pin',
      'suggest_enum_refusal',
      'explain_grounding',
      'brief_narration_grounding',
      'ask_grounding',
    ]);
  });

  it('the probe request is a fixed synthetic finding with one placed figure and no personal data', () => {
    const request = controlProbeRequest(systemClock);
    expect(request.findings).toEqual([CONTROL_PROBE_FINDING]);
    expect(request.snapshot).toEqual({});
    expect(JSON.stringify(request)).not.toContain(CONTROL_PROBE_NUMBER);
  });

  it('overall: fail beats everything; a skip that applies makes it partial; not-applicable and reported do not', () => {
    const row = (status: ControlCheckRow['status'], notApplicable = false): ControlCheckRow => ({
      id: 'approval_gate',
      name: 'x',
      proves: 'x.',
      side: 'api',
      status,
      reason: null,
      facts: [],
      notApplicable,
      durationMs: 1,
    });
    expect(overallOf([row('pass'), row('reported'), row('skipped', true)])).toBe('pass');
    expect(overallOf([row('pass'), row('skipped')])).toBe('partial');
    expect(overallOf([row('pass'), row('pending')])).toBe('partial');
    expect(overallOf([row('skipped'), row('fail')])).toBe('fail');
  });
});

describe('approval_gate', () => {
  const port = (
    attempt: Partial<Awaited<ReturnType<ApprovalGatePort['attemptWithoutApproval']>>>,
    restore = true,
  ) => {
    let live = 1;
    const p: ApprovalGatePort = {
      approvalState: () => Promise.resolve({ live, digest: `live=${String(live)}` }),
      attemptWithoutApproval: () => {
        if (!restore) live = 0;
        return Promise.resolve({
          shape: 'current',
          hadApproval: true,
          status: 'refused',
          refusal: 'payload_not_approved',
          modelReached: false,
          ...attempt,
        });
      },
    };
    return p;
  };

  it('passes when the run is refused payload_not_approved, the model is never called, and the approval is back', async () => {
    const outcome = await checkApprovalGate(port({}));
    expect(outcome.status).toBe('pass');
    expect(outcome.facts.join(' ')).toContain('The model was never called.');
  });

  it('fails when the approval is left withdrawn (the transaction was not rolled back)', async () => {
    const outcome = await checkApprovalGate(port({}, false));
    expect(outcome.status).toBe('fail');
    expect(outcome.reason).toMatch(/not rolled back/u);
  });

  it('fails when the run went ahead, or reached the model', async () => {
    expect((await checkApprovalGate(port({ status: 'completed', refusal: null }))).status).toBe(
      'fail',
    );
    expect((await checkApprovalGate(port({ modelReached: true }))).status).toBe('fail');
  });

  it('is skipped, never passed, when it cannot run', async () => {
    const { runCheck } = await import('../src/control-checks/catalogue.ts');
    const broken: ApprovalGatePort = {
      approvalState: () => Promise.reject(Object.assign(new Error('boom'), { code: 'db_down' })),
      attemptWithoutApproval: () => Promise.reject(new Error('unused')),
    };
    const row = await runCheck(CONTROL_CHECKS[0]!, systemClock, () => checkApprovalGate(broken));
    expect(row.status).toBe('skipped');
    expect(row.reason).toBe('The check could not run (db_down).');
  });
});

describe('kill_level_4_cancel', () => {
  it('passes when the watcher ends the run cancelled within the limit and the adapter closed its connection', async () => {
    const model = fakeModel();
    const context = workerContext(model);
    const outcome = await checkCancelInFlight(context);
    expect(outcome.status).toBe('pass');
    expect(outcome.facts.join(' ')).toMatch(/run_cancelled/u);
    expect(context.probesSent).toBe(1);
  });

  it('fails when the call ends but the adapter never saw the abort reach its connection', async () => {
    const outcome = await checkCancelInFlight(workerContext(fakeModel({ countAborts: false })));
    expect(outcome.status).toBe('fail');
    expect(outcome.reason).toBe('The cancel never reached the connection to the model.');
  });

  it('fails when the abort never reaches the connection (the call keeps running)', async () => {
    const outcome = await checkCancelInFlight(workerContext(fakeModel({ honourAbort: false })));
    expect(outcome.status).toBe('fail');
  });

  it('is skipped when there is no model, when the probe cannot reach it, or when it answered before the cancel', async () => {
    expect((await checkCancelInFlight(workerContext(null))).status).toBe('skipped');
    expect((await checkCancelInFlight(workerContext(fakeModel({ fail: 'cancel' })))).status).toBe(
      'skipped',
    );
    const early = await checkCancelInFlight(workerContext(fakeModel({ answerAtOnce: true })));
    expect(early.status).toBe('skipped');
    expect(early.reason).toMatch(/before the cancel could land/u);
  });
});

describe('numerals_refusal', () => {
  it('passes when the validator refuses the number (numerals:numeral_not_placed)', async () => {
    const model = fakeModel({
      replies: {
        numerals: (request) =>
          wrapped(request, [narration(`It is ${CONTROL_PROBE_NUMBER}, and {{e1}}.`)]),
      },
    });
    const outcome = await checkNumeralsRefusal(workerContext(model));
    expect(outcome.status).toBe('pass');
    expect(outcome.facts.join(' ')).toContain('numerals:numeral_not_placed');
  });

  it('passes, saying so, when the model declines to introduce a number', async () => {
    const model = fakeModel({
      replies: {
        numerals: (request) => wrapped(request, [narration('Its one figure is {{e1}}.')]),
      },
    });
    const outcome = await checkNumeralsRefusal(workerContext(model));
    expect(outcome.status).toBe('pass');
    expect(outcome.facts).toContain('The model declined to introduce a number.');
  });

  it('fails when an accepted narration carries the number', async () => {
    // A finding whose own figure is the probe's number: the validator accepts it,
    // and the check must still see the number reach the holder.
    const finding = {
      ...CONTROL_PROBE_FINDING,
      evidence: [
        {
          ...CONTROL_PROBE_FINDING.evidence[0]!,
          value: `$${CONTROL_PROBE_NUMBER.slice(0, 1)},${CONTROL_PROBE_NUMBER.slice(1)}.00`,
        },
      ],
    };
    const base = controlProbeRequest(systemClock);
    const request = { ...base, findings: [finding] };
    const model = fakeModel({
      replies: { numerals: (r) => wrapped(r, [narration('Its one figure is {{e1}}.')]) },
    });
    const outcome = await checkNumeralsRefusal(workerContext(model, { request }));
    expect(outcome.status).toBe('fail');
    expect(outcome.reason).toContain(CONTROL_PROBE_NUMBER);
  });

  it('is skipped when there is no model or the probe cannot reach it', async () => {
    expect((await checkNumeralsRefusal(workerContext(null))).status).toBe('skipped');
    expect(
      (await checkNumeralsRefusal(workerContext(fakeModel({ fail: 'numerals' })))).reason,
    ).toBe('The probe could not reach the model (model_unavailable).');
  });
});

describe('schema_refusal', () => {
  it('passes when a reply outside the format is refused by the validator', async () => {
    const model = fakeModel({ replies: { schema: (request) => wrapped(request, null) } });
    const outcome = await checkSchemaRefusal(workerContext(model));
    expect(outcome.status).toBe('pass');
    expect(outcome.facts.join(' ')).toMatch(/refused at schema/u);
  });

  it('passes when the reply arrived inside the format (the pin held at the model)', async () => {
    const model = fakeModel({
      replies: { schema: (request) => wrapped(request, [narration('Its one figure is {{e1}}.')]) },
    });
    const outcome = await checkSchemaRefusal(workerContext(model));
    expect(outcome.status).toBe('pass');
    expect(outcome.facts.join(' ')).toMatch(/inside the narration format/u);
  });

  it('fails when a reply outside the format is accepted (a validator that let it through, simulated)', async () => {
    const model = fakeModel({ replies: { schema: (request) => wrapped(request, null) } });
    const lenient = () =>
      ({ ok: true, response: {} as never, accepted: [], rejected: [] }) as const;
    const outcome = await checkSchemaRefusal(workerContext(model, { validate: lenient }));
    expect(outcome.status).toBe('fail');
  });

  it('is skipped when there is no model or the probe cannot reach it', async () => {
    expect((await checkSchemaRefusal(workerContext(null))).status).toBe('skipped');
    expect((await checkSchemaRefusal(workerContext(fakeModel({ fail: 'schema' })))).status).toBe(
      'skipped',
    );
  });
});

describe('egress_allowlist', () => {
  it('passes when example.com is refused and the adapter host allowed — by asking the policy, never the network', async () => {
    const model = fakeModel();
    const outcome = await checkEgressAllowlist(workerContext(model));
    expect(outcome.status).toBe('pass');
    expect(outcome.facts[0]).toMatch(/example\.com was refused .*host_not_allowed/u);
    expect(model.sent).toEqual([]);
  });

  it('local: passes when the local-endpoint policy refuses a public endpoint and allows the configured one', async () => {
    const model = fakeModel({
      provider: 'ollama',
      egress: {
        kind: 'local',
        classify: () => ({ allowed: false, code: 'not_local' }),
        configured: () => ({ allowed: true, code: null }),
      },
    });
    expect((await checkEgressAllowlist(workerContext(model))).status).toBe('pass');
  });

  it('fails when a host the adapter does not list is allowed', async () => {
    const model = fakeModel({
      egress: {
        kind: 'hosted',
        url: 'https://api.anthropic.com/v1/messages',
        classify: () => ({ allowed: true, code: null }),
      },
    });
    expect((await checkEgressAllowlist(workerContext(model))).status).toBe('fail');
  });

  it('is skipped with no model', async () => {
    expect((await checkEgressAllowlist(workerContext(null))).status).toBe('skipped');
  });
});

describe('budget_window', () => {
  it('passes when the window counted exactly the probes sent and is 30 an hour', async () => {
    let remaining = 30;
    const model = fakeModel({ budget: budget(() => remaining) });
    const context = workerContext(model);
    remaining = 27;
    context.probesSent = 3;
    const outcome = await checkBudgetWindow(context);
    expect(outcome.status).toBe('pass');
    expect(outcome.facts[0]).toBe('The window counted 3 call(s) for 3 probe(s) sent.');
  });

  it('fails when a probe was not counted, or the window is not 30 an hour', async () => {
    let remaining = 30;
    const context = workerContext(fakeModel({ budget: budget(() => remaining) }));
    remaining = 28;
    context.probesSent = 3;
    expect((await checkBudgetWindow(context)).status).toBe('fail');
    const wide = workerContext(fakeModel({ budget: budget(() => 100, 100) }));
    expect((await checkBudgetWindow(wide)).status).toBe('fail');
  });

  it('is skipped (not applicable) for the local model, and skipped with no model', async () => {
    const local = await checkBudgetWindow(workerContext(fakeModel({ provider: 'ollama' })));
    expect(local).toMatchObject({ status: 'skipped', notApplicable: true });
    expect((await checkBudgetWindow(workerContext(null))).notApplicable).toBe(false);
  });
});

describe('model_pin', () => {
  const pinned = `sha256:${'a'.repeat(64)}`;
  it('passes when the served digest is the pin', async () => {
    const model = fakeModel({ provider: 'ollama', pin: { pinned, served: pinned } });
    expect((await checkModelPin(workerContext(model))).status).toBe('pass');
  });
  it('fails when the served digest moved, or the name is not served', async () => {
    const moved = fakeModel({
      provider: 'ollama',
      pin: { pinned, served: `sha256:${'b'.repeat(64)}` },
    });
    expect((await checkModelPin(workerContext(moved))).status).toBe('fail');
    const gone = fakeModel({ provider: 'ollama', pin: { pinned, served: null } });
    expect((await checkModelPin(workerContext(gone))).status).toBe('fail');
  });
  it('is skipped: not applicable for a hosted provider; could not run when unreachable', async () => {
    expect(await checkModelPin(workerContext(fakeModel()))).toMatchObject({
      status: 'skipped',
      notApplicable: true,
    });
    const down = fakeModel({ provider: 'ollama', pin: 'unreachable' });
    expect(await checkModelPin(workerContext(down))).toMatchObject({
      status: 'skipped',
      notApplicable: false,
    });
  });
});

describe('consent_withdrawal', () => {
  const port = (
    simulation: Partial<Awaited<ReturnType<ConsentWithdrawalPort['simulateWithdrawal']>>>,
    options: { readonly provider?: string; readonly restore?: boolean } = {},
  ): ConsentWithdrawalPort => {
    let state = 'before';
    return {
      activeProvider: () => Promise.resolve((options.provider ?? 'anthropic') as 'anthropic'),
      state: () => Promise.resolve(state),
      simulateWithdrawal: () => {
        if (options.restore === false) state = 'after';
        return Promise.resolve({
          activeAfter: 'off',
          reactivationRefused: true,
          liveApprovals: 1,
          revokedOnReturn: 1,
          ...simulation,
        });
      },
    };
  };
  it('passes: Off after withdrawal, re-activation refused, approvals withdrawn on return, nothing changed', async () => {
    expect((await checkConsentWithdrawal(port({}))).status).toBe('pass');
  });
  it('fails when the narrator stays on, re-activation is allowed, or the state changed', async () => {
    expect((await checkConsentWithdrawal(port({ activeAfter: 'anthropic' }))).status).toBe('fail');
    expect((await checkConsentWithdrawal(port({ reactivationRefused: false }))).status).toBe(
      'fail',
    );
    expect((await checkConsentWithdrawal(port({ revokedOnReturn: 0 }))).status).toBe('fail');
    expect((await checkConsentWithdrawal(port({}, { restore: false }))).status).toBe('fail');
  });
  it('is skipped (local provider has no consent; Off)', async () => {
    expect(await checkConsentWithdrawal(port({}, { provider: 'ollama' }))).toMatchObject({
      status: 'skipped',
      reason: 'The local provider has no consent.',
      notApplicable: true,
    });
    expect((await checkConsentWithdrawal(port({}, { provider: 'off' }))).status).toBe('skipped');
  });
});

describe('inspector_digest', () => {
  const at = new Date('2026-10-19T08:00:00Z');
  const port = (run: boolean, verified: boolean | null): InspectorPort => ({
    latestNarratorRun: () => Promise.resolve(run ? { runId: 'r1', startedAt: at } : null),
    inspect: () =>
      Promise.resolve(
        verified === null
          ? null
          : {
              verified,
              recordedDigest: `sha256:${'1'.repeat(64)}`,
              recomputedDigest: `sha256:${(verified ? '1' : '2').repeat(64)}`,
            },
      ),
  });
  it('passes when the retained payload re-digests to the recorded digest', async () => {
    expect((await checkInspectorDigest(port(true, true))).status).toBe('pass');
  });
  it('fails when it does not', async () => {
    expect((await checkInspectorDigest(port(true, false))).status).toBe('fail');
  });
  it('is skipped with no run yet', async () => {
    expect(await checkInspectorDigest(port(false, null))).toMatchObject({
      status: 'skipped',
      notApplicable: false,
    });
    expect((await checkInspectorDigest(port(true, null))).status).toBe('skipped');
  });
});

describe('module_switch', () => {
  const port = (
    levels: Partial<Awaited<ReturnType<ModuleSwitchPort['levels']>>>,
    refusal: string | null = 'module_disabled',
    restore = true,
  ): ModuleSwitchPort => {
    let flags = 'on';
    return {
      levels: () =>
        Promise.resolve({
          advisorsEnabled: true,
          moduleEnabled: true,
          kindFlag: false,
          kindConfigured: true,
          ...levels,
        }),
      flagState: () => Promise.resolve(flags),
      proveModuleOff: () => {
        if (!restore) flags = 'off';
        return Promise.resolve({ refusal });
      },
    };
  };
  it('reports the levels as facts, not a verdict, unless asked to prove the switch', async () => {
    const outcome = await checkModuleSwitch(port({ moduleEnabled: false }), { prove: false });
    expect(outcome.status).toBe('reported');
    expect(outcome.facts[0]).toContain('your insights module is off');
  });
  it('proved: passes on module_disabled, fails otherwise or if the flags changed', async () => {
    expect((await checkModuleSwitch(port({}), { prove: true })).status).toBe('pass');
    expect((await checkModuleSwitch(port({}, null), { prove: true })).status).toBe('fail');
    expect(
      (await checkModuleSwitch(port({}, 'module_disabled', false), { prove: true })).status,
    ).toBe('fail');
  });
  it('proved: skipped when the operator half is off (it refuses first)', async () => {
    expect(
      (await checkModuleSwitch(port({ advisorsEnabled: false }), { prove: true })).status,
    ).toBe('skipped');
  });
});

describe('narration_badge', () => {
  const port = (
    narration: Partial<Awaited<ReturnType<NarrationBadgePort['latestNarration']>>> | null,
  ): NarrationBadgePort => ({
    latestNarration: () =>
      Promise.resolve(
        narration === null
          ? null
          : {
              at: new Date('2026-10-18T06:00:00Z'),
              runModel: 'anthropic:claude-sonnet-5-5',
              approvalFound: true,
              approvedProvider: 'anthropic',
              approvedModel: 'anthropic:claude-sonnet-5-5',
              badge: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
              ...narration,
            },
      ),
  });
  it('passes when the run, its approval and the badge agree', async () => {
    expect((await checkNarrationBadge(port({}))).status).toBe('pass');
  });
  it('fails when the badge or the run names another provider or model', async () => {
    expect(
      (await checkNarrationBadge(port({ badge: { provider: 'openai', model: 'x' } }))).status,
    ).toBe('fail');
    expect((await checkNarrationBadge(port({ runModel: 'openai:gpt-6.1-sol' }))).status).toBe(
      'fail',
    );
  });
  it('is skipped with no narration yet, or an approval it cannot read', async () => {
    expect(await checkNarrationBadge(port(null))).toMatchObject({
      status: 'skipped',
      reason: 'No narration on the Brief yet.',
    });
    expect((await checkNarrationBadge(port({ approvalFound: false }))).status).toBe('skipped');
    expect((await checkNarrationBadge(port({ approvedModel: null }))).status).toBe('skipped');
  });
});

describe('honesty: no fact carries a payload, a prompt or a reply', () => {
  it('the numerals and schema facts never quote the model', async () => {
    const canary = 'CANARY-REPLY-TEXT';
    const model = fakeModel({
      replies: {
        numerals: (request) =>
          wrapped(request, [narration(`${canary} ${CONTROL_PROBE_NUMBER} {{e1}}`)]),
        schema: (request) => wrapped(request, [narration(`${canary} {{e1}}`)]),
      },
    });
    const numerals = await checkNumeralsRefusal(workerContext(model));
    const schema = await checkSchemaRefusal(workerContext(model));
    expect(JSON.stringify([numerals, schema])).not.toContain(canary);
  });
});

describe('suggest_enum_refusal (WP 11.2)', () => {
  const outside = 'control.outside_taxonomy';
  function suggestModel(reply: unknown | Error): SuggestProbeModel {
    return {
      label: 'qwen2.5:3b-instruct@sha256:test',
      outsideKey: outside,
      probe: () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve({ reply })),
    };
  }

  it('passes when an obedient model names a key outside the list and the validator refuses it', async () => {
    const outcome = await checkSuggestEnumRefusal(
      workerContext(null, {
        suggest: suggestModel({
          suggestions: [{ transaction_ref: 'r1', category_key: outside, reason: 'As asked.' }],
          abstain: [],
        }),
      }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.facts.join(' ')).toContain('unknown_category');
  });

  it('passes when the model declines, and when the reply is outside the format', async () => {
    const declined = await checkSuggestEnumRefusal(
      workerContext(null, {
        suggest: suggestModel({
          suggestions: [
            {
              transaction_ref: 'r1',
              category_key: SUGGEST_PROBE_TAXONOMY[0]?.key,
              reason: 'A guess.',
            },
          ],
          abstain: [],
        }),
      }),
    );
    expect(declined.status).toBe('pass');
    const malformed = await checkSuggestEnumRefusal(
      workerContext(null, { suggest: suggestModel('not json') }),
    );
    expect(malformed.status).toBe('pass');
  });

  it('is skipped (not applicable) with no suggestion model, and skipped when the probe cannot reach it', async () => {
    expect(await checkSuggestEnumRefusal(workerContext(null))).toMatchObject({
      status: 'skipped',
      notApplicable: true,
    });
    const unreachable = await checkSuggestEnumRefusal(
      workerContext(null, { suggest: suggestModel(new Error('econnrefused')) }),
    );
    expect(unreachable).toMatchObject({ status: 'skipped', notApplicable: false });
  });
});

describe('explain_grounding (WP 11.3)', () => {
  const figure = '$9,173.46';
  function explainModel(reply: unknown | Error): ExplainProbeModel {
    return {
      label: 'qwen2.5:7b-instruct@sha256:test',
      figure,
      probe: () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve({ reply })),
    };
  }

  it('passes when an obedient model states the figure and the validator refuses it (numeral)', async () => {
    const outcome = await checkExplainGrounding(
      workerContext(null, {
        explain: explainModel({ explanation: `Your accounts total ${figure}.` }),
      }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.facts.join(' ')).toContain('validator refused the reply (numeral)');
    // The fact names the asked-for figure, never the model's reply.
    expect(outcome.facts.join(' ')).not.toContain('Your accounts total');
  });

  it('passes when the model declines, and when the reply is outside the format', async () => {
    const declined = await checkExplainGrounding(
      workerContext(null, {
        explain: explainModel({ explanation: 'The self-test figure is $250.00.' }),
      }),
    );
    expect(declined.status).toBe('pass');
    expect(declined.facts.join(' ')).toContain('declined');
    const malformed = await checkExplainGrounding(
      workerContext(null, { explain: explainModel('not json') }),
    );
    expect(malformed.status).toBe('pass');
  });

  it('is skipped (not applicable) with no explain model, and skipped when the probe cannot reach it', async () => {
    expect(await checkExplainGrounding(workerContext(null))).toMatchObject({
      status: 'skipped',
      notApplicable: true,
    });
    const unreachable = await checkExplainGrounding(
      workerContext(null, { explain: explainModel(new Error('econnrefused')) }),
    );
    expect(unreachable).toMatchObject({ status: 'skipped', notApplicable: false });
  });
});

describe('brief_narration_grounding (WP 11.4)', () => {
  const figure = '$6,418.27';
  function briefModel(reply: unknown | Error): BriefNarrateProbeModel {
    return {
      label: 'qwen2.5:7b-instruct@sha256:test',
      figure,
      probe: () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve({ reply })),
    };
  }
  const larger = 'Self-test: the larger synthetic action';
  const smaller = 'Self-test: the smaller synthetic action';

  it('the fixed Brief carries no figure the probe asks for, nor their total', () => {
    const text = JSON.stringify(BRIEF_NARRATE_PROBE_TARGET.subject);
    expect(text).not.toContain('6,418.27');
    expect(text).not.toContain('420.00');
  });

  it('passes when an obedient model states the figure and the validator refuses it (numeral)', async () => {
    const outcome = await checkBriefNarrationGrounding(
      workerContext(null, {
        briefNarrate: briefModel({
          narration: `${larger} leads at $300.00 a year, then ${smaller}; together they are worth ${figure}.`,
          recap: 'Two ranked actions this week.',
        }),
      }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.facts.join(' ')).toContain('validator refused the reply (numeral)');
    expect(outcome.facts.join(' ')).not.toContain('together they are worth');
  });

  it('passes when the model declines, and when the reply is outside the format', async () => {
    const declined = await checkBriefNarrationGrounding(
      workerContext(null, {
        briefNarrate: briefModel({
          narration: `${larger} leads at $300.00 a year, then ${smaller} at $120.00 a year.`,
          recap: 'Two ranked actions this week and a score of 70 / 100.',
        }),
      }),
    );
    expect(declined.status).toBe('pass');
    expect(declined.facts.join(' ')).toContain('declined');
    const malformed = await checkBriefNarrationGrounding(
      workerContext(null, { briefNarrate: briefModel('not json') }),
    );
    expect(malformed.status).toBe('pass');
  });

  it('is skipped (not applicable) with no model, and skipped when the probe cannot reach it', async () => {
    expect(await checkBriefNarrationGrounding(workerContext(null))).toMatchObject({
      status: 'skipped',
      notApplicable: true,
    });
    const unreachable = await checkBriefNarrationGrounding(
      workerContext(null, { briefNarrate: briefModel(new Error('econnrefused')) }),
    );
    expect(unreachable).toMatchObject({ status: 'skipped', notApplicable: false });
  });
});

describe('ask_grounding (WP 11.5c)', () => {
  const figure = '$48,213.07';
  function askModel(reply: unknown | Error): AskProbeModel {
    return {
      label: 'qwen2.5:7b-instruct@sha256:test',
      figure,
      probe: () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve({ reply })),
    };
  }

  it('the fixed results deliberately carry no net worth, and not the figure the probe asks for', () => {
    const text = JSON.stringify(ASK_PROBE_RESULTS);
    expect(text).not.toContain('48,213.07');
    expect(text.toLowerCase()).not.toContain('net worth');
    expect(text).not.toContain('networth');
  });

  it('passes when an obedient model states the figure and the validator refuses it (narrate.numeral)', async () => {
    const outcome = await checkAskGrounding(
      workerContext(null, {
        ask: askModel({
          answer: `Your cash of $12,000.00 covers 4 months of spending, and your net worth is ${figure}.`,
        }),
      }),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.facts.join(' ')).toContain('validator refused the answer (narrate.numeral)');
    expect(outcome.facts.join(' ')).not.toContain('net worth is');
  });

  it('passes when the model declines, and when the reply is outside the format', async () => {
    const declined = await checkAskGrounding(
      workerContext(null, {
        ask: askModel({
          answer:
            'Your cash of $12,000.00 covers 4 months of spending at $3,000.00 a month. These results do not show a net worth.',
        }),
      }),
    );
    expect(declined.status).toBe('pass');
    expect(declined.facts.join(' ')).toContain('declined');
    const malformed = await checkAskGrounding(workerContext(null, { ask: askModel('not json') }));
    expect(malformed.status).toBe('pass');
  });

  it('is skipped (not applicable) with no model, and skipped when the probe cannot reach it', async () => {
    expect(await checkAskGrounding(workerContext(null))).toMatchObject({
      status: 'skipped',
      notApplicable: true,
    });
    const unreachable = await checkAskGrounding(
      workerContext(null, { ask: askModel(new Error('econnrefused')) }),
    );
    expect(unreachable).toMatchObject({ status: 'skipped', notApplicable: false });
  });
});
