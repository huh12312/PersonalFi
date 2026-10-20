// SPDX-License-Identifier: MIT
import type { Route } from '@playwright/test';

/**
 * WP 10.6: `/api/narrator/*` - Settings › Language model - in the response shapes
 * `apps/api/src/routes/narrator-settings.ts` really sends, with real state, wired through `installApiMocks`
 * (so the a11y sweep, the keyboard journeys and `narrator-settings.spec.ts` all see it). The same machine as the
 * unit tests' `src/features/narrator/narrator-fixtures.ts` (e2e never imports from `src/`).
 *
 * The api's rules: every write but Test needs a fresh step-up (`isFresh()`, the caller's flag set by its step-up
 * verify handler); a hosted provider can be made active only with a standing consent and a key; making a provider
 * active (or changing the active one's model) revokes the narrator's standing payload approvals; withdrawing the
 * active provider's consent turns the narrator off; the operator's file wins over a stored key; a key is never in
 * any response, only its last four characters; a second Test of one provider is the api's 20 s 409.
 *
 * The providers start as a mix, one of each state the cards draw:
 *
 *   - ollama: active, pinned by the operator's environment (read-only), ready.
 *   - openai: key from the operator's file (read-only), consent ticked, ready.
 *   - openrouter: key stored (ending in r9Qx), consent not ticked.
 *   - anthropic: no key, consent not ticked.
 */

type NarratorProvider = 'ollama' | 'openai' | 'openrouter' | 'anthropic';
type NarratorChoice = NarratorProvider | 'off';
type NotReady =
  | 'off'
  | 'not_configured'
  | 'consent_required'
  | 'key_missing'
  | 'key_unopenable'
  | 'endpoint_refused';

export const CONSENT_VERSION = 'narrator-consent/1';
export const WHAT_LEAVES =
  'Brief findings: aggregated amounts, bucketed, merchants pseudonymised — never a transaction, never an account number';

const HOSTS = {
  openai: 'api.openai.com',
  openrouter: 'openrouter.ai',
  anthropic: 'api.anthropic.com',
};
const DEFAULTS = {
  openai: 'gpt-6.1-sol',
  openrouter: 'anthropic/claude-sonnet-5.5',
  anthropic: 'claude-sonnet-5-5',
};
const DISPLAY = {
  ollama: 'Ollama (local)',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
};
type Hosted = keyof typeof HOSTS;

export function consentText(provider: Hosted): string {
  const name = DISPLAY[provider];
  return (
    `Send the narrator's payload to ${name} (${HOSTS[provider]}) ` +
    `with my own key. What leaves this machine: ${WHAT_LEAVES}. ` +
    'I see the exact payload before anything is sent, and approve it first. ' +
    `${name}'s own terms apply to what it receives.`
  );
}

export interface FixtureKey {
  source: 'file' | 'stored' | 'none';
  hint: string | null;
  storedAt: string | null;
  rotatedAt: string | null;
}

export interface NarratorMockState {
  activeProvider: NarratorChoice;
  keys: Record<NarratorProvider, FixtureKey>;
  models: Record<Hosted, string | null>;
  consents: Record<Hosted, string | null>;
  ollama: { pinned: boolean; endpoint: string | null; model: string | null; digest: string | null };
  /** Standing payload approvals of the narrator; a switch revokes them. */
  approvals: number;
  /** `METHOD path` of every call, in order. */
  calls: string[];
  /** Every `PUT .../credentials` body that arrived after a step-up. */
  keyBodies: unknown[];
  /** Tests per provider, for the 20 s 409. */
  tests: Record<string, number>;
  /** WP 10.16: the controls self-test (`GET`/`POST /api/narrator/control-checks`). */
  controlChecks: ControlChecksMockState;
}

export const PINNED_MODEL = 'qwen2.5:7b-instruct-q4_K_M';
export const PINNED_DIGEST = `sha256:${'3f'.repeat(32)}`;

const NONE: FixtureKey = { source: 'none', hint: null, storedAt: null, rotatedAt: null };

