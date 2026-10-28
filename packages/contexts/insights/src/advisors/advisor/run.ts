// SPDX-License-Identifier: MIT
/**
 * Running an advisor session (WP 11.5d): the worker's `insights.advisor_step`
 * pass. It moves a session through every model step that is due — clarify;
 * then, after the holder answers, gather → options → trade-offs → the judge;
 * then, after the holder picks, the plan → tracked — and stops wherever the
 * holder must act or the session ends.
 *
 * Each model step is 11.5c's run, step for step (11 §2 rule 3: same gate,
 * same ladder, same evidence):
 *
 *   1. **Gate** (transaction 1, under the step's advisor row lock), through
 *      `decideContinue` — levels 1–3 and this step's approved shape (which
 *      folds in the advisor's consent text). A refusal is an `advisor_runs`
 *      row; the session finishes `failed` with the reason and nothing is sent.
 *   2. **The run row and the claim** — `advisor_runs` with the payload's digest,
 *      the prompt hash and the model; the payload retained for the inspector;
 *      the step claimed (`claimAdvisorStep`: an `advisor_session_steps` row,
 *      UNIQUE per session and step). A step already claimed is never asked
 *      again.
 *   3. **The call**, raced against the manifest's deadline and the watcher
 *      (kill level 4: a cancel lands on a run in flight).
 *   4. **The barrier** (transaction 2) — a kill that landed during the call
 *      discards the reply (`cancelled`); then the validator, the run's
 *      outcome, the step row and the session's transition, together; the
 *      call's tokens are added to the session's count.
 *
 * Before every step the session's token budget is read: a session that has
 * spent it finishes `failed` (`token_budget_exhausted`) before the call. A
 * hosted provider's hourly window is the adapter's own (the narrator's
 * budget); a call it refuses fails the step by its code.
 */
import { newId, todayIn } from '@core/kernel';
import { sql } from 'drizzle-orm';
import {
  askCompileSubjectOf,
  buildAskCompileRequest,
  validateAskCompileReply,
  type AskCompileWireRequest,
  type AskCompiledCall,
} from '../ask/compile.ts';
import { runAskCalls } from '../ask/run.ts';
import { precheckQuestion, ASK_TOPIC_WORDS } from '../ask/precheck.ts';
import { ASK_FUNCTION_PAGES, type AskNearestScreen } from '../ask/screens.ts';
import type { AskResultView } from '../ask/results.ts';
import { listCatalogue, type CatalogueRuntimeDependencies } from '../../catalogue/catalogue.ts';
import {
  knowledgeCatalogueOf,
  knowledgeReadRecord,
  type KnowledgeReadRecord,
} from '../../knowledge/citations.ts';
import type { ParameterCitation } from '../../knowledge/params.ts';
import type { KnowledgeBase, ReviewedPlaybookPage } from '../../knowledge/playbook.ts';
import {
  BREAKER_THRESHOLDS,
  decideContinue,
  type CancelReason,
  type RunSwitches,
} from '../../policy/kill-switches.ts';
import { RUN_WATCH_POLL_MS, RunCancelled, watchRun } from '../../policy/run-watch.ts';
import { hasLiveApproval, queryShape } from '../../preview.ts';
import type { InsightsContext, InsightsDatabase, InsightsExecutor } from '../../db.ts';
import { SnapshotBuilder } from '../../snapshot/builder.ts';
import { deriveTokenKey } from '../../snapshot/tokens.ts';
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
import type { AdvisorStep, RunTrigger } from '../../../schema/index.ts';
import { narratorGrantCeiling } from '../local/grant.ts';
import { NARRATOR_MANIFEST } from '../local/manifest.ts';
import {
  buildClarifyRequest,
  validateClarifyReply,
  type AdvisorDefaults,
  type Clarification,
} from './clarify.ts';
import { advisorDisplayText, buildAdvisorContext, type BuiltAdvisorContext } from './context.ts';
import { advisorWatcherFor, evaluateAdvisorWatcher } from './follow-up.ts';
import { advisorGatherQuestion, advisorKnowledgeFor, gatherRefusalOf } from './gather.ts';
import { buildJudgeRequest, validateJudgeReply } from './judge.ts';
import {
  ADVISOR_SCOPES,
  ADVISOR_STEP_IDS,
  ADVISOR_STEP_MANIFESTS,
  ADVISOR_STEP_VERSION,
  advisorShapeTemplateHash,
} from './manifest.ts';
import { buildOptionsRequest, validateOptionsReply, type AdvisorOption } from './options.ts';
import { buildPlanRequest, validatePlanReply } from './plan.ts';
import {
  claimAdvisorStep,
  findAdvisorSession,
  finishAdvisorStep,
  listAdvisorSteps,
  recordAdvisorTokens,
  transitionAdvisorSession,
  type AdvisorSessionFields,
  type StoredAdvisorSession,
} from './source.ts';
import { advisorRubricFor } from './topics.ts';
import {
  buildTradeoffsRequest,
  validateTradeoffsReply,
  type AdvisorTradeoff,
} from './tradeoffs.ts';

/** What every advisor model step is sent: a subject the app built. */
export interface AdvisorPortRequest {
  readonly request_id: string;
  readonly subject: Readonly<Record<string, unknown>>;
  readonly deadline: string;
  readonly max_response_bytes: number;
}

