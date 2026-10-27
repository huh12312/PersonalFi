// SPDX-License-Identifier: MIT
/**
 * `/categories/suggestions/*` — Settings → Language model → Category
 * suggestions (WP 11.2), and the Inbox's "Not this".
 *
 * The api never calls a model. It reads the gate, shows the payload, records
 * the approval, the model choice, the hosted consent and the Enable switch,
 * and enqueues the measurement for the worker. **Enable is refused below the
 * gate** — the latest completed measurement for the chosen model must show
 * ≥ 85 % precision over ≥ 20 scored rows (`gateOf`) — and the worker checks
 * the gate again on every batch, so this route is one lock of two.
 */
import { isUuid } from '@core/kernel';
import {
  SUGGESTION_GATE,
  SUGGESTION_MODEL_CHOICES,
  gateOf,
  latestSuggestionEval,
  listResidueForSuggestion,
  readSuggestionSettings,
  rejectSuggestion,
  suggestionTaxonomy,
  writeSuggestionSettings,
  type CategorizationExecutor,
  type SuggestionEval,
  type SuggestionModelChoice,
} from '@ctx/categorization';
import {
  CATEGORY_SUGGEST_ADVISOR_ID,
  PreviewError,
  SUGGEST_BATCH_MAX,
  approveCategorySuggest,
  categorySuggestShape,
  ensureCategorySuggestAdvisor,
  findAdvisor,
  hasLiveApproval,
  liveCategorySuggestApprovals,
  previewCategorySuggest,
  setCategorySuggestEnabled,
} from '@ctx/insights';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  SUGGEST_HOSTED_CONSENT_TEXT,
  enqueueMeasurement,
  hostedSuggestionConsented,
  suggestHostedConsentSha256,
  type SuggestionRuntime,
} from '../category-suggestions.ts';
import { createCategorizationLedgerPort } from '../domain.ts';
import { AppError, problems } from '../problem.ts';
import { isoInstant } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

const choiceSchema = z.enum(SUGGESTION_MODEL_CHOICES);

const evalSchema = z
  .object({
    id: z.uuid(),
    modelChoice: choiceSchema,
    model: z.string(),
    modelDigest: z.string().nullable(),
    status: z.enum(['completed', 'failed']),
    failure: z.string().nullable(),
    goldTotal: z.int().nonnegative(),
    residue: z.int().nonnegative(),
    asked: z.int().nonnegative(),
    scored: z.int().nonnegative(),
    correct: z.int().nonnegative(),
    abstained: z.int().nonnegative(),
    refused: z.int().nonnegative(),
    precision: z.number().nullable(),
    coverage: z.number().nullable(),
    confusions: z.array(
      z.object({ expected: z.string(), got: z.string(), count: z.int().positive() }),
    ),
    measuredAt: isoInstant,
  })
  .meta({ id: 'CategorySuggestionEval' });

const gateReasonSchema = z.enum([
  'not_measured',
  'measurement_failed',
  'too_few_rows',
  'below_precision',
]);

const settingsSchema = z
  .object({
    state: z
      .enum(['no_model', 'not_measured', 'below_gate', 'ready', 'on'])
      .describe(
        '`no_model`: nothing can answer for the chosen model. `not_measured` / `below_gate`: off, ' +
          'and Enable is refused. `ready`: the gate is open and the switch is off. `on`.',
      ),
    enabled: z.boolean(),
    gate: z.object({
      open: z.boolean(),
      reason: gateReasonSchema.nullable(),
      minPrecision: z.number(),
      minScored: z.int(),
    }),
    modelChoice: choiceSchema,
    models: z.array(
      z.object({
        choice: choiceSchema,
        label: z.string().nullable(),
        provider: z.string().nullable(),
        available: z.boolean(),
        unavailableReason: z.string().nullable(),
        latest: evalSchema.nullable(),
      }),
    ),
    approval: z.object({
      queryShape: z.string().nullable(),
      approved: z.boolean(),
      live: z.int().nonnegative(),
    }),
    hosted: z.object({
      /** The chosen model would be a hosted provider (the narrator is on one). */
      applies: z.boolean(),
      consented: z.boolean(),
      consentText: z.string(),
      consentTextSha256: z.string(),
    }),
  })
  .meta({ id: 'CategorySuggestionSettings' });

