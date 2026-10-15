// SPDX-License-Identifier: MIT
/**
 * Settings, Language model (WP 10.6; decision D30, which revises D22).
 *
 * Chris's request: "i want to make the LLM setup available in the setting as
 * well. ideally options include ollama/openai/openrouter/anthropic options
 * where you can bring your own api key for use."
 *
 * | Operation | Guard | What |
 * | --- | --- | --- |
 * | `GET /narrator/settings` | session | the active provider; per provider: key source (file / stored / none) and hint, model, the Ollama endpoint, the consent, ready or why not |
 * | `PUT /narrator/settings` | step-up | make a provider active (or Off). A hosted one needs a standing consent and a key; making one active revokes the narrator's payload approvals |
 * | `PUT /narrator/providers/{p}/model` | step-up | a hosted provider's model id (`null`: the default) |
 * | `PUT`/`DELETE /narrator/providers/ollama/endpoint` | step-up | a local endpoint, model name and digest, when the environment pins none |
 * | `PUT`/`DELETE /narrator/providers/{p}/consent` | step-up | give (against the current text version) or withdraw a hosted provider's consent |
 * | `PUT`/`DELETE /narrator/providers/{p}/credentials` | step-up | the holder's key (an Ollama bearer token), sealed, never returned |
 * | `POST /narrator/providers/{p}/test` | session | the fixed, personal-data-free probe; the round trip in words |
 *
 * Nothing here narrates: the api's narrator runtime is in preview mode (every
 * transport it builds rejects). The Test is the one call this file makes to a
 * provider, through `@advisor/local-model`'s hosted adapter and its one-host
 * egress policy, with `PROBE_MESSAGES` and nothing from the database. The key
 * is never returned, logged or put in an audit row; a non-empty operator file
 * wins over a stored key (409 `provider_credentials.managed_by_files`).
 */
import {
  createHostedModelAdapter,
  HOSTED_DEFAULT_MODELS,
  HOSTED_DISPLAY_NAMES,
  HOSTED_MODEL_ERROR_CODES,
  HOSTED_MODEL_HOSTS,
  HOSTED_MODEL_ID_PATTERN,
  HOSTED_PROVIDERS,
  HOSTED_TIMEOUT_CEILING_MS,
  type HostedModelKey,
  type HostedProbeResult,
  type HostedProvider,
} from '@advisor/local-model';
import { createLocalEndpointPolicy, type HttpTransport, type Resolver } from '@core/platform';
import {
  eraseCredentialKey,
  listLanguageModelKeyStatuses,
  openLanguageModelKey,
  removeProviderCredentials,
  setLanguageModelKey,
  type LanguageModelKeyProvider,
} from '@ctx/connections';
import { recordSecurityEvent } from '@ctx/identity';
import {
  findAdvisor,
  giveNarratorConsent,
  NARRATOR_MANIFEST,
  NarratorSettingsError,
  readNarratorSettings,
  registerAdvisor,
  setActiveNarratorProvider,
  setHostedNarratorModel,
  setOllamaNarratorEndpoint,
  withdrawNarratorConsent,
  type InsightsContext,
} from '@ctx/insights';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  narratorConsentSha256,
  narratorConsentText,
  NARRATOR_CONSENT_VERSION,
  NARRATOR_CONSENT_WHAT_LEAVES,
} from '../narrator-consent.ts';
import type { NarratorRuntime } from '../narrator-wiring.ts';
import { AppError, problems } from '../problem.ts';
import { contextOf as connectionsContextOf } from './connections.ts';
import type { RouteDeps } from './deps.ts';
import { mapDomainErrors } from './domain-errors.ts';

const PROVIDERS = ['ollama', 'openai', 'openrouter', 'anthropic'] as const;
type NarratorProvider = (typeof PROVIDERS)[number];
const ACTIVE = [...PROVIDERS, 'off'] as const;

/** One Test per holder per provider per this long: a hosted probe spends the holder's money. */
export const NARRATOR_TEST_MIN_INTERVAL_MS = 20_000;

