// SPDX-License-Identifier: MIT
/**
 * One advisor run, end to end — and the order of its steps is the design.
 *
 * ```
 * kill switches → open the run → build the snapshot → [retain the payload]
 *   → invoke, watched → validate → write barrier → drop what is suppressed
 *   → upsert → close the run
 * ```
 *
 * Five things about that order are load-bearing:
 *
 *   * **The switches come first, before the snapshot exists.** A quarantined or
 *     disabled advisor is not handed data and then ignored; it is never handed
 *     data. That is why `"a quarantined advisor's output never reaches
 *     pending_review"` is true for a stronger reason than "we drop its output".
 *   * **The switches are read three times, not once** (WP 5.1). Before the run
 *     (transaction 1); while the untrusted call is in flight, by the run
 *     watcher, at most once a second (`policy/run-watch.ts`); and at the write
 *     barrier — transaction 2 re-reads every switch under a row lock on the
 *     `advisors` row before it writes, so a run killed between the reply and
 *     the insert lands nothing and closes `cancelled` with the level named.
 *     Every one of the three asks `decideRun`; there is no fourth.
 *   * **Validation comes before suppression, and both come before the write.**
 *     A fabricated number is rejected whether or not the user would have seen
 *     the insight, so the rejection counter — and therefore the breaker — is
 *     not silently suppressed along with the finding.
 *   * **The invocation is outside any transaction.** An advisor may take up to
 *     five minutes (`PLATFORM_LIMITS.timeoutMs`); holding a Postgres
 *     transaction open across it would pin a connection and an XID snapshot for
 *     the duration, which is how a nightly job makes autovacuum stop working.
 *     So the run is two transactions with an untrusted call in between, and
 *     `advisor_runs` is what ties them together: a crash in the middle leaves a
 *     row with `status = 'started'` and no `finished_at`, which is exactly what
 *     an interrupted run should look like. The watcher's reads borrow a pooled
 *     connection per tick and return it — nothing is held across the call.
 *   * **A `local_model` advisor runs only in its own lane** (WP 5.1). It is
 *     executed by the `insights.run_local` job and nowhere else — never by
 *     `insights.run` (whose concurrency of 1 would queue every built-in behind
 *     a three-minute model call) and never inline in the API.
 *     `runAdvisor` refuses to execute one unless the caller says it is that
 *     lane; `jobs.ts` is the only caller that does.
 *
 * ## The deadline is ours
 *
 * 08 §4.4: "Hard timeout, enforced by us." The `AbortSignal` passed to
 * `Advisor.run` is created here, aborted by the deadline or by the watcher,
 * and the race below means an advisor that ignores the signal still cannot
 * hold the worker — it can only leak its own continuation, which is a bug in
 * that advisor and not an outage. A deadline is a *failure* (the breaker
 * counts it: the advisor did not answer in time); a kill is a *cancellation*
 * (it does not: the holder or the operator stopped it).
 *
 * ## Suppression drops proposals; it does not delete rows
 *
 * A finding under cooldown is not written, so a dismissed insight does not
 * reappear as `pending_review` tomorrow. Its existing row — dismissed, with its
 * evidence — is untouched, so the user can still see what they refused and take
 * it back. `suppressed` is counted on the result and logged, because "the
 * advisor found nothing" and "the advisor found six things you have already
 * refused" are different situations and only one of them is worth acting on.
 */
import { dependenciesForHolder, type HolderNarrator } from './holder.ts';
import type { Clock } from '@core/kernel';
import { appendEvent, canonicalJson } from '@core/platform';
import type { AdvisorKind, AdvisorScope } from './contract/scopes.ts';
import type { AdvisorRequest } from './contract/request.ts';
import {
  platformOf,
  type InsightsContext,
  type InsightsDatabase,
  type InsightsExecutor,
} from './db.ts';
import {
  AdvisorRunCancelled,
  AdvisorRunCompleted,
  AdvisorRunFailed,
  AdvisorRunStarted,
  InsightAccepted,
  InsightDismissed,
  InsightProposed,
  InsightReviewed,
} from './events.ts';
import {
  LADDER_LEVEL,
  decideContinue,
  decideRun,
  shouldQuarantine,
  staticRunSwitches,
  type CancelReason,
  type KillSwitchInputs,
  type RunRefusal,
  type RunSwitches,
} from './policy/kill-switches.ts';
import { RunCancelled, RUN_WATCH_POLL_MS, watchRun } from './policy/run-watch.ts';
import { isSuppressed } from './policy/cooldown.ts';
import type { PromptRenderer } from './ports.ts';
import {
  buildAdvisorRequest,
  canonicalRunDigest,
  effectiveRunScopes,
  hasLiveApproval,
  requiresPayloadApproval,
  shapeFor,
} from './preview.ts';
import type { AdvisorManifest } from './contract/manifest.ts';
import type { AdvisorRegistry, RegisteredAdvisor } from './registry.ts';
import type { BuiltSnapshot } from './snapshot/builder.ts';
import type { SnapshotPorts } from './snapshot/ports.ts';
import {
  finishRun,
  findAdvisor,
  findInsight,
  findRun,
  listGrants,
  loadSuppressions,
  lockAdvisor,
  recordFeedback,
  recordRunHealth,
  recordRunModel,
  rejectionsSince,
  quarantineAdvisor,
  retainRunPayload,
  startRun,
  upsertInsight,
  type FeedbackInput,
} from './store.ts';
import { validateResponse, type InsightRejection } from './validate/pipeline.ts';
// WP 5.3 — the narrator's findings envelope and its link-not-rank write.
import { linkNarration } from './advisors/local/link.ts';
import { buildNarrationRequest, type NarrationRequest } from './advisors/local/request.ts';

