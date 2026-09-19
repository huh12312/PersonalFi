// SPDX-License-Identifier: MIT
/**
 * One advisor run, end to end — and the order of its steps is the design.
 *
 * ```
 * kill switches → open the run → build the snapshot → invoke → validate
 *              → drop what is suppressed → upsert → close the run
 * ```
 *
 * Three things about that order are load-bearing:
 *
 *   * **The switches come first, before the snapshot exists.** A quarantined or
 *     disabled advisor is not handed data and then ignored; it is never handed
 *     data. That is why `"a quarantined advisor's output never reaches
 *     pending_review"` is true for a stronger reason than "we drop its output".
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
 *     an interrupted run should look like.
 *
 * ## The deadline is ours
 *
 * 08 §4.4: "Hard timeout, enforced by us." The `AbortSignal` passed to
 * `Advisor.run` is created here from `resolveLimits`, and the `Promise.race`
 * below means a built-in that ignores the signal still cannot hold the worker —
 * it can only leak its own continuation, which is a bug in that advisor and not
 * an outage.
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
import { newId, todayIn, type Clock } from '@core/kernel';
import { appendEvent } from '@core/platform';
import type { AdvisorKind, AdvisorScope } from './contract/scopes.ts';
import type { AdvisorRequest } from './contract/request.ts';
import { ADVISOR_CONTRACT_MAJOR } from './contract/version.ts';
import { platformOf, type InsightsContext, type InsightsDatabase } from './db.ts';
import {
  AdvisorRunCompleted,
  AdvisorRunFailed,
  AdvisorRunStarted,
  InsightAccepted,
  InsightDismissed,
  InsightProposed,
  InsightReviewed,
} from './events.ts';
import { decideRun, shouldQuarantine, type RunRefusal } from './policy/kill-switches.ts';
import { isSuppressed } from './policy/cooldown.ts';
import type { AdvisorRegistry } from './registry.ts';
import { SnapshotBuilder } from './snapshot/builder.ts';
import type { SnapshotPorts } from './snapshot/ports.ts';
import { deriveTokenKey } from './snapshot/tokens.ts';
import {
  finishRun,
  findAdvisor,
  findInsight,
  listGrants,
  loadSuppressions,
  recordFeedback,
  recordRunHealth,
  quarantineAdvisor,
  startRun,
  upsertInsight,
  type FeedbackInput,
} from './store.ts';
import { validateResponse, type InsightRejection } from './validate/pipeline.ts';

/** Deployment-level settings a run needs. Supplied by the composition root. */
export interface InsightsSettings {
  /** Kill switch 1. `ADVISORS_ENABLED`. */
  readonly advisorsEnabled: boolean;
  /** The `module.insights` feature flag, resolved for this user. */
  readonly moduleEnabled: boolean;
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
}

export interface RunAdvisorInput {
  readonly advisorId: string;
  readonly trigger: 'schedule' | 'event' | 'manual' | 'backfill';
  readonly triggerEventType?: string | null;
}

