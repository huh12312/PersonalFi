// SPDX-License-Identifier: MIT
/**
 * WP 11.2: category suggestions for the abstained residue — the composition
 * root's half. `@ctx/categorization` owns the residue, the cache, where a
 * suggestion lands and the precision gate; `@ctx/insights` owns
 * `categorize.suggest`'s kill ladder, approval, run row and validator;
 * `@advisor/local-model` owns the prompt and the call. Contexts never import
 * each other, so this file joins them:
 *
 *   * `createSuggestionRuntime` — which model suggests for a holder, resolved
 *     through the narrator runtime's per-holder view (`resolve(userId)`: the
 *     provider they chose, its consent and key) and the same stores, with one
 *     rule added: **a hosted provider only under the separate suggestion
 *     consent** (D22; its text says merchant names leave this machine; no row
 *     means unticked). The local endpoint, digest pin, timeout ceiling and
 *     abort are the narrator's own; the model is the narrator's pinned one or
 *     the second pin `LOCAL_MODEL_CLASSIFIER_*`, as the holder chose.
 *   * `createCategorySuggestJob` — `categorization.suggest`, in the worker,
 *     after a sync's categorisation pass left new residue: cache hits applied,
 *     misses asked in batches, answers recorded on the abstention rows. Never
 *     in the request path; never blocking the ledger (its own job, concurrency
 *     1, after the pass committed).
 *   * `createCategorySuggestMeasureJob` — Settings' "Measure": the gold-set
 *     replay with the model as a seventh tier on the residue, scored against
 *     the holder's picks, one result row and no other write.
 */
import {
  createHostedSuggestionAdapter,
  createLocalSuggestionAdapter,
  HOSTED_DEFAULT_MODELS,
  HOSTED_TIMEOUT_CEILING_MS,
  type HostedProvider,
  type LocalModelLogger,
  type LocalModelTransport,
  type SuggestionModelAdapter,
} from '@advisor/local-model';
import type { Database } from '@core/db';
import { newId, systemClock, type Clock } from '@core/kernel';
import {
  configHash,
  defineJob,
  enqueueJob,
  platformExecutor,
  type HttpTransport,
  type JobHandlerRegistration,
  type Resolver,
} from '@core/platform';
import {
  SUGGEST_JOB_KIND,
  SUGGEST_MEASURE_JOB_KIND,
  applyCachedSuggestions,
  emptyFigures,
  gateOf,
  latestSuggestionEval,
  listResidueForSuggestion,
  loadGoldSet,
  measurementResidue,
  readSuggestionSettings,
  recordSuggestionEval,
  recordSuggestions,
  scoreMeasurement,
  suggestionTaxonomy,
  type CategorizationExecutor,
  type MeasuredAnswer,
  type MerchantAnswer,
  type ResidueRecorded,
  type SuggestionModelChoice,
  type SuggestionSettings,
} from '@ctx/categorization';
import {
  CATEGORY_SUGGEST_ADVISOR_ID,
  ensureCategorySuggestAdvisor,
  findAdvisor,
  measureCategorySuggest,
  runCategorySuggest,
  type RunSwitches,
  type SuggestAnswer,
  type SuggestionModelPort,
} from '@ctx/insights';
import { createCategorizationLedgerPort } from './domain.ts';
import type { NarratorRuntime, NarratorStores } from './narrator-wiring.ts';

// ---------------------------------------------------------------------------
// The separate hosted consent (D22, 11 §6 item 1)
// ---------------------------------------------------------------------------

export const SUGGEST_HOSTED_CONSENT_VERSION = 'category-suggestions-hosted/1';

/** The exact words a holder ticks. Shipped unticked; consenting stores the sha256 of these bytes. */
export const SUGGEST_HOSTED_CONSENT_TEXT =
  'Category suggestions on a hosted provider: merchant names leave this machine. For every ' +
  'uncategorised merchant, its payee words, the kind of card or account, the direction, an amount ' +
  'band and the part of the month are sent to the hosted provider you chose for the narrator, ' +
  'under your key. Nothing is filed until you tap Confirm. Withdraw this at any time; suggestions ' +
  'then run on the local model only, or not at all.';

export function suggestHostedConsentSha256(): string {
  return `sha256:${configHash({
    version: SUGGEST_HOSTED_CONSENT_VERSION,
    text: SUGGEST_HOSTED_CONSENT_TEXT,
  })}`;
}

