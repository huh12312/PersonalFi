// SPDX-License-Identifier: MIT
/**
 * Running `merchant.name` for one descriptor: the kill ladder, the approval,
 * the run inspector, the call and the validator — in that order, and nothing
 * written but `advisor_runs` (the composition root records the answer in the
 * ledger's `merchant_name_suggestions`).
 *
 *   1. **Gate**, read through `decideContinue` as every `local_model` run reads
 *      it: level 1 (`ADVISORS_ENABLED`, `module.insights`), level 2 (the
 *      `local_model` kind switch, and a local model bound for this holder — Off
 *      is off, and a hosted narrator binds none), level 3 (`advisors.enabled`
 *      for `merchant.name`, and its quarantine), then the payload approval for
 *      the shape this run would send. A refusal is an `advisor_runs` row.
 *   2. **The run row** — `advisor_runs` with the payload's digest, the prompt
 *      hash and the model before the call; the payload retained 30 days for the
 *      inspector (`inspectRunPayload` re-derives the digest).
 *   3. **The call**, raced against the manifest's deadline and the watcher
 *      (every switch and the run's own cancel flag, once a second).
 *   4. **The barrier** — the switches once more after the reply; a kill that
 *      landed during the call discards everything the model said.
 *   5. **Validation** (`reply.ts`): a substring-preserving name, an abstention,
 *      or a named refusal.
 *
 * A failed call or a reply outside the format counts for the breaker (three in
 * a row quarantine the advisor); a name the validator refused does not — a
 * hostile descriptor must not be able to switch the feature off.
 */
import {
  BREAKER_THRESHOLDS,
  decideContinue,
  type CancelReason,
  type RunSwitches,
} from '../../policy/kill-switches.ts';
import { RUN_WATCH_POLL_MS, RunCancelled, watchRun } from '../../policy/run-watch.ts';
import { hasLiveApproval, queryShape } from '../../preview.ts';
import type { InsightsContext, InsightsDatabase, InsightsExecutor } from '../../db.ts';
import {
  findAdvisor,
  findRun,
  finishRun,
  quarantineAdvisor,
  recordRunHealth,
  recordRunModel,
  retainRunPayload,
  startRun,
} from '../../store.ts';
import type { RunTrigger } from '../../../schema/index.ts';
import {
  MERCHANT_NAME_ADVISOR_ID,
  MERCHANT_NAME_MANIFEST,
  MERCHANT_NAME_SCOPES,
  MERCHANT_NAME_VERSION,
  merchantNameShapeTemplateHash,
} from './manifest.ts';
import { buildMerchantNameRequest, type MerchantNameWireRequest } from './request.ts';
import { validateMerchantNameReply, type MerchantNameVerdict } from './reply.ts';

