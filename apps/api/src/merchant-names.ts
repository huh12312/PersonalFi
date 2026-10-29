// SPDX-License-Identifier: MIT
/**
 * WP 11.6: merchant display-name suggestions (`merchant.name`) — the
 * composition root's half. `@ctx/ledger` owns which merchants are noise, the
 * suggestion rows and the rename an Accept writes; `@ctx/insights` owns the
 * query type's kill ladder, approval, run row and the substring-preserving
 * validator; `@advisor/local-model` owns the prompt and the call. Contexts never
 * import each other, so this file joins them:
 *
 *   * `createMerchantNameRuntime` — which model suggests for a holder: the
 *     narrator's **local** model, and only that. Off is off; a hosted narrator
 *     binds nothing (`hosted_narrator`), because the descriptor crosses
 *     untokenised and this query type has no hosted path (D22). The local
 *     endpoint, digest pin, timeout ceiling and abort are the narrator's own.
 *   * `runMerchantNamePass` / `createMerchantNamesJob` — `insights.merchant_names`,
 *     nightly in the worker: at most fifty noise merchants a holder, one call
 *     each, every answer recorded once. Never in the request path; the api
 *     holds a preview-mode runtime whose transport refuses every call.
 */
import {
  createLocalMerchantNameAdapter,
  type LocalModelLogger,
  type LocalModelTransport,
  type MerchantNameModelAdapter,
} from '@advisor/local-model';
import type { Database } from '@core/db';
import { systemClock, type Clock } from '@core/kernel';
import { defineJob, type JobHandlerRegistration } from '@core/platform';
import {
  MERCHANT_NAME_RUN_CAP,
  listMerchantNameCandidates,
  mayBeNoise,
  recordMerchantNameAnswer,
  type MerchantNameAnswer,
  type MerchantNameCandidate,
} from '@ctx/ledger';
import {
  MERCHANT_NAMES_JOB_KIND,
  MERCHANT_NAME_ADVISOR_ID,
  ensureMerchantNameAdvisor,
  findAdvisor,
  merchantNameUnavailable,
  runMerchantName,
  type CancelReason,
  type MerchantNameVerdict,
  type RunSwitches,
} from '@ctx/insights';
import type { NarratorRuntime, NarratorStores } from './narrator-wiring.ts';

// ---------------------------------------------------------------------------
// Which model suggests for a holder: the local one, or none
// ---------------------------------------------------------------------------

export type MerchantNameUnavailableModel =
  'off' | 'not_configured' | 'hosted_narrator' | 'key_unopenable' | 'endpoint_refused';

export interface MerchantNameResolution {
  readonly adapter: MerchantNameModelAdapter | null;
  readonly reason: MerchantNameUnavailableModel | null;
}

export interface MerchantNameRuntime {
  resolve(userId: string): Promise<MerchantNameResolution>;
}

export interface MerchantNameRuntimeOptions {
  readonly mode: 'run' | 'preview';
  readonly narrator: Pick<NarratorRuntime, 'resolve'>;
  readonly stores: NarratorStores;
  /** The worker's `config.localModel` (endpoint, name, digest); `undefined` in the api. */
  readonly localModel:
    { readonly endpoint: string; readonly name: string; readonly digest: string } | undefined;
  readonly timeoutMs: number;
  readonly allowRemote: boolean;
  readonly logger?: LocalModelLogger;
  readonly clock?: Clock;
  /** Tests only. */
  readonly localTransport?: LocalModelTransport;
}

/** The api renders and approves; it never calls a model. Its transport says so. */
const PREVIEW_ONLY_LOCAL: LocalModelTransport = Object.freeze({
  request: () =>
    Promise.reject(
      new Error('the api process holds no model endpoint: it renders and previews, it never calls'),
    ),
});

/** `name@sha256:<64 hex>` → its parts; `null` for anything else. */
function pinOfLabel(label: string): { readonly name: string; readonly digest: string } | null {
  const at = label.lastIndexOf('@sha256:');
  if (at <= 0) return null;
  return { name: label.slice(0, at), digest: label.slice(at + 1) };
}