/** The shortest key stored; its last four characters are then at most a quarter of it. */
const KEY_MIN = 16;

const DISPLAY: Readonly<Record<NarratorProvider, string>> = Object.freeze({
  ollama: 'Ollama (local)',
  ...HOSTED_DISPLAY_NAMES,
});

const EVENT_KIND = {
  set: 'provider_credentials.set',
  rotated: 'provider_credentials.rotated',
  removed: 'provider_credentials.removed',
  changed: 'narrator.provider_changed',
} as const;

const NOT_READY = [
  'off',
  'not_configured',
  'consent_required',
  'key_missing',
  'key_unopenable',
  'endpoint_refused',
] as const;

const providerWire = z.object({
  provider: z.enum(PROVIDERS),
  displayName: z.string(),
  kind: z.enum(['local', 'hosted']),
  /** The one host a hosted provider's adapter may reach. `null` for the local model. */
  host: z.string().nullable(),
  key: z.object({
    /** `file`: the operator's secret file (read-only here). `stored`: sealed in this install. */
    source: z.enum(['file', 'stored', 'none']),
    /** The last four characters of a stored key. Never the key. */
    hint: z.string().nullable(),
    storedAt: z.string().nullable(),
    rotatedAt: z.string().nullable(),
    /** A hosted provider needs one; Ollama's is an optional bearer token. */
    required: z.boolean(),
  }),
  model: z.object({
    /** The model in force (a hosted provider's default when none is set). */
    value: z.string().nullable(),
    default: z.string().nullable(),
    source: z.enum(['environment', 'settings', 'default', 'none']),
    /** True when the operator's environment pins it (Ollama). */
    locked: z.boolean(),
  }),
  /** Ollama only. `value` is null when the environment pins the model (the api never learns that endpoint). */
  endpoint: z
    .object({
      value: z.string().nullable(),
      digest: z.string().nullable(),
      locked: z.boolean(),
    })
    .nullable(),
  /** Hosted only: the consent this provider needs before it can be made active. */
  consent: z
    .object({
      given: z.boolean(),
      consentedAt: z.string().nullable(),
      version: z.string(),
      text: z.string(),
    })
    .nullable(),
  /** Whether this provider could narrate if it were made active now. */
  ready: z.boolean(),
  notReady: z.enum(NOT_READY).nullable(),
});

const settingsWire = z.object({
  activeProvider: z.enum(ACTIVE),
  active: z.object({
    provider: z.enum(ACTIVE),
    /** `provider:model` or the local model's `name@sha256:…`: what a run records. */
    label: z.string().nullable(),
    model: z.string().nullable(),
    ready: z.boolean(),
    notReady: z.enum(NOT_READY).nullable(),
  }),
  consentVersion: z.string(),
  /** What leaves the machine for a hosted provider, in the consent's words. */
  whatLeaves: z.string(),
  providers: z.array(providerWire),
});

const changeWire = settingsWire.extend({
  /** Standing payload approvals of the narrator revoked by this change (re-approve under the new model). */
  approvalsRevoked: z.int().nonnegative(),
});

const testWire = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().nullable(),
  outcome: z.enum([
    'ok',
    ...HOSTED_MODEL_ERROR_CODES,
    'key_missing',
    'not_configured',
    'worker_only',
  ]),
  ok: z.boolean(),
  roundTripMs: z.int().nonnegative().nullable(),
  status: z.int().nullable(),
  /** The result in words. */
  message: z.string(),
});

const hostedParams = z.object({ provider: z.enum(HOSTED_PROVIDERS) });
const anyParams = z.object({ provider: z.enum(PROVIDERS) });
const keyBody = z.object({
  key: z
    .string()
    .min(KEY_MIN)
    .max(512)
    .regex(/^[A-Za-z0-9_.:=+/-]+$/, 'a key is letters, digits and - _ . : = + / only')
    .describe('The API key (or Ollama bearer token). Sealed, and never echoed back.'),
});
const modelBody = z.object({
  model: z
    .string()
    .regex(HOSTED_MODEL_ID_PATTERN, 'not a plain vendor model id')
    .nullable()
    .describe('A vendor model id, or null for the default.'),
});
const endpointBody = z.object({
  endpoint: z.string().min(1).max(512),
  model: z.string().regex(HOSTED_MODEL_ID_PATTERN, 'not a plain model name'),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'sha256: followed by 64 lowercase hex'),
});