export function createNarratorState(overrides: Partial<NarratorMockState> = {}): NarratorMockState {
  return {
    activeProvider: 'ollama',
    keys: {
      ollama: { ...NONE },
      openai: { source: 'file', hint: null, storedAt: null, rotatedAt: null },
      openrouter: {
        source: 'stored',
        hint: 'r9Qx',
        storedAt: '2026-09-02T10:00:00.000Z',
        rotatedAt: null,
      },
      anthropic: { ...NONE },
    },
    models: { openai: null, openrouter: null, anthropic: null },
    consents: { openai: '2026-09-01T10:00:00.000Z', openrouter: null, anthropic: null },
    ollama: { pinned: true, endpoint: null, model: null, digest: null },
    approvals: 1,
    calls: [],
    keyBodies: [],
    tests: {},
    controlChecks: createControlChecksState(),
    ...overrides,
  };
}

function providerState(state: NarratorMockState, provider: NarratorProvider) {
  const key = { ...state.keys[provider], required: provider !== 'ollama' };
  if (provider === 'ollama') {
    const o = state.ollama;
    const fromSettings = o.endpoint !== null && o.model !== null && o.digest !== null;
    const configured = o.pinned || fromSettings;
    return {
      provider,
      displayName: DISPLAY.ollama,
      kind: 'local' as const,
      host: null,
      key,
      model: {
        value: o.pinned ? PINNED_MODEL : o.model,
        default: null,
        source: o.pinned
          ? ('environment' as const)
          : fromSettings
            ? ('settings' as const)
            : ('none' as const),
        locked: o.pinned,
      },
      endpoint: {
        value: o.pinned ? null : o.endpoint,
        digest: o.pinned ? PINNED_DIGEST : o.digest,
        locked: o.pinned,
      },
      consent: null,
      ready: configured,
      notReady: configured ? null : ('not_configured' as const),
    };
  }
  const consentedAt = state.consents[provider];
  const stored = state.models[provider];
  const notReady =
    consentedAt === null
      ? ('consent_required' as const)
      : key.source === 'none'
        ? ('key_missing' as const)
        : null;
  return {
    provider,
    displayName: DISPLAY[provider],
    kind: 'hosted' as const,
    host: HOSTS[provider],
    key,
    model: {
      value: stored ?? DEFAULTS[provider],
      default: DEFAULTS[provider],
      source: stored === null ? ('default' as const) : ('settings' as const),
      locked: false,
    },
    endpoint: null,
    consent: {
      given: consentedAt !== null,
      consentedAt,
      version: CONSENT_VERSION,
      text: consentText(provider),
    },
    ready: notReady === null,
    notReady,
  };
}

export function settingsOf(state: NarratorMockState): Record<string, unknown> {
  const providers = (['ollama', 'openai', 'openrouter', 'anthropic'] as const).map((p) =>
    providerState(state, p),
  );
  const choice = state.activeProvider;
  const active = choice === 'off' ? null : providers.find((p) => p.provider === choice);
  return {
    activeProvider: choice,
    active: {
      provider: choice,
      label:
        active === undefined || active === null || !active.ready
          ? null
          : choice === 'ollama'
            ? `${active.model.value ?? ''}@${active.endpoint?.digest ?? ''}`
            : `${choice}:${active.model.value ?? ''}`,
      model: active?.ready === true ? active.model.value : null,
      ready: active?.ready === true,
      notReady: (choice === 'off' ? 'off' : (active?.notReady ?? null)) as NotReady | null,
    },
    consentVersion: CONSENT_VERSION,
    whatLeaves: WHAT_LEAVES,
    providers,
  };
}

export interface FixtureReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function problem(status: number, code: string, detail: string): FixtureReply {
  return {
    status,
    body: {
      type: 'about:blank',
      title: status === 409 ? 'Conflict' : 'Error',
      status,
      code,
      detail,
    },
  };
}

const STEP_UP: FixtureReply = {
  status: 403,
  body: {
    type: 'about:blank',
    title: 'Forbidden',
    status: 403,
    code: 'step_up_required',
    correlationId: 'corr_narrator',
  },
};

const PATH =
  /^\/api\/narrator\/(?:settings|providers\/(ollama|openai|openrouter|anthropic)\/(credentials|model|endpoint|consent|test))$/u;

