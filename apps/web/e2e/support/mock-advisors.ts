// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * The advisor-management routes (WP 5.12), as a layerable mock: moved out of `advisors.spec.ts` by WP 9.8
 * so `a11y-sweep.spec.ts` can visit `/settings/advisors` with the same bodies. Install it after
 * `installApiMocks(page)` and pass that mock's state (its `steppedUp` flag is the step-up gate this layer
 * honours); `route.fallback()` hands everything else down.
 */

export const ADVISOR_ID = 'local.narrator';

/**
 * The exact prompt bytes a run of `local.narrator` would send — the same
 * object reused for the preview's `prompt.text` and the retained payload's
 * `payload` field below, so the two are byte-identical by construction (the
 * mock's honest version of "the run that followed retained what the preview
 * showed"), which the evidence file compares directly.
 */
export const PROMPT_MESSAGES = [
  {
    role: 'system',
    content: 'Narrate only from the grounded findings below. Never invent a figure.',
  },
  {
    role: 'user',
    content:
      'Findings:\n<untrusted_data>{"finding_key":"cash.low_balance","summary":"Checking balance is low this week."}</untrusted_data>',
  },
];
export const PROMPT_TEXT = JSON.stringify({ messages: PROMPT_MESSAGES });
export const PROMPT_HASH =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const QUERY_SHAPE =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const INPUT_DIGEST = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

export interface Store {
  grantedScopes: Set<string>;
  approved: boolean;
  liveStatus: string;
  liveCancelReason: string | null;
  /** Level 1: the operator's `ADVISORS_ENABLED` (read-only here) and the holder's `module.insights`. */
  advisorsEnabled: boolean;
  moduleEnabled: boolean;
  /** Level 2: the `advisors.kind.local_model` flag, and whether the deployment has a model configured. */
  kindEnabled: boolean;
  modelConfigured: boolean;
  grantEvents: Record<string, unknown>[];
}

export function moduleState(store: Store) {
  return {
    operator: { advisorsEnabled: store.advisorsEnabled },
    user: { enabled: store.moduleEnabled },
    effective: store.advisorsEnabled && store.moduleEnabled,
  };
}

export function kindState(store: Store) {
  return {
    kind: 'local_model',
    enabled: store.kindEnabled,
    configured: store.modelConfigured,
    effective: store.kindEnabled && store.modelConfigured,
  };
}

export function scopesFor(store: Store) {
  return [
    {
      scope: 'cash.summary',
      sensitivity: 2,
      key: 'cash.summary',
      yields: 'Account balances and cash totals, rounded.',
      drops: 'No transaction detail, no merchant names.',
      externalAllowed: true,
      requiresPerRunConsent: false,
      sourcedInPhase2: true,
      granted: store.grantedScopes.has('cash.summary'),
      requested: true,
    },
    {
      scope: 'transactions.raw',
      sensitivity: 9,
      key: 'transactions.raw',
      yields: 'Every raw transaction row, including merchant free text.',
      drops: 'Nothing — this is the widest transaction scope.',
      externalAllowed: false,
      requiresPerRunConsent: true,
      sourcedInPhase2: false,
      granted: store.grantedScopes.has('transactions.raw'),
      requested: true,
    },
    {
      scope: 'risk.profile',
      sensitivity: 5,
      key: 'risk.profile',
      yields: 'The holder’s own risk-tolerance answers.',
      drops: 'No account or transaction data.',
      externalAllowed: false,
      requiresPerRunConsent: false,
      sourcedInPhase2: true,
      granted: store.grantedScopes.has('risk.profile'),
      // G5-3: the narrator never asks for this scope, so it cannot be granted.
      requested: false,
    },
  ] as const;
}

