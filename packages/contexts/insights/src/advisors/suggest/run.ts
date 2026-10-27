// SPDX-License-Identifier: MIT
/**
 * Running `categorize.suggest`: the kill ladder, the approval, the run
 * inspector, the call and the validator — in that order, and nothing written
 * but `advisor_runs` (11 §2 rule 3: same gate, same ladder, same evidence).
 *
 *   1. **Gate**, read through `decideRun` exactly as a narrator run reads it:
 *      level 1 (`ADVISORS_ENABLED`, `module.insights`), level 2 (the
 *      `local_model` kind switch, and a model bound for this holder), level 3
 *      (`advisors.enabled` for `categorize.suggest`, its quarantine — **and the
 *      precision gate**: below 85 % on the holder's own history the advisor is
 *      off whatever its row says, so a row enabled by any other path cannot
 *      open it), then the payload approval for the shape this run would send.
 *   2. **The run row** — `advisor_runs`, the batch's `canonicalRunDigest`,
 *      the prompt hash and model before the call, the payload retained 30
 *      days for the inspector (`inspectRunPayload` re-derives the digest).
 *   3. **The call**, raced against the manifest's deadline and the watcher
 *      (every switch and the run's own cancel flag, once a second): any one
 *      of them aborts the model's socket.
 *   4. **The barrier** — the switches once more after the reply; a kill that
 *      landed during the call discards everything the model said.
 *   5. **Validation** (`reply.ts`), per row; refusals recorded by class.
 *
 * `measureCategorySuggest` is steps 1, 3 and 5 only, for Settings' "Measure":
 * level 3's `advisors.enabled` and the precision gate are what a measurement
 * exists to *open*, so it skips those two and honours everything else
 * (including the quarantine and the approval). It writes nothing at all — the
 * measurement's own result row is `@ctx/categorization`'s, written by the
 * composition root.
 */
import { decideContinue, type CancelReason } from '../../policy/kill-switches.ts';
import type { RunSwitches } from '../../policy/kill-switches.ts';
import { RUN_WATCH_POLL_MS, RunCancelled, watchRun } from '../../policy/run-watch.ts';
import { hasLiveApproval, queryShape } from '../../preview.ts';
import type { InsightsContext, InsightsDatabase, InsightsExecutor } from '../../db.ts';
import {
  findAdvisor,
  findRun,
  listGrants,
  finishRun,
  quarantineAdvisor,
  recordRunHealth,
  recordRunModel,
  retainRunPayload,
  startRun,
} from '../../store.ts';
import { BREAKER_THRESHOLDS } from '../../policy/kill-switches.ts';
import type { RunTrigger } from '../../../schema/index.ts';
import {
  CATEGORY_SUGGEST_ADVISOR_ID,
  CATEGORY_SUGGEST_MANIFEST,
  CATEGORY_SUGGEST_SCOPES,
  CATEGORY_SUGGEST_VERSION,
} from './manifest.ts';
import {
  buildSuggestRequest,
  type ResidueRowInput,
  type SuggestTaxonomyEntry,
  type SuggestWireRequest,
} from './request.ts';
import { validateSuggestReply, type SuggestRefusalClass } from './reply.ts';

/** What the composition root binds: `@advisor/local-model`'s `SuggestionModelAdapter`, structurally. */
export interface SuggestionModelPort {
  readonly provider: string;
  readonly label: string;
  readonly templateHash: string;
  render(request: SuggestWireRequest): { readonly text: string; readonly hash: string };
  run(
    request: SuggestWireRequest,
    signal: AbortSignal,
  ): Promise<{
    readonly reply: unknown;
    readonly isJson: boolean;
    readonly label: string;
    readonly promptHash: string;
    readonly warnings: readonly string[];
    readonly runtimeMs: number;
  }>;
}

export interface CategorySuggestDependencies {
  readonly switches: RunSwitches;
  /** This holder's suggestion model, or `null`: none configured, or hosted without the consent. */
  readonly model: SuggestionModelPort | null;
  /** Tests only. */
  readonly runWatchPollMs?: number;
}

/** The approvable shape: advisor id, version, kind, scopes, and the suggestion template hash. */
export function categorySuggestShape(templateHash: string | null): string {
  return queryShape({
    advisorId: CATEGORY_SUGGEST_ADVISOR_ID,
    advisorVersion: CATEGORY_SUGGEST_VERSION,
    kind: 'local_model',
    scopes: CATEGORY_SUGGEST_SCOPES,
    promptTemplateHash: templateHash,
  });
}

export type SuggestAnswer =
  | { readonly verdict: 'suggested'; readonly categoryKey: string; readonly reason: string }
  | { readonly verdict: 'abstained' }
  | { readonly verdict: 'refused'; readonly refusal: SuggestRefusalClass };

