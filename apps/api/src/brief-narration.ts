// SPDX-License-Identifier: MIT
/**
 * WP 11.4: the Brief's own narration and the weekly recap (`brief.narrate`) —
 * the composition root's half. `@ctx/insights` owns the query type's subject,
 * kill ladder, approval, run row, validator and the one-call-per-Brief claim;
 * `@advisor/local-model` owns the prompt and the call. This file joins them:
 *
 *   * `createBriefNarrateRuntime` — which model narrates a holder's Brief:
 *     **the narrator's own provider**, resolved through the narrator runtime's
 *     per-holder view, exactly as `insight-explain.ts`'s `createExplainRuntime`
 *     resolves it (the local model by default with the narrator's pin, a
 *     hosted provider only under the narrator's WP 10.6 consent, with its key
 *     and its hourly window). No consent of its own: the payload class is the
 *     narrator's. Off is off. Preview mode (the api) builds rejecting
 *     transports: the api renders and approves, it never calls a model.
 *   * `loadBriefNarrateTarget` — the Brief as the holder reads it: the
 *     overview's figures **read from the blocks `GET /insights/brief/*`
 *     serves** (`briefOverviewBlocks` over the same two reads), the ranked
 *     items with their validated per-item wording when the deployment shows
 *     narration text (else the built-in summary), last week's outcomes, and
 *     the titles the Brief did not choose (never sent; the G5-15 check).
 *   * `createBriefNarrateJob` — `insights.brief_narrate`, in the worker only:
 *     waits (re-enqueues itself, no model asked) while any of this Brief's
 *     item narrations is still queued or running, then runs the composition
 *     at most once per Brief, and announces the Brief
 *     (`insights.BriefRecapReady`) with the recap when one passed the
 *     validator, without one otherwise.
 *   * `createBriefNarrationEnqueue` — the Brief job's hook.
 *   * `briefNarrateProbeFor` — the controls self-test's reach into the model
 *     (`brief_narration_grounding`).
 */
import {
  BRIEF_NARRATE_CONTROL_FIGURE,
  createHostedBriefNarrateAdapter,
  createLocalBriefNarrateAdapter,
  HOSTED_DEFAULT_MODELS,
  HOSTED_TIMEOUT_CEILING_MS,
  type BriefNarrateModelAdapter,
  type HostedProvider,
} from '@advisor/local-model';
import type { Database } from '@core/db';
import { newId, systemClock, type Block, type Clock } from '@core/kernel';
import {
  appendEvent,
  defineJob,
  platformExecutor,
  type JobHandlerRegistration,
} from '@core/platform';
import {
  BRIEF_NARRATE_JOB_KIND,
  BRIEF_NARRATE_MAX_WAITS,
  BRIEF_NARRATE_WAIT_MS,
  BriefRecapReady,
  briefMoneyText,
  briefNarrateCeiling,
  briefNarrateTargetOf,
  enqueueBriefNarration,
  ensureBriefNarrateAdvisor,
  loadBriefNarrateSources,
  narrationsFor,
  runBriefNarration,
  type BriefNarrateJobPayload,
  type BriefNarrateProbeModel,
  type BriefNarrateResult,
  type BriefNarrateSources,
  type BriefNarrateTarget,
  type BriefWeekFigures,
  type RunSwitches,
  type StoredBriefNarration,
} from '@ctx/insights';
import { sql } from 'drizzle-orm';
import { briefOverviewBlocks, type BriefItemForBlocks } from './blocks/brief.ts';
import type { ExplainRuntimeOptions, ExplainUnavailableModel } from './insight-explain.ts';
import { narratedByOf, overviewReadsFor } from './routes/brief.ts';

// ---------------------------------------------------------------------------
// Which model narrates a holder's Brief
// ---------------------------------------------------------------------------

export interface BriefNarrateResolution {
  readonly provider: 'ollama' | HostedProvider | 'off';
  readonly adapter: BriefNarrateModelAdapter | null;
  readonly reason: ExplainUnavailableModel | null;
}

export interface BriefNarrateRuntime {
  resolve(userId: string): Promise<BriefNarrateResolution>;
}

/** The narrator runtime's options, as `createExplainRuntime` takes them. */
export type BriefNarrateRuntimeOptions = ExplainRuntimeOptions;

const PREVIEW_ONLY_LOCAL = Object.freeze({
  request: () =>
    Promise.reject(
      new Error('the api process holds no model endpoint: it renders and previews, it never calls'),
    ),
});
const PREVIEW_ONLY_HOSTED = (): Promise<never> =>
  Promise.reject(new Error('the api process never calls a hosted model'));