export function requestFor(store: Store) {
  return {
    contract_version: 1,
    request_id: 'req_1',
    advisor_id: ADVISOR_ID,
    advisor_version: '1.0.0',
    kind: 'local_model',
    generated_at: '2026-06-01T00:00:00.000Z',
    base_currency: 'USD',
    time_zone: 'UTC',
    today: '2026-06-01',
    granted_scopes: [...store.grantedScopes],
    input_digest: INPUT_DIGEST,
    limits: { max_insights: 5, max_response_bytes: 65536, deadline: '2026-06-01T00:03:00.000Z' },
    snapshot: {},
  };
}

export function liveRun(store: Store) {
  return {
    id: 'run_live',
    advisorId: ADVISOR_ID,
    advisorVersion: '1.0.0',
    trigger: 'manual',
    status: store.liveStatus,
    refusal: null,
    inputDigest: INPUT_DIGEST,
    grantedScopes: [...store.grantedScopes],
    emittedScopes: ['cash.summary'],
    proposedCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    errorCode: null,
    durationMs: null,
    startedAt: '2026-06-01T06:00:00.000Z',
    finishedAt: store.liveStatus === 'started' ? null : '2026-06-01T06:00:05.000Z',
    cancelRequestedAt: store.liveStatus === 'started' ? null : '2026-06-01T06:00:04.000Z',
    cancelReason: store.liveCancelReason,
    llmModel: store.liveStatus === 'started' ? null : 'qwen2.5:7b-instruct-q4_K_M',
    llmPromptHash: store.liveStatus === 'started' ? null : PROMPT_HASH,
  };
}

export function doneRun() {
  return {
    id: 'run_done',
    advisorId: ADVISOR_ID,
    advisorVersion: '1.0.0',
    trigger: 'schedule',
    status: 'completed',
    refusal: null,
    inputDigest: INPUT_DIGEST,
    grantedScopes: ['cash.summary'],
    emittedScopes: ['cash.summary'],
    proposedCount: 1,
    acceptedCount: 1,
    rejectedCount: 1,
    errorCode: null,
    durationMs: 4800,
    startedAt: '2026-05-25T06:00:00.000Z',
    finishedAt: '2026-05-25T06:00:05.000Z',
    cancelRequestedAt: null,
    cancelReason: null,
    llmModel: 'qwen2.5:7b-instruct-q4_K_M',
    llmPromptHash: PROMPT_HASH,
  };
}

/**
 * Registers every `/advisors*` route this screen calls, over the shared
 * mock's session/step-up handling (`state.steppedUp`, flipped by
 * `/api/auth/step-up/verify` — the same flag `mock-api.ts`'s own
 * `/api/connections` POST reads).
 */