/** Deployment-level settings a run needs. Supplied by the composition root. */
export interface InsightsSettings {
  /**
   * @deprecated Kill level 1 is read through `InsightsDependencies.switches`
   * (WP 5.1). Consulted only when no `switches` port is bound — the worker's
   * `modules.ts` until the W-A wiring batch replaces its literal `true` — and
   * then an absent value is `false`: fail closed.
   */
  readonly advisorsEnabled?: boolean;
  /** @deprecated As `advisorsEnabled`: the `module.insights` flag, read through `switches`. */
  readonly moduleEnabled?: boolean;
  /** IANA zone. Every "today" in a snapshot is computed in it. */
  readonly timeZone: string;
  readonly baseCurrency: string;
  /**
   * The deployment secret merchant pseudonyms are keyed from.
   *
   * One value, mixed with the user id inside `deriveTokenKey`. It must be
   * stable for the life of the install — rotating it re-pseudonymises every
   * merchant, which breaks an advisor's ability to say "the same vendor as last
   * month" and orphans every `MERCHANT_…` already stored in an evidence row.
   */
  readonly tokenSecret: string;
}

export interface InsightsDependencies {
  readonly registry: AdvisorRegistry;
  readonly ports: SnapshotPorts;
  readonly settings: InsightsSettings;
  /**
   * Kill levels 1 and 2, read live (WP 5.1). Bound by the composition root to
   * `config.env.ADVISORS_ENABLED`, an **uncached** flag reader, and which
   * kinds are configured (`createRunSwitches`). Absent ⇒ the deprecated
   * booleans on `settings`, fail-closed, and no kind but `builtin`.
   */
  readonly switches?: RunSwitches;
  /**
   * WP 5.2's prompt construction, bound by the composition root. Needed by a
   * `local_model` run (the prompt hash and model it records) and by the
   * payload preview (the template hash in the query shape). Absent ⇒ a
   * `local_model` advisor has no approvable shape and never runs.
   */
  readonly promptRenderer?: PromptRenderer;
  /**
   * WP 10.6 (D30): the holder's own narrator — the local model, a hosted
   * provider with their key, or `null` for Off / nothing configured —
   * resolved per run by the composition root's cached runtime
   * (`apps/api/src/narrator-wiring.ts`). Absent ⇒ `registry` and
   * `promptRenderer` as bound: the behaviour before WP 10.6. See `holder.ts`.
   */
  readonly narratorFor?: (userId: string) => Promise<HolderNarrator | null>;
  /** The run watcher's interval. Tests only; production is `RUN_WATCH_POLL_MS`. */
  readonly runWatchPollMs?: number;
}

/**
 * Which job lane may execute an advisor of this kind.
 *
 * `builtin` runs in `insights.run` (or inline, for the API's button); every
 * other kind runs only in `insights.run_local`. `external` has no advisor
 * until Phase 6 and is put in the untrusted lane by default rather than the
 * built-in one: the failure to avoid is a slow, untrusted call queued in
 * front of the deterministic rules.
 */
export type RunLane = 'builtin' | 'local';

export function laneOf(kind: AdvisorKind): RunLane {
  return kind === 'builtin' ? 'builtin' : 'local';
}

/** Thrown — a wiring bug, not a refusal — when an advisor is executed outside its lane. */
export class LaneViolation extends Error {
  constructor(advisorId: string, kind: AdvisorKind, lane: RunLane) {
    super(
      `advisor ${advisorId} is a ${kind} advisor and runs only in the ${laneOf(kind)} lane ` +
        `(insights.run_local); it was asked to run in the ${lane} lane`,
    );
    this.name = 'LaneViolation';
  }
}