export interface RunAdvisorResult {
  readonly runId: string;
  readonly advisorId: string;
  readonly status: 'completed' | 'failed' | 'refused';
  readonly refusal: RunRefusal | null;
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

/** `AbortSignal.timeout` plus a race, so an advisor that ignores it still ends. */
async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, rejectPromise) => {
    timer = setTimeout(() => {
      controller.abort();
      rejectPromise(new Error('advisor_timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runAdvisor(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: InsightsDependencies,
  input: RunAdvisorInput,
): Promise<RunAdvisorResult> {
  const registered = dependencies.registry.get(input.advisorId);
  if (registered === undefined) {
    // Not a refusal: a refusal is an answer about a known advisor. Being asked
    // to run something that was never registered is a wiring bug, and failing
    // loudly at the composition root is better than an `advisor_runs` row
    // nobody will read.
    throw new Error(`advisor ${input.advisorId} is not registered`);
  }
  const { manifest, limits } = registered;

  // --- transaction 1: the switches, and the run row -------------------------
  const opened = await database.transaction(async (tx) => {
    const row = await findAdvisor(tx, context.userId, manifest.advisor_id);
    const decision = decideRun({
      advisorsEnabled: dependencies.settings.advisorsEnabled,
      moduleEnabled: dependencies.settings.moduleEnabled,
      // An advisor with no registry row has not been turned on. The default is
      // off (the DDL says so too), so "never registered" and "registered and
      // disabled" behave identically rather than the first one being a hole.
      advisorEnabled: row?.enabled ?? false,
      quarantinedAt: row?.quarantinedAt ?? null,
    });

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
      return { runId: run.id, refusal: decision.refusal, grants: [] as readonly AdvisorScope[] };
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

    return {
      runId: run.id,
      refusal: null,
      grants: await listGrants(tx, context.userId, manifest.advisor_id),
    };
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

  // --- outside any transaction: build, invoke, validate ---------------------
  // The injected clock, not `Date.now()`: every duration this module records
  // comes from the same source as every timestamp it writes, so a fixed clock
  // in a test produces a run whose `duration_ms` is 0 rather than a few
  // milliseconds of wall time that make a golden comparison flaky.
  const clock: Clock = context.clock;
  const startedAt = clock.now().getTime();
  const today = todayIn(clock, dependencies.settings.timeZone);

  try {
    const builder = new SnapshotBuilder(dependencies.ports);
    const built = await builder.build({
      userId: context.userId,
      kind: manifest.kind,
      // The intersection of what the user granted and what this advisor asked
      // for. A grant the manifest never requested is not silently used: the
      // manifest is the artefact a human reviewed and it is the narrower claim.
      grantedScopes: opened.grants.filter((scope) => manifest.requires_scopes.includes(scope)),
      today,
      baseCurrency: dependencies.settings.baseCurrency,
      tokenKey: deriveTokenKey(dependencies.settings.tokenSecret, context.userId),
    });

    const request: AdvisorRequest = {
      contract_version: ADVISOR_CONTRACT_MAJOR,
      request_id: newId(),
      advisor_id: manifest.advisor_id,
      advisor_version: manifest.version,
      kind: manifest.kind,
      generated_at: clock.now().toISOString(),
      base_currency: dependencies.settings.baseCurrency,
      time_zone: dependencies.settings.timeZone,
      today,
      granted_scopes: [...built.grantedScopes],
      input_digest: built.inputDigest,
      limits: {
        max_insights: limits.maxInsights,
        max_response_bytes: limits.maxResponseBytes,
        deadline: new Date(clock.now().getTime() + limits.timeoutMs).toISOString(),
      },
      snapshot: built.snapshot,
    };

    const body = await withDeadline(
      (signal) => registered.advisor.run(request, signal),
      limits.timeoutMs,
    );

    const outcome = validateResponse({ request, manifest, limits, body });
    if (!outcome.ok) {
      // An envelope-level rejection is a failed run, not a run that proposed
      // nothing: there is no partial result to keep and the breaker should
      // count it. The digest is still recorded — knowing what we sent is most
      // valuable precisely when the answer came back unusable.
      return await failRun(database, context, {
        runId: opened.runId,
        advisorId: manifest.advisor_id,
        errorCode: `${outcome.rejection.step}:${outcome.rejection.reason}`,
        durationMs: clock.now().getTime() - startedAt,
        inputDigest: built.inputDigest,
        grantedScopes: built.grantedScopes,
        emittedScopes: built.emittedScopes,
      });
    }

    // --- transaction 2: suppression, the writes, the close -------------------
    return await database.transaction(async (tx) => {
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
          inputDigest: built.inputDigest,
        });
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
        inputDigest: built.inputDigest,
        grantedScopes: built.grantedScopes,
        emittedScopes: built.emittedScopes,
        proposedCount: outcome.response.insights.length,
        acceptedCount: outcome.accepted.length,
        rejectedCount: outcome.rejected.length,
        rejections: outcome.rejected.map((rejection) => ({ ...rejection })),
        durationMs,
      });

      await recordRunHealth(tx, context, manifest.advisor_id, true);

      // The breaker's second trigger: a run whose output the validator mostly
      // refused. An advisor having a bad night fails; an advisor whose output
      // is mostly unciteable is not having a bad night.
      const trip = shouldQuarantine({
        consecutiveFailures: 0,
        accepted: outcome.accepted.length,
        rejected: outcome.rejected.length,
      });
      if (trip !== null) await quarantineAdvisor(tx, context, manifest.advisor_id, trip);

      await appendEvent(
        outbox,
        AdvisorRunCompleted.create(
          {
            runId: opened.runId,
            advisorId: manifest.advisor_id,
            inputDigest: built.inputDigest,
            proposed: outcome.response.insights.length,
            accepted: outcome.accepted.length,
            rejected: outcome.rejected.length,
            emittedScopes: [...built.emittedScopes],
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
        proposed: outcome.response.insights.length,
        accepted: written,
        rejected: outcome.rejected.length,
        suppressed,
        inserted,
        emittedScopes: built.emittedScopes,
        inputDigest: built.inputDigest,
        quarantined: trip !== null,
        rejections: outcome.rejected,
      };
    });
  } catch (error) {
    return await failRun(database, context, {
      runId: opened.runId,
      advisorId: manifest.advisor_id,
      errorCode: error instanceof Error ? error.message.slice(0, 120) : 'unknown_error',
      durationMs: clock.now().getTime() - startedAt,
      inputDigest: null,
      grantedScopes: [],
      emittedScopes: [],
    });
  }
}

interface FailRunInput {
  readonly runId: string;
  readonly advisorId: string;
  readonly errorCode: string;
  readonly durationMs: number;
  readonly inputDigest: string | null;
  readonly grantedScopes: readonly string[];
  readonly emittedScopes: readonly string[];
}

/**
 * Close a run as failed, advance the failure streak, trip the breaker if the
 * streak has reached its limit, and say so.
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
    const trip = shouldQuarantine({ consecutiveFailures, accepted: 0, rejected: 0 });
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
 * Run every advisor a trigger names, sequentially.
 *
 * Sequential on purpose. Each run assembles the whole snapshot in memory, and
 * the snapshot is the most sensitive object this application constructs;
 * running eight advisors concurrently would mean eight copies of it resident at
 * once for no wall-clock gain worth having on a single-user install. One
 * advisor's failure does not stop the next — the result list carries each
 * outcome, and `AdvisorRunFailed` is already on the outbox by then.
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