export function createMerchantNameRuntime(
  options: MerchantNameRuntimeOptions,
): MerchantNameRuntime {
  const preview = options.mode === 'preview';

  async function resolve(userId: string): Promise<MerchantNameResolution> {
    const none = (reason: MerchantNameUnavailableModel): MerchantNameResolution => ({
      adapter: null,
      reason,
    });
    const narrator = await options.narrator.resolve(userId);
    if (narrator.provider === 'off') return none('off');
    // D22: the descriptor crosses untokenised, so a hosted provider never sees it.
    if (narrator.provider !== 'ollama') return none('hosted_narrator');
    if (narrator.narrator === null) {
      const reason = narrator.reason ?? 'not_configured';
      return none(
        reason === 'off' || reason === 'key_unopenable' || reason === 'endpoint_refused'
          ? reason
          : 'not_configured',
      );
    }
    const stored = await options.stores.settings(userId);
    // The environment wins over Settings, as for the narrator. In the api the
    // environment carries only the pin: the narrator's label is
    // `name@sha256:digest`, exactly what rendering and approving need.
    const configured = options.localModel ?? stored.ollama;
    const pin = configured === null ? pinOfLabel(narrator.narrator.label) : null;
    const config =
      configured ?? (pin === null ? null : { endpoint: stored.ollama?.endpoint ?? '', ...pin });
    if (config === null) return none('not_configured');
    const token = await options.stores.storedKey(userId, 'ollama');
    if (token === 'unopenable') return none('key_unopenable');
    try {
      const transport = preview ? PREVIEW_ONLY_LOCAL : options.localTransport;
      const adapter = createLocalMerchantNameAdapter(
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
          ...(token === null ? {} : { bearer: token }),
        },
      );
      return { adapter, reason: null };
    } catch {
      options.logger?.warn(
        { event: 'merchant_name.endpoint_refused', userId },
        'the local endpoint for merchant names is refused by the local-endpoint policy',
      );
      return none('endpoint_refused');
    }
  }

  return Object.freeze({ resolve });
}

// ---------------------------------------------------------------------------
// The nightly pass
// ---------------------------------------------------------------------------

export interface MerchantNamesJobDependencies {
  readonly database: Database;
  readonly runtime: MerchantNameRuntime;
  readonly switches: RunSwitches;
  readonly clock?: Clock;
  /** Tests only: fewer than `MERCHANT_NAME_RUN_CAP`. */
  readonly cap?: number;
  /** Tests only. */
  readonly runWatchPollMs?: number;
}

export interface MerchantNamePassResult {
  readonly outcome: 'disabled' | 'no_model' | 'gated' | 'nothing_to_ask' | 'completed' | 'stopped';
  /** Why nothing was asked, when `outcome` is `no_model` or `gated`. */
  readonly reason: MerchantNameUnavailableModel | CancelReason | null;
  readonly asked: number;
  readonly suggested: number;
  readonly abstained: number;
  readonly refused: number;
  /** Descriptors the pass would not send because they are not noise (a defence; the listing never offers one). */
  readonly notNoise: number;
  readonly deferred: number;
  readonly runs: readonly string[];
}

/** The validator's verdict as the ledger stores it: an abstention is a refusal of class `abstained`. */
export function answerOf(verdict: MerchantNameVerdict): MerchantNameAnswer {
  if (verdict.verdict === 'suggested') {
    return { status: 'suggested', displayName: verdict.displayName };
  }
  if (verdict.verdict === 'abstained') return { status: 'refused', refusalClass: 'abstained' };
  return { status: 'refused', refusalClass: verdict.refusal };
}

export type MerchantNameStep =
  | { readonly kind: 'not_noise' }
  | { readonly kind: 'stopped'; readonly runId: string }
  | { readonly kind: 'answered'; readonly runId: string; readonly verdict: MerchantNameVerdict };

/**
 * One descriptor: the noise guard, the run (`runMerchantName`: ladder, approval,
 * run row, call, validator) and the record. **The model is never asked about a
 * descriptor that is not noise**, whatever handed it over: the guard is checked
 * here, before anything is built, and returns without touching the database.
 * Exported for the red team.
 */