/** Answers a `/api/narrator/*` call, or returns `null` for any other path. */
function narratorReply(
  state: NarratorMockState,
  method: string,
  path: string,
  body: unknown,
  isFresh: () => boolean,
): FixtureReply | null {
  const match = PATH.exec(path);
  if (match === null) return null;
  state.calls.push(`${method} ${path}`);
  const provider = match[1] as NarratorProvider | undefined;
  const what = match[2];

  if (provider === undefined && method === 'GET') return { status: 200, body: settingsOf(state) };

  if (what === 'test' && provider !== undefined && method === 'POST') {
    const count = (state.tests[provider] ?? 0) + 1;
    state.tests[provider] = count;
    if (count > 1) {
      return {
        ...problem(409, 'narrator.test_too_soon', 'Try again in 17 s.'),
        headers: { 'Retry-After': '17' },
      };
    }
    const view = providerState(state, provider);
    if (provider === 'ollama') {
      return {
        status: 200,
        body: {
          provider,
          model: view.model.value,
          outcome: view.ready ? 'worker_only' : 'not_configured',
          ok: view.ready,
          roundTripMs: null,
          status: null,
          message: view.ready
            ? `The local model ${view.model.value ?? ''} is configured. Only the worker can reach it, over its internal network — this server has no route to it by design — and the worker checks the served model’s digest before every narration.`
            : 'No local model is configured: the operator’s environment pins none, and none is set here.',
        },
      };
    }
    if (view.key.source === 'none') {
      return {
        status: 200,
        body: {
          provider,
          model: view.model.value,
          outcome: 'key_missing',
          ok: false,
          roundTripMs: null,
          status: null,
          message: `${view.displayName} has no key yet. Save one first.`,
        },
      };
    }
    return {
      status: 200,
      body: {
        provider,
        model: view.model.value,
        outcome: 'ok',
        ok: true,
        roundTripMs: 412,
        status: 200,
        message: `${view.displayName} answered in 412 ms with ${view.model.value ?? ''}, in the narration's reply format. Nothing personal was sent.`,
      },
    };
  }

  if (!isFresh()) return STEP_UP;
  const input = (body ?? {}) as Record<string, unknown>;

  if (provider === undefined && method === 'PUT') {
    const choice = input['activeProvider'] as NarratorChoice;
    if (choice !== 'off') {
      const view = providerState(state, choice);
      if (choice !== 'ollama' && view.consent?.given !== true) {
        return problem(
          409,
          'narrator.consent_required',
          `${view.displayName} cannot narrate until you tick its consent: what leaves this machine is ${WHAT_LEAVES}.`,
        );
      }
      if (choice !== 'ollama' && view.key.source === 'none') {
        return problem(
          409,
          'narrator.key_required',
          `${view.displayName} has no key: save one (or write the operator's secret file) first.`,
        );
      }
      if (choice === 'ollama' && !view.ready) {
        return problem(409, 'narrator.not_configured', 'No local model is configured.');
      }
    }
    let revoked = 0;
    if (choice !== state.activeProvider && choice !== 'off') {
      revoked = state.approvals;
      state.approvals = 0;
    }
    state.activeProvider = choice;
    return { status: 200, body: { ...settingsOf(state), approvalsRevoked: revoked } };
  }

  if (provider === undefined) return problem(405, 'method_not_allowed', 'Method not allowed.');

  if (what === 'credentials') {
    if (method === 'DELETE') {
      if (state.keys[provider].source === 'stored') state.keys[provider] = { ...NONE };
      return { status: 200, body: settingsOf(state) };
    }
    if (state.keys[provider].source === 'file') {
      return problem(
        409,
        'provider_credentials.managed_by_files',
        `The ${DISPLAY[provider]} key is supplied by the operator's secret file, which takes precedence. Empty ${provider}_api_key in the secrets directory to use a stored key.`,
      );
    }
    state.keyBodies.push(body);
    const key = String(input['key'] ?? '');
    const previous = state.keys[provider];
    const now = '2026-10-15T09:00:00.000Z';
    state.keys[provider] = {
      source: 'stored',
      hint: key.slice(-4),
      storedAt: previous.source === 'stored' ? previous.storedAt : now,
      rotatedAt: previous.source === 'stored' ? now : null,
    };
    return { status: 200, body: settingsOf(state) };
  }

  if (what === 'consent' && provider !== 'ollama') {
    if (method === 'PUT') {
      if (input['consentVersion'] !== CONSENT_VERSION) {
        return problem(
          409,
          'narrator.consent_version_unknown',
          'The consent text has changed since it was shown. Read it again and tick it.',
        );
      }
      state.consents[provider] = '2026-10-15T09:00:00.000Z';
      return { status: 200, body: settingsOf(state) };
    }
    state.consents[provider] = null;
    if (state.activeProvider === provider) state.activeProvider = 'off';
    return { status: 200, body: settingsOf(state) };
  }

  if (what === 'model' && provider !== 'ollama') {
    const model = (input['model'] ?? null) as string | null;
    state.models[provider] = model;
    let revoked = 0;
    if (state.activeProvider === provider) {
      revoked = state.approvals;
      state.approvals = 0;
    }
    return { status: 200, body: { ...settingsOf(state), approvalsRevoked: revoked } };
  }

  if (what === 'endpoint' && provider === 'ollama') {
    if (state.ollama.pinned) {
      return problem(
        409,
        'narrator.managed_by_environment',
        "The local model is pinned by the operator's environment.",
      );
    }
    if (method === 'DELETE') {
      state.ollama = { pinned: false, endpoint: null, model: null, digest: null };
      return { status: 200, body: { ...settingsOf(state), approvalsRevoked: 0 } };
    }
    const endpoint = String(input['endpoint'] ?? '');
    if (endpoint.includes('example.com')) {
      return problem(
        422,
        'narrator.endpoint_refused',
        'That endpoint is refused by the local-endpoint policy: loopback or a compose-internal name only.',
      );
    }
    state.ollama = {
      pinned: false,
      endpoint,
      model: String(input['model'] ?? ''),
      digest: String(input['digest'] ?? ''),
    };
    return { status: 200, body: { ...settingsOf(state), approvalsRevoked: 0 } };
  }

  return problem(404, 'not_found', 'Not found.');
}