export interface RunAdvisorInput {
  readonly advisorId: string;
  readonly trigger: 'schedule' | 'event' | 'manual' | 'backfill';
  readonly triggerEventType?: string | null;
  /**
   * The lane executing this run. Default `builtin`. Only the
   * `insights.run_local` job handler passes `local`.
   */
  readonly lane?: RunLane;
  /**
   * `requiresPerRunConsent` scopes the holder consented to for **this** run
   * (Phase 4 gate G4-22). A standing grant of such a scope is dropped without
   * one. Nothing supplies it yet — WP 5.10's route does — so today such a
   * scope is never emitted.
   */
  readonly perRunConsent?: readonly AdvisorScope[];
  /**
   * WP 5.3. For a `narrates_only` advisor: the built-in insights to narrate —
   * the Brief's items, which WP 5.6 / W-C enqueue. Absent ⇒ the feed's own top
   * findings. Ignored for every other advisor.
   */
  readonly narrateInsightIds?: readonly string[];
}

export interface RunAdvisorResult {
  readonly runId: string;
  readonly advisorId: string;
  readonly status: 'completed' | 'failed' | 'refused' | 'cancelled';
  readonly refusal: RunRefusal | null;
  /** Set exactly when `status` is `cancelled`: the broadest level that applied. */
  readonly cancelReason: CancelReason | null;
  readonly proposed: number;
  readonly accepted: number;
  readonly rejected: number;
  /** Accepted proposals that a cooldown kept out of the queue. */
  readonly suppressed: number;
  /** Of the written rows, how many were new. Drives `InsightProposed`. */
  readonly inserted: number;
  readonly emittedScopes: readonly string[];
  readonly inputDigest: string | null;
  readonly quarantined: boolean;
  readonly rejections: readonly InsightRejection[];
}

const EMPTY_RESULT = {
  cancelReason: null,
  proposed: 0,
  accepted: 0,
  rejected: 0,
  suppressed: 0,
  inserted: 0,
  emittedScopes: [] as readonly string[],
  inputDigest: null,
  quarantined: false,
  rejections: [] as readonly InsightRejection[],
} as const;

function switchesOf(dependencies: InsightsDependencies): RunSwitches {
  return dependencies.switches ?? staticRunSwitches(dependencies.settings);
}

// ---------------------------------------------------------------------------
// The gate: one read of every switch, used before, during and at the barrier
// ---------------------------------------------------------------------------

interface GateRead {
  readonly inputs: KillSwitchInputs;
  readonly cancelRequestedAt: Date | null;
}

/**
 * Read every input `decideRun` needs, for one advisor (and, once it exists,
 * one run). `lock` takes the `advisors` row `FOR UPDATE` — the write barrier's
 * form; the watcher and transaction 1 read without it.
 */
async function readGate(
  executor: InsightsExecutor,
  switches: RunSwitches,
  input: {
    readonly userId: string;
    readonly manifest: AdvisorManifest;
    readonly runId: string | null;
    readonly shape: string | null;
    readonly lock: boolean;
  },
): Promise<GateRead> {
  const { userId, manifest } = input;
  const [advisorsEnabled, moduleEnabled, kindEnabled] = await Promise.all([
    switches.advisorsEnabled(),
    switches.moduleEnabled(userId),
    switches.kindEnabled(userId, manifest.kind),
  ]);
  const row = input.lock
    ? await lockAdvisor(executor, userId, manifest.advisor_id)
    : await findAdvisor(executor, userId, manifest.advisor_id);
  const payloadApproved =
    !requiresPayloadApproval(manifest.kind) ||
    (input.shape !== null &&
      (await hasLiveApproval(executor, userId, manifest.advisor_id, input.shape)));
  const run = input.runId === null ? null : await findRun(executor, userId, input.runId);
  return {
    inputs: {
      advisorsEnabled,
      moduleEnabled,
      kindEnabled,
      // An advisor with no registry row has not been turned on. The default is
      // off (the DDL says so too), so "never registered" and "registered and
      // disabled" behave identically rather than the first one being a hole.
      advisorEnabled: row?.enabled ?? false,
      quarantinedAt: row?.quarantinedAt ?? null,
      payloadApproved,
    },
    cancelRequestedAt: run?.cancelRequestedAt ?? null,
  };
}

/**
 * The advisor call, raced against our deadline and against the watcher's
 * abort. An advisor that ignores its signal still ends here — it can only
 * leak its own continuation.
 */
async function invoke(
  registered: RegisteredAdvisor,
  request: AdvisorRequest,
  controller: AbortController,
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, rejectPromise) => {
    timer = setTimeout(() => {
      controller.abort(new Error('advisor_timeout'));
      rejectPromise(new Error('advisor_timeout'));
    }, timeoutMs);
    onAbort = () => {
      const reason: unknown = controller.signal.reason;
      rejectPromise(reason instanceof Error ? reason : new Error('advisor_aborted'));
    };
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([registered.advisor.run(request, controller.signal), stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) controller.signal.removeEventListener('abort', onAbort);
  }
}