export interface CategorySuggestResult {
  /** `null` for a measurement, which records no run. */
  readonly runId: string | null;
  readonly status: 'completed' | 'failed' | 'refused' | 'cancelled';
  readonly refusal: string | null;
  readonly cancelReason: CancelReason | null;
  readonly errorCode: string | null;
  readonly digest: string;
  readonly model: string | null;
  /** One answer per input row, in input order. Empty unless `status` is `completed`. */
  readonly answers: readonly SuggestAnswer[];
}

interface GateInputs {
  readonly userId: string;
  readonly shape: string | null;
  /** The run's own row, for level 4. */
  readonly runId: string | null;
  /** A measurement skips level 3's enabled bit and the precision gate (see the header). */
  readonly measuring: boolean;
  readonly precisionGateOpen: boolean;
  readonly modelBound: boolean;
}

async function readSuggestGate(
  executor: InsightsExecutor,
  switches: RunSwitches,
  input: GateInputs,
): Promise<CancelReason | null> {
  const [advisorsEnabled, moduleEnabled, kindEnabled] = await Promise.all([
    switches.advisorsEnabled(),
    switches.moduleEnabled(input.userId),
    switches.kindEnabled(input.userId, 'local_model'),
  ]);
  const row = await findAdvisor(executor, input.userId, CATEGORY_SUGGEST_ADVISOR_ID);
  const payloadApproved =
    input.shape !== null &&
    (await hasLiveApproval(executor, input.userId, CATEGORY_SUGGEST_ADVISOR_ID, input.shape));
  const run = input.runId === null ? null : await findRun(executor, input.userId, input.runId);
  // Level 3 for a run: the row's switch, the precision gate, and the scope grant
  // the Enable switch writes beside it. A measurement asks none of the three.
  const granted =
    input.measuring ||
    (await listGrants(executor, input.userId, CATEGORY_SUGGEST_ADVISOR_ID)).includes(
      'transactions.residue',
    );
  return decideContinue({
    advisorsEnabled,
    moduleEnabled,
    kindEnabled: kindEnabled && input.modelBound,
    advisorEnabled: input.measuring
      ? true
      : (row?.enabled ?? false) && input.precisionGateOpen && granted,
    quarantinedAt: row?.quarantinedAt ?? null,
    payloadApproved,
    cancelRequestedAt: run?.cancelRequestedAt ?? null,
  });
}

async function invokeModel(
  model: SuggestionModelPort,
  request: SuggestWireRequest,
  controller: AbortController,
  timeoutMs: number,
): Promise<Awaited<ReturnType<SuggestionModelPort['run']>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('advisor_timeout'));
      reject(new Error('advisor_timeout'));
    }, timeoutMs);
    onAbort = () => {
      const reason: unknown = controller.signal.reason;
      reject(reason instanceof Error ? reason : new Error('advisor_aborted'));
    };
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([model.run(request, controller.signal), stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) controller.signal.removeEventListener('abort', onAbort);
  }
}

function errorCodeOf(error: unknown): string {
  if (error instanceof RunCancelled) return 'run_cancelled';
  if (error instanceof Error && error.message === 'advisor_timeout') return 'advisor_timeout';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_.:-]{0,63}$/u.test(code)
    ? code
    : 'model_unavailable';
}

function answersOf(
  reply: unknown,
  refs: readonly string[],
  taxonomy: readonly SuggestTaxonomyEntry[],
): { readonly answers: SuggestAnswer[]; readonly refused: number; readonly schema: boolean } {
  const validation = validateSuggestReply(reply, {
    refs,
    categoryKeys: new Set(taxonomy.map((entry) => entry.key)),
  });
  const byRef = new Map<string, SuggestAnswer>();
  for (const suggestion of validation.suggestions) {
    byRef.set(suggestion.ref, {
      verdict: 'suggested',
      categoryKey: suggestion.categoryKey,
      reason: suggestion.reason,
    });
  }
  for (const ref of validation.abstained) byRef.set(ref, { verdict: 'abstained' });
  for (const refusal of validation.refusals) {
    if (refusal.ref !== null && !byRef.has(refusal.ref)) {
      byRef.set(refusal.ref, { verdict: 'refused', refusal: refusal.refusal });
    }
  }
  const answers = refs.map(
    (ref): SuggestAnswer => byRef.get(ref) ?? { verdict: 'refused', refusal: 'missing' },
  );
  return {
    answers,
    refused: answers.filter((answer) => answer.verdict === 'refused').length,
    schema: validation.replyRefusal === 'schema',
  };
}

interface AskInput {
  readonly taxonomy: readonly SuggestTaxonomyEntry[];
  readonly rows: readonly ResidueRowInput[];
}