/** `name@sha256:<64 hex>` → its parts; `null` for anything else. */
function pinOfLabel(label: string): { readonly name: string; readonly digest: string } | null {
  const at = label.lastIndexOf('@sha256:');
  if (at <= 0) return null;
  return { name: label.slice(0, at), digest: label.slice(at + 1) };
}

export function createBriefNarrateRuntime(
  options: BriefNarrateRuntimeOptions,
): BriefNarrateRuntime {
  const preview = options.mode === 'preview';

  async function resolve(userId: string): Promise<BriefNarrateResolution> {
    const narrator = await options.narrator.resolve(userId);
    const none = (reason: ExplainUnavailableModel): BriefNarrateResolution => ({
      provider: narrator.provider,
      adapter: null,
      reason,
    });
    if (narrator.provider === 'off') return none('off');
    if (narrator.narrator === null) {
      const reason = narrator.reason ?? 'not_configured';
      return none(reason === 'off' ? 'off' : reason);
    }

    if (narrator.provider === 'ollama') {
      const stored = await options.stores.settings(userId);
      const configured = options.localModel ?? stored.ollama;
      const pin = configured === null ? pinOfLabel(narrator.narrator.label) : null;
      const config =
        configured ?? (pin === null ? null : { endpoint: stored.ollama?.endpoint ?? '', ...pin });
      if (config === null) return none('not_configured');
      const token = await options.stores.storedKey(userId, 'ollama');
      if (token === 'unopenable') return none('key_unopenable');
      try {
        const transport = preview ? PREVIEW_ONLY_LOCAL : options.localTransport;
        const adapter = createLocalBriefNarrateAdapter(
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
        return { provider: 'ollama', adapter, reason: null };
      } catch {
        options.logger?.warn(
          { event: 'brief_narrate.endpoint_refused', userId },
          "the local endpoint for the Brief's narration is refused by the local-endpoint policy",
        );
        return none('endpoint_refused');
      }
    }

    // A hosted narrator: its resolution already required the standing consent
    // and a key. The same key (a file wins), the narrator's model, its window.
    const provider = narrator.provider;
    const file = options.fileKeys[provider];
    let key: { reveal(): string } | null = file ?? null;
    if (key === null) {
      const storedKey = await options.stores.storedKey(userId, provider);
      if (storedKey === 'unopenable') return none('key_unopenable');
      key = storedKey;
    }
    if (key === null) return none('key_missing');
    const budget = options.narrator.budgets.get(provider);
    const adapter = createHostedBriefNarrateAdapter(
      {
        provider,
        model: narrator.narrator.modelId ?? HOSTED_DEFAULT_MODELS[provider],
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
        ...(budget === undefined ? {} : { budget }),
      },
    );
    return { provider, adapter, reason: null };
  }

  return Object.freeze({ resolve });
}

// ---------------------------------------------------------------------------
// The Brief as the holder reads it
// ---------------------------------------------------------------------------

function infoValue(block: Block | undefined): string | null {
  if (block === undefined || block.kind !== 'info') return null;
  return typeof block.value === 'string' ? block.value : null;
}

/** Walk the overview's blocks for the week's figures. Every figure here is one a block shows. */
export function briefWeekFiguresOf(blocks: readonly Block[]): BriefWeekFigures {
  const byId = new Map<string, Block>();
  const visit = (list: readonly Block[]): void => {
    for (const block of list) {
      if (block.id !== undefined) byId.set(block.id, block);
      if (block.kind === 'group') visit(block.blocks);
    }
  };
  visit(blocks);
  const milestones: { label: string; value: string; on: string }[] = [];
  for (const [id, block] of byId) {
    if (!id.startsWith('milestone-') || block.kind !== 'money' || block.amountMinor === null) {
      continue;
    }
    const value = briefMoneyText({ minor: block.amountMinor, currency: block.currency });
    const on = /^On (\d{4}-\d{2}-\d{2})\.$/u.exec(block.hint ?? '')?.[1];
    if (value === null || on === undefined) continue;
    milestones.push({ label: block.label, value, on });
  }
  return {
    week: infoValue(byId.get('brief-week-label')) ?? '',
    rankedCount: infoValue(byId.get('brief-week-ranked')) ?? '0',
    attentionCount: infoValue(byId.get('brief-week-attention')) ?? '0',
    healthScore: infoValue(byId.get('brief-health-score')),
    milestones,
  };
}

function wireMoney(money: { readonly minor: string; readonly currency: string } | null) {
  return money === null ? null : { minor: money.minor, currency: money.currency };
}

/** The served Brief's overview blocks, from the stored rows and the two overview reads. */
async function overviewBlocksOf(
  database: Database,
  userId: string,
  sources: BriefNarrateSources,
): Promise<readonly Block[]> {
  const overview = await overviewReadsFor(database, userId);
  const none = { status: 'none' as const, textShown: false, summaryMd: null, narratedBy: null };
  const items: BriefItemForBlocks[] = [
    ...sources.ranked.map((item, index) => ({
      id: `ranked-${String(index)}`,
      section: 'ranked' as const,
      title: item.title,
      summaryMd: item.summaryMd,
      carried: item.carried,
      annualizedImpact: wireMoney(item.annualizedImpact),
      oneTimeImpact: wireMoney(item.oneTimeImpact),
      narration: none,
    })),
    ...Array.from({ length: sources.attentionCount }, (_unused, index) => ({
      id: `attention-${String(index)}`,
      section: 'attention' as const,
      title: '',
      summaryMd: '',
      carried: false,
      annualizedImpact: null,
      oneTimeImpact: null,
      narration: none,
    })),
  ];
  return briefOverviewBlocks(
    { isoWeek: sources.isoWeek, nothingMaterial: sources.nothingMaterial, items },
    overview.health,
    overview.milestones,
  );
}

export interface LoadedBriefNarrateTarget {
  readonly target: BriefNarrateTarget;
  readonly sources: BriefNarrateSources;
}

/** Load one Brief's composition target. `textShown` is `NARRATION_TEXT_SHOWN` (Phase 5 gate R-2). */
export async function loadBriefNarrateTarget(
  database: Database,
  userId: string,
  briefId: string,
  options: { readonly textShown: boolean },
): Promise<LoadedBriefNarrateTarget | null> {
  const sources = await loadBriefNarrateSources(database, userId, briefId);
  if (sources === null) return null;
  const findingIds = sources.ranked.flatMap((item) =>
    item.insightId === null ? [] : [item.insightId],
  );
  // The items' validated per-item wording is used only where the holder could
  // read it: while the deployment withholds narration text, the composition
  // is built from the built-in summaries, so it can never relay wording the
  // holder was not shown.
  const [narrations, blocks, ceiling] = await Promise.all([
    options.textShown ? narrationsFor(database, userId, findingIds) : Promise.resolve(new Map()),
    overviewBlocksOf(database, userId, sources),
    briefNarrateCeiling(database, userId),
  ]);
  const target = briefNarrateTargetOf({
    briefId: sources.briefId,
    isoWeek: sources.isoWeek,
    week: briefWeekFiguresOf(blocks),
    ranked: sources.ranked.map((item) => ({
      ...item,
      narrationText:
        item.insightId === null
          ? null
          : ((narrations.get(item.insightId) as { summaryMd: string } | undefined)?.summaryMd ??
            null),
    })),
    lastWeek: sources.lastWeek,
    allowedScopes: ceiling,
    foreignTitles: sources.foreignTitles,
  });
  return { target, sources };
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export interface BriefNarrateJobDependencies {
  readonly database: Database;
  readonly runtime: BriefNarrateRuntime;
  readonly switches: RunSwitches;
  /** `NARRATION_TEXT_SHOWN`. */
  readonly textShown: boolean;
  readonly clock?: Clock;
  /** Tests only. */
  readonly runWatchPollMs?: number;
  readonly waitMs?: number;
}

/** This Brief's per-item narrations still queued or running (the Brief job's own dedupe keys). */
export async function pendingItemNarrations(
  database: Database,
  userId: string,
  isoWeek: string,
): Promise<number> {
  const prefix = `insights.run_local:local.narrator:${userId}:${isoWeek}:`;
  const result = await platformExecutor(database).execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM jobs
    WHERE user_id = ${userId}::uuid
      AND kind = 'insights.run_local'
      AND status IN ('pending', 'running')
      AND starts_with(dedupe_key, ${prefix})
  `);
  return Number(result.rows[0]?.count ?? '0');
}

export interface BriefNarrationPassResult {
  readonly outcome: 'waiting' | 'not_found' | 'no_model' | BriefNarrateResult['status'];
  readonly result: BriefNarrateResult | null;
  /** Whether `insights.BriefRecapReady` was appended by this pass. */
  readonly announced: boolean;
}

function recapByOf(stored: StoredBriefNarration | null) {
  if (stored === null || stored.status !== 'shown' || stored.recap === null) return null;
  return narratedByOf(stored.model);
}

/** One Brief's composition step. Exported for the api-db tests and the evaluation harness. */
export async function runBriefNarrationPass(
  dependencies: BriefNarrateJobDependencies,
  context: {
    readonly userId: string;
    readonly correlationId: string;
    readonly payload: BriefNarrateJobPayload;
  },
): Promise<BriefNarrationPassResult> {
  const clock = dependencies.clock ?? systemClock;
  const { database } = dependencies;
  const { payload } = context;
  const ctx = { userId: context.userId, clock, correlationId: context.correlationId };

  // The item narrations first: the composition reads their validated wording.
  const pending = await pendingItemNarrations(database, context.userId, payload.isoWeek);
  if (pending > 0 && payload.waits < BRIEF_NARRATE_MAX_WAITS) {
    await enqueueBriefNarration(platformExecutor(database), {
      userId: context.userId,
      briefId: payload.briefId,
      isoWeek: payload.isoWeek,
      waits: payload.waits + 1,
      runAfter: new Date(clock.nowMs() + (dependencies.waitMs ?? BRIEF_NARRATE_WAIT_MS)),
      correlationId: context.correlationId,
    });
    return { outcome: 'waiting', result: null, announced: false };
  }

  const loaded = await loadBriefNarrateTarget(database, context.userId, payload.briefId, {
    textShown: dependencies.textShown,
  });
  if (loaded === null) return { outcome: 'not_found', result: null, announced: false };

  await ensureBriefNarrateAdvisor(database, ctx);
  const resolution = await dependencies.runtime.resolve(context.userId);
  let result: BriefNarrateResult | null = null;
  if (resolution.adapter !== null) {
    result = await runBriefNarration(
      database,
      ctx,
      {
        switches: dependencies.switches,
        model: resolution.adapter,
        ...(dependencies.runWatchPollMs === undefined
          ? {}
          : { runWatchPollMs: dependencies.runWatchPollMs }),
      },
      { target: loaded.target, trigger: 'event' },
    );
    // A Brief already composed was already announced.
    if (result.status === 'already') return { outcome: 'already', result, announced: false };
  }

  // Announce the Brief: the deterministic lines always, the recap only when it passed.
  const stored = result?.narration ?? null;
  const recapBy = recapByOf(stored);
  await appendEvent(
    platformExecutor(database),
    BriefRecapReady.create(
      {
        briefId: loaded.sources.briefId,
        isoWeek: loaded.sources.isoWeek,
        rankedCount: Math.min(loaded.sources.ranked.length, 5),
        attentionCount: loaded.sources.attentionCount,
        nothingMaterial: loaded.sources.nothingMaterial,
        recap: recapBy === null ? null : (stored?.recap ?? null),
        recapBy,
      },
      {
        userId: context.userId,
        aggregateId: loaded.sources.briefId,
        correlationId: context.correlationId,
        causationId: null,
      },
    ),
  );
  return {
    outcome: result === null ? 'no_model' : result.status,
    result,
    announced: true,
  };
}

/** `insights.brief_narrate`: concurrency 1 (the model is one), never retried, in the worker only. */
export function createBriefNarrateJob(
  dependencies: BriefNarrateJobDependencies,
): JobHandlerRegistration {
  return defineJob<BriefNarrateJobPayload>(
    BRIEF_NARRATE_JOB_KIND,
    async (payload, job) => {
      if (
        payload === null ||
        typeof payload !== 'object' ||
        typeof payload.briefId !== 'string' ||
        typeof payload.isoWeek !== 'string'
      ) {
        return;
      }
      const pass = await runBriefNarrationPass(dependencies, {
        userId: job.userId,
        correlationId: job.correlationId ?? newId(),
        payload: {
          briefId: payload.briefId,
          isoWeek: payload.isoWeek,
          waits: typeof payload.waits === 'number' ? payload.waits : 0,
        },
      });
      job.logger.info(
        {
          job: BRIEF_NARRATE_JOB_KIND,
          outcome: pass.outcome,
          announced: pass.announced,
          runId: pass.result?.runId ?? null,
          replyRefusal: pass.result?.replyRefusal ?? null,
          errorCode: pass.result?.errorCode ?? null,
        },
        "the Brief's own narration: pass finished",
      );
    },
    { concurrency: 1 },
  );
}

/** The Brief job's `briefNarration` hook: one `insights.brief_narrate` job per published Brief. */
export function createBriefNarrationEnqueue(database: Database) {
  return async (input: {
    readonly userId: string;
    readonly briefId: string;
    readonly isoWeek: string;
    readonly correlationId: string;
  }): Promise<void> => {
    await enqueueBriefNarration(platformExecutor(database), { ...input, waits: 0 });
  };
}

// ---------------------------------------------------------------------------
// The controls self-test
// ---------------------------------------------------------------------------

/** WP 11.4: the holder's Brief-narration model's grounding probe, for `brief_narration_grounding`. */
export function briefNarrateProbeFor(runtime: BriefNarrateRuntime) {
  return async (userId: string): Promise<BriefNarrateProbeModel | null> => {
    const resolution = await runtime.resolve(userId);
    const adapter = resolution.adapter;
    if (adapter === null) return null;
    return {
      label: adapter.label,
      figure: BRIEF_NARRATE_CONTROL_FIGURE,
      probe: (request, signal) =>
        adapter.controlProbe('brief_narration_grounding', request, signal),
    };
  };
}