/**
 * Answers the request when `path` is a `/api/narrator/*` route and returns `true`; returns `false` (and touches
 * nothing) for any other path, so the caller's own routing carries on.
 */
export async function handleNarrator(
  route: Route,
  path: string,
  method: string,
  state: NarratorMockState,
  isFresh: () => boolean,
): Promise<boolean> {
  if (!path.startsWith('/api/narrator/')) return false;
  const raw = route.request().postData();
  if (path === '/api/narrator/control-checks') {
    if (method !== 'GET' && method !== 'POST') return false;
    const checks = controlChecksReply(
      state.controlChecks,
      method,
      raw === null || raw === '' ? undefined : JSON.parse(raw),
      isFresh,
    );
    await route.fulfill({
      status: checks.status,
      contentType: 'application/json',
      ...(checks.headers === undefined ? {} : { headers: checks.headers }),
      body: JSON.stringify(checks.body),
    });
    return true;
  }
  const reply = narratorReply(
    state,
    method,
    path,
    raw === null || raw === '' ? undefined : JSON.parse(raw),
    isFresh,
  );
  if (reply === null) return false;
  await route.fulfill({
    status: reply.status,
    contentType: 'application/json',
    ...(reply.headers === undefined ? {} : { headers: reply.headers }),
    body: JSON.stringify(reply.body),
  });
  return true;
}

// ---------------------------------------------------------------------------
// WP 10.16: the controls self-test, `GET`/`POST /api/narrator/control-checks`
// ---------------------------------------------------------------------------

/**
 * The same machine as the unit tests' `src/features/narrator/control-checks-fixtures.ts`, in the shapes
 * `apps/api/src/routes/narrator-control-checks.ts` really sends: `POST` needs a fresh step-up (403
 * `step_up_required`), answers 202 with a run whose eleven checks are pending, and refuses a second run inside ten
 * minutes with the api's 409 `narrator.control_checks_too_soon` and `Retry-After`. Each `GET` after a start moves
 * the run on: the checks that were running get their outcome, and the next three start, so the run is finished on
 * the fifth read with a realistic mix for the local model (passes, two not-applicable skips, a skip with a reason,
 * a reported kill-switch check) and the overall result "partial".
 *
 * With no run the list says `lastProven: null` (the dashboard's "controls never proven"); `seedControlCheckRun`
 * puts a finished run in place first (the dashboard's "controls proven <date>").
 */

type ControlCheckId =
  | 'approval_gate'
  | 'kill_level_4_cancel'
  | 'numerals_refusal'
  | 'schema_refusal'
  | 'egress_allowlist'
  | 'consent_withdrawal'
  | 'inspector_digest'
  | 'budget_window'
  | 'module_switch'
  | 'narration_badge'
  | 'model_pin';