export async function runAdvisor(
  database: InsightsDatabase,
  context: InsightsContext,
  boundDependencies: InsightsDependencies,
  input: RunAdvisorInput,
): Promise<RunAdvisorResult> {
  // WP 10.6: the holder's narrator, resolved once, before anything else — the
  // renderer that records the model, the model this run calls and the shape
  // its approval is checked against all come from this one answer.
  const dependencies = await dependenciesForHolder(boundDependencies, context.userId);
  const registered = dependencies.registry.get(input.advisorId);
  if (registered === undefined) {
    // Not a refusal: a refusal is an answer about a known advisor. Being asked
    // to run something that was never registered is a wiring bug, and failing
    // loudly at the composition root is better than an `advisor_runs` row
    // nobody will read.
    throw new Error(`advisor ${input.advisorId} is not registered`);
  }
  const { manifest, limits } = registered;
  const lane = input.lane ?? 'builtin';
  if (laneOf(manifest.kind) !== lane) {
    // Before anything is opened or read: the lane is a property of the call
    // site, and the wrong call site gets no `advisor_runs` row to hide in.
    throw new LaneViolation(manifest.advisor_id, manifest.kind, lane);
  }
  const switches = switchesOf(dependencies);

  // --- transaction 1: the switches, and the run row -------------------------
  const opened = await database.transaction(async (tx) => {
    const grants = await listGrants(tx, context.userId, manifest.advisor_id);
    const scopes = effectiveRunScopes(manifest, grants, input.perRunConsent ?? []);
    const shape = requiresPayloadApproval(manifest.kind)
      ? shapeFor(manifest, scopes, dependencies)
      : null;
    const gate = await readGate(tx, switches, {
      userId: context.userId,
      manifest,
      runId: null,
      shape,
      lock: false,
    });
    const decision = decideRun(gate.inputs);

    const run = await startRun(tx, context, {
      advisorId: manifest.advisor_id,
      advisorVersion: manifest.version,
      trigger: input.trigger,
      triggerEventType: input.triggerEventType ?? null,
    });

    if (!decision.run) {
      await finishRun(tx, context, {
        runId: run.id,
        status: 'refused',
        refusal: decision.refusal,
        durationMs: 0,
      });
      return { runId: run.id, refusal: decision.refusal, scopes, shape };
    }

    await appendEvent(
      platformOf(tx),
      AdvisorRunStarted.create(
        {
          runId: run.id,
          advisorId: manifest.advisor_id,
          advisorVersion: manifest.version,
          kind: manifest.kind as AdvisorKind,
          trigger: input.trigger,
        },
        {
          userId: context.userId,
          aggregateId: run.id,
          correlationId: context.correlationId,
          causationId: context.causationId ?? null,
        },
        context.clock,
      ),
    );

    return { runId: run.id, refusal: null, scopes, shape };
  });

  if (opened.refusal !== null) {
    return {
      ...EMPTY_RESULT,
      runId: opened.runId,
      advisorId: manifest.advisor_id,
      status: 'refused',
      refusal: opened.refusal,
    };
  }

  // --- outside any transaction: build, retain, invoke (watched), validate ---
  // The injected clock, not `Date.now()`: every duration this module records
  // comes from the same source as every timestamp it writes, so a fixed clock
  // in a test produces a run whose `duration_ms` is 0 rather than a few
  // milliseconds of wall time that make a golden comparison flaky.
  const clock: Clock = context.clock;
  const startedAt = clock.now().getTime();
  let built: BuiltSnapshot | null = null;

  try {
    // WP 5.3: a narrator is sent the findings envelope (laundered against its
    // effective grant) and an empty snapshot; everything else is sent its
    // granted snapshot. `narration` is non-null exactly for a narrator run.
    const narration: NarrationRequest | null = manifest.capabilities.narrates_only
      ? await buildNarrationRequest(
          database,
          dependencies,
          context,
          registered,
          opened.scopes,
          input.narrateInsightIds,
        )
      : null;
    const prepared =
      narration ?? (await buildAdvisorRequest(dependencies, context, registered, opened.scopes));
    const { request } = prepared;
    // Phase 5 gate C5-5/G5-16: the digest this run records — the inspector's
    // authority, and what every insight proposed this run "stood on" — must
    // cover everything this request actually carried: its snapshot, its
    // findings envelope (set only for a narrator) and the scopes it was
    // granted. `prepared.built.inputDigest` alone is `inputDigest(snapshot)`,
    // and a narrator's snapshot is always `{}` by design (`advisors/local/
    // request.ts`), so every narrator run carried the *same* digest and a
    // tampered findings envelope still re-digested clean. `canonicalRunDigest`
    // is the one function that computes this, used here and by
    // `inspectRunPayload` below — never two implementations of the same
    // check.
    const corrected: BuiltSnapshot = {
      ...prepared.built,
      inputDigest: canonicalRunDigest(request),
    };
    built = corrected;
    if (narration !== null && narration.findingCount === 0) {
      // Nothing the narrator may see: no prompt, no model call, no payload.
      return await closeNothingToNarrate(database, context, {
        runId: opened.runId,
        advisorId: manifest.advisor_id,
        durationMs: clock.now().getTime() - startedAt,
        built: corrected,
      });
    }

    // What a local model or an external advisor is sent is retained for the
    // run inspector (30 days), and a local model's prompt hash and pinned
    // model are recorded — before the call, so a run that never returns
    // still says what it was waiting on. A short transaction of its own.
    if (requiresPayloadApproval(manifest.kind) && opened.shape !== null) {
      const shape = opened.shape;
      const prompt =
        manifest.kind === 'local_model' ? dependencies.promptRenderer?.render(request) : undefined;
      const canonical = canonicalJson(request);
      await database.transaction(async (tx) => {
        await retainRunPayload(tx, context, {
          runId: opened.runId,
          advisorId: manifest.advisor_id,
          queryShape: shape,
          payload: JSON.parse(canonical) as Record<string, unknown>,
          payloadBytes: new TextEncoder().encode(canonical).byteLength,
        });
        if (prompt !== undefined && dependencies.promptRenderer !== undefined) {
          await recordRunModel(tx, context, {
            runId: opened.runId,
            llmModel: dependencies.promptRenderer.model,
            llmPromptHash: prompt.hash,
          });
        }
      });
    }

    const controller = new AbortController();
    const watch = watchRun({
      controller,
      pollMs: dependencies.runWatchPollMs ?? RUN_WATCH_POLL_MS,
      probe: async () => {
        // Short reads on the pool — no transaction, nothing held between ticks.
        const gate = await readGate(database, switches, {
          userId: context.userId,
          manifest,
          runId: opened.runId,
          shape: opened.shape,
          lock: false,
        });
        return decideContinue({ ...gate.inputs, cancelRequestedAt: gate.cancelRequestedAt });
      },
    });
    let body: unknown;
    try {
      body = await invoke(registered, request, controller, limits.timeoutMs);
    } finally {
      await watch.stop();
    }

    const outcome = validateResponse({
      request,
      manifest,
      limits,
      body,
      // Never supplied before WP 5.3, so every narration was refused at step
      // 4 and the narration path had never run once (05 §2). The coarse half
      // of "restate, never introduce"; the 1:1 match is the fine half.
      ...(narration === null
        ? {}
        : { knownFindingTypes: new Set(request.findings?.map((finding) => finding.type) ?? []) }),
    });
    if (!outcome.ok) {
      // An envelope-level rejection is a failed run, not a run that proposed
      // nothing: there is no partial result to keep and the breaker should
      // count it. The digest is still recorded — knowing what we sent is most
      // valuable precisely when the answer came back unusable.
      return await failRun(database, context, {
        runId: opened.runId,
        advisorId: manifest.advisor_id,
        kind: manifest.kind,
        errorCode: `${outcome.rejection.step}:${outcome.rejection.reason}`,
        durationMs: clock.now().getTime() - startedAt,
        inputDigest: corrected.inputDigest,
        grantedScopes: corrected.grantedScopes,
        emittedScopes: corrected.emittedScopes,
      });
    }

    // --- transaction 2: the write barrier, suppression, the writes, the close
    const snapshot = corrected;
    return await database.transaction(async (tx): Promise<RunAdvisorResult> => {
      // The write barrier. Every switch, re-read under the `advisors` row lock
      // every level-3/4 writer also takes, before anything is written. A kill
      // that landed after the watcher's last tick — between the reply and this
      // line — is seen here, and the run writes nothing.
      const gate = await readGate(tx, switches, {
        userId: context.userId,
        manifest,
        runId: opened.runId,
        shape: opened.shape,
        lock: true,
      });
      const stop = decideContinue({ ...gate.inputs, cancelRequestedAt: gate.cancelRequestedAt });
      if (stop !== null) {
        return closeCancelled(tx, context, {
          runId: opened.runId,
          advisorId: manifest.advisor_id,
          reason: stop,
          stage: 'write_barrier',
          durationMs: clock.now().getTime() - startedAt,
          built: snapshot,
        });
      }

      const outbox = platformOf(tx);
      const suppressions = await loadSuppressions(tx, context.userId, manifest.advisor_id);
      const now = clock.now();

      let suppressed = 0;
      let inserted = 0;
      let written = 0;

      for (const validated of outcome.accepted) {
        if (isSuppressed(suppressions.get(validated.insight.key) ?? null, now)) {
          suppressed += 1;
          continue;
        }
        const result = await upsertInsight(tx, context, {
          validated,
          advisorId: manifest.advisor_id,
          advisorVersion: manifest.version,
          runId: opened.runId,
          inputDigest: snapshot.inputDigest,
        });
        if (narration !== null) {
          // Linked, never ranked (0031): the narration becomes wording on its
          // finding's card, in this transaction, and emits no InsightProposed
          // — a narration is not a finding. A finding gone since assembly
          // takes its narration with it.
          const findingId = narration.insightIdByKey.get(validated.insight.key);
          const linked =
            findingId !== undefined &&
            (await linkNarration(tx, context.userId, result.insightId, findingId));
          if (linked) written += 1;
          continue;
        }
        written += 1;
        if (!result.inserted) continue;
        inserted += 1;
        await appendEvent(
          outbox,
          InsightProposed.create(
            {
              insightId: result.insightId,
              advisorId: manifest.advisor_id,
              key: validated.insight.key,
              period: validated.insight.period,
              type: validated.insight.type,
              severity: validated.severity,
              confidence: validated.insight.confidence,
              impactAnnualizedMinor: validated.insight.impact.annualized?.minor ?? null,
              currency:
                validated.insight.impact.annualized?.currency ??
                validated.insight.impact.one_time?.currency ??
                null,
              evidenceCount: validated.evidence.length,
            },
            {
              userId: context.userId,
              aggregateId: result.insightId,
              correlationId: context.correlationId,
              causationId: context.causationId ?? null,
            },
            clock,
          ),
        );
      }

      const durationMs = clock.now().getTime() - startedAt;
      await finishRun(tx, context, {
        runId: opened.runId,
        status: 'completed',
        inputDigest: snapshot.inputDigest,
        grantedScopes: snapshot.grantedScopes,
        emittedScopes: snapshot.emittedScopes,
        proposedCount: outcome.response.insights.length,
        acceptedCount: outcome.accepted.length,
        rejectedCount: outcome.rejected.length,
        rejections: outcome.rejected.map((rejection) => ({ ...rejection })),
        durationMs,
      });

      await recordRunHealth(tx, context, manifest.advisor_id, true);

      // The breaker's second trigger, per kind: a built-in whose run the
      // validator mostly refused; a local model with five refusals in a
      // rolling 24 h (08 §4.4). This run's row is already closed above, so
      // the window includes it.
      const trip = shouldQuarantine({
        kind: manifest.kind,
        consecutiveFailures: 0,
        accepted: outcome.accepted.length,
        rejected: outcome.rejected.length,
        rejectionsIn24h:
          manifest.kind === 'builtin'
            ? 0
            : await rejectionsSince(tx, context.userId, manifest.advisor_id, dayBefore(now)),
      });
      if (trip !== null) await quarantineAdvisor(tx, context, manifest.advisor_id, trip);

      await appendEvent(
        outbox,
        AdvisorRunCompleted.create(
          {
            runId: opened.runId,
            advisorId: manifest.advisor_id,
            inputDigest: snapshot.inputDigest,
            proposed: outcome.response.insights.length,
            accepted: outcome.accepted.length,
            rejected: outcome.rejected.length,
            emittedScopes: [...snapshot.emittedScopes],
            durationMs,
          },
          {
            userId: context.userId,
            aggregateId: opened.runId,
            correlationId: context.correlationId,
            causationId: context.causationId ?? null,
          },
          clock,
        ),
      );

      return {
        runId: opened.runId,
        advisorId: manifest.advisor_id,
        status: 'completed' as const,
        refusal: null,
        cancelReason: null,
        proposed: outcome.response.insights.length,
        accepted: written,
        rejected: outcome.rejected.length,
        suppressed,
        inserted,
        emittedScopes: snapshot.emittedScopes,
        inputDigest: snapshot.inputDigest,
        quarantined: trip !== null,
        rejections: outcome.rejected,
      };
    });
  } catch (error) {
    if (error instanceof RunCancelled) {
      // The watcher stopped it in flight. Not a failure: nothing was wrong
      // with the advisor, somebody switched it off.
      const cancelledBuilt = built;
      return await database.transaction((tx) =>
        closeCancelled(tx, context, {
          runId: opened.runId,
          advisorId: manifest.advisor_id,
          reason: error.reason,
          stage: 'in_flight',
          durationMs: clock.now().getTime() - startedAt,
          built: cancelledBuilt,
        }),
      );
    }
    return await failRun(database, context, {
      runId: opened.runId,
      advisorId: manifest.advisor_id,
      kind: manifest.kind,
      errorCode: error instanceof Error ? error.message.slice(0, 120) : 'unknown_error',
      durationMs: clock.now().getTime() - startedAt,
      inputDigest: built?.inputDigest ?? null,
      grantedScopes: built?.grantedScopes ?? [],
      emittedScopes: built?.emittedScopes ?? [],
    });
  }
}