export interface NarratorSettingsRouteOptions {
  /** The api's preview-mode runtime: resolves the holder's narrator without ever calling it. */
  readonly runtime: NarratorRuntime;
  /** `LOCAL_MODEL_TIMEOUT_MS` and `LOCAL_MODEL_ALLOW_REMOTE`, for the Test and the endpoint check. */
  readonly timeoutMs: number;
  readonly allowRemote: boolean;
  /** The operator's non-empty secret files. */
  readonly fileKeys: Readonly<Partial<Record<HostedProvider, HostedModelKey | undefined>>>;
  /** Tests only: the Test's transport and DNS (a hermetic fake; no vendor is called in a test). */
  readonly transport?: HttpTransport;
  readonly resolve?: Resolver;
}

function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

function isHosted(provider: string): provider is HostedProvider {
  return (HOSTED_PROVIDERS as readonly string[]).includes(provider);
}

/** The result of the Test, in words. Never the provider's prose. */
export function testMessage(provider: NarratorProvider, result: HostedProbeResult): string {
  const name = DISPLAY[provider];
  const http = result.status === null ? '' : ` (HTTP ${String(result.status)})`;
  switch (result.outcome) {
    case 'ok':
      return result.replyShaped
        ? `${name} answered in ${String(result.roundTripMs)} ms with ${result.model}, in the narration's reply format. Nothing personal was sent.`
        : `${name} answered in ${String(result.roundTripMs)} ms with ${result.model}, but not in the narration's reply format; narrations would be refused. Try another model.`;
    case 'key_rejected':
      return `${name} did not accept the key${http}. Check that it is the whole key, copied from your ${name} account.`;
    case 'provider_rate_limited':
      return `${name} said the key is over its rate limit or out of credit${http}.`;
    case 'request_refused':
      return `${name} refused the request${http}: most often a model id it does not serve (${result.model}), or one that cannot return structured output.`;
    case 'model_unavailable':
      return `${name} could not be reached, or answered with a server error${http}.`;
    case 'model_timeout':
      return `${name} did not answer in time.`;
    case 'endpoint_refused':
      return `The connection to ${name} was refused by this install's egress policy (only ${isHosted(provider) ? HOSTED_MODEL_HOSTS[provider] : 'its host'} is allowed, and redirects are never followed).`;
    case 'budget_exhausted':
      return `This install's hourly window for ${name} is used up; try again later.`;
    case 'model_refused':
      return `${name}'s model declined to answer the probe.`;
    case 'model_protocol_error':
      return `${name} answered, but not in the shape it documents${http}.`;
    default:
      return `${name}: ${result.outcome}.`;
  }
}