interface ControlCheckRow {
  id: ControlCheckId;
  name: string;
  proves: string;
  side: 'api' | 'worker';
  status: 'pending' | 'running' | 'pass' | 'fail' | 'skipped' | 'reported';
  reason: string | null;
  facts: string[];
  notApplicable: boolean;
  durationMs: number | null;
}

export interface ControlCheckRunBody {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  state: 'running' | 'finished' | 'interrupted';
  provider: 'ollama' | 'openai' | 'openrouter' | 'anthropic' | 'off';
  model: string | null;
  overall: 'pass' | 'fail' | 'partial' | null;
  evidenceVersion: string;
  results: ControlCheckRow[];
}

type Outcome = Pick<
  ControlCheckRow,
  'status' | 'reason' | 'facts' | 'notApplicable' | 'durationMs'
>;

const CONTROL_CHECKS: ReadonlyArray<Pick<ControlCheckRow, 'id' | 'name' | 'proves' | 'side'>> = [
  {
    id: 'approval_gate',
    name: 'Payload approval gate',
    proves:
      'A narration whose payload shape has no live approval is refused payload_not_approved, and the model is never called.',
    side: 'api',
  },
  {
    id: 'kill_level_4_cancel',
    name: 'Cancel a run in flight (level 4)',
    proves:
      'Cancelling a narration while the model is answering ends the run cancelled within 2 seconds and closes the connection to the model.',
    side: 'worker',
  },
  {
    id: 'numerals_refusal',
    name: 'Numbers the app did not write',
    proves:
      'A reply that introduces a number the finding never had is refused by the validator and never reaches the Brief.',
    side: 'worker',
  },
  {
    id: 'schema_refusal',
    name: 'Replies outside the format',
    proves: 'A reply outside the narration reply format never reaches the Brief.',
    side: 'worker',
  },
  {
    id: 'egress_allowlist',
    name: 'Egress allow-list',
    proves:
      'The model adapter refuses a host it does not list before any connection is made, and allows its own.',
    side: 'worker',
  },
  {
    id: 'consent_withdrawal',
    name: 'Consent withdrawal',
    proves:
      "Withdrawing the active hosted provider's consent turns the narrator Off; using it again needs a fresh consent and withdraws the payload approval.",
    side: 'api',
  },
  {
    id: 'inspector_digest',
    name: 'Run inspector digest',
    proves:
      "The last narration's retained payload re-digests to exactly the digest its run recorded.",
    side: 'api',
  },
  {
    id: 'budget_window',
    name: 'Hourly call window',
    proves: "Every hosted call is counted against the provider's window of 30 calls an hour.",
    side: 'worker',
  },
  {
    id: 'module_switch',
    name: 'Kill switches 1 and 2',
    proves:
      'The module and model switches as they stand; asked to prove it, turning the module off refuses a run module_disabled.',
    side: 'api',
  },
  {
    id: 'narration_badge',
    name: 'Narration badge',
    proves: 'The latest narration names the provider and model its payload was approved for.',
    side: 'api',
  },
  {
    id: 'model_pin',
    name: 'Local model pin',
    proves: 'The local model the worker reaches is served at exactly the pinned digest.',
    side: 'worker',
  },
];

const LOCAL_LABEL = `${PINNED_MODEL}@${PINNED_DIGEST}`;

const passed = (durationMs: number, ...facts: string[]): Outcome => ({
  status: 'pass',
  reason: null,
  facts,
  notApplicable: false,
  durationMs,
});