const previewSchema = z
  .object({
    advisorId: z.string(),
    advisorVersion: z.string(),
    queryShape: z.string(),
    scopes: z.array(z.string()),
    promptTemplateHash: z.string(),
    provider: z.string(),
    model: z.string(),
    payload: z.record(z.string(), z.unknown()),
    prompt: z.object({ text: z.string(), hash: z.string() }),
    approved: z.boolean(),
  })
  .meta({ id: 'CategorySuggestionPreview' });

function evalWire(row: SuggestionEval | null) {
  if (row === null) return null;
  return {
    id: row.id,
    modelChoice: row.modelChoice,
    model: row.model,
    modelDigest: row.modelDigest,
    status: row.status,
    failure: row.failure,
    goldTotal: row.goldTotal,
    residue: row.residue,
    asked: row.asked,
    scored: row.scored,
    correct: row.correct,
    abstained: row.abstained,
    refused: row.refused,
    precision: row.precision,
    coverage: row.coverage,
    confusions: row.confusions.map((pair) => ({ ...pair })),
    measuredAt: row.measuredAt.toISOString(),
  };
}

export const categorySuggestionRoutes = (
  deps: RouteDeps,
  options: { readonly runtime: SuggestionRuntime },
): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;
  const executor = database as unknown as CategorizationExecutor;

  function contextOf(userId: string, requestId: string) {
    return { userId, clock, correlationId: requestId };
  }

  async function settingsView(userId: string) {
    const settings = await readSuggestionSettings(executor, userId);
    const advisor = await findAdvisor(database, userId, CATEGORY_SUGGEST_ADVISOR_ID);
    const models = [];
    for (const choice of SUGGESTION_MODEL_CHOICES) {
      const resolution = await options.runtime.resolve(userId, choice);
      models.push({
        choice,
        label: resolution.label,
        provider: resolution.provider,
        available: resolution.adapter !== null,
        unavailableReason: resolution.reason,
        latest: evalWire(await latestSuggestionEval(executor, userId, choice)),
      });
    }
    const chosen = models.find((model) => model.choice === settings.modelChoice);
    const latest = await latestSuggestionEval(executor, userId, settings.modelChoice);
    const gate = gateOf(latest);
    const resolution = await options.runtime.resolve(userId, settings.modelChoice);
    const enabled = advisor?.enabled ?? false;
    const state =
      chosen === undefined || !chosen.available
        ? 'no_model'
        : !gate.open
          ? gate.reason === 'not_measured'
            ? 'not_measured'
            : 'below_gate'
          : enabled
            ? 'on'
            : 'ready';
    const shape =
      resolution.adapter === null ? null : categorySuggestShape(resolution.adapter.templateHash);
    return {
      settings,
      body: {
        state,
        enabled,
        gate: {
          open: gate.open,
          reason: gate.open ? null : gate.reason,
          minPrecision: SUGGESTION_GATE.minPrecision,
          minScored: SUGGESTION_GATE.minScored,
        },
        modelChoice: settings.modelChoice,
        models,
        approval: {
          queryShape: shape,
          approved:
            shape !== null &&
            (await previewApproved(userId, resolution.adapter?.templateHash ?? null)),
          live: await liveCategorySuggestApprovals(database, userId),
        },
        hosted: {
          applies: resolution.provider !== null && resolution.provider !== 'ollama',
          consented: hostedSuggestionConsented(settings),
          consentText: SUGGEST_HOSTED_CONSENT_TEXT,
          consentTextSha256: suggestHostedConsentSha256(),
        },
      } as const,
    };
  }

  async function previewApproved(userId: string, templateHash: string | null): Promise<boolean> {
    if (templateHash === null) return false;
    return hasLiveApproval(
      database,
      userId,
      CATEGORY_SUGGEST_ADVISOR_ID,
      categorySuggestShape(templateHash),
    );
  }

  async function rendererFor(userId: string) {
    const resolution = await options.runtime.resolve(userId);
    if (resolution.adapter === null) {
      throw new AppError({
        status: 503,
        code: 'categorization.suggestion_model_unavailable',
        title: 'Service Unavailable',
        detail: `No model can suggest categories for you (${resolution.reason ?? 'not_configured'}).`,
        family: 'connector',
      });
    }
    return resolution.adapter;
  }

  return async (app) => {
    app.get(
      '/categories/suggestions/settings',
      {
        schema: {
          operationId: 'getCategorySuggestionSettings',
          summary: 'Category suggestions: the gate, the models, the approval and the switch',
          tags: ['categories'],
          response: { 200: settingsSchema, ...problems(401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return (await settingsView(session.userId)).body;
      },
    );

    app.put(
      '/categories/suggestions/settings',
      {
        schema: {
          operationId: 'setCategorySuggestionModel',
          summary: 'Choose which pinned local model suggests categories',
          description:
            'Changing the model does not carry a measurement over: the gate reads the latest ' +
            'measurement of the model now chosen.',
          tags: ['categories'],
          body: z.object({ modelChoice: choiceSchema }),
          response: { 200: settingsSchema, ...problems(400, 401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        await writeSuggestionSettings(executor, contextOf(session.userId, String(request.id)), {
          modelChoice: request.body.modelChoice,
        });
        return (await settingsView(session.userId)).body;
      },
    );

    app.put(
      '/categories/suggestions/hosted-consent',
      {
        schema: {
          operationId: 'setCategorySuggestionHostedConsent',
          summary: 'The separate consent for suggestions on a hosted provider (off by default)',
          description:
            'D22: categorisation runs on the local model unless this is given. Consenting names ' +
            'the exact text (its sha256); a reworded consent is not covered by an old tick.',
          tags: ['categories'],
          body: z.object({ consent: z.boolean(), consentTextSha256: z.string().optional() }),
          response: { 200: settingsSchema, ...problems(400, 401, 409, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        if (
          request.body.consent &&
          request.body.consentTextSha256 !== suggestHostedConsentSha256()
        ) {
          throw new AppError({
            status: 409,
            code: 'categorization.consent_text_changed',
            title: 'Conflict',
            detail: 'The consent text changed since it was shown. Read it again before consenting.',
            family: 'domain',
          });
        }
        await writeSuggestionSettings(executor, contextOf(session.userId, String(request.id)), {
          hostedConsentTextHash: request.body.consent ? suggestHostedConsentSha256() : null,
        });
        return (await settingsView(session.userId)).body;
      },
    );

    app.get(
      '/categories/suggestions/preview',
      {
        schema: {
          operationId: 'previewCategorySuggestionPayload',
          summary: 'The exact payload and prompt a suggestion run would send now',
          description: 'Invokes nothing. At most one batch of the current residue.',
          tags: ['categories'],
          response: { 200: previewSchema, ...problems(401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const renderer = await rendererFor(session.userId);
        const taxonomy = await suggestionTaxonomy(executor, session.userId);
        const residue = await listResidueForSuggestion(
          executor,
          createCategorizationLedgerPort(database, clock),
          session.userId,
          taxonomy.version,
        );
        const preview = await previewCategorySuggest(
          database,
          contextOf(session.userId, String(request.id)),
          {
            renderer,
            taxonomy: taxonomy.categories.map((entry) => ({ key: entry.key, label: entry.label })),
            rows: residue.misses.slice(0, SUGGEST_BATCH_MAX).map((merchant) => merchant.features),
          },
        );
        return {
          ...preview,
          scopes: [...preview.scopes],
          payload: preview.payload as unknown as Record<string, unknown>,
        };
      },
    );

    app.post(
      '/categories/suggestions/approve',
      {
        schema: {
          operationId: 'approveCategorySuggestionPayload',
          summary: 'Approve the payload shape the preview showed',
          description: '409 `insights.shape_changed` when the shape moved since the preview.',
          tags: ['categories'],
          body: z.object({ queryShape: z.string().min(1).max(128) }),
          response: {
            200: z.object({ approvalId: z.uuid(), queryShape: z.string() }),
            ...problems(400, 401, 409, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const renderer = await rendererFor(session.userId);
        try {
          return await approveCategorySuggest(
            database,
            contextOf(session.userId, String(request.id)),
            { renderer, queryShape: request.body.queryShape },
          );
        } catch (error) {
          if (error instanceof PreviewError && error.code === 'shape_changed') {
            throw new AppError({
              status: 409,
              code: 'insights.shape_changed',
              title: 'Conflict',
              detail: error.message,
              family: 'domain',
            });
          }
          throw error;
        }
      },
    );

    app.post(
      '/categories/suggestions/measure',
      {
        schema: {
          operationId: 'measureCategorySuggestions',
          summary: 'Measure the chosen model on your own history (runs in the worker)',
          description:
            'The gold-set replay with the model as a seventh tier on the residue the six tiers ' +
            'abstain on, scored against your picks. Writes one result row and nothing else. 202; ' +
            'read the result from the settings.',
          tags: ['categories'],
          body: z.object({ modelChoice: choiceSchema.optional() }),
          response: {
            202: z.object({ jobId: z.uuid(), deduped: z.boolean(), modelChoice: choiceSchema }),
            ...problems(401, 503),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireFreshSession(request);
        const settings = await readSuggestionSettings(executor, session.userId);
        const modelChoice: SuggestionModelChoice = request.body.modelChoice ?? settings.modelChoice;
        const queued = await enqueueMeasurement(database, {
          userId: session.userId,
          modelChoice,
          correlationId: String(request.id),
          clock,
        });
        return reply.code(202).send({ ...queued, modelChoice });
      },
    );

    app.post(
      '/categories/suggestions/enabled',
      {
        schema: {
          operationId: 'setCategorySuggestionsEnabled',
          summary: 'Turn category suggestions on or off (refused below the precision gate)',
          description:
            '409 `categorization.suggestions_below_gate` when the latest measurement of the chosen ' +
            'model is below 85 % precision or has fewer than 20 scored rows; 409 ' +
            '`categorization.suggestion_model_unavailable` when nothing can answer. Turning off is ' +
            'always allowed.',
          tags: ['categories'],
          body: z.object({ enabled: z.boolean() }),
          response: { 200: settingsSchema, ...problems(400, 401, 403, 409, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const context = contextOf(session.userId, String(request.id));
        if (request.body.enabled) {
          const view = await settingsView(session.userId);
          if (view.body.state === 'no_model') {
            throw new AppError({
              status: 409,
              code: 'categorization.suggestion_model_unavailable',
              title: 'Conflict',
              detail:
                'No model can suggest categories for you, so suggestions cannot be turned on.',
              family: 'domain',
            });
          }
          if (!view.body.gate.open) {
            const latest = view.body.models.find(
              (model) => model.choice === view.body.modelChoice,
            )?.latest;
            const figure =
              latest?.precision === null || latest?.precision === undefined
                ? 'not measured yet'
                : `${String(Math.round(latest.precision * 100))} % on ${String(latest.scored)} rows`;
            throw new AppError({
              status: 409,
              code: 'categorization.suggestions_below_gate',
              title: 'Conflict',
              detail: `Suggestions stay off below ${String(Math.round(SUGGESTION_GATE.minPrecision * 100))} % precision over at least ${String(SUGGESTION_GATE.minScored)} rows of your own history (${figure}).`,
              family: 'domain',
            });
          }
        }
        await ensureCategorySuggestAdvisor(database, context);
        await setCategorySuggestEnabled(database, context, request.body.enabled, {
          stepUpSessionId: session.id,
        });
        return (await settingsView(session.userId)).body;
      },
    );

    app.post(
      '/transactions/:transactionId/suggestion/reject',
      {
        schema: {
          operationId: 'rejectCategorySuggestion',
          summary: '"Not this": record that the suggested category is wrong for this merchant',
          description:
            'Clears the chip on this merchant’s uncategorised rows and stops the cached suggestion ' +
            'from being shown again. Assigns nothing; the classifier is not touched.',
          tags: ['transactions'],
          params: z.object({ transactionId: z.uuid() }),
          response: {
            200: z.object({ outcome: z.enum(['rejected', 'no_suggestion']) }),
            ...problems(400, 401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        if (!isUuid(request.params.transactionId)) {
          return { outcome: 'no_suggestion' as const };
        }
        const outcome = await rejectSuggestion(
          database,
          createCategorizationLedgerPort(database, clock),
          { transactionId: request.params.transactionId },
          contextOf(session.userId, String(request.id)),
        );
        return { outcome };
      },
    );
  };
};