function dayBefore(now: Date): Date {
  return new Date(now.getTime() - 86_400_000);
}

interface CloseCancelledInput {
  readonly runId: string;
  readonly advisorId: string;
  readonly reason: CancelReason;
  readonly stage: 'in_flight' | 'write_barrier';
  readonly durationMs: number;
  readonly built: BuiltSnapshot | null;
}

/**
 * Close a run as `cancelled`, naming the level, and say so. In the caller's
 * transaction: at the barrier that is transaction 2, which then commits this
 * and nothing else. The breaker is not touched — a kill is not the advisor's
 * failure — and the digest of what was sent is kept, so the inspector can
 * still answer "what did it see before we stopped it?".
 */
async function closeCancelled(
  tx: InsightsExecutor,
  context: InsightsContext,
  input: CloseCancelledInput,
): Promise<RunAdvisorResult> {
  await finishRun(tx, context, {
    runId: input.runId,
    status: 'cancelled',
    cancelReason: input.reason,
    inputDigest: input.built?.inputDigest ?? null,
    grantedScopes: input.built?.grantedScopes ?? [],
    emittedScopes: input.built?.emittedScopes ?? [],
    durationMs: input.durationMs,
  });
  await appendEvent(
    platformOf(tx),
    AdvisorRunCancelled.create(
      {
        runId: input.runId,
        advisorId: input.advisorId,
        reason: input.reason,
        level: LADDER_LEVEL[input.reason],
        stage: input.stage,
        durationMs: input.durationMs,
      },
      {
        userId: context.userId,
        aggregateId: input.runId,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
      },
      context.clock,
    ),
  );
  return {
    ...EMPTY_RESULT,
    runId: input.runId,
    advisorId: input.advisorId,
    status: 'cancelled',
    refusal: null,
    cancelReason: input.reason,
    inputDigest: input.built?.inputDigest ?? null,
    emittedScopes: input.built?.emittedScopes ?? [],
  };
}