export interface AdvisorReply {
  readonly reply: unknown;
  readonly isJson: boolean;
  readonly label: string;
  readonly promptHash: string;
  readonly warnings: readonly string[];
  readonly runtimeMs: number;
  readonly tokens: number | null;
}

/** One step's adapter: structurally `@advisor/local-model`'s `AdvisorModelAdapter` (and `AskCompileModelAdapter` for gather). */
export interface AdvisorStepModel<Req> {
  readonly provider: string;
  readonly label: string;
  readonly templateHash: string;
  readonly egress: 'local' | 'hosted';
  render(request: Req): { readonly text: string; readonly hash: string };
  run(request: Req, signal: AbortSignal): Promise<AdvisorReply>;
}

/** The holder's advisor models: one provider for every step (D31: hosted only under the advisor's own consent). */
export interface AdvisorModels {
  readonly provider: 'ollama' | 'openai' | 'openrouter' | 'anthropic';
  readonly egress: 'local' | 'hosted';
  readonly clarify: AdvisorStepModel<AdvisorPortRequest>;
  readonly gather: AdvisorStepModel<AskCompileWireRequest>;
  readonly options: AdvisorStepModel<AdvisorPortRequest>;
  readonly tradeoffs: AdvisorStepModel<AdvisorPortRequest>;
  readonly plan: AdvisorStepModel<AdvisorPortRequest>;
  readonly judge: AdvisorStepModel<AdvisorPortRequest>;
  /** A hosted provider's hourly window as it stands; `null` for the local model. */
  windowLeft(): number | null;
}

/** The renderer half: what the api binds (it never calls a model). */
export type AdvisorRenderer = Pick<
  AdvisorStepModel<unknown>,
  'provider' | 'label' | 'templateHash' | 'render' | 'egress'
>;

export interface AdvisorRunDependencies {
  readonly switches: RunSwitches;
  /** The holder's advisor models, or `null` (Off, or nothing configured). */
  readonly models: AdvisorModels | null;
  readonly catalogue: CatalogueRuntimeDependencies;
  /** The knowledge base (11.5a), or `null`: then nothing is cited and a marker is refused. */
  readonly knowledge: KnowledgeBase | null;
  /** Tests only. */
  readonly runWatchPollMs?: number;
}

// ---------------------------------------------------------------------------
// Shapes and the gate
// ---------------------------------------------------------------------------

/** The approvable shape of one step: advisor id, version, kind, the scope bound, and the template + consent hash. */
export function advisorStepShape(step: AdvisorStep, adapterTemplateHash: string | null): string {
  return queryShape({
    advisorId: ADVISOR_STEP_IDS[step],
    advisorVersion: ADVISOR_STEP_VERSION,
    kind: 'local_model',
    scopes: ADVISOR_SCOPES,
    promptTemplateHash:
      adapterTemplateHash === null ? null : advisorShapeTemplateHash(step, adapterTemplateHash),
  });
}

