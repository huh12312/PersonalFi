// SPDX-License-Identifier: MIT
/**
 * Running one Ask PersonalFi question (WP 11.5c): compile → the catalogue
 * calls → narrate, in the worker, one model call per step. Each model step is
 * `brief.narrate`'s run, step for step (11 §2 rule 3: same gate, same ladder,
 * same evidence):
 *
 *   1. **Gate** (transaction 1, under the step's advisor row lock), through
 *      `decideContinue` as every `local_model` run reads it — levels 1–3 and
 *      this step's approved shape. A refusal is an `advisor_runs` row; the
 *      session finishes `failed` with the reason and nothing is sent.
 *   2. **The run row and the claim** — `advisor_runs` with the payload's
 *      digest, the prompt hash and the model; the payload retained for the
 *      inspector; the step claimed on the session (`claimAskStep`). A step
 *      already claimed is never asked again: the session finishes `failed`
 *      (`step_interrupted`) instead.
 *   3. **The call**, raced against the manifest's deadline and the watcher
 *      (kill level 4).
 *   4. **The barrier** (transaction 2) — a kill that landed during the call
 *      discards the reply (`cancelled`); then the validator, the run's
 *      outcome and the session's transition, together.
 *
 * Between the two model steps the app runs the compiled calls itself,
 * in process, through `callCatalogueByName` — the 11.5b gate, which re-reads
 * the holder's grant: a function the holder has not granted was never listed
 * to the compiler and is refused here too. Nothing is written but
 * `advisor_runs` (and its retained payloads) and `ask_sessions`.
 */
import type { CatalogueRuntimeDependencies } from '../../catalogue/catalogue.ts';
import { callCatalogueByName, listCatalogue } from '../../catalogue/catalogue.ts';
import { isCatalogueRefusal } from '../../catalogue/ports.ts';
import { CATALOGUE_VERSION } from '../../catalogue/version.ts';
import { knowledgeCatalogueOf } from '../../knowledge/citations.ts';
import type { ParameterCitation } from '../../knowledge/params.ts';
import {
  isKnowledgeRefusal,
  type KnowledgeBase,
  type ReviewedPlaybookPage,
} from '../../knowledge/playbook.ts';
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
  lockAdvisor,
  quarantineAdvisor,
  recordRunHealth,
  recordRunModel,
  retainRunPayload,
  startRun,
} from '../../store.ts';
import type { RunTrigger } from '../../../schema/index.ts';
import { todayIn } from '@core/kernel';
import { narratorGrantCeiling } from '../local/grant.ts';
import {
  askCompileSubjectOf,
  buildAskCompileRequest,
  validateAskCompileReply,
  type AskCompileWireRequest,
  type AskCompiledCall,
} from './compile.ts';
import {
  ASK_COMPILE_ADVISOR_ID,
  ASK_COMPILE_MANIFEST,
  ASK_COMPILE_VERSION,
  ASK_NARRATE_ADVISOR_ID,
  ASK_NARRATE_MANIFEST,
  ASK_NARRATE_VERSION,
  ASK_SCOPES,
  askShapeTemplateHash,
  type AskStep,
} from './manifest.ts';
import {
  buildAskNarrateRequest,
  validateAskNarrateReply,
  type AskKnowledgeSent,
  type AskNarrateWireRequest,
} from './narrate.ts';
import { ASK_TOPIC_WORDS, precheckQuestion } from './precheck.ts';
import { askRefusedViewOf, askResultViewOf, type AskResultView } from './results.ts';
import { ASK_FUNCTION_PAGES, type AskNearestScreen } from './screens.ts';
import {
  advanceAskSession,
  claimAskStep,
  findAskSession,
  finishAskSession,
  type AskSessionFields,
  type StoredAskSession,
} from './source.ts';