/** Run one batch for the worker's suggestion job. Writes `advisor_runs` (and the retained payload) only. */
export async function runCategorySuggest(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: CategorySuggestDependencies,
  input: AskInput & {
    readonly trigger: RunTrigger;
    readonly precisionGateOpen: boolean;
  },
): Promise<CategorySuggestResult> {
  const limits = CATEGORY_SUGGEST_MANIFEST.limits;
  const model = dependencies.model;
  const built = buildSuggestRequest({
    taxonomy: input.taxonomy,
    rows: input.rows,
    now: context.clock.now(),
    timeoutMs: limits.timeout_ms,
    maxResponseBytes: limits.max_response_bytes,
  });
  const shape = categorySuggestShape(model?.templateHash ?? null);
  const gate = {
    userId: context.userId,
    shape: model === null ? null : shape,
    measuring: false,
    precisionGateOpen: input.precisionGateOpen,
    modelBound: model !== null,
  };
  const started = context.clock.nowMs();

  // --- transaction 1: the gate and the run row --------------------------------
  const opened = await database.transaction(async (tx) => {
    const run = await startRun(tx, context, {
      advisorId: CATEGORY_SUGGEST_ADVISOR_ID,
      advisorVersion: CATEGORY_SUGGEST_VERSION,
      trigger: input.trigger,
    });
    const refusal = decideRunReason(
      await readSuggestGate(tx, dependencies.switches, {
        ...gate,
        runId: null,
      }),
    );
    if (refusal !== null || model === null) {
      await finishRun(tx, context, {
        runId: run.id,
        status: 'refused',
        refusal: (refusal ?? 'kind_disabled') as never,
        durationMs: 0,
      });
      return { runId: run.id, refusal: refusal ?? 'kind_disabled' };
    }
    const rendered = model.render(built.request);
    await recordRunModel(tx, context, {
      runId: run.id,
      llmModel: model.label,
      llmPromptHash: rendered.hash,
    });
    await retainRunPayload(tx, context, {
      runId: run.id,
      advisorId: CATEGORY_SUGGEST_ADVISOR_ID,
      queryShape: shape,
      payload: built.payload as unknown as Record<string, unknown>,
      payloadBytes: new TextEncoder().encode(JSON.stringify(built.payload)).length,
    });
    return { runId: run.id, refusal: null };
  });
  if (opened.refusal !== null || model === null) {
    return {
      runId: opened.runId,
      status: 'refused',
      refusal: opened.refusal,
      cancelReason: null,
      errorCode: null,
      digest: built.digest,
      model: model?.label ?? null,
      answers: [],
    };
  }
  const runId = opened.runId;

  // --- the call, watched ------------------------------------------------------
  const controller = new AbortController();
  const watch = watchRun({
    controller,
    pollMs: dependencies.runWatchPollMs ?? RUN_WATCH_POLL_MS,
    probe: () => readSuggestGate(database, dependencies.switches, { ...gate, runId }),
  });
  let reply: Awaited<ReturnType<SuggestionModelPort['run']>> | null = null;
  let failure: unknown = null;
  try {
    reply = await invokeModel(model, built.request, controller, limits.timeout_ms);
  } catch (error) {
    failure = error;
  } finally {
    await watch.stop();
  }

  // --- transaction 2: the barrier, then the record ----------------------------
  return database.transaction(async (tx) => {
    const durationMs = Math.max(0, context.clock.nowMs() - started);
    const stoppedBy =
      watch.reason() ??
      (failure instanceof RunCancelled ? failure.reason : null) ??
      (await readSuggestGate(tx, dependencies.switches, { ...gate, runId }));
    if (stoppedBy !== null) {
      await finishRun(tx, context, {
        runId,
        status: 'cancelled',
        cancelReason: stoppedBy as never,
        inputDigest: built.digest,
        grantedScopes: [...CATEGORY_SUGGEST_SCOPES],
        durationMs,
      });
      return {
        runId,
        status: 'cancelled' as const,
        refusal: null,
        cancelReason: stoppedBy,
        errorCode: null,
        digest: built.digest,
        model: model.label,
        answers: [],
      };
    }
    if (reply === null) {
      const errorCode = errorCodeOf(failure);
      await finishRun(tx, context, {
        runId,
        status: 'failed',
        inputDigest: built.digest,
        grantedScopes: [...CATEGORY_SUGGEST_SCOPES],
        errorCode,
        durationMs,
      });
      await tripBreaker(tx, context, false);
      return {
        runId,
        status: 'failed' as const,
        refusal: null,
        cancelReason: null,
        errorCode,
        digest: built.digest,
        model: model.label,
        answers: [],
      };
    }
    const refs = built.request.rows.map((row) => row.transaction_ref);
    const scored = answersOf(reply.reply, refs, built.request.taxonomy);
    await finishRun(tx, context, {
      runId,
      status: 'completed',
      inputDigest: built.digest,
      grantedScopes: [...CATEGORY_SUGGEST_SCOPES],
      emittedScopes: [...CATEGORY_SUGGEST_SCOPES],
      proposedCount: refs.length,
      acceptedCount: scored.answers.filter((answer) => answer.verdict === 'suggested').length,
      rejectedCount: scored.refused,
      rejections: scored.answers.flatMap((answer, index) =>
        answer.verdict === 'refused' ? [{ ref: refs[index], refusal: answer.refusal }] : [],
      ),
      errorCode: scored.schema ? 'reply_schema' : null,
      durationMs,
    });
    // A whole reply outside the format is a failure for the breaker; a row the
    // validator refused is not — a merchant name that talks the model into an
    // unknown key must not be able to switch the feature off for everyone.
    await tripBreaker(tx, context, !scored.schema);
    return {
      runId,
      status: 'completed' as const,
      refusal: null,
      cancelReason: null,
      errorCode: scored.schema ? 'reply_schema' : null,
      digest: built.digest,
      model: model.label,
      answers: scored.answers,
    };
  });
}