/** Whether the stored consent covers today's text, byte for byte. */
export function hostedSuggestionConsented(settings: SuggestionSettings): boolean {
  return (
    settings.hostedConsentedAt !== null &&
    settings.hostedConsentTextHash === suggestHostedConsentSha256()
  );
}

// ---------------------------------------------------------------------------
// Which model suggests for a holder
// ---------------------------------------------------------------------------

export type SuggestionUnavailableReason =
  | 'off'
  | 'not_configured'
  | 'classifier_not_configured'
  | 'hosted_consent_required'
  | 'consent_required'
  | 'key_missing'
  | 'key_unopenable'
  | 'endpoint_refused';

export interface SuggestionResolution {
  readonly choice: SuggestionModelChoice;
  readonly adapter: SuggestionModelAdapter | null;
  readonly reason: SuggestionUnavailableReason | null;
  /** `name@sha256:…` or `provider:model` of the model that would answer, when known. */
  readonly label: string | null;
  /** The pinned digest of a local model; `null` for hosted. */
  readonly digest: string | null;
  readonly provider: 'ollama' | HostedProvider | null;
}

export interface SuggestionRuntime {
  /** For the holder's chosen model, or `choice` when given (the Settings card reports both). */
  resolve(userId: string, choice?: SuggestionModelChoice): Promise<SuggestionResolution>;
}

export interface SuggestionRuntimeOptions {
  readonly mode: 'run' | 'preview';
  readonly database: Database;
  readonly narrator: Pick<NarratorRuntime, 'resolve'>;
  readonly stores: NarratorStores;
  /** The worker's `config.localModel` (endpoint, name, digest); `undefined` in the api. */
  readonly localModel:
    { readonly endpoint: string; readonly name: string; readonly digest: string } | undefined;
  /** `config.localModelClassifier`: the second pin. */
  readonly classifier: { readonly name: string; readonly digest: string } | undefined;
  readonly timeoutMs: number;
  readonly allowRemote: boolean;
  /** The operator's non-empty key files (a file wins over a stored key, as for the narrator). */
  readonly fileKeys: Readonly<Partial<Record<HostedProvider, { reveal(): string } | undefined>>>;
  readonly logger?: LocalModelLogger;
  readonly clock?: Clock;
  /** Tests only. */
  readonly localTransport?: LocalModelTransport;
  readonly hostedTransport?: HttpTransport;
  readonly resolveHost?: Resolver;
}

const PREVIEW_ONLY_LOCAL: LocalModelTransport = Object.freeze({
  request: () =>
    Promise.reject(
      new Error('the api process holds no model endpoint: it renders and previews, it never calls'),
    ),
});
const PREVIEW_ONLY_HOSTED: HttpTransport = () =>
  Promise.reject(new Error('the api process never calls a hosted model'));