/**
 * WP 5.3: a narrator run whose envelope came out empty — nothing pending, or
 * nothing its grant launders. Completed with zero proposals: nothing was sent,
 * nothing was retained, no model was called, and the breaker is not touched.
 */
async function closeNothingToNarrate(
  database: InsightsDatabase,
  context: InsightsContext,
  input: {
    readonly runId: string;
    readonly advisorId: string;
    readonly durationMs: number;
    readonly built: BuiltSnapshot;
  },
): Promise<RunAdvisorResult> {
  return database.transaction(async (tx) => {
    await finishRun(tx, context, {
      runId: input.runId,
      status: 'completed',
      inputDigest: input.built.inputDigest,
      grantedScopes: input.built.grantedScopes,
      emittedScopes: [],
      proposedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      rejections: [],
      durationMs: input.durationMs,
    });
    await appendEvent(
      platformOf(tx),
      AdvisorRunCompleted.create(
        {
          runId: input.runId,
          advisorId: input.advisorId,
          inputDigest: input.built.inputDigest,
          proposed: 0,
          accepted: 0,
          rejected: 0,
          emittedScopes: [],
          durationMs: input.durationMs,
        },
        {
          userId: context.userId,
          aggregateId: input.runId,
          correlationId: context.correlationId,
          causationId: context.causationId ?? null,
        },
        context.clock,
      ),
    );
    return {
      ...EMPTY_RESULT,
      runId: input.runId,
      advisorId: input.advisorId,
      status: 'completed' as const,
      refusal: null,
      inputDigest: input.built.inputDigest,
    };
  });
}

