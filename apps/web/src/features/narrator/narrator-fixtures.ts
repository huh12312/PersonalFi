// SPDX-License-Identifier: MIT
/**
 * A stand-in for `apps/api/src/routes/narrator-settings.ts` with real state, for the unit tests (WP 10.6). It
 * answers in the api's shapes and with its rules: every write but Test needs a fresh step-up; a hosted provider
 * can be made active only with a standing consent and a key; making a provider active (or changing the active
 * one's model) revokes the narrator's standing payload approvals; withdrawing the active provider's consent turns
 * the narrator off; the operator's file wins over a stored key; a key is never in any response, only its last
 * four characters. `e2e/support/mock-narrator.ts` is the same machine for Playwright.
 */
import type { NarratorChoice, NarratorProvider, NarratorSettings } from './narrator-api.ts';

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

export interface NarratorFixtureState {
  activeProvider: NarratorChoice;
  keys: Record<NarratorProvider, FixtureKey>;
  models: Record<Hosted, string | null>;
  consents: Record<Hosted, string | null>;
  ollama: { pinned: boolean; endpoint: string | null; model: string | null; digest: string | null };
  /** Standing payload approvals of the narrator; a switch revokes them. */
  approvals: number;
  fresh: boolean;
  /** `METHOD path` of every call, in order. */
  calls: string[];
  /** Every `PUT .../credentials` body that arrived after a step-up. */
  keyBodies: unknown[];
  /** Tests per provider, for the 20 s 409. */
  tests: Record<string, number>;
  stepUps: number;
}

export const PINNED_MODEL = 'qwen2.5:7b-instruct-q4_K_M';
export const PINNED_DIGEST = `sha256:${'3f'.repeat(32)}`;

const NONE: FixtureKey = { source: 'none', hint: null, storedAt: null, rotatedAt: null };

export function initialNarratorState(
  overrides: Partial<NarratorFixtureState> = {},
): NarratorFixtureState {
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
    fresh: false,
    calls: [],
    keyBodies: [],
    tests: {},
    stepUps: 0,
    ...overrides,
  };
}

function providerState(state: NarratorFixtureState, provider: NarratorProvider) {
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

export function settingsOf(state: NarratorFixtureState): NarratorSettings {
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
      notReady: choice === 'off' ? 'off' : (active?.notReady ?? null),
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
export function narratorReply(
  state: NarratorFixtureState,
  method: string,
  path: string,
  body: unknown,
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

  if (!state.fresh) return STEP_UP;
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