export async function askMerchantName(
  dependencies: Pick<MerchantNamesJobDependencies, 'database' | 'switches' | 'runWatchPollMs'>,
  ctx: { readonly userId: string; readonly clock: Clock; readonly correlationId: string },
  model: MerchantNameModelAdapter,
  candidate: Pick<MerchantNameCandidate, 'normalizedKey' | 'descriptor' | 'strippedPrefix'>,
): Promise<MerchantNameStep> {
  if (!mayBeNoise(candidate.descriptor)) return { kind: 'not_noise' };
  const { database } = dependencies;
  const outcome = await runMerchantName(
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
      descriptor: candidate.descriptor,
      strippedPrefix: candidate.strippedPrefix,
      trigger: 'schedule',
    },
  );
  if (outcome.status !== 'completed' || outcome.answer === null) {
    return { kind: 'stopped', runId: outcome.runId };
  }
  await recordMerchantNameAnswer(database, ctx, {
    normalizedKey: candidate.normalizedKey,
    descriptor: candidate.descriptor,
    strippedPrefix: candidate.strippedPrefix,
    answer: answerOf(outcome.answer),
    llmProvider: 'ollama',
    llmModel: outcome.model ?? model.label,
    runId: outcome.runId,
    inputDigest: outcome.digest,
  });
  return { kind: 'answered', runId: outcome.runId, verdict: outcome.answer };
}

/** One pass for one holder. Exported for the api-db tests. */
export async function runMerchantNamePass(
  dependencies: MerchantNamesJobDependencies,
  context: {
    readonly userId: string;
    readonly correlationId: string;
    readonly signal?: AbortSignal;
  },
): Promise<MerchantNamePassResult> {
  const clock = dependencies.clock ?? systemClock;
  const { database } = dependencies;
  const ctx = { userId: context.userId, clock, correlationId: context.correlationId };
  const counts = { asked: 0, suggested: 0, abstained: 0, refused: 0, notNoise: 0, deferred: 0 };
  const runs: string[] = [];
  const result = (
    outcome: MerchantNamePassResult['outcome'],
    reason: MerchantNamePassResult['reason'] = null,
  ): MerchantNamePassResult => ({ outcome, reason, ...counts, runs });

  // Plainly off: no run row (a refusal every night would bury the inspector).
  const row = await findAdvisor(database, context.userId, MERCHANT_NAME_ADVISOR_ID);
  if (row === null || !row.enabled) return result('disabled');
  const resolution = await dependencies.runtime.resolve(context.userId);
  if (resolution.adapter === null) return result('no_model', resolution.reason);
  // Until the shape is approved (or while any switch is off) nothing is listed and nothing is sent.
  const gated = await merchantNameUnavailable(database, dependencies.switches, {
    userId: context.userId,
    templateHash: resolution.adapter.templateHash,
  });
  if (gated !== null) return result('gated', gated);

  const listed = await listMerchantNameCandidates(database, context.userId, {
    limit: Math.min(dependencies.cap ?? MERCHANT_NAME_RUN_CAP, MERCHANT_NAME_RUN_CAP),
  });
  counts.deferred = listed.deferred;
  if (listed.candidates.length === 0) return result('nothing_to_ask');

  for (const candidate of listed.candidates) {
    if (context.signal?.aborted === true) return result('stopped');
    const step = await askMerchantName(dependencies, ctx, resolution.adapter, candidate);
    if (step.kind === 'not_noise') {
      counts.notNoise += 1;
      continue;
    }
    runs.push(step.runId);
    // A kill, a refusal or a failed call ends the pass: the rest wait for the next night.
    if (step.kind === 'stopped') return result('stopped');
    counts.asked += 1;
    if (step.verdict.verdict === 'suggested') counts.suggested += 1;
    else if (step.verdict.verdict === 'abstained') counts.abstained += 1;
    else counts.refused += 1;
  }
  return result('completed');
}

/** `insights.merchant_names`: concurrency 1, never retried by the queue (tomorrow's run asks again). */
export function createMerchantNamesJob(
  dependencies: MerchantNamesJobDependencies,
): JobHandlerRegistration {
  return defineJob(
    MERCHANT_NAMES_JOB_KIND,
    async (_payload: unknown, job) => {
      await ensureMerchantNameAdvisor(dependencies.database, {
        userId: job.userId,
        clock: job.clock,
        correlationId: job.correlationId,
      });
      const result = await runMerchantNamePass(
        { ...dependencies, clock: dependencies.clock ?? job.clock },
        { userId: job.userId, correlationId: job.correlationId, signal: job.signal },
      );
      // Counts and reasons only: never a descriptor or a name.
      job.logger.info(
        {
          job: MERCHANT_NAMES_JOB_KIND,
          outcome: result.outcome,
          reason: result.reason,
          asked: result.asked,
          suggested: result.suggested,
          abstained: result.abstained,
          refused: result.refused,
          deferred: result.deferred,
          runs: result.runs.length,
        },
        'merchant names: pass finished',
      );
    },
    { concurrency: 1 },
  );
}