interface FailRunInput {
  readonly runId: string;
  readonly advisorId: string;
  readonly kind: AdvisorKind;
  readonly errorCode: string;
  readonly durationMs: number;
  readonly inputDigest: string | null;
  readonly grantedScopes: readonly string[];
  readonly emittedScopes: readonly string[];
}

/**
 * Close a run as failed, advance the failure streak, trip the breaker if the
 * streak has reached its kind's limit, and say so.
 *
 * Module-private rather than a method, because both call sites in `runAdvisor`
 * want the same five side effects in the same order and a second ordering is
 * how a failure ends up counted twice or not at all.
 */
async function failRun(
  database: InsightsDatabase,
  context: InsightsContext,
  input: FailRunInput,
): Promise<RunAdvisorResult> {
  return database.transaction(async (tx) => {
    await finishRun(tx, context, {
      runId: input.runId,
      status: 'failed',
      errorCode: input.errorCode,
      inputDigest: input.inputDigest,
      grantedScopes: input.grantedScopes,
      emittedScopes: input.emittedScopes,
      durationMs: input.durationMs,
    });
    const consecutiveFailures = await recordRunHealth(tx, context, input.advisorId, false);
    const trip = shouldQuarantine({
      kind: input.kind,
      consecutiveFailures,
      accepted: 0,
      rejected: 0,
      rejectionsIn24h:
        input.kind === 'builtin'
          ? 0
          : await rejectionsSince(
              tx,
              context.userId,
              input.advisorId,
              dayBefore(context.clock.now()),
            ),
    });
    if (trip !== null) await quarantineAdvisor(tx, context, input.advisorId, trip);

    await appendEvent(
      platformOf(tx),
      AdvisorRunFailed.create(
        {
          runId: input.runId,
          advisorId: input.advisorId,
          errorCode: input.errorCode,
          consecutiveFailures,
          quarantined: trip !== null,
        },
        {
          userId: context.userId,
          aggregateId: input.runId,
          correlationId: context.correlationId,
          causationId: context.causationId ?? null,
        },
        context.clock,
      ),
    );

    return {
      ...EMPTY_RESULT,
      runId: input.runId,
      advisorId: input.advisorId,
      status: 'failed' as const,
      refusal: null,
      inputDigest: input.inputDigest,
      emittedScopes: input.emittedScopes,
      quarantined: trip !== null,
    };
  });
}