/** What the composition root binds: `@advisor/local-model`'s `MerchantNameModelAdapter`, structurally. */
export interface MerchantNameModelPort {
  /** Always the local model: the query type has no hosted path. */
  readonly provider: 'ollama';
  readonly label: string;
  readonly templateHash: string;
  render(request: MerchantNameWireRequest): { readonly text: string; readonly hash: string };
  run(
    request: MerchantNameWireRequest,
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

/** The renderer half: what the api binds (it never calls a model). */
export type MerchantNameRenderer = Pick<
  MerchantNameModelPort,
  'provider' | 'label' | 'templateHash' | 'render'
>;

export interface MerchantNameDependencies {
  readonly switches: RunSwitches;
  /** This holder's local model, or `null`: Off, nothing configured, or a hosted narrator. */
  readonly model: MerchantNameModelPort | null;
  /** Tests only. */
  readonly runWatchPollMs?: number;
}

/** The approvable shape: advisor id, version, kind, scopes, and the template + consent hash. */
export function merchantNameShape(adapterTemplateHash: string | null): string {
  return queryShape({
    advisorId: MERCHANT_NAME_ADVISOR_ID,
    advisorVersion: MERCHANT_NAME_VERSION,
    kind: 'local_model',
    scopes: MERCHANT_NAME_SCOPES,
    promptTemplateHash:
      adapterTemplateHash === null ? null : merchantNameShapeTemplateHash(adapterTemplateHash),
  });
}

interface GateInputs {
  readonly userId: string;
  readonly shape: string | null;
  readonly runId: string | null;
  readonly modelBound: boolean;
}

async function readMerchantNameGate(
  executor: InsightsExecutor,
  switches: RunSwitches,
  input: GateInputs,
): Promise<CancelReason | null> {
  const [advisorsEnabled, moduleEnabled, kindEnabled] = await Promise.all([
    switches.advisorsEnabled(),
    switches.moduleEnabled(input.userId),
    switches.kindEnabled(input.userId, 'local_model'),
  ]);
  const row = await findAdvisor(executor, input.userId, MERCHANT_NAME_ADVISOR_ID);
  const payloadApproved =
    input.shape !== null &&
    (await hasLiveApproval(executor, input.userId, MERCHANT_NAME_ADVISOR_ID, input.shape));
  const run = input.runId === null ? null : await findRun(executor, input.userId, input.runId);
  return decideContinue({
    advisorsEnabled,
    moduleEnabled,
    kindEnabled: kindEnabled && input.modelBound,
    advisorEnabled: row?.enabled ?? false,
    quarantinedAt: row?.quarantinedAt ?? null,
    payloadApproved,
    cancelRequestedAt: run?.cancelRequestedAt ?? null,
  });
}

/**
 * Could a suggestion be asked for now? The job asks before it lists anything
 * and the api's list route reports it where a chip would be. `null` means yes.
 */
export async function merchantNameUnavailable(
  executor: InsightsExecutor,
  switches: RunSwitches,
  input: { readonly userId: string; readonly templateHash: string | null },
): Promise<CancelReason | null> {
  const reason = await readMerchantNameGate(executor, switches, {
    userId: input.userId,
    shape: input.templateHash === null ? null : merchantNameShape(input.templateHash),
    runId: null,
    modelBound: input.templateHash !== null,
  });
  return reason === 'run_cancelled' ? null : reason;
}

export interface MerchantNameResult {
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'refused' | 'cancelled';
  /** The gate's refusal, when `status` is `refused`. */
  readonly refusal: CancelReason | null;
  readonly cancelReason: CancelReason | null;
  readonly errorCode: string | null;
  readonly digest: string;
  readonly model: string | null;
  /** The validator's verdict; `null` unless `status` is `completed`. */
  readonly answer: MerchantNameVerdict | null;
}

async function invokeModel(
  model: MerchantNameModelPort,
  request: MerchantNameWireRequest,
  controller: AbortController,
  timeoutMs: number,
): Promise<Awaited<ReturnType<MerchantNameModelPort['run']>>> {
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

async function tripBreaker(
  executor: InsightsExecutor,
  context: InsightsContext,
  succeeded: boolean,
): Promise<void> {
  const failures = await recordRunHealth(executor, context, MERCHANT_NAME_ADVISOR_ID, succeeded);
  if (!succeeded && failures >= BREAKER_THRESHOLDS.local_model.consecutiveFailures) {
    await quarantineAdvisor(executor, context, MERCHANT_NAME_ADVISOR_ID, 'consecutive_failures');
  }
}

/** Ask about one descriptor. Writes `advisor_runs` (and the retained payload) only. */
export async function runMerchantName(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: MerchantNameDependencies,
  input: {
    readonly descriptor: string;
    readonly strippedPrefix: string | null;
    readonly trigger: RunTrigger;
  },
): Promise<MerchantNameResult> {
  const limits = MERCHANT_NAME_MANIFEST.limits;
  const model = dependencies.model;
  const built = buildMerchantNameRequest({
    descriptor: input.descriptor,
    strippedPrefix: input.strippedPrefix,
    now: context.clock.now(),
    timeoutMs: limits.timeout_ms,
    maxResponseBytes: limits.max_response_bytes,
  });
  const shape = merchantNameShape(model?.templateHash ?? null);
  const gate = {
    userId: context.userId,
    shape: model === null ? null : shape,
    modelBound: model !== null,
  };
  const started = context.clock.nowMs();

  // --- transaction 1: the gate and the run row --------------------------------
  const opened = await database.transaction(async (tx) => {
    const run = await startRun(tx, context, {
      advisorId: MERCHANT_NAME_ADVISOR_ID,
      advisorVersion: MERCHANT_NAME_VERSION,
      trigger: input.trigger,
    });
    const gated = await readMerchantNameGate(tx, dependencies.switches, { ...gate, runId: null });
    const refusal = gated === 'run_cancelled' ? null : gated;
    if (refusal !== null || model === null) {
      await finishRun(tx, context, {
        runId: run.id,
        status: 'refused',
        refusal: (refusal ?? 'kind_disabled') as never,
        durationMs: 0,
      });
      return { runId: run.id, refusal: refusal ?? ('kind_disabled' as CancelReason) };
    }
    const rendered = model.render(built.request);
    await recordRunModel(tx, context, {
      runId: run.id,
      llmModel: model.label,
      llmPromptHash: rendered.hash,
    });
    await retainRunPayload(tx, context, {
      runId: run.id,
      advisorId: MERCHANT_NAME_ADVISOR_ID,
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
      answer: null,
    };
  }
  const runId = opened.runId;

  // --- the call, watched ------------------------------------------------------
  const controller = new AbortController();
  const watch = watchRun({
    controller,
    pollMs: dependencies.runWatchPollMs ?? RUN_WATCH_POLL_MS,
    probe: () => readMerchantNameGate(database, dependencies.switches, { ...gate, runId }),
  });
  let reply: Awaited<ReturnType<MerchantNameModelPort['run']>> | null = null;
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
      (await readMerchantNameGate(tx, dependencies.switches, { ...gate, runId }));
    const base = { runId, digest: built.digest, model: model.label } as const;
    if (stoppedBy !== null) {
      await finishRun(tx, context, {
        runId,
        status: 'cancelled',
        cancelReason: stoppedBy as never,
        inputDigest: built.digest,
        grantedScopes: [...MERCHANT_NAME_SCOPES],
        durationMs,
      });
      return {
        ...base,
        status: 'cancelled' as const,
        refusal: null,
        cancelReason: stoppedBy,
        errorCode: null,
        answer: null,
      };
    }
    if (reply === null) {
      const errorCode = errorCodeOf(failure);
      await finishRun(tx, context, {
        runId,
        status: 'failed',
        inputDigest: built.digest,
        grantedScopes: [...MERCHANT_NAME_SCOPES],
        errorCode,
        durationMs,
      });
      await tripBreaker(tx, context, false);
      return {
        ...base,
        status: 'failed' as const,
        refusal: null,
        cancelReason: null,
        errorCode,
        answer: null,
      };
    }
    const answer = validateMerchantNameReply(reply.reply, { descriptor: built.request.descriptor });
    const schema = answer.verdict === 'refused' && answer.refusal === 'schema';
    await finishRun(tx, context, {
      runId,
      status: 'completed',
      inputDigest: built.digest,
      grantedScopes: [...MERCHANT_NAME_SCOPES],
      emittedScopes: [...MERCHANT_NAME_SCOPES],
      proposedCount: 1,
      acceptedCount: answer.verdict === 'suggested' ? 1 : 0,
      rejectedCount: answer.verdict === 'refused' ? 1 : 0,
      rejections:
        answer.verdict === 'refused' ? [{ ref: 'descriptor', refusal: answer.refusal }] : [],
      errorCode: schema ? 'reply_schema' : null,
      durationMs,
    });
    await tripBreaker(tx, context, !schema);
    return {
      ...base,
      status: 'completed' as const,
      refusal: null,
      cancelReason: null,
      errorCode: schema ? 'reply_schema' : null,
      answer,
    };
  });
}