export async function installAdvisorMocks(
  page: Page,
  state: { steppedUp: boolean },
): Promise<Store> {
  const store: Store = {
    grantedScopes: new Set(['cash.summary']),
    approved: false,
    liveStatus: 'started',
    liveCancelReason: null,
    advisorsEnabled: true,
    moduleEnabled: false,
    kindEnabled: true,
    modelConfigured: false,
    grantEvents: [],
  };

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const stepUpRequired = () =>
      json(
        {
          type: 'about:blank',
          title: 'Step-up required',
          status: 403,
          code: 'step_up_required',
          correlationId: 'corr_su',
        },
        403,
      );

    if (path === '/api/advisors' && method === 'GET') {
      return json({
        advisors: [
          {
            advisorId: ADVISOR_ID,
            displayName: 'Local narrator',
            kind: 'local_model',
            version: '1.0.0',
            enabled: true,
            quarantinedAt: null,
            quarantineReason: null,
            consecutiveFailures: 0,
            lastRunAt: '2026-06-01T06:00:00.000Z',
            grantedScopes: [...store.grantedScopes],
            lastRunStatus: store.liveStatus,
            lastRunRejected: 1,
          },
        ],
      });
    }

    if (path === `/api/advisors/${ADVISOR_ID}/scopes` && method === 'GET') {
      return json({ advisorId: ADVISOR_ID, kind: 'local_model', scopes: scopesFor(store) });
    }

    if (path === `/api/advisors/${ADVISOR_ID}/grants` && method === 'PUT') {
      if (!state.steppedUp) return stepUpRequired();
      const body = request.postDataJSON() as { scopes: string[] };
      const before = new Set(store.grantedScopes);
      store.grantedScopes = new Set(body.scopes);
      const granted = body.scopes.filter((s) => !before.has(s));
      const revoked = [...before].filter((s) => !store.grantedScopes.has(s));
      return json({ advisorId: ADVISOR_ID, granted, revoked, notRequested: [] });
    }

    if (path === `/api/advisors/${ADVISOR_ID}/grant-events` && method === 'GET') {
      return json({ advisorId: ADVISOR_ID, events: store.grantEvents });
    }

    if (path === `/api/advisors/${ADVISOR_ID}/payload-preview` && method === 'GET') {
      return json({
        advisorId: ADVISOR_ID,
        kind: 'local_model',
        queryShape: QUERY_SHAPE,
        scopes: [...store.grantedScopes],
        promptTemplateHash: PROMPT_HASH,
        request: requestFor(store),
        prompt: { text: PROMPT_TEXT, hash: PROMPT_HASH },
        approvalRequired: true,
        approved: store.approved,
      });
    }

    if (path === `/api/advisors/${ADVISOR_ID}/payload-approvals` && method === 'POST') {
      if (!state.steppedUp) return stepUpRequired();
      store.approved = true;
      return json({ approvalId: 'appr_1', queryShape: QUERY_SHAPE });
    }

    if (path === `/api/advisors/${ADVISOR_ID}/runs` && method === 'GET') {
      return json({ runs: [liveRun(store), doneRun()] });
    }

    if (path === '/api/advisors/runs/run_live' && method === 'GET') {
      return json({ run: liveRun(store), rejections: [], payload: null });
    }

    if (path === '/api/advisors/runs/run_done' && method === 'GET') {
      return json({
        run: doneRun(),
        rejections: [
          { step: 'numerals', code: 'figure_not_traceable', findingKey: 'cash.low_balance' },
        ],
        payload: {
          queryShape: QUERY_SHAPE,
          recordedDigest: INPUT_DIGEST,
          recomputedDigest: INPUT_DIGEST,
          digestVerified: true,
          payload: { messages: PROMPT_MESSAGES },
          expiresAt: '2026-06-25T06:00:00.000Z',
        },
      });
    }

    if (path === '/api/advisors/runs/run_live/cancel' && method === 'POST') {
      if (!state.steppedUp) return stepUpRequired();
      if (store.liveStatus !== 'started') {
        return json(
          {
            type: 'about:blank',
            title: 'Run not in flight',
            status: 409,
            code: 'insights.run_not_in_flight',
            correlationId: 'corr_c',
          },
          409,
        );
      }
      store.liveStatus = 'cancelled';
      store.liveCancelReason = 'run_cancelled';
      return json({ runId: 'run_live', outcome: 'requested' });
    }

    if (path === '/api/advisors/kinds/local_model/enabled' && method === 'GET') {
      return json(kindState(store));
    }

    if (path === '/api/advisors/kinds/local_model/enabled' && method === 'PUT') {
      if (!state.steppedUp) return stepUpRequired();
      const body = request.postDataJSON() as { enabled: boolean };
      store.kindEnabled = body.enabled;
      return json({ kind: 'local_model', enabled: body.enabled });
    }

    if (path === '/api/advisors/module/enabled' && method === 'GET') {
      return json(moduleState(store));
    }

    if (path === '/api/advisors/module/enabled' && method === 'PUT') {
      if (!state.steppedUp) return stepUpRequired();
      const body = request.postDataJSON() as { enabled: boolean };
      store.moduleEnabled = body.enabled;
      return json(moduleState(store));
    }

    return route.fallback();
  });

  return store;
}