export const narratorSettingsRoutes = (
  deps: RouteDeps,
  options: NarratorSettingsRouteOptions,
): FastifyPluginAsyncZod => {
  const { guards, database, pool, clock, config } = deps;
  const lastTest = new Map<string, number>();
  const pin = config.localModelPin;

  function insightsContext(userId: string, requestId: unknown): InsightsContext {
    return { userId, clock, correlationId: String(requestId) };
  }

  async function audit(
    kind: (typeof EVENT_KIND)[keyof typeof EVENT_KIND],
    outcome: 'success' | 'failure' | 'blocked',
    userId: string,
    detail: Record<string, unknown>,
    request: Parameters<typeof guards.contextOf>[0],
  ): Promise<void> {
    await recordSecurityEvent(pool, clock, {
      kind,
      outcome,
      userId,
      detail,
      context: guards.contextOf(request),
    });
  }

  async function settingsFor(userId: string): Promise<z.infer<typeof settingsWire>> {
    const [view, keys, resolution] = await Promise.all([
      readNarratorSettings(database, userId),
      listLanguageModelKeyStatuses(database, userId),
      options.runtime.resolve(userId),
    ]);
    const row = view.row;
    const providers = PROVIDERS.map((provider): z.infer<typeof providerWire> => {
      const stored = keys.get(provider as LanguageModelKeyProvider);
      const file = isHosted(provider) ? options.fileKeys[provider] : undefined;
      const key = {
        source:
          file !== undefined
            ? ('file' as const)
            : stored !== undefined
              ? ('stored' as const)
              : ('none' as const),
        hint: file === undefined ? (stored?.keyHint ?? null) : null,
        storedAt: file === undefined ? iso(stored?.createdAt) : null,
        rotatedAt: file === undefined ? iso(stored?.rotatedAt) : null,
        required: provider !== 'ollama',
      };
      if (provider === 'ollama') {
        const fromSettings =
          row?.ollamaEndpoint != null && row.ollamaModel != null && row.ollamaDigest != null;
        const configured = pin !== undefined || fromSettings;
        return {
          provider,
          displayName: DISPLAY[provider],
          kind: 'local',
          host: null,
          key,
          model: {
            value: pin?.name ?? row?.ollamaModel ?? null,
            default: null,
            source: pin !== undefined ? 'environment' : fromSettings ? 'settings' : 'none',
            locked: pin !== undefined,
          },
          endpoint: {
            value: pin !== undefined ? null : (row?.ollamaEndpoint ?? null),
            digest: pin?.digest ?? row?.ollamaDigest ?? null,
            locked: pin !== undefined,
          },
          consent: null,
          ready: configured,
          notReady: configured ? null : 'not_configured',
        };
      }
      const consent = view.consents.get(provider);
      const consentCurrent =
        consent !== undefined &&
        consent.consentTextVersion === NARRATOR_CONSENT_VERSION &&
        consent.consentTextSha256 === narratorConsentSha256(provider);
      const storedModel =
        provider === 'openai'
          ? (row?.openaiModel ?? null)
          : provider === 'openrouter'
            ? (row?.openrouterModel ?? null)
            : (row?.anthropicModel ?? null);
      const notReady = !consentCurrent
        ? ('consent_required' as const)
        : key.source === 'none'
          ? ('key_missing' as const)
          : null;
      return {
        provider,
        displayName: DISPLAY[provider],
        kind: 'hosted',
        host: HOSTED_MODEL_HOSTS[provider],
        key,
        model: {
          value: storedModel ?? HOSTED_DEFAULT_MODELS[provider],
          default: HOSTED_DEFAULT_MODELS[provider],
          source: storedModel === null ? 'default' : 'settings',
          locked: false,
        },
        endpoint: null,
        consent: {
          given: consentCurrent,
          consentedAt: consentCurrent ? iso(consent?.consentedAt) : null,
          version: NARRATOR_CONSENT_VERSION,
          text: narratorConsentText(provider),
        },
        ready: notReady === null,
        notReady,
      };
    });
    const activeProvider = row?.activeProvider ?? 'ollama';
    return {
      activeProvider,
      active: {
        provider: resolution.provider,
        label: resolution.narrator?.label ?? null,
        model: resolution.narrator?.modelId ?? null,
        ready: resolution.narrator !== null,
        notReady: resolution.reason,
      },
      consentVersion: NARRATOR_CONSENT_VERSION,
      whatLeaves: NARRATOR_CONSENT_WHAT_LEAVES,
      providers,
    };
  }

  function conflict(code: string, detail: string): AppError {
    return new AppError({ status: 409, code, title: 'Conflict', detail, family: 'domain' });
  }

  async function keyFor(userId: string, provider: HostedProvider): Promise<HostedModelKey | null> {
    const file = options.fileKeys[provider];
    if (file !== undefined) return file;
    const { secretBox } = deps.connections();
    const opened = await openLanguageModelKey(database, secretBox, userId, provider);
    if (opened === null || opened === 'unopenable') return null;
    return { reveal: () => opened.key() };
  }

  return async (app) => {
    app.get(
      '/narrator/settings',
      {
        schema: {
          operationId: 'getNarratorSettings',
          summary: 'Which language model narrates, and each provider’s state — never a key',
          description:
            'The active provider (`ollama`, `openai`, `openrouter`, `anthropic` or `off`) and, per ' +
            'provider: where its key comes from (the operator’s file, stored here with its last ' +
            'four characters, or none), the model in force, the local endpoint (Ollama), the ' +
            'consent a hosted provider needs and its exact text, and whether it could narrate now. ' +
            'No field can carry a key (WP 10.6).',
          tags: ['insights'],
          response: { 200: settingsWire, ...problems(401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return settingsFor(session.userId);
      },
    );

    app.put(
      '/narrator/settings',
      {
        schema: {
          operationId: 'putNarratorSettings',
          summary: 'Make a provider the narrator, or turn the narrator off',
          description:
            'Needs a step-up (D21). A hosted provider needs a standing consent to the current text ' +
            '(409 `narrator.consent_required`) and a key, by file or stored (409 ' +
            '`narrator.key_required`); Ollama needs a model pinned by the environment or set here ' +
            '(409 `narrator.not_configured`). Making a hosted provider active revokes every standing ' +
            'payload approval of the narrator: the holder re-approves the payload under the provider ' +
            'and model it will go to. `off` stops narration; the Brief keeps its own wording.',
          tags: ['insights'],
          body: z.object({ activeProvider: z.enum(ACTIVE) }),
          response: { 200: changeWire, ...problems(400, 401, 403, 409, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const provider = request.body.activeProvider;
        const view = await readNarratorSettings(database, session.userId);
        let model: string | null = null;
        if (isHosted(provider)) {
          // A file, or a stored row (opened or not: a locked box is a 503 elsewhere, not "no key").
          const hasKey =
            options.fileKeys[provider] !== undefined ||
            (await listLanguageModelKeyStatuses(database, session.userId)).has(provider);
          if (!hasKey) {
            throw conflict(
              'narrator.key_required',
              `${DISPLAY[provider]} has no key: save one (or write the operator's secret file) first.`,
            );
          }
          const storedModel =
            provider === 'openai'
              ? view.row?.openaiModel
              : provider === 'openrouter'
                ? view.row?.openrouterModel
                : view.row?.anthropicModel;
          model = storedModel ?? HOSTED_DEFAULT_MODELS[provider];
        } else if (provider === 'ollama') {
          model = pin?.name ?? view.row?.ollamaModel ?? null;
          if (model === null) {
            throw conflict(
              'narrator.not_configured',
              'No local model is configured: the operator sets LOCAL_MODEL_* (and LOCAL_MODEL_PIN_* on the api), or set an endpoint, model and digest here first.',
            );
          }
        }
        let change;
        try {
          change = await database.transaction(async (tx) => {
            const context = insightsContext(session.userId, request.id);
            const result = await setActiveNarratorProvider(tx, context, {
              provider,
              currentConsentVersion: NARRATOR_CONSENT_VERSION,
              model,
            });
            // The approval's foreign key needs the advisor's row; register it
            // off, the way the worker does, if this holder has none yet.
            if (
              provider !== 'off' &&
              (await findAdvisor(tx, session.userId, NARRATOR_MANIFEST.advisor_id)) === null
            ) {
              await registerAdvisor(tx, context, { manifest: NARRATOR_MANIFEST, enabled: false });
            }
            return result;
          });
        } catch (error) {
          if (error instanceof NarratorSettingsError) {
            await audit(
              EVENT_KIND.changed,
              'blocked',
              session.userId,
              { provider, reason: error.code },
              request,
            ).catch(() => undefined);
            throw conflict(
              'narrator.consent_required',
              `${provider === 'off' ? 'This provider' : DISPLAY[provider]} cannot narrate until you tick its consent: what leaves this machine is ${NARRATOR_CONSENT_WHAT_LEAVES}.`,
            );
          }
          throw error;
        }
        options.runtime.invalidate();
        if (change.previousProvider !== provider) {
          await audit(EVENT_KIND.changed, 'success', session.userId, { provider, model }, request);
        }
        return {
          ...(await settingsFor(session.userId)),
          approvalsRevoked: change.approvalsRevoked,
        };
      },
    );

    app.put(
      '/narrator/providers/:provider/model',
      {
        schema: {
          operationId: 'putNarratorModel',
          summary: 'Set a hosted provider’s model id (null: the default)',
          description:
            'Needs a step-up. Changing the model of the active provider revokes the narrator’s ' +
            'standing payload approvals (the approval records the model it was given for).',
          tags: ['insights'],
          params: hostedParams,
          body: modelBody,
          response: { 200: changeWire, ...problems(400, 401, 403, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const provider = request.params.provider;
        const effective = request.body.model ?? HOSTED_DEFAULT_MODELS[provider];
        const change = await database.transaction((tx) =>
          setHostedNarratorModel(tx, insightsContext(session.userId, request.id), {
            provider,
            model: request.body.model,
            effectiveModel: effective,
          }),
        );
        options.runtime.invalidate();
        if (change.row.activeProvider === provider) {
          await audit(
            EVENT_KIND.changed,
            'success',
            session.userId,
            { provider, model: effective },
            request,
          );
        }
        return {
          ...(await settingsFor(session.userId)),
          approvalsRevoked: change.approvalsRevoked,
        };
      },
    );

    app.put(
      '/narrator/providers/ollama/endpoint',
      {
        schema: {
          operationId: 'putNarratorOllamaEndpoint',
          summary:
            'Set the local model’s endpoint, name and digest (when the environment pins none)',
          description:
            'Needs a step-up. The endpoint must pass the local-endpoint policy (loopback or a ' +
            'compose-internal name; a dotted name only with LOCAL_MODEL_ALLOW_REMOTE, and then ' +
            'https) — 422 `narrator.endpoint_refused`. 409 `narrator.managed_by_environment` when ' +
            'the operator’s environment pins the local model. The worker checks the served digest ' +
            'against this one before every narration.',
          tags: ['insights'],
          body: endpointBody,
          response: { 200: changeWire, ...problems(400, 401, 403, 409, 422, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        if (pin !== undefined) {
          throw conflict(
            'narrator.managed_by_environment',
            'The local model is pinned by the operator’s environment (LOCAL_MODEL_*), which takes precedence.',
          );
        }
        try {
          createLocalEndpointPolicy({
            endpoint: request.body.endpoint,
            allowRemote: options.allowRemote,
            timeoutMs: Math.min(options.timeoutMs, HOSTED_TIMEOUT_CEILING_MS),
          });
        } catch {
          throw new AppError({
            status: 422,
            code: 'narrator.endpoint_refused',
            title: 'Unprocessable Content',
            detail:
              'The local-endpoint policy refuses this endpoint: use a loopback address or a compose-internal name (an https dotted name only when the operator sets LOCAL_MODEL_ALLOW_REMOTE). Nothing was saved.',
            family: 'user',
          });
        }
        const change = await database.transaction((tx) =>
          setOllamaNarratorEndpoint(tx, insightsContext(session.userId, request.id), request.body),
        );
        options.runtime.invalidate();
        return {
          ...(await settingsFor(session.userId)),
          approvalsRevoked: change.approvalsRevoked,
        };
      },
    );

    app.delete(
      '/narrator/providers/ollama/endpoint',
      {
        schema: {
          operationId: 'deleteNarratorOllamaEndpoint',
          summary: 'Clear the local model set in Settings',
          tags: ['insights'],
          response: { 200: changeWire, ...problems(401, 403, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const change = await database.transaction((tx) =>
          setOllamaNarratorEndpoint(tx, insightsContext(session.userId, request.id), {
            endpoint: null,
            model: null,
            digest: null,
          }),
        );
        options.runtime.invalidate();
        return {
          ...(await settingsFor(session.userId)),
          approvalsRevoked: change.approvalsRevoked,
        };
      },
    );

    app.put(
      '/narrator/providers/:provider/consent',
      {
        schema: {
          operationId: 'putNarratorConsent',
          summary: 'Consent to a hosted provider receiving the narrator’s payload',
          description:
            'Needs a step-up. Carries the consent text version the holder was shown; 409 ' +
            '`narrator.consent_version_unknown` when it is not the current one. Recorded with the ' +
            'version and the sha256 of the exact text.',
          tags: ['insights'],
          params: hostedParams,
          body: z.object({ consentVersion: z.string() }),
          response: { 200: settingsWire, ...problems(400, 401, 403, 409, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const provider = request.params.provider;
        if (request.body.consentVersion !== NARRATOR_CONSENT_VERSION) {
          throw conflict(
            'narrator.consent_version_unknown',
            'The consent text has changed since it was shown. Read it again and tick it.',
          );
        }
        await database.transaction((tx) =>
          giveNarratorConsent(tx, insightsContext(session.userId, request.id), {
            provider,
            consentTextVersion: NARRATOR_CONSENT_VERSION,
            consentTextSha256: narratorConsentSha256(provider),
          }),
        );
        options.runtime.invalidate();
        return settingsFor(session.userId);
      },
    );

    app.delete(
      '/narrator/providers/:provider/consent',
      {
        schema: {
          operationId: 'deleteNarratorConsent',
          summary: 'Withdraw a hosted provider’s consent (turns the narrator off if it is active)',
          tags: ['insights'],
          params: hostedParams,
          response: { 200: settingsWire, ...problems(401, 403, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const provider = request.params.provider;
        const result = await database.transaction((tx) =>
          withdrawNarratorConsent(tx, insightsContext(session.userId, request.id), provider),
        );
        options.runtime.invalidate();
        if (result.turnedOff) {
          await audit(
            EVENT_KIND.changed,
            'success',
            session.userId,
            { provider: 'off', model: null },
            request,
          );
        }
        return settingsFor(session.userId);
      },
    );

    app.put(
      '/narrator/providers/:provider/credentials',
      {
        schema: {
          operationId: 'putNarratorCredentials',
          summary: 'Store (or replace) this holder’s key for a language-model provider',
          description:
            'Needs a step-up (D21). Sealed under the KEK in `provider_credentials`; never returned, ' +
            'logged or exported; only its last four characters are shown. For Ollama, an optional ' +
            'bearer token. 409 `provider_credentials.managed_by_files` when the operator’s secret ' +
            'file supplies the key. The key is not checked here: the Test button is the check.',
          tags: ['insights'],
          params: anyParams,
          body: keyBody,
          response: { 200: settingsWire, ...problems(400, 401, 403, 409, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const provider = request.params.provider;
        if (isHosted(provider) && options.fileKeys[provider] !== undefined) {
          throw conflict(
            'provider_credentials.managed_by_files',
            `The ${DISPLAY[provider]} key is supplied by the operator's secret file, which takes precedence. Empty ${provider}_api_key in the secrets directory to use a stored key.`,
          );
        }
        const { secretBox } = deps.connections();
        const result = await mapDomainErrors(() =>
          database.transaction((tx) =>
            setLanguageModelKey(
              tx,
              { provider, key: request.body.key, secretBox },
              connectionsContextOf(deps, session.userId, String(request.id)),
            ),
          ),
        );
        options.runtime.invalidate();
        await audit(
          result.rotated ? EVENT_KIND.rotated : EVENT_KIND.set,
          'success',
          session.userId,
          { provider },
          request,
        );
        return settingsFor(session.userId);
      },
    );

    app.delete(
      '/narrator/providers/:provider/credentials',
      {
        schema: {
          operationId: 'deleteNarratorCredentials',
          summary: 'Remove this holder’s stored key for a language-model provider',
          description:
            'Needs a step-up. Deletes the sealed row and retires its key. Revokes nothing at the ' +
            'provider; leaves an operator’s file untouched. Idempotent. A hosted provider left ' +
            'active with no key stops narrating until one is set.',
          tags: ['insights'],
          params: anyParams,
          response: { 200: settingsWire, ...problems(401, 403, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const provider = request.params.provider;
        const { secretBox } = deps.connections();
        const removed = await mapDomainErrors(() =>
          database.transaction((tx) =>
            removeProviderCredentials(
              tx,
              { provider },
              connectionsContextOf(deps, session.userId, String(request.id)),
            ),
          ),
        );
        if (removed) {
          await eraseCredentialKey(secretBox, session.userId, provider).catch(() => undefined);
          await audit(EVENT_KIND.removed, 'success', session.userId, { provider }, request);
        }
        options.runtime.invalidate();
        return settingsFor(session.userId);
      },
    );

    app.post(
      '/narrator/providers/:provider/test',
      {
        schema: {
          operationId: 'testNarratorProvider',
          summary: 'Send the fixed, personal-data-free probe and report the round trip in words',
          description:
            'For a hosted provider: one call with `PROBE_MESSAGES` (a fixed instruction to return an ' +
            'empty narration) under the narration’s reply format, with the holder’s key and model — ' +
            'nothing from the database. Needs no consent (nothing personal is sent), and a key. ' +
            'For Ollama: the api has no route to the local model by design, so the Test checks the ' +
            'configuration and says the worker verifies the model’s digest before every narration. ' +
            'At most one per provider per 20 s: 409 `narrator.test_too_soon` with `Retry-After`.',
          tags: ['insights'],
          params: anyParams,
          response: { 200: testWire, ...problems(401, 409, 503) },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const provider = request.params.provider;
        const slot = `${session.userId}:${provider}`;
        const now = clock.now().getTime();
        const last = lastTest.get(slot);
        if (last !== undefined && now - last < NARRATOR_TEST_MIN_INTERVAL_MS) {
          const seconds = Math.max(
            1,
            Math.ceil((last + NARRATOR_TEST_MIN_INTERVAL_MS - now) / 1000),
          );
          void reply.header('retry-after', String(seconds));
          throw conflict('narrator.test_too_soon', `Try again in ${String(seconds)} s.`);
        }
        lastTest.set(slot, now);
        const view = await readNarratorSettings(database, session.userId);
        if (!isHosted(provider)) {
          const name = pin?.name ?? view.row?.ollamaModel ?? null;
          if (name === null) {
            return {
              provider,
              model: null,
              outcome: 'not_configured' as const,
              ok: false,
              roundTripMs: null,
              status: null,
              message:
                'No local model is configured: the operator’s environment pins none, and none is set here.',
            };
          }
          return {
            provider,
            model: name,
            outcome: 'worker_only' as const,
            ok: true,
            roundTripMs: null,
            status: null,
            message:
              `The local model ${name} is configured. Only the worker can reach it, over its internal ` +
              'network — this server has no route to it by design — and the worker checks the served ' +
              'model’s digest before every narration.',
          };
        }
        const key = await keyFor(session.userId, provider).catch(() => null);
        const storedModel =
          provider === 'openai'
            ? view.row?.openaiModel
            : provider === 'openrouter'
              ? view.row?.openrouterModel
              : view.row?.anthropicModel;
        const model = storedModel ?? HOSTED_DEFAULT_MODELS[provider];
        if (key === null) {
          return {
            provider,
            model,
            outcome: 'key_missing' as const,
            ok: false,
            roundTripMs: null,
            status: null,
            message: `${DISPLAY[provider]} has no key yet. Save one first.`,
          };
        }
        // The same window the api's runtime keeps per provider: a Test spends against it.
        const budget = options.runtime.budgets.get(provider);
        const adapter = createHostedModelAdapter(
          {
            provider,
            model,
            timeoutMs: Math.min(options.timeoutMs, HOSTED_TIMEOUT_CEILING_MS),
            key,
          },
          {
            clock,
            logger: app.log,
            ...(budget === undefined ? {} : { budget }),
            ...(options.transport === undefined ? {} : { transport: options.transport }),
            ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
          },
        );
        const result = await adapter.probe(new AbortController().signal);
        return {
          provider,
          model,
          outcome: result.outcome,
          ok: result.outcome === 'ok' && result.replyShaped,
          roundTripMs: result.roundTripMs,
          status: result.status,
          message: testMessage(provider, result),
        };
      },
    );
  };
};