function localOutcomes(proveSwitch: boolean): Record<ControlCheckId, Outcome> {
  return {
    approval_gate: passed(
      120,
      'A narration with no live approval for its payload shape was refused payload_not_approved.',
      'The model was not called.',
    ),
    kill_level_4_cancel: passed(
      1840,
      'Cancelled 600 ms after the probe started; the run read run_cancelled 140 ms later.',
    ),
    numerals_refusal: passed(
      2310,
      'Asked the local model to write 7319 into a narration.',
      'The validator refused the reply: it had a number the finding never had.',
    ),
    schema_refusal: passed(
      1980,
      'Asked the local model to reply in prose, outside the reply format.',
    ),
    egress_allowlist: passed(
      15,
      'The adapter refused a host it does not list before connecting.',
      'It allowed its own host.',
    ),
    consent_withdrawal: {
      status: 'skipped',
      reason: 'The local provider has no consent.',
      facts: [],
      notApplicable: true,
      durationMs: 3,
    },
    inspector_digest: {
      status: 'skipped',
      reason: 'No narration has run yet with its payload retained (the last 30 days).',
      facts: [],
      notApplicable: false,
      durationMs: 40,
    },
    budget_window: {
      status: 'skipped',
      reason: 'The local model has no hourly call window.',
      facts: [],
      notApplicable: true,
      durationMs: 2,
    },
    module_switch: proveSwitch
      ? passed(
          60,
          'Kill switch 1 (the module) and kill switch 2 (the model) are on.',
          'With the module turned off inside a transaction that was rolled back, a run was refused module_disabled.',
        )
      : {
          status: 'reported',
          reason: null,
          facts: [
            'Kill switch 1 (the module) and kill switch 2 (the model) are on.',
            'Not asked to prove kill switch 1 this time.',
          ],
          notApplicable: false,
          durationMs: 25,
        },
    narration_badge: passed(
      30,
      `The narration of 2026-10-12 was written by ${PINNED_MODEL}.`,
      'Its payload was approved for the same provider and model.',
    ),
    model_pin: passed(410, `The worker reached ${PINNED_MODEL} served at the pinned digest.`),
  };
}

function pendingRunBody(id: string, startedAt: string): ControlCheckRunBody {
  return {
    id,
    startedAt,
    finishedAt: null,
    state: 'running',
    provider: 'ollama',
    model: LOCAL_LABEL,
    overall: null,
    evidenceVersion: 'control-checks/1',
    results: CONTROL_CHECKS.map((check) => ({
      ...check,
      status: 'pending',
      reason: null,
      facts: [],
      notApplicable: false,
      durationMs: null,
    })),
  };
}

function overallOf(rows: readonly ControlCheckRow[]): ControlCheckRunBody['overall'] {
  if (rows.some((row) => row.status === 'fail')) return 'fail';
  if (rows.some((row) => row.status === 'skipped' && !row.notApplicable)) return 'partial';
  return 'pass';
}

export interface ControlChecksMockState {
  runs: ControlCheckRunBody[];
  /** Whether the run being watched was asked to prove kill switch 1. */
  proveSwitch: boolean;
  /** The list's `nextAllowedAt` (turn off to reach the api's 409 from a stale screen). */
  reportWindow: boolean;
  /** Checks a `GET` starts, while the newest run is going. */
  advancePerRead: number;
  /** `METHOD path` of every call, in order. */
  calls: string[];
  /** Every `POST` body that got past the step-up. */
  bodies: unknown[];
  sequence: number;
}

export function createControlChecksState(
  overrides: Partial<ControlChecksMockState> = {},
): ControlChecksMockState {
  return {
    runs: [],
    proveSwitch: false,
    reportWindow: true,
    advancePerRead: 3,
    calls: [],
    bodies: [],
    sequence: 0,
    ...overrides,
  };
}

/**
 * A finished run in place before the page loads: `overall` 'pass' (the proven-on-the-dashboard case: kill switch 1
 * proven, the two provider skips not applicable, the digest check run), 'partial' (the default mix) or 'fail'.
 */
export function seedControlCheckRun(
  state: ControlChecksMockState,
  options: { finishedAt: string; overall?: 'pass' | 'partial' | 'fail' },
): ControlCheckRunBody {
  const overall = options.overall ?? 'pass';
  const outcomes = localOutcomes(overall === 'pass');
  const startedAt = new Date(new Date(options.finishedAt).getTime() - 9_000).toISOString();
  state.sequence += 1;
  const base = pendingRunBody(
    `00000000-0000-4000-9000-${String(state.sequence).padStart(12, '0')}`,
    startedAt,
  );
  const results = base.results.map((row) => {
    const outcome: Outcome = { ...outcomes[row.id] };
    if (row.id === 'inspector_digest' && overall === 'pass') {
      return {
        ...row,
        ...passed(
          55,
          'The narration of 2026-10-12 recorded sha256:9c1d…; its retained payload re-digests to the same.',
        ),
      };
    }
    if (row.id === 'egress_allowlist' && overall === 'fail') {
      return {
        ...row,
        status: 'fail' as const,
        reason: 'The adapter connected to a host it does not list.',
        facts: ['It reached example.invalid before refusing.'],
        notApplicable: false,
        durationMs: 1234,
      };
    }
    return { ...row, ...outcome };
  });
  const run: ControlCheckRunBody = {
    ...base,
    state: 'finished',
    finishedAt: options.finishedAt,
    overall: overallOf(results),
    results,
  };
  state.runs = [run, ...state.runs];
  return run;
}