export function createSuggestionRuntime(options: SuggestionRuntimeOptions): SuggestionRuntime {
  const preview = options.mode === 'preview';

  function local(
    userId: string,
    choice: SuggestionModelChoice,
    config: { readonly endpoint: string; readonly name: string; readonly digest: string },
    bearer: { reveal(): string } | null,
  ): SuggestionResolution {
    try {
      const transport = preview ? PREVIEW_ONLY_LOCAL : options.localTransport;
      const adapter = createLocalSuggestionAdapter(
        {
          endpoint: preview ? '' : config.endpoint,
          name: config.name,
          digest: config.digest,
          timeoutMs: preview ? 1_000 : options.timeoutMs,
          allowRemote: options.allowRemote,
        },
        {
          ...(transport === undefined ? {} : { transport }),
          ...(options.logger === undefined ? {} : { logger: options.logger }),
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          ...(bearer === null ? {} : { bearer }),
        },
      );
      return {
        choice,
        adapter,
        reason: null,
        label: adapter.label,
        digest: config.digest,
        provider: 'ollama',
      };
    } catch {
      options.logger?.warn(
        { event: 'category_suggest.endpoint_refused', userId },
        'the local endpoint for category suggestions is refused by the local-endpoint policy',
      );
      return {
        choice,
        adapter: null,
        reason: 'endpoint_refused',
        label: null,
        digest: null,
        provider: 'ollama',
      };
    }
  }

  async function resolve(
    userId: string,
    requested?: SuggestionModelChoice,
  ): Promise<SuggestionResolution> {
    const settings = await readSuggestionSettings(
      options.database as unknown as CategorizationExecutor,
      userId,
    );
    const choice = requested ?? settings.modelChoice;
    const none = (
      reason: SuggestionUnavailableReason,
      provider: SuggestionResolution['provider'] = null,
    ): SuggestionResolution => ({
      choice,
      adapter: null,
      reason,
      label: null,
      digest: null,
      provider,
    });
    const narrator = await options.narrator.resolve(userId);
    const stored = await options.stores.settings(userId);
    const endpoint = options.localModel?.endpoint ?? stored.ollama?.endpoint ?? null;

    if (choice === 'classifier') {
      // The second pin runs on the local model only, on the narrator's endpoint.
      if (options.classifier === undefined) return none('classifier_not_configured', 'ollama');
      if (endpoint === null && !preview) return none('not_configured', 'ollama');
      const token = await options.stores.storedKey(userId, 'ollama');
      if (token === 'unopenable') return none('key_unopenable', 'ollama');
      return local(userId, choice, { endpoint: endpoint ?? '', ...options.classifier }, token);
    }

    // The narrator's model: whatever the holder's narrator resolves to.
    if (narrator.provider === 'off') return none('off');
    if (narrator.narrator === null) {
      const reason = narrator.reason ?? 'not_configured';
      return none(
        reason === 'off' ? 'off' : reason,
        narrator.provider === 'ollama' ? 'ollama' : narrator.provider,
      );
    }
    if (narrator.provider === 'ollama') {
      // The environment wins over Settings, as for the narrator. In the api the
      // environment carries only the pin, and the narrator's label is
      // `name@sha256:digest` — exactly what rendering and approving need.
      const configured: {
        readonly endpoint: string;
        readonly name: string;
        readonly digest: string;
      } | null = options.localModel ?? stored.ollama;
      const pinned =
        configured ??
        (() => {
          const pin = pinOfLabel(narrator.narrator.label);
          return pin === null ? null : { endpoint: endpoint ?? '', ...pin };
        })();
      if (pinned === null) return none('not_configured', 'ollama');
      const token = await options.stores.storedKey(userId, 'ollama');
      if (token === 'unopenable') return none('key_unopenable', 'ollama');
      return local(
        userId,
        choice,
        {
          endpoint: pinned.endpoint,
          name: pinned.name,
          digest: pinned.digest,
        },
        token,
      );
    }

    // A hosted narrator. D22: never for categorisation without the separate consent.
    const provider = narrator.provider;
    if (!hostedSuggestionConsented(settings)) return none('hosted_consent_required', provider);
    if (!stored.consented.has(provider)) return none('consent_required', provider);
    const file = options.fileKeys[provider];
    let key: { reveal(): string } | null = file ?? null;
    if (key === null) {
      const storedKey = await options.stores.storedKey(userId, provider);
      if (storedKey === 'unopenable') return none('key_unopenable', provider);
      key = storedKey;
    }
    if (key === null) return none('key_missing', provider);
    const model = stored.models[provider] ?? HOSTED_DEFAULT_MODELS[provider];
    const adapter = createHostedSuggestionAdapter(
      {
        provider,
        model,
        timeoutMs: Math.min(options.timeoutMs, HOSTED_TIMEOUT_CEILING_MS),
        key,
      },
      {
        ...(preview
          ? { transport: PREVIEW_ONLY_HOSTED }
          : options.hostedTransport === undefined
            ? {}
            : { transport: options.hostedTransport }),
        ...(options.resolveHost === undefined ? {} : { resolve: options.resolveHost }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
    );
    return { choice, adapter, reason: null, label: adapter.label, digest: null, provider };
  }

  return Object.freeze({ resolve });
}

/** `name@sha256:<64 hex>` → its parts; `null` for anything else. */
function pinOfLabel(label: string): { readonly name: string; readonly digest: string } | null {
  const at = label.lastIndexOf('@sha256:');
  if (at <= 0) return null;
  return { name: label.slice(0, at), digest: label.slice(at + 1) };
}

// ---------------------------------------------------------------------------
// The jobs
// ---------------------------------------------------------------------------

/**
 * Rows per request. The ceiling is fifty (`SUGGEST_BATCH_MAX`); fifteen is
 * what fits the local model's reply budget — `num_predict` 1024 tokens, about
 * fifty tokens a suggestion with its reason — so a full batch is never cut
 * mid-reply (the adapter's own measurement, recorded in the evidence).
 */
export const SUGGEST_BATCH_ROWS = 15;
/** At most this many batches per job; a larger residue is finished by the next job. */
export const SUGGEST_BATCHES_PER_JOB = 20;

export interface CategorySuggestJobDependencies {
  readonly database: Database;
  readonly runtime: SuggestionRuntime;
  readonly switches: RunSwitches;
  readonly clock?: Clock;
  /** Tests only. */
  readonly runWatchPollMs?: number;
}

function answerToMerchant(
  answer: SuggestAnswer,
  merchant: { readonly merchantKey: string; readonly transactionIds: readonly string[] },
  idByKey: ReadonlyMap<string, string>,
): MerchantAnswer {
  if (answer.verdict === 'suggested') {
    const categoryId = idByKey.get(answer.categoryKey);
    if (categoryId !== undefined) {
      return {
        merchantKey: merchant.merchantKey,
        transactionIds: merchant.transactionIds,
        verdict: 'suggested',
        categoryId,
        reason: answer.reason,
        refusal: null,
      };
    }
    // Validated against the keys this request sent; a key with no id now is a
    // category archived in between. Refused, never shown.
    return {
      merchantKey: merchant.merchantKey,
      transactionIds: merchant.transactionIds,
      verdict: 'refused',
      categoryId: null,
      reason: null,
      refusal: 'unknown_category',
    };
  }
  if (answer.verdict === 'abstained') {
    return {
      merchantKey: merchant.merchantKey,
      transactionIds: merchant.transactionIds,
      verdict: 'abstained',
      categoryId: null,
      reason: null,
      refusal: null,
    };
  }
  return {
    merchantKey: merchant.merchantKey,
    transactionIds: merchant.transactionIds,
    verdict: 'refused',
    categoryId: null,
    reason: null,
    refusal: answer.refusal,
  };
}

export interface SuggestPassResult {
  readonly outcome:
    'disabled' | 'below_gate' | 'no_model' | 'nothing_to_ask' | 'completed' | 'stopped';
  readonly asked: number;
  readonly shownFromCache: number;
  readonly shown: number;
  readonly runs: readonly string[];
}

/** One pass of the suggestion job for one holder. Exported for the api-db tests. */
export async function runSuggestionPass(
  dependencies: CategorySuggestJobDependencies,
  context: {
    readonly userId: string;
    readonly correlationId: string;
    readonly signal?: AbortSignal;
  },
): Promise<SuggestPassResult> {
  const clock = dependencies.clock ?? systemClock;
  const { database } = dependencies;
  const executor = database as unknown as CategorizationExecutor;
  const ctx = { userId: context.userId, clock, correlationId: context.correlationId };
  const empty = { asked: 0, shownFromCache: 0, shown: 0, runs: [] as string[] };

  // Plainly off: no run row (a refusal per sync would bury the inspector).
  const row = await findAdvisor(database, context.userId, CATEGORY_SUGGEST_ADVISOR_ID);
  if (row === null || !row.enabled) return { outcome: 'disabled', ...empty };
  const settings = await readSuggestionSettings(executor, context.userId);
  const gate = gateOf(await latestSuggestionEval(executor, context.userId, settings.modelChoice));
  if (!gate.open) return { outcome: 'below_gate', ...empty };
  const resolution = await dependencies.runtime.resolve(context.userId);
  if (resolution.adapter === null) return { outcome: 'no_model', ...empty };

  const port = createCategorizationLedgerPort(database, clock);
  const taxonomy = await suggestionTaxonomy(executor, context.userId);
  const idByKey = new Map(taxonomy.categories.map((entry) => [entry.key, entry.id]));
  const residue = await listResidueForSuggestion(executor, port, context.userId, taxonomy.version);
  const shownFromCache = await applyCachedSuggestions(database, ctx, residue.hits);
  if (residue.misses.length === 0 || taxonomy.categories.length === 0) {
    return { outcome: 'nothing_to_ask', ...empty, shownFromCache };
  }

  const model: SuggestionModelPort = resolution.adapter;
  let asked = 0;
  let shown = 0;
  const runs: string[] = [];
  for (
    let start = 0, batch = 0;
    start < residue.misses.length && batch < SUGGEST_BATCHES_PER_JOB;
    start += SUGGEST_BATCH_ROWS, batch += 1
  ) {
    if (context.signal?.aborted === true)
      return { outcome: 'stopped', asked, shownFromCache, shown, runs };
    const merchants = residue.misses.slice(start, start + SUGGEST_BATCH_ROWS);
    const result = await runCategorySuggest(
      database,
      ctx,
      {
        switches: dependencies.switches,
        model,
        ...(dependencies.runWatchPollMs === undefined
          ? {}
          : { runWatchPollMs: dependencies.runWatchPollMs }),
      },
      {
        taxonomy: taxonomy.categories.map((entry) => ({ key: entry.key, label: entry.label })),
        rows: merchants.map((merchant) => merchant.features),
        trigger: 'event',
        precisionGateOpen: true,
      },
    );
    if (result.runId !== null) runs.push(result.runId);
    if (result.status !== 'completed')
      return { outcome: 'stopped', asked, shownFromCache, shown, runs };
    asked += merchants.length;
    const recorded = await recordSuggestions(database, ctx, {
      taxonomyVersion: taxonomy.version,
      model: result.model ?? model.label,
      runId: result.runId,
      answers: merchants.map((merchant, index) =>
        answerToMerchant(
          result.answers[index] ?? { verdict: 'refused', refusal: 'missing' },
          merchant,
          idByKey,
        ),
      ),
    });
    shown += recorded.shown;
  }
  return { outcome: 'completed', asked, shownFromCache, shown, runs };
}

/** `categorization.suggest`: deduped per holder, concurrency 1, in the worker only. */
export function createCategorySuggestJob(
  dependencies: CategorySuggestJobDependencies,
): JobHandlerRegistration {
  return defineJob(
    SUGGEST_JOB_KIND,
    async (_payload: unknown, job) => {
      await ensureCategorySuggestAdvisor(dependencies.database, {
        userId: job.userId,
        clock: job.clock,
        correlationId: job.correlationId,
      });
      const result = await runSuggestionPass(dependencies, {
        userId: job.userId,
        correlationId: job.correlationId,
        signal: job.signal,
      });
      job.logger.info(
        {
          job: SUGGEST_JOB_KIND,
          outcome: result.outcome,
          asked: result.asked,
          shown: result.shown,
          shownFromCache: result.shownFromCache,
          runs: result.runs.length,
        },
        'category suggestions: pass finished',
      );
    },
    { concurrency: 1 },
  );
}

/**
 * The categorization consumer's hook: a sync pass that left new residue
 * enqueues one suggestion job per holder, a minute later (deduped: a sync of
 * forty pages is one job), in the pump's own transaction.
 */
export function enqueueSuggestionsAfterSync(clock: Clock = systemClock) {
  return async (input: ResidueRecorded): Promise<void> => {
    await enqueueJob(
      input.tx,
      {
        userId: input.userId,
        kind: SUGGEST_JOB_KIND,
        dedupeKey: `${SUGGEST_JOB_KIND}:${input.userId}`,
        runAfter: new Date(clock.now().getTime() + 60_000),
        priority: 500,
        maxAttempts: 1,
        correlationId: input.correlationId,
        causationEventId: input.causationId,
      },
      { clock },
    );
  };
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

export interface MeasurePayload {
  readonly modelChoice?: SuggestionModelChoice;
}

/** Enqueue a measurement (the api's "Measure" button). Deduped: one at a time per holder. */
export async function enqueueMeasurement(
  database: Database,
  input: {
    readonly userId: string;
    readonly modelChoice: SuggestionModelChoice;
    readonly correlationId: string;
    readonly clock?: Clock;
  },
): Promise<{ readonly jobId: string; readonly deduped: boolean }> {
  const result = await enqueueJob(
    platformExecutor(database),
    {
      userId: input.userId,
      kind: SUGGEST_MEASURE_JOB_KIND,
      payload: { modelChoice: input.modelChoice } satisfies MeasurePayload,
      dedupeKey: `${SUGGEST_MEASURE_JOB_KIND}:${input.userId}`,
      priority: 10,
      maxAttempts: 1,
      correlationId: input.correlationId,
    },
    input.clock === undefined ? {} : { clock: input.clock },
  );
  return { jobId: result.id, deduped: result.deduped };
}

/** One measurement for one holder. Writes its own result row and nothing else. Exported for tests. */
export async function runMeasurement(
  dependencies: CategorySuggestJobDependencies,
  context: {
    readonly userId: string;
    readonly correlationId: string;
    readonly modelChoice: SuggestionModelChoice;
    readonly signal?: AbortSignal;
  },
): Promise<string> {
  const clock = dependencies.clock ?? systemClock;
  const { database } = dependencies;
  const executor = database as unknown as CategorizationExecutor;
  const ctx = { userId: context.userId, clock, correlationId: context.correlationId };
  const started = clock.nowMs();
  const resolution = await dependencies.runtime.resolve(context.userId, context.modelChoice);
  const port = createCategorizationLedgerPort(database, clock);
  const gold = await loadGoldSet(executor, port, context.userId);
  const residue = measurementResidue(gold.examples, {
    rules: gold.rules,
    lockedMerchantDefaults: gold.lockedMerchantDefaults,
  });
  const record = async (
    status: 'completed' | 'failed',
    failure: string | null,
    figures = emptyFigures(residue.goldTotal, residue.rows.length),
    batchDigests: readonly string[] = [],
  ): Promise<string> =>
    recordSuggestionEval(executor, ctx, {
      modelChoice: context.modelChoice,
      model: resolution.label ?? `unavailable:${resolution.reason ?? 'unknown'}`,
      modelDigest: resolution.digest,
      status,
      failure,
      figures,
      batchDigests,
      durationMs: Math.max(0, clock.nowMs() - started),
    });

  if (resolution.adapter === null) return record('failed', resolution.reason ?? 'no_model');
  const taxonomy = await suggestionTaxonomy(executor, context.userId);
  const wireTaxonomy = taxonomy.categories.map((entry) => ({ key: entry.key, label: entry.label }));
  const answers = new Map<string, MeasuredAnswer>();
  const digests: string[] = [];
  for (let start = 0; start < residue.merchants.length; start += SUGGEST_BATCH_ROWS) {
    if (context.signal?.aborted === true) return record('failed', 'aborted');
    const merchants = residue.merchants.slice(start, start + SUGGEST_BATCH_ROWS);
    const result = await measureCategorySuggest(
      database,
      ctx,
      {
        switches: dependencies.switches,
        model: resolution.adapter,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(dependencies.runWatchPollMs === undefined
          ? {}
          : { runWatchPollMs: dependencies.runWatchPollMs }),
      },
      { taxonomy: wireTaxonomy, rows: merchants.map((merchant) => merchant.features) },
    );
    digests.push(result.digest);
    if (result.status !== 'completed') {
      return record(
        'failed',
        result.refusal ?? result.cancelReason ?? result.errorCode ?? result.status,
        emptyFigures(residue.goldTotal, residue.rows.length),
        digests,
      );
    }
    merchants.forEach((merchant, index) => {
      const answer = result.answers[index];
      answers.set(
        merchant.merchantKey,
        answer === undefined || answer.verdict === 'refused'
          ? { verdict: 'refused', categoryKey: null }
          : answer.verdict === 'abstained'
            ? { verdict: 'abstained', categoryKey: null }
            : { verdict: 'suggested', categoryKey: answer.categoryKey },
      );
    });
  }
  return record('completed', null, scoreMeasurement(residue, answers), digests);
}

export function createCategorySuggestMeasureJob(
  dependencies: CategorySuggestJobDependencies,
): JobHandlerRegistration {
  return defineJob<MeasurePayload>(
    SUGGEST_MEASURE_JOB_KIND,
    async (payload, job) => {
      const modelChoice: SuggestionModelChoice =
        payload?.modelChoice === 'classifier' ? 'classifier' : 'narrator';
      const id = await runMeasurement(dependencies, {
        userId: job.userId,
        correlationId: job.correlationId ?? newId(),
        modelChoice,
        signal: job.signal,
      });
      job.logger.info(
        { job: SUGGEST_MEASURE_JOB_KIND, evalId: id, modelChoice },
        'category suggestions: measurement recorded',
      );
    },
    { concurrency: 1 },
  );
}