async function readGate(
  executor: InsightsExecutor,
  switches: RunSwitches,
  input: {
    readonly step: AdvisorStep;
    readonly userId: string;
    readonly shape: string | null;
    readonly runId: string | null;
    readonly modelBound: boolean;
  },
): Promise<CancelReason | null> {
  const advisorId = ADVISOR_STEP_IDS[input.step];
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

export type AdvisorUnavailableReason = CancelReason | 'scope_not_granted';

/** The steps a session cannot start without (the judge is evidence: it never blocks). */
export const ADVISOR_REQUIRED_STEPS: readonly AdvisorStep[] = Object.freeze([
  'clarify',
  'gather',
  'options',
  'tradeoffs',
  'plan',
]);

/**
 * Could this holder start a session now? `null` means yes: every required
 * step callable (approved, switches on) and a scope granted.
 */
export async function advisorUnavailable(
  executor: InsightsExecutor,
  switches: RunSwitches,
  input: {
    readonly userId: string;
    readonly templateHashes: Readonly<Partial<Record<AdvisorStep, string | null>>>;
  },
): Promise<{
  readonly step: AdvisorStep | null;
  readonly reason: AdvisorUnavailableReason;
} | null> {
  for (const step of ADVISOR_REQUIRED_STEPS) {
    const hash = input.templateHashes[step] ?? null;
    const reason = await readGate(executor, switches, {
      step,
      userId: input.userId,
      shape: hash === null ? null : advisorStepShape(step, hash),
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

type StepFinish =
  | { readonly kind: 'cancelled'; readonly reason: CancelReason }
  | { readonly kind: 'failed'; readonly errorCode: string }
  | { readonly kind: 'replied'; readonly reply: unknown };

type StepOutcome =
  | { readonly kind: 'gate'; readonly reason: CancelReason }
  | { readonly kind: 'claimed_already' }
  | { readonly kind: 'done'; readonly runId: string };

/** What the validator says of a reply, for the run row and the step row. */
interface StepVerdict {
  readonly ok: boolean;
  readonly refusal: string | null;
  /** Outside the reply format: a failure for the breaker. */
  readonly schema: boolean;
  readonly knowledgeRead?: Record<string, unknown> | null;
}

async function invokeModel<Req>(
  model: AdvisorStepModel<Req>,
  request: Req,
  controller: AbortController,
  timeoutMs: number,
): Promise<AdvisorReply> {
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

/** Rough tokens for a call whose runtime reported none: a quarter of the bytes, rounded up. */
function estimatedTokens(promptBytes: number, reply: unknown): number {
  const replyBytes = new TextEncoder().encode(JSON.stringify(reply ?? null)).length;
  return Math.ceil((promptBytes + replyBytes) / 4);
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
  dependencies: AdvisorRunDependencies,
  input: {
    readonly step: AdvisorStep;
    readonly sessionId: string;
    readonly expectStatus: StoredAdvisorSession['status'];
    readonly model: AdvisorStepModel<Req>;
    readonly windowLeft: () => number | null;
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
  const advisorId = ADVISOR_STEP_IDS[step];
  const manifest = ADVISOR_STEP_MANIFESTS[step];
  const shape = advisorStepShape(step, model.templateHash);
  const gate = { step, userId: context.userId, shape, modelBound: true } as const;
  const scopes = [...built.payload.granted_scopes];
  const started = context.clock.nowMs();
  const rendered = model.render(built.request);
  const promptBytes = new TextEncoder().encode(rendered.text).length;

  // --- 1–2. transaction 1: the lock, the gate, the run row, the claim -----------
  const opened = await database.transaction(async (tx) => {
    await lockAdvisor(tx, context.userId, advisorId);
    const run = await startRun(tx, context, {
      advisorId,
      advisorVersion: ADVISOR_STEP_VERSION,
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
      return { kind: 'gate' as const, reason: refusal };
    }
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
    const claimed = await claimAdvisorStep(tx, {
      userId: context.userId,
      sessionId: input.sessionId,
      step,
      expect: { status: input.expectStatus },
      runId: run.id,
      inputDigest: built.digest,
      provider: model.provider,
      model: model.label,
      egress: model.egress,
      now: context.clock.now(),
    });
    if (!claimed) {
      // The step was claimed by an earlier pass: nothing may be asked again.
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
  let reply: AdvisorReply | null = null;
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
    // The same lock order as transaction 1 — the advisor's row, then the session's —
    // so a second pass waiting on this step's advisor can never deadlock with this one.
    await lockAdvisor(tx, context.userId, advisorId);
    const now = context.clock.now();
    const durationMs = Math.max(0, context.clock.nowMs() - started);
    const tokens =
      reply === null ? null : (reply.tokens ?? estimatedTokens(promptBytes, reply.reply));
    if (tokens !== null) {
      await recordAdvisorTokens(tx, {
        userId: context.userId,
        sessionId: input.sessionId,
        tokens,
        windowLeft: model.egress === 'hosted' ? input.windowLeft() : null,
      });
    }
    const stepRow = {
      userId: context.userId,
      sessionId: input.sessionId,
      step,
      tokens,
      durationMs,
      now,
    };
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
      await finishAdvisorStep(tx, { ...stepRow, outcome: 'cancelled', errorCode: stoppedBy });
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
      await finishAdvisorStep(tx, { ...stepRow, outcome: 'failed', errorCode });
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
    await finishAdvisorStep(tx, {
      ...stepRow,
      outcome: verdict.ok ? 'accepted' : 'refused',
      refusal: verdict.refusal,
      knowledgeRead: verdict.knowledgeRead ?? null,
    });
    await input.onFinish(tx, { kind: 'replied', reply: reply.reply });
  });
  return { kind: 'done', runId };
}

// ---------------------------------------------------------------------------
// What the session keeps between passes
// ---------------------------------------------------------------------------

/** The gathered step's record: everything needed to rebuild the context object exactly. */
export interface AdvisorGathered {
  readonly calls: readonly AskCompiledCall[];
  readonly results: readonly AskResultView[];
  readonly date: string;
  readonly pages: readonly ReviewedPlaybookPage[];
  readonly params: readonly ParameterCitation[];
  readonly withheld: readonly { readonly key: string; readonly code: string }[];
  readonly topic_pages: readonly string[];
  readonly options_dropped?: number;
}

export interface StoredClarification extends Clarification {
  /** The refs the clarify step was sent, with the app's own rendering of each. */
  readonly defaults_sent: readonly {
    readonly ref: string;
    readonly about: string;
    readonly value: string;
  }[];
}

function answersOf(session: StoredAdvisorSession): { question: string; answer: string }[] {
  const clarification = session.clarification as unknown as StoredClarification | null;
  const answers = (session.answers ?? []) as readonly string[];
  return (clarification?.questions ?? []).map((question, index) => ({
    question,
    answer: answers[index] ?? '',
  }));
}

/** The context object, rebuilt from the session row. `null` when its digest no longer matches. */
export function advisorContextOfSession(
  session: StoredAdvisorSession,
  knowledge: KnowledgeBase | null,
): BuiltAdvisorContext | null {
  const gathered = session.gathered as unknown as AdvisorGathered | null;
  const clarification = session.clarification as unknown as StoredClarification | null;
  if (gathered === null || clarification === null) return null;
  const built = buildAdvisorContext({
    restatement: clarification.restatement,
    answers: answersOf(session),
    date: gathered.date,
    results: gathered.results,
    knowledge: { pages: gathered.pages, params: gathered.params, withheld: gathered.withheld },
    knowledgeCatalogue: knowledge === null ? null : knowledgeCatalogueOf(knowledge),
  });
  if (session.contextDigest !== null && built.digest !== session.contextDigest) return null;
  return built;
}

function recordOf(record: KnowledgeReadRecord | null): Record<string, unknown> | null {
  return record === null ? null : (record as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// The holder's defaults (for clarify)
// ---------------------------------------------------------------------------

/**
 * The plan's retirement age and the goals' names with their `goal_ref`s, read
 * from a narrator-kind snapshot of only `goals.list` and `plan.projection`,
 * and only those the holder's grant covers. Never a goal id.
 */
export async function advisorDefaultsFor(
  catalogue: CatalogueRuntimeDependencies,
  userId: string,
): Promise<AdvisorDefaults> {
  const ceiling = await narratorGrantCeiling(catalogue.database, userId);
  const scopes = (['goals.list', 'plan.projection'] as const).filter((scope) =>
    ceiling.includes(scope),
  );
  if (scopes.length === 0) return { retirementAge: null, goals: [] };
  const built = await new SnapshotBuilder(catalogue.ports.snapshot).build({
    userId,
    kind: NARRATOR_MANIFEST.kind,
    grantedScopes: scopes,
    today: todayIn(catalogue.clock, catalogue.timeZone),
    baseCurrency: catalogue.baseCurrency,
    tokenKey: deriveTokenKey(catalogue.tokenSecret, userId),
  });
  return {
    retirementAge: built.snapshot.plan_projection?.ages.retirement ?? null,
    goals: (built.snapshot.goals_list?.goals ?? []).slice(0, 12).map((goal) => ({
      goal_ref: goal.goal_ref,
      name: goal.name,
    })),
  };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface AdvisorPassResult {
  readonly status: 'not_found' | StoredAdvisorSession['status'];
  readonly session: StoredAdvisorSession | null;
  /** How many model calls this pass made. */
  readonly modelCalls: number;
}

/** A claimed step older than this (its deadline and five minutes) was interrupted. */
export const ADVISOR_STEP_STALE_AFTER_MS = 300_000 + 5 * 60_000;

type Progress = 'advanced' | 'stopped';

/**
 * Move one session as far as it can go without the holder. Writes
 * `advisor_runs` (and its retained payloads), `advisor_session_steps`,
 * `advisor_sessions` and — on tracking — the follow-up's builtin insight;
 * asks a model at most once per step.
 */
export async function runAdvisorPass(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: AdvisorRunDependencies,
  input: { readonly sessionId: string; readonly trigger: RunTrigger },
): Promise<AdvisorPassResult> {
  const { sessionId } = input;
  let modelCalls = 0;
  const done = async (): Promise<AdvisorPassResult> => {
    const session = await findAdvisorSession(database, context.userId, sessionId);
    return { status: session?.status ?? 'not_found', session, modelCalls };
  };
  const finish = (
    status: 'refused' | 'unanswerable' | 'failed' | 'cancelled',
    from: readonly StoredAdvisorSession['status'][],
    fields: AdvisorSessionFields,
    executor: InsightsExecutor = database,
  ) => transitionAdvisorSession(executor, context, { sessionId, from, to: status, fields });
  const failOnFinish =
    (from: StoredAdvisorSession['status']) =>
    async (tx: InsightsExecutor, outcome: StepFinish): Promise<boolean> => {
      if (outcome.kind === 'cancelled') {
        await finish('cancelled', [from], { errorCode: outcome.reason }, tx);
        return true;
      }
      if (outcome.kind === 'failed') {
        await finish('failed', [from], { errorCode: outcome.errorCode }, tx);
        return true;
      }
      return false;
    };

  /** A step that could not be claimed: interrupted (closed) when stale, else another pass holds it. */
  const notClaimed = async (
    step: AdvisorStep,
    from: StoredAdvisorSession['status'],
  ): Promise<Progress> => {
    const steps = await listAdvisorSteps(database, context.userId, sessionId);
    const row = steps.find((entry) => entry.step === step);
    const since = row === undefined ? null : (row.finishedAt ?? row.createdAt).getTime();
    if (since !== null && context.clock.nowMs() - since > ADVISOR_STEP_STALE_AFTER_MS) {
      await finish('failed', [from], { errorCode: 'step_interrupted' });
    }
    return 'stopped';
  };

  const models = dependencies.models;
  const budgetSpent = (session: StoredAdvisorSession): boolean =>
    session.tokensUsed >= session.tokenBudget;

  async function preflight(
    session: StoredAdvisorSession,
    from: StoredAdvisorSession['status'],
  ): Promise<boolean> {
    if (models === null) {
      await finish('failed', [from], { errorCode: 'kind_disabled' });
      return false;
    }
    if (budgetSpent(session)) {
      await finish('failed', [from], { errorCode: 'token_budget_exhausted' });
      return false;
    }
    return true;
  }

  // --- step 1: clarify -----------------------------------------------------------
  async function clarify(session: StoredAdvisorSession): Promise<Progress> {
    const pre = precheckQuestion(session.question);
    if (pre.kind === 'refused') {
      await finish('refused', ['clarifying'], { refusal: pre.refusal });
      return 'stopped';
    }
    if (pre.kind === 'out_of_scope') {
      await finish('unanswerable', ['clarifying'], {
        unanswerableReason: 'out_of_scope',
        unanswerableTopic: pre.topic,
        nearestScreen: ASK_TOPIC_WORDS[pre.topic].screen,
      });
      return 'stopped';
    }
    if (!(await preflight(session, 'clarifying')) || models === null) return 'stopped';
    const listing = await listCatalogue(dependencies.catalogue, { userId: context.userId });
    if (listing.functions.length === 0) {
      await finish('failed', ['clarifying'], { errorCode: 'scope_not_granted' });
      return 'stopped';
    }
    const defaults = await advisorDefaultsFor(dependencies.catalogue, context.userId);
    const ceiling = await narratorGrantCeiling(database, context.userId);
    const built = buildClarifyRequest({
      question: session.question,
      listing: listing.functions,
      defaults,
      grantedScopes: (['goals.list', 'plan.projection'] as const).filter(
        (scope) =>
          ceiling.includes(scope) &&
          (scope === 'goals.list' ? defaults.goals.length > 0 : defaults.retirementAge !== null),
      ),
      now: context.clock.now(),
      timeoutMs: ADVISOR_STEP_MANIFESTS.clarify.limits.timeout_ms,
      maxResponseBytes: ADVISOR_STEP_MANIFESTS.clarify.limits.max_response_bytes,
    });
    const failed = failOnFinish('clarifying');
    const outcome = await runModelStep(database, context, dependencies, {
      step: 'clarify',
      sessionId,
      expectStatus: 'clarifying',
      model: models.clarify,
      windowLeft: () => models.windowLeft(),
      built: { ...built, request: built.request as unknown as AdvisorPortRequest },
      trigger: input.trigger,
      validate: (reply) => {
        const verdict = validateClarifyReply(reply, built.check);
        return {
          ok: verdict.ok,
          refusal: verdict.ok ? null : verdict.refusal,
          schema: !verdict.ok && verdict.refusal === 'clarify.schema',
        };
      },
      onFinish: async (tx, finished) => {
        if (await failed(tx, finished)) return;
        if (finished.kind !== 'replied') return;
        const verdict = validateClarifyReply(finished.reply, built.check);
        if (!verdict.ok) {
          await finish('refused', ['clarifying'], { refusal: verdict.refusal }, tx);
          return;
        }
        const stored: StoredClarification = {
          ...verdict.clarification,
          defaults_sent: built.request.subject.defaults.refs.map((entry) => ({ ...entry })),
        };
        await transitionAdvisorSession(tx, context, {
          sessionId,
          from: ['clarifying'],
          fields: { clarification: stored as unknown as Record<string, unknown> },
          where: sql`clarification IS NULL`,
        });
      },
    });
    if (outcome.kind === 'gate') {
      await finish('failed', ['clarifying'], { errorCode: outcome.reason });
      return 'stopped';
    }
    if (outcome.kind === 'claimed_already') return notClaimed('clarify', 'clarifying');
    modelCalls += 1;
    // The holder answers next: the pass ends here either way.
    return 'stopped';
  }

  // --- step 2: gather ------------------------------------------------------------
  async function gather(session: StoredAdvisorSession): Promise<Progress> {
    if (!(await preflight(session, 'gathering')) || models === null) return 'stopped';
    const clarification = session.clarification as unknown as StoredClarification | null;
    if (clarification === null) {
      await finish('failed', ['gathering'], { errorCode: 'clarification_missing' });
      return 'stopped';
    }
    const listing = await listCatalogue(dependencies.catalogue, { userId: context.userId });
    if (listing.functions.length === 0) {
      await finish('failed', ['gathering'], { errorCode: 'scope_not_granted' });
      return 'stopped';
    }
    const today = todayIn(context.clock, dependencies.catalogue.timeZone);
    const answers = answersOf(session);
    const text = advisorGatherQuestion({ restatement: clarification.restatement, answers });
    const built = buildAskCompileRequest({
      subject: askCompileSubjectOf({ question: text, today, listing }),
      now: context.clock.now(),
      timeoutMs: ADVISOR_STEP_MANIFESTS.gather.limits.timeout_ms,
      maxResponseBytes: ADVISOR_STEP_MANIFESTS.gather.limits.max_response_bytes,
    });
    let compiled: readonly AskCompiledCall[] | null = null;
    const failed = failOnFinish('gathering');
    const outcome = await runModelStep(database, context, dependencies, {
      step: 'gather',
      sessionId,
      expectStatus: 'gathering',
      model: models.gather,
      windowLeft: () => models.windowLeft(),
      built,
      trigger: input.trigger,
      validate: (reply) => {
        const verdict = validateAskCompileReply(reply, built.check);
        return {
          ok: verdict.ok,
          refusal: verdict.ok ? null : gatherRefusalOf(verdict.refusal),
          schema: !verdict.ok && verdict.refusal === 'compile.schema',
        };
      },
      onFinish: async (tx, finished) => {
        if (await failed(tx, finished)) return;
        if (finished.kind !== 'replied') return;
        const verdict = validateAskCompileReply(finished.reply, built.check);
        if (!verdict.ok) {
          await finish('refused', ['gathering'], { refusal: gatherRefusalOf(verdict.refusal) }, tx);
          return;
        }
        if (verdict.kind === 'unanswerable') {
          await finish(
            'unanswerable',
            ['gathering'],
            { unanswerableReason: verdict.reason, nearestScreen: verdict.nearestScreen },
            tx,
          );
          return;
        }
        compiled = verdict.calls;
      },
    });
    if (outcome.kind === 'gate') {
      await finish('failed', ['gathering'], { errorCode: outcome.reason });
      return 'stopped';
    }
    if (outcome.kind === 'claimed_already') return notClaimed('gather', 'gathering');
    modelCalls += 1;
    const calls = compiled as readonly AskCompiledCall[] | null;
    if (calls === null) return 'stopped';

    // The calls: deterministic, in process, under the holder's grants.
    const results = await runAskCalls(dependencies, context, calls);
    const knowledge = advisorKnowledgeFor(dependencies.knowledge, { text, results });
    const gathered: AdvisorGathered = {
      calls,
      results,
      date: today,
      pages: knowledge.pages,
      params: knowledge.params,
      withheld: knowledge.withheld,
      topic_pages: knowledge.topicPages,
    };
    if (!results.some((result) => result.status === 'ok')) {
      const screen: AskNearestScreen = results[0]?.screen ?? '/';
      await finish('unanswerable', ['gathering'], {
        gathered: gathered as unknown as Record<string, unknown>,
        unanswerableReason: 'not_computable',
        nearestScreen: screen,
      });
      return 'stopped';
    }
    const context0 = buildAdvisorContext({
      restatement: clarification.restatement,
      answers,
      date: today,
      results,
      knowledge,
      knowledgeCatalogue:
        dependencies.knowledge === null ? null : knowledgeCatalogueOf(dependencies.knowledge),
    });
    const read = {
      read: recordOf(
        context0.check.knowledge === null ? null : knowledgeReadRecord(context0.check.sent),
      ),
      withheld_pages: knowledge.withheld,
      topic_pages: knowledge.topicPages,
    };
    await database.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE advisor_session_steps
           SET knowledge_read = ${JSON.stringify(read)}::jsonb
         WHERE user_id = ${context.userId} AND session_id = ${sessionId} AND step = 'gather'
      `);
      await transitionAdvisorSession(tx, context, {
        sessionId,
        from: ['gathering'],
        to: 'options',
        fields: {
          gathered: gathered as unknown as Record<string, unknown>,
          contextDigest: context0.digest,
        },
      });
    });
    return 'advanced';
  }

  // --- step 3: options -------------------------------------------------------------
  async function options(session: StoredAdvisorSession): Promise<Progress> {
    if (!(await preflight(session, 'options')) || models === null) return 'stopped';
    const built0 = advisorContextOfSession(session, dependencies.knowledge);
    if (built0 === null) {
      await finish('failed', ['options'], { errorCode: 'context_changed' });
      return 'stopped';
    }
    const ceiling = scopesOf(session);
    const built = buildOptionsRequest({
      context: built0.context,
      grantedScopes: ceiling,
      now: context.clock.now(),
      timeoutMs: ADVISOR_STEP_MANIFESTS.options.limits.timeout_ms,
      maxResponseBytes: ADVISOR_STEP_MANIFESTS.options.limits.max_response_bytes,
    });
    const failed = failOnFinish('options');
    const outcome = await runModelStep(database, context, dependencies, {
      step: 'options',
      sessionId,
      expectStatus: 'options',
      model: models.options,
      windowLeft: () => models.windowLeft(),
      built: { ...built, request: built.request as unknown as AdvisorPortRequest },
      trigger: input.trigger,
      validate: (reply) => {
        const verdict = validateOptionsReply(reply, built0.check);
        return {
          ok: verdict.ok,
          refusal: verdict.ok ? null : verdict.refusal,
          schema: !verdict.ok && verdict.refusal === 'options.schema',
          knowledgeRead: verdict.ok ? recordOf(verdict.record) : null,
        };
      },
      onFinish: async (tx, finished) => {
        if (await failed(tx, finished)) return;
        if (finished.kind !== 'replied') return;
        const verdict = validateOptionsReply(finished.reply, built0.check);
        if (!verdict.ok) {
          await finish('refused', ['options'], { refusal: verdict.refusal }, tx);
          return;
        }
        const gathered = session.gathered as unknown as AdvisorGathered;
        await transitionAdvisorSession(tx, context, {
          sessionId,
          from: ['options'],
          to: 'tradeoffs',
          fields: {
            options: verdict.options as unknown as Record<string, unknown>[],
            gathered: { ...gathered, options_dropped: verdict.dropped } as unknown as Record<
              string,
              unknown
            >,
          },
        });
      },
    });
    if (outcome.kind === 'gate') {
      await finish('failed', ['options'], { errorCode: outcome.reason });
      return 'stopped';
    }
    if (outcome.kind === 'claimed_already') return notClaimed('options', 'options');
    modelCalls += 1;
    return 'advanced';
  }

  // --- step 4: trade-offs, then the judge ---------------------------------------
  async function tradeoffs(session: StoredAdvisorSession): Promise<Progress> {
    if (session.tradeoffs !== null) return judge(session);
    if (!(await preflight(session, 'tradeoffs')) || models === null) return 'stopped';
    const built0 = advisorContextOfSession(session, dependencies.knowledge);
    const opts = (session.options ?? []) as unknown as AdvisorOption[];
    if (built0 === null || opts.length === 0) {
      await finish('failed', ['tradeoffs'], { errorCode: 'context_changed' });
      return 'stopped';
    }
    const built = buildTradeoffsRequest({
      context: built0.context,
      options: opts,
      grantedScopes: scopesOf(session),
      now: context.clock.now(),
      timeoutMs: ADVISOR_STEP_MANIFESTS.tradeoffs.limits.timeout_ms,
      maxResponseBytes: ADVISOR_STEP_MANIFESTS.tradeoffs.limits.max_response_bytes,
    });
    const check = { ...built0.check, options: opts.map((option) => option.id) };
    const failed = failOnFinish('tradeoffs');
    const outcome = await runModelStep(database, context, dependencies, {
      step: 'tradeoffs',
      sessionId,
      expectStatus: 'tradeoffs',
      model: models.tradeoffs,
      windowLeft: () => models.windowLeft(),
      built: { ...built, request: built.request as unknown as AdvisorPortRequest },
      trigger: input.trigger,
      validate: (reply) => {
        const verdict = validateTradeoffsReply(reply, check);
        return {
          ok: verdict.ok,
          refusal: verdict.ok ? null : verdict.refusal,
          schema: !verdict.ok && verdict.refusal === 'tradeoffs.schema',
          knowledgeRead: verdict.ok ? recordOf(verdict.record) : null,
        };
      },
      onFinish: async (tx, finished) => {
        if (await failed(tx, finished)) return;
        if (finished.kind !== 'replied') return;
        const verdict = validateTradeoffsReply(finished.reply, check);
        if (!verdict.ok) {
          await finish('refused', ['tradeoffs'], { refusal: verdict.refusal }, tx);
          return;
        }
        await transitionAdvisorSession(tx, context, {
          sessionId,
          from: ['tradeoffs'],
          fields: { tradeoffs: verdict.tradeoffs as unknown as Record<string, unknown>[] },
          where: sql`tradeoffs IS NULL`,
        });
      },
    });
    if (outcome.kind === 'gate') {
      await finish('failed', ['tradeoffs'], { errorCode: outcome.reason });
      return 'stopped';
    }
    if (outcome.kind === 'claimed_already') return notClaimed('tradeoffs', 'tradeoffs');
    modelCalls += 1;
    return 'advanced';
  }

  /** The rubric judge: evidence, never a gate. Whatever it does, the session moves on to the pick. */
  async function judge(session: StoredAdvisorSession): Promise<Progress> {
    const toPick = (fields: AdvisorSessionFields, executor: InsightsExecutor = database) =>
      transitionAdvisorSession(executor, context, {
        sessionId,
        from: ['tradeoffs'],
        to: 'awaiting_pick',
        fields,
      });
    const steps = await listAdvisorSteps(database, context.userId, sessionId);
    if (steps.some((entry) => entry.step === 'judge' && entry.outcome !== null)) {
      await toPick({});
      return 'stopped';
    }
    if (models === null) {
      await toPick({ judgeError: 'kind_disabled' });
      return 'stopped';
    }
    if (budgetSpent(session)) {
      await toPick({ judgeError: 'token_budget_exhausted' });
      return 'stopped';
    }
    const clarification = session.clarification as unknown as StoredClarification | null;
    const opts = (session.options ?? []) as unknown as AdvisorOption[];
    const trades = (session.tradeoffs ?? []) as unknown as AdvisorTradeoff[];
    const gathered = session.gathered as unknown as AdvisorGathered | null;
    const pages = [
      ...(gathered?.topic_pages ?? []),
      ...(gathered?.results ?? []).flatMap((result) => {
        const page = ASK_FUNCTION_PAGES[result.function];
        return page === undefined ? [] : [page];
      }),
    ];
    const rubric = advisorRubricFor(pages);
    const built = buildJudgeRequest({
      narration: [
        { part: 'restatement', text: advisorDisplayText(clarification?.restatement ?? '') },
        ...opts.map((option) => ({
          part: 'option',
          text: advisorDisplayText(`${option.label}. ${option.summary}`),
        })),
        ...trades.map((entry) => ({ part: 'tradeoff', text: advisorDisplayText(entry.note) })),
      ],
      rubric,
      now: context.clock.now(),
      timeoutMs: ADVISOR_STEP_MANIFESTS.judge.limits.timeout_ms,
      maxResponseBytes: ADVISOR_STEP_MANIFESTS.judge.limits.max_response_bytes,
    });
    let runIdOf: string | null = null;
    const outcome = await runModelStep(database, context, dependencies, {
      step: 'judge',
      sessionId,
      expectStatus: 'tradeoffs',
      model: models.judge,
      windowLeft: () => models.windowLeft(),
      built: { ...built, request: built.request as unknown as AdvisorPortRequest },
      trigger: input.trigger,
      validate: (reply) => {
        const verdict = validateJudgeReply(reply, rubric);
        return {
          ok: verdict.ok,
          refusal: verdict.ok ? null : verdict.refusal,
          schema: !verdict.ok && verdict.refusal === 'judge.schema',
        };
      },
      onFinish: async (tx, finished) => {
        if (finished.kind === 'cancelled') {
          await toPick({ judgeError: finished.reason }, tx);
          return;
        }
        if (finished.kind === 'failed') {
          await toPick({ judgeError: finished.errorCode }, tx);
          return;
        }
        const verdict = validateJudgeReply(finished.reply, rubric);
        if (!verdict.ok) {
          await toPick({ judgeError: verdict.refusal }, tx);
          return;
        }
        const run = await tx.execute<{ run_id: string }>(sql`
          SELECT run_id FROM advisor_session_steps
           WHERE user_id = ${context.userId} AND session_id = ${sessionId} AND step = 'judge'
        `);
        runIdOf = run.rows[0]?.run_id ?? null;
        await toPick(
          {
            judgeScore: verdict.score.score,
            judgeRunId: runIdOf,
            judgeDetail: verdict.score as unknown as Record<string, unknown>,
          },
          tx,
        );
      },
    });
    if (outcome.kind === 'gate') {
      await toPick({ judgeError: outcome.reason });
      return 'stopped';
    }
    if (outcome.kind === 'claimed_already') {
      await notClaimed('judge', 'tradeoffs');
      return 'stopped';
    }
    modelCalls += 1;
    return 'stopped';
  }

  // --- step 5: plan, then the watcher --------------------------------------------
  async function plan(session: StoredAdvisorSession): Promise<Progress> {
    if (!(await preflight(session, 'planning')) || models === null) return 'stopped';
    const built0 = advisorContextOfSession(session, dependencies.knowledge);
    const opts = (session.options ?? []) as unknown as AdvisorOption[];
    const trades = (session.tradeoffs ?? []) as unknown as AdvisorTradeoff[];
    const option = opts.find((entry) => entry.id === session.pickedOption);
    const tradeoff = trades.find((entry) => entry.option === session.pickedOption);
    if (built0 === null || option === undefined || tradeoff === undefined) {
      await finish('failed', ['planning'], { errorCode: 'context_changed' });
      return 'stopped';
    }
    const built = buildPlanRequest({
      context: built0.context,
      option,
      tradeoff,
      grantedScopes: scopesOf(session),
      now: context.clock.now(),
      timeoutMs: ADVISOR_STEP_MANIFESTS.plan.limits.timeout_ms,
      maxResponseBytes: ADVISOR_STEP_MANIFESTS.plan.limits.max_response_bytes,
    });
    const failed = failOnFinish('planning');
    let tracked = false;
    const outcome = await runModelStep(database, context, dependencies, {
      step: 'plan',
      sessionId,
      expectStatus: 'planning',
      model: models.plan,
      windowLeft: () => models.windowLeft(),
      built: { ...built, request: built.request as unknown as AdvisorPortRequest },
      trigger: input.trigger,
      validate: (reply) => {
        const verdict = validatePlanReply(reply, built0.check);
        return {
          ok: verdict.ok,
          refusal: verdict.ok ? null : verdict.refusal,
          schema: !verdict.ok && verdict.refusal === 'plan.schema',
        };
      },
      onFinish: async (tx, finished) => {
        if (await failed(tx, finished)) return;
        if (finished.kind !== 'replied') return;
        const verdict = validatePlanReply(finished.reply, built0.check);
        if (!verdict.ok) {
          await finish('refused', ['planning'], { refusal: verdict.refusal }, tx);
          return;
        }
        const gathered = session.gathered as unknown as AdvisorGathered;
        const watcherId = newId();
        const watcher = advisorWatcherFor({
          option,
          tradeoff,
          results: gathered.results,
          watcherKey: `advisor.follow_up.${watcherId}`,
        });
        if (watcher === null) {
          await finish(
            'failed',
            ['planning'],
            {
              plan: verdict.steps as unknown as Record<string, unknown>[],
              errorCode: 'watcher_unavailable',
            },
            tx,
          );
          return;
        }
        const moved = await transitionAdvisorSession(tx, context, {
          sessionId,
          from: ['planning'],
          to: 'tracked',
          fields: {
            plan: verdict.steps as unknown as Record<string, unknown>[],
            watcherId,
            watcher: watcher as unknown as Record<string, unknown>,
          },
        });
        tracked = moved !== null;
      },
    });
    if (outcome.kind === 'gate') {
      await finish('failed', ['planning'], { errorCode: outcome.reason });
      return 'stopped';
    }
    if (outcome.kind === 'claimed_already') return notClaimed('plan', 'planning');
    modelCalls += 1;
    if (tracked) {
      // Step 6: the first check, at once — no model.
      const now = await findAdvisorSession(database, context.userId, sessionId);
      if (now !== null) {
        await evaluateAdvisorWatcher(database, context, { catalogue: dependencies.catalogue }, now);
      }
    }
    return 'stopped';
  }

  /** What the session's catalogue results were computed over, catalogue order: the payload's data categories. */
  function scopesOf(session: StoredAdvisorSession): string[] {
    const gathered = session.gathered as unknown as AdvisorGathered | null;
    const wanted = new Set((gathered?.results ?? []).flatMap((result) => result.scopes));
    return ADVISOR_SCOPES.filter((scope) => wanted.has(scope));
  }

  for (let guard = 0; guard < 8; guard += 1) {
    const session = await findAdvisorSession(database, context.userId, sessionId);
    if (session === null) return { status: 'not_found', session: null, modelCalls };
    let progress: Progress;
    switch (session.status) {
      case 'clarifying':
        progress = session.clarification === null ? await clarify(session) : 'stopped';
        break;
      case 'gathering':
        progress = await gather(session);
        break;
      case 'options':
        progress = await options(session);
        break;
      case 'tradeoffs':
        progress = await tradeoffs(session);
        break;
      case 'planning':
        progress = await plan(session);
        break;
      default:
        progress = 'stopped';
    }
    if (progress === 'stopped') break;
  }
  return done();
}