const CONTROL_CHECKS_WINDOW_MS = 10 * 60_000;

function advanceControlChecks(state: ControlChecksMockState): void {
  const run = state.runs[0];
  if (run?.state !== 'running' || state.advancePerRead === 0) return;
  const outcomes = localOutcomes(state.proveSwitch);
  let budget = state.advancePerRead;
  const results = run.results.map((row): ControlCheckRow => {
    if (row.status === 'running') return { ...row, ...outcomes[row.id] };
    if (row.status === 'pending' && budget > 0) {
      budget -= 1;
      return { ...row, status: 'running' };
    }
    return row;
  });
  const done = results.every((row) => row.status !== 'pending' && row.status !== 'running');
  state.runs = [
    done
      ? {
          ...run,
          results,
          state: 'finished',
          finishedAt: new Date().toISOString(),
          overall: overallOf(results),
        }
      : { ...run, results },
    ...state.runs.slice(1),
  ];
}

/** The `GET` body, without moving anything on. */
export function controlCheckRunsOf(state: ControlChecksMockState): Record<string, unknown> {
  const latest = state.runs[0];
  const opensAt =
    latest === undefined ? null : new Date(latest.startedAt).getTime() + CONTROL_CHECKS_WINDOW_MS;
  const finished = state.runs.find((run) => run.finishedAt !== null && run.overall !== null);
  return {
    runs: state.runs,
    provider: 'ollama',
    model: LOCAL_LABEL,
    cost: {
      modelCalls: 3,
      hosted: false,
      message:
        'This runs up to 3 short probes on the local model through the worker; it can take a few minutes. Nothing leaves this machine.',
    },
    nextAllowedAt:
      state.reportWindow && opensAt !== null && opensAt > Date.now()
        ? new Date(opensAt).toISOString()
        : null,
    lastProven:
      finished === undefined || finished.finishedAt === null || finished.overall === null
        ? null
        : { at: finished.finishedAt, overall: finished.overall },
  };
}

function controlChecksReply(
  state: ControlChecksMockState,
  method: 'GET' | 'POST',
  body: unknown,
  isFresh: () => boolean,
): FixtureReply {
  state.calls.push(`${method} /api/narrator/control-checks`);
  if (method === 'GET') {
    advanceControlChecks(state);
    return { status: 200, body: controlCheckRunsOf(state) };
  }
  if (!isFresh()) return STEP_UP;
  const latest = state.runs[0];
  if (latest !== undefined) {
    const left = new Date(latest.startedAt).getTime() + CONTROL_CHECKS_WINDOW_MS - Date.now();
    if (left > 0) {
      const seconds = Math.max(1, Math.ceil(left / 1000));
      return {
        ...problem(
          409,
          'narrator.control_checks_too_soon',
          `The controls were checked less than 10 minutes ago. Try again in ${String(Math.ceil(seconds / 60))} min.`,
        ),
        headers: { 'Retry-After': String(seconds) },
      };
    }
  }
  state.bodies.push(body ?? {});
  state.proveSwitch = (body as { proveSwitch?: unknown } | undefined)?.proveSwitch === true;
  state.sequence += 1;
  const run = pendingRunBody(
    `00000000-0000-4000-8000-${String(state.sequence).padStart(12, '0')}`,
    new Date().toISOString(),
  );
  state.runs = [run, ...state.runs].slice(0, 20);
  return { status: 202, body: run };
}

/**
 * A run still going, started now, moved on by `reads` reads and then held there (`advancePerRead` 0), so a sweep
 * can scan the running state - the Running badges, the live region, the unavailable button - as long as it likes.
 */
export function seedRunningControlCheckRun(state: ControlChecksMockState, reads = 2): void {
  state.sequence += 1;
  state.runs = [
    pendingRunBody(
      `00000000-0000-4000-8000-${String(state.sequence).padStart(12, '0')}`,
      new Date().toISOString(),
    ),
    ...state.runs,
  ];
  for (let n = 0; n < reads; n += 1) advanceControlChecks(state);
  state.advancePerRead = 0;
}