/** One model step's adapter, structurally `@advisor/local-model`'s `AskCompileModelAdapter` / `AskNarrateModelAdapter`. */
export interface AskModelPort<Req> {
  readonly provider: string;
  readonly label: string;
  readonly templateHash: string;
  render(request: Req): { readonly text: string; readonly hash: string };
  run(
    request: Req,
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
export type AskCompileModelPort = AskModelPort<AskCompileWireRequest>;
export type AskNarrateModelPort = AskModelPort<AskNarrateWireRequest>;

/** The renderer half: what the api binds (it never calls a model). */
export type AskRenderer<Req> = Pick<
  AskModelPort<Req>,
  'provider' | 'label' | 'templateHash' | 'render'
>;

export interface AskRunDependencies {
  readonly switches: RunSwitches;
  /** This holder's models — the narrator's provider — or `null` (Off, or nothing configured). */
  readonly compileModel: AskCompileModelPort | null;
  readonly narrateModel: AskNarrateModelPort | null;
  /** The catalogue's runtime (11.5b): the calls run in process, under the holder's grants. */
  readonly catalogue: CatalogueRuntimeDependencies;
  /** The knowledge base (11.5a), or `null`: then nothing is cited and a marker is refused. */
  readonly knowledge: KnowledgeBase | null;
  /** Tests only. */
  readonly runWatchPollMs?: number;
}

// ---------------------------------------------------------------------------
// Shapes and the gate
// ---------------------------------------------------------------------------

const STEP = Object.freeze({
  compile: {
    advisorId: ASK_COMPILE_ADVISOR_ID,
    version: ASK_COMPILE_VERSION,
    manifest: ASK_COMPILE_MANIFEST,
  },
  narrate: {
    advisorId: ASK_NARRATE_ADVISOR_ID,
    version: ASK_NARRATE_VERSION,
    manifest: ASK_NARRATE_MANIFEST,
  },
});

/** The approvable shape of one step: advisor id, version, kind, the scope bound, and the template + consent hash. */
export function askShape(step: AskStep, adapterTemplateHash: string | null): string {
  return queryShape({
    advisorId: STEP[step].advisorId,
    advisorVersion: STEP[step].version,
    kind: 'local_model',
    scopes: ASK_SCOPES,
    promptTemplateHash:
      adapterTemplateHash === null ? null : askShapeTemplateHash(step, adapterTemplateHash),
  });
}

async function readGate(
  executor: InsightsExecutor,
  switches: RunSwitches,
  input: {
    readonly step: AskStep;
    readonly userId: string;
    readonly shape: string | null;
    readonly runId: string | null;
    readonly modelBound: boolean;
  },
): Promise<CancelReason | null> {
  const advisorId = STEP[input.step].advisorId;
  const [advisorsEnabled, moduleEnabled, kindEnabled] = await Promise.all([
    switches.advisorsEnabled(),
    switches.moduleEnabled(input.userId),
    switches.kindEnabled(input.userId, 'local_model'),
  ]);
  const row = await findAdvisor(executor, input.userId, advisorId);
  const payloadApproved =
    input.shape !== null && (await hasLiveApproval(executor, input.userId, advisorId, input.shape));
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

export type AskUnavailableReason = CancelReason | 'scope_not_granted';

/**
 * Could this holder ask now? `null` means yes. Both steps must be callable:
 * the api's "unavailable" (and its link to Advisor management) reads this
 * before a session is created.
 */
export async function askUnavailable(
  executor: InsightsExecutor,
  switches: RunSwitches,
  input: {
    readonly userId: string;
    readonly compileTemplateHash: string | null;
    readonly narrateTemplateHash: string | null;
  },
): Promise<{ readonly step: AskStep | null; readonly reason: AskUnavailableReason } | null> {
  for (const step of ['compile', 'narrate'] as const) {
    const hash = step === 'compile' ? input.compileTemplateHash : input.narrateTemplateHash;
    const reason = await readGate(executor, switches, {
      step,
      userId: input.userId,
      shape: hash === null ? null : askShape(step, hash),
      runId: null,
      modelBound: hash !== null,
    });
    if (reason !== null && reason !== 'run_cancelled') return { step, reason };
  }
  if ((await narratorGrantCeiling(executor, input.userId)).length === 0) {
    return { step: null, reason: 'scope_not_granted' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// One model step
// ---------------------------------------------------------------------------

type StepVerdict = {
  readonly ok: boolean;
  readonly refusal: string | null;
  readonly schema: boolean;
};

type StepFinish =
  | { readonly kind: 'cancelled'; readonly reason: CancelReason }
  | { readonly kind: 'failed'; readonly errorCode: string }
  | { readonly kind: 'replied'; readonly reply: unknown };

type StepOutcome =
  | { readonly kind: 'gate'; readonly reason: CancelReason; readonly runId: string }
  | { readonly kind: 'claimed_already' }
  | { readonly kind: 'done'; readonly runId: string };

async function invokeModel<Req>(
  model: AskModelPort<Req>,
  request: Req,
  controller: AbortController,
  timeoutMs: number,
): Promise<Awaited<ReturnType<AskModelPort<Req>['run']>>> {
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
  advisorId: string,
  succeeded: boolean,
): Promise<void> {
  const failures = await recordRunHealth(executor, context, advisorId, succeeded);
  if (!succeeded && failures >= BREAKER_THRESHOLDS.local_model.consecutiveFailures) {
    await quarantineAdvisor(executor, context, advisorId, 'consecutive_failures');
  }
}

async function runModelStep<Req>(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: AskRunDependencies,
  input: {
    readonly step: AskStep;
    readonly sessionId: string;
    readonly model: AskModelPort<Req>;
    readonly built: {
      readonly request: Req;
      readonly payload: { readonly granted_scopes: readonly string[] };
      readonly digest: string;
    };
    readonly trigger: RunTrigger;
    readonly validate: (reply: unknown) => StepVerdict;
    /** Writes the session's transition, inside the barrier's transaction. */
    readonly onFinish: (tx: InsightsExecutor, finish: StepFinish) => Promise<void>;
  },
): Promise<StepOutcome> {
  const { step, model, built } = input;
  const { advisorId, version, manifest } = STEP[step];
  const shape = askShape(step, model.templateHash);
  const gate = { step, userId: context.userId, shape, modelBound: true } as const;
  const scopes = [...built.payload.granted_scopes];
  const started = context.clock.nowMs();

  // --- 1–2. transaction 1: the lock, the gate, the run row, the claim -----------
  const opened = await database.transaction(async (tx) => {
    await lockAdvisor(tx, context.userId, advisorId);
    const run = await startRun(tx, context, {
      advisorId,
      advisorVersion: version,
      trigger: input.trigger,
    });
    const reason = await readGate(tx, dependencies.switches, { ...gate, runId: null });
    const refusal = reason === 'run_cancelled' ? null : reason;
    if (refusal !== null) {
      await finishRun(tx, context, {
        runId: run.id,
        status: 'refused',
        refusal: refusal as never,
        durationMs: 0,
      });
      return { kind: 'gate' as const, reason: refusal, runId: run.id };
    }
    const rendered = model.render(built.request);
    await recordRunModel(tx, context, {
      runId: run.id,
      llmModel: model.label,
      llmPromptHash: rendered.hash,
    });
    await retainRunPayload(tx, context, {
      runId: run.id,
      advisorId,
      queryShape: shape,
      payload: built.payload as unknown as Record<string, unknown>,
      payloadBytes: new TextEncoder().encode(JSON.stringify(built.payload)).length,
    });
    const claimed = await claimAskStep(tx, {
      userId: context.userId,
      sessionId: input.sessionId,
      step,
      runId: run.id,
      inputDigest: built.digest,
      provider: model.provider,
      model: model.label,
    });
    if (!claimed) {
      // The step was claimed by an earlier job: nothing may be asked again.
      await finishRun(tx, context, {
        runId: run.id,
        status: 'refused',
        refusal: 'advisor_disabled' as never,
        durationMs: 0,
      });
      return { kind: 'claimed_already' as const };
    }
    return { kind: 'open' as const, runId: run.id };
  });
  if (opened.kind !== 'open') return opened;
  const runId = opened.runId;

  // --- 3. the call, watched ----------------------------------------------------
  const controller = new AbortController();
  const watch = watchRun({
    controller,
    pollMs: dependencies.runWatchPollMs ?? RUN_WATCH_POLL_MS,
    probe: () => readGate(database, dependencies.switches, { ...gate, runId }),
  });
  let reply: Awaited<ReturnType<AskModelPort<Req>['run']>> | null = null;
  let failure: unknown = null;
  try {
    reply = await invokeModel(model, built.request, controller, manifest.limits.timeout_ms);
  } catch (error) {
    failure = error;
  } finally {
    await watch.stop();
  }

  // --- 4. transaction 2: the barrier, the record, the session ------------------
  await database.transaction(async (tx) => {
    const durationMs = Math.max(0, context.clock.nowMs() - started);
    const stoppedBy =
      watch.reason() ??
      (failure instanceof RunCancelled ? failure.reason : null) ??
      (await readGate(tx, dependencies.switches, { ...gate, runId }));
    if (stoppedBy !== null) {
      await finishRun(tx, context, {
        runId,
        status: 'cancelled',
        cancelReason: stoppedBy as never,
        inputDigest: built.digest,
        grantedScopes: scopes,
        durationMs,
      });
      await input.onFinish(tx, { kind: 'cancelled', reason: stoppedBy });
      return;
    }
    if (reply === null) {
      const errorCode = errorCodeOf(failure);
      await finishRun(tx, context, {
        runId,
        status: 'failed',
        inputDigest: built.digest,
        grantedScopes: scopes,
        errorCode,
        durationMs,
      });
      await tripBreaker(tx, context, advisorId, false);
      await input.onFinish(tx, { kind: 'failed', errorCode });
      return;
    }
    const verdict = input.validate(reply.reply);
    await finishRun(tx, context, {
      runId,
      status: 'completed',
      inputDigest: built.digest,
      grantedScopes: scopes,
      emittedScopes: scopes,
      proposedCount: 1,
      acceptedCount: verdict.ok ? 1 : 0,
      rejectedCount: verdict.ok ? 0 : 1,
      rejections: verdict.ok ? [] : [{ refusal: verdict.refusal }],
      errorCode: verdict.schema ? 'reply_schema' : null,
      durationMs,
    });
    // A reply outside the format is a failure for the breaker; one the validator
    // refused on its content is not (a hostile question must not switch the feature off).
    await tripBreaker(tx, context, advisorId, !verdict.schema);
    await input.onFinish(tx, { kind: 'replied', reply: reply.reply });
  });
  return { kind: 'done', runId };
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

export interface AskRunResult {
  readonly status: 'not_found' | 'already' | StoredAskSession['status'];
  readonly session: StoredAskSession | null;
  /** How many model calls this pass made (0, 1 or 2). */
  readonly modelCalls: number;
}

/** The knowledge the results rest on: reviewed pages (none today) and the parameters read. */
export function askKnowledgeFor(
  knowledge: KnowledgeBase | null,
  results: readonly AskResultView[],
): AskKnowledgeSent {
  if (knowledge === null) return { pages: [], params: [], withheld: [] };
  const pages: ReviewedPlaybookPage[] = [];
  const withheld: { key: string; code: string }[] = [];
  const pageKeys = [
    ...new Set(
      results.flatMap((result) => {
        const key = ASK_FUNCTION_PAGES[result.function];
        return key === undefined || result.status !== 'ok' ? [] : [key];
      }),
    ),
  ];
  for (const key of pageKeys) {
    try {
      pages.push(knowledge.playbook.get(key));
    } catch (error) {
      if (!isKnowledgeRefusal(error)) throw error;
      // A draft is refused by the review gate (`playbook.unreviewed`): it is
      // never sent, and the session says which pages were withheld and why.
      withheld.push({ key, code: error.code });
    }
  }
  const params: ParameterCitation[] = [];
  for (const key of [...new Set(results.flatMap((result) => result.parameter_keys))]) {
    try {
      params.push(knowledge.params.get(key));
    } catch (error) {
      if (!isKnowledgeRefusal(error)) throw error;
    }
  }
  return { pages, params, withheld };
}

async function runCalls(
  dependencies: AskRunDependencies,
  context: InsightsContext,
  calls: readonly AskCompiledCall[],
): Promise<readonly AskResultView[]> {
  const results: AskResultView[] = [];
  for (const call of calls) {
    try {
      const envelope = await callCatalogueByName(
        dependencies.catalogue,
        { userId: context.userId, correlationId: context.correlationId },
        call.name,
        call.args,
      );
      results.push(askResultViewOf(call.name, call.args, envelope));
    } catch (error) {
      if (isCatalogueRefusal(error)) {
        results.push(
          askRefusedViewOf(call.name, call.args, { code: error.code, message: error.message }),
        );
        continue;
      }
      const code = (error as { code?: unknown } | null)?.code;
      results.push(
        askRefusedViewOf(call.name, call.args, {
          code: typeof code === 'string' ? code.slice(0, 64) : 'catalogue.error',
          message: 'The calculation failed.',
        }),
      );
    }
  }
  return results;
}

function precheckFinish(
  question: string,
):
  | { status: 'refused'; fields: AskSessionFields }
  | { status: 'unanswerable'; fields: AskSessionFields }
  | null {
  const pre = precheckQuestion(question);
  if (pre.kind === 'refused') return { status: 'refused', fields: { refusal: pre.refusal } };
  if (pre.kind === 'out_of_scope') {
    return {
      status: 'unanswerable',
      fields: {
        unanswerable: {
          reason: 'out_of_scope',
          topic: pre.topic,
          nearestScreen: ASK_TOPIC_WORDS[pre.topic].screen,
        },
      },
    };
  }
  return null;
}

/**
 * Answer one question. Writes `advisor_runs` (and its retained payloads) and
 * `ask_sessions` only, and asks a model at most once per step.
 */
export async function runAskSession(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: AskRunDependencies,
  input: { readonly sessionId: string; readonly trigger: RunTrigger },
): Promise<AskRunResult> {
  const { sessionId } = input;
  let modelCalls = 0;
  const done = async (): Promise<AskRunResult> => {
    const session = await findAskSession(database, context.userId, sessionId);
    return { status: session?.status ?? 'not_found', session, modelCalls };
  };
  const finish = (
    status: Parameters<typeof finishAskSession>[2]['status'],
    fields: AskSessionFields,
    executor: InsightsExecutor = database,
  ) => finishAskSession(executor, context, { sessionId, status, fields });

  const session = await findAskSession(database, context.userId, sessionId);
  if (session === null) return { status: 'not_found', session: null, modelCalls };
  const claimed =
    session.status === 'running' ||
    session.status === 'narrating' ||
    (session.status === 'compiling' && session.compileRunId !== null);
  if (claimed) {
    // Another pass holds this question (or held it and died). A claimed step is
    // never asked again: a live one is left alone; one older than any step's
    // deadline allows is closed `failed`, so the screen stops waiting.
    if (context.clock.nowMs() - session.createdAt.getTime() > ASK_STALE_AFTER_MS) {
      await finish('failed', { errorCode: 'step_interrupted' });
      return done();
    }
    return { status: 'already', session, modelCalls };
  }
  if (session.status !== 'compiling') return { status: 'already', session, modelCalls };

  // --- the deterministic pre-check, again ----------------------------------------
  const pre = precheckFinish(session.question);
  if (pre !== null) {
    await finish(pre.status, pre.fields);
    return done();
  }

  // --- compile ---------------------------------------------------------------------
  const compileStarted = context.clock.nowMs();
  const listing = await listCatalogue(dependencies.catalogue, { userId: context.userId });
  if (listing.functions.length === 0) {
    await finish('failed', { errorCode: 'scope_not_granted' });
    return done();
  }
  const compileModel = dependencies.compileModel;
  if (compileModel === null || dependencies.narrateModel === null) {
    await finish('failed', { errorCode: 'kind_disabled' });
    return done();
  }
  const today = todayIn(context.clock, dependencies.catalogue.timeZone);
  const compileBuilt = buildAskCompileRequest({
    subject: askCompileSubjectOf({ question: session.question, today, listing }),
    now: context.clock.now(),
    timeoutMs: ASK_COMPILE_MANIFEST.limits.timeout_ms,
    maxResponseBytes: ASK_COMPILE_MANIFEST.limits.max_response_bytes,
  });
  let compiled: readonly AskCompiledCall[] | null = null;
  const compileStep = await runModelStep(database, context, dependencies, {
    step: 'compile',
    sessionId,
    model: compileModel,
    built: compileBuilt,
    trigger: input.trigger,
    validate: (reply) => {
      const verdict = validateAskCompileReply(reply, compileBuilt.check);
      return {
        ok: verdict.ok,
        refusal: verdict.ok ? null : verdict.refusal,
        schema: !verdict.ok && verdict.refusal === 'compile.schema',
      };
    },
    onFinish: async (tx, outcome) => {
      const compileMs = context.clock.nowMs() - compileStarted;
      if (outcome.kind === 'cancelled') {
        await finish('cancelled', { errorCode: outcome.reason, compileMs }, tx);
        return;
      }
      if (outcome.kind === 'failed') {
        await finish('failed', { errorCode: outcome.errorCode, compileMs }, tx);
        return;
      }
      const verdict = validateAskCompileReply(outcome.reply, compileBuilt.check);
      if (!verdict.ok) {
        await finish('refused', { refusal: verdict.refusal, compileMs }, tx);
        return;
      }
      if (verdict.kind === 'unanswerable') {
        await finish(
          'unanswerable',
          {
            compiledCalls: [],
            unanswerable: {
              reason: verdict.reason,
              topic: null,
              nearestScreen: verdict.nearestScreen,
            },
            compileMs,
          },
          tx,
        );
        return;
      }
      compiled = verdict.calls;
      await advanceAskSession(tx, {
        userId: context.userId,
        sessionId,
        from: 'compiling',
        to: 'running',
        fields: { compiledCalls: verdict.calls, compileMs },
      });
    },
  });
  if (compileStep.kind === 'gate') {
    await finish('failed', { errorCode: compileStep.reason });
    return done();
  }
  if (compileStep.kind === 'claimed_already') return done();
  modelCalls += 1;
  const calls = compiled as readonly AskCompiledCall[] | null;
  if (calls === null) return done();

  // --- the calls: deterministic, in process, under the holder's grants -------------
  const callsStarted = context.clock.nowMs();
  const results = await runCalls(dependencies, context, calls);
  const callsMs = context.clock.nowMs() - callsStarted;
  const answered = results.filter((result) => result.status === 'ok');
  if (answered.length === 0) {
    const screen: AskNearestScreen = results[0]?.screen ?? '/';
    await finish('unanswerable', {
      results,
      unanswerable: { reason: 'not_computable', topic: null, nearestScreen: screen },
      callsMs,
    });
    return done();
  }
  const ceiling = new Set<string>(await narratorGrantCeiling(database, context.userId));
  if (results.some((result) => result.scopes.some((scope) => !ceiling.has(scope)))) {
    // Unreachable through `callCatalogueByName`'s gate; the narration's own bound, kept anyway.
    await finish('failed', { results, errorCode: 'scope_not_granted', callsMs });
    return done();
  }
  const advanced = await advanceAskSession(database, {
    userId: context.userId,
    sessionId,
    from: 'running',
    to: 'narrating',
    fields: { results, callsMs },
  });
  if (!advanced) return done();

  // --- narrate -------------------------------------------------------------------
  const narrateStarted = context.clock.nowMs();
  const knowledge = askKnowledgeFor(dependencies.knowledge, results);
  const narrateBuilt = buildAskNarrateRequest({
    question: session.question,
    date: today,
    results,
    knowledge,
    knowledgeCatalogue:
      dependencies.knowledge === null ? null : knowledgeCatalogueOf(dependencies.knowledge),
    now: context.clock.now(),
    timeoutMs: ASK_NARRATE_MANIFEST.limits.timeout_ms,
    maxResponseBytes: ASK_NARRATE_MANIFEST.limits.max_response_bytes,
  });
  const narrateModel = dependencies.narrateModel;
  const readRecord = (record: Record<string, unknown> | null): Record<string, unknown> => ({
    read: record,
    withheld_pages: knowledge.withheld.map((entry) => ({ key: entry.key, code: entry.code })),
  });
  const narrateStep = await runModelStep(database, context, dependencies, {
    step: 'narrate',
    sessionId,
    model: narrateModel,
    built: narrateBuilt,
    trigger: input.trigger,
    validate: (reply) => {
      const verdict = validateAskNarrateReply(reply, narrateBuilt.check);
      return {
        ok: verdict.ok,
        refusal: verdict.ok ? null : verdict.refusal,
        schema: !verdict.ok && verdict.refusal === 'narrate.schema',
      };
    },
    onFinish: async (tx, outcome) => {
      const narrateMs = context.clock.nowMs() - narrateStarted;
      if (outcome.kind === 'cancelled') {
        await finish('cancelled', { errorCode: outcome.reason, narrateMs }, tx);
        return;
      }
      if (outcome.kind === 'failed') {
        await finish('failed', { errorCode: outcome.errorCode, narrateMs }, tx);
        return;
      }
      const verdict = validateAskNarrateReply(outcome.reply, narrateBuilt.check);
      if (!verdict.ok) {
        await finish(
          'refused',
          { refusal: verdict.refusal, narrateMs, knowledgeRead: readRecord(null) },
          tx,
        );
        return;
      }
      await finish(
        'shown',
        {
          narrationText: verdict.text,
          narrateMs,
          knowledgeRead: readRecord(verdict.record as unknown as Record<string, unknown> | null),
        },
        tx,
      );
    },
  });
  if (narrateStep.kind === 'gate') {
    await finish('failed', { errorCode: narrateStep.reason });
    return done();
  }
  if (narrateStep.kind === 'done') modelCalls += 1;
  return done();
}

/** A question still in flight after this long (both steps' deadlines and the calls) was interrupted. */
export const ASK_STALE_AFTER_MS =
  ASK_COMPILE_MANIFEST.limits.timeout_ms + ASK_NARRATE_MANIFEST.limits.timeout_ms + 5 * 60_000;

/** The version a new session records. */
export const ASK_CATALOGUE_VERSION = CATALOGUE_VERSION;