/**
 * Run every advisor a trigger names, sequentially, in the built-in lane.
 *
 * Sequential on purpose. Each run assembles the whole snapshot in memory, and
 * the snapshot is the most sensitive object this application constructs;
 * running eight advisors concurrently would mean eight copies of it resident at
 * once for no wall-clock gain worth having on a single-user install. One
 * advisor's failure does not stop the next — the result list carries each
 * outcome, and `AdvisorRunFailed` is already on the outbox by then.
 *
 * A caller with a mixed list — the API's button — wants `requestAdvisorRuns`
 * in `jobs.ts`, which runs the built-ins here and queues the rest in their
 * lane; handing a `local_model` id to this function throws `LaneViolation`.
 */
export async function runAdvisors(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: InsightsDependencies,
  input: {
    readonly advisorIds: readonly string[];
    readonly trigger: RunAdvisorInput['trigger'];
    readonly triggerEventType?: string | null;
  },
): Promise<readonly RunAdvisorResult[]> {
  const results: RunAdvisorResult[] = [];
  for (const advisorId of input.advisorIds) {
    results.push(
      await runAdvisor(database, context, dependencies, {
        advisorId,
        trigger: input.trigger,
        triggerEventType: input.triggerEventType ?? null,
      }),
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// The human half
// ---------------------------------------------------------------------------

export interface ReviewResult {
  readonly insightId: string;
  readonly status: string;
  readonly dismissCount: number;
  readonly permanent: boolean;
  readonly suppressedUntil: Date | null;
}

/**
 * Record the user's answer and state the corresponding fact.
 *
 * One transaction, because the log row, the status change and the ladder must
 * agree — see `store.ts`'s `recordFeedback` — and the event must not survive a
 * rollback of any of them.
 */
export async function reviewInsight(
  database: InsightsDatabase,
  context: InsightsContext,
  input: FeedbackInput,
): Promise<ReviewResult> {
  return database.transaction(async (tx) => {
    const before = await findInsight(tx, context.userId, input.insightId);
    if (before === null) throw new Error(`no insight ${input.insightId}`);

    const outcome = await recordFeedback(tx, context, input);
    const outbox = platformOf(tx);
    const meta = {
      userId: context.userId,
      aggregateId: before.id,
      correlationId: context.correlationId,
      causationId: context.causationId ?? null,
    };

    if (input.action === 'accept') {
      await appendEvent(
        outbox,
        InsightAccepted.create(
          {
            insightId: before.id,
            advisorId: before.advisorId,
            key: before.key,
            type: before.type,
          },
          meta,
          context.clock,
        ),
      );
    } else if (input.action === 'dismiss') {
      await appendEvent(
        outbox,
        InsightDismissed.create(
          {
            insightId: before.id,
            advisorId: before.advisorId,
            key: before.key,
            type: before.type,
            dismissCount: outcome.suppression?.dismissCount ?? 1,
            permanent: outcome.suppression?.permanent ?? false,
            suppressedUntil: outcome.suppression?.suppressedUntil?.toISOString() ?? null,
          },
          meta,
          context.clock,
        ),
      );
    } else {
      await appendEvent(
        outbox,
        InsightReviewed.create(
          {
            insightId: before.id,
            advisorId: before.advisorId,
            key: before.key,
            action: input.action,
            status: outcome.status as 'pending_review',
            snoozeUntil: outcome.suppression?.suppressedUntil?.toISOString() ?? null,
          },
          meta,
          context.clock,
        ),
      );
    }

    return {
      insightId: before.id,
      status: outcome.status,
      dismissCount: outcome.suppression?.dismissCount ?? 0,
      permanent: outcome.suppression?.permanent ?? false,
      suppressedUntil: outcome.suppression?.suppressedUntil ?? null,
    };
  });
}