/** `decideRun`'s refusal vocabulary from `decideContinue`'s (no run exists yet, so no level 4). */
function decideRunReason(reason: CancelReason | null): CancelReason | null {
  return reason === 'run_cancelled' ? null : reason;
}

async function tripBreaker(
  executor: InsightsExecutor,
  context: InsightsContext,
  succeeded: boolean,
): Promise<void> {
  const failures = await recordRunHealth(executor, context, CATEGORY_SUGGEST_ADVISOR_ID, succeeded);
  if (!succeeded && failures >= BREAKER_THRESHOLDS.local_model.consecutiveFailures) {
    await quarantineAdvisor(executor, context, CATEGORY_SUGGEST_ADVISOR_ID, 'consecutive_failures');
  }
}

/**
 * One batch for the measurement: the same gate (less level 3's enabled bit
 * and the precision gate), the same request, the same call and the same
 * validator — and no write of any kind.
 */
export async function measureCategorySuggest(
  executor: InsightsExecutor,
  context: InsightsContext,
  dependencies: CategorySuggestDependencies & { readonly signal?: AbortSignal },
  input: AskInput,
): Promise<CategorySuggestResult> {
  const limits = CATEGORY_SUGGEST_MANIFEST.limits;
  const model = dependencies.model;
  const built = buildSuggestRequest({
    taxonomy: input.taxonomy,
    rows: input.rows,
    now: context.clock.now(),
    timeoutMs: limits.timeout_ms,
    maxResponseBytes: limits.max_response_bytes,
  });
  const gate = {
    userId: context.userId,
    shape: model === null ? null : categorySuggestShape(model.templateHash),
    runId: null,
    measuring: true,
    precisionGateOpen: false,
    modelBound: model !== null,
  };
  const refused = (refusal: string): CategorySuggestResult => ({
    runId: null,
    status: 'refused',
    refusal,
    cancelReason: null,
    errorCode: null,
    digest: built.digest,
    model: model?.label ?? null,
    answers: [],
  });
  const before = decideRunReason(await readSuggestGate(executor, dependencies.switches, gate));
  if (before !== null) return refused(before);
  if (model === null) return refused('kind_disabled');
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(new Error('advisor_aborted'));
  dependencies.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const watch = watchRun({
    controller,
    pollMs: dependencies.runWatchPollMs ?? RUN_WATCH_POLL_MS,
    probe: () => readSuggestGate(executor, dependencies.switches, gate),
  });
  try {
    const reply = await invokeModel(model, built.request, controller, limits.timeout_ms);
    const after = watch.reason() ?? (await readSuggestGate(executor, dependencies.switches, gate));
    if (after !== null) {
      return { ...refused(after), status: 'cancelled', refusal: null, cancelReason: after };
    }
    const refs = built.request.rows.map((row) => row.transaction_ref);
    const scored = answersOf(reply.reply, refs, built.request.taxonomy);
    return {
      runId: null,
      status: 'completed',
      refusal: null,
      cancelReason: null,
      errorCode: scored.schema ? 'reply_schema' : null,
      digest: built.digest,
      model: model.label,
      answers: scored.answers,
    };
  } catch (error) {
    const reason = watch.reason();
    if (reason !== null) {
      return { ...refused(reason), status: 'cancelled', refusal: null, cancelReason: reason };
    }
    return {
      ...refused('failed'),
      status: 'failed',
      refusal: null,
      errorCode: errorCodeOf(error),
    };
  } finally {
    dependencies.signal?.removeEventListener('abort', onOuterAbort);
    await watch.stop();
  }
}
