// SPDX-License-Identifier: MIT
/**
 * WP 4.6 — `planning.GoalOffTrack` (07 R6), once per evaluation.
 *
 * The WP 3.2 defect this exists not to repeat: `LotsUpdated` and friends were
 * emitted on **every** re-delivery of an unchanged sync, so every downstream
 * consumer woke every night to be told nothing. Here the risk is sharper — a
 * redelivered `ProjectionCompleted` re-running the goal evaluation would put a
 * second "your emergency fund is behind" in front of the holder for one
 * evaluation.
 *
 * The consumer is the real one (`createGoalPaceConsumer`), driven the way the
 * pump drives it: the same envelope handed over twice, as a redelivery after a
 * failed offset commit — or a replay from 0 after a version bump, which no
 * `processed_events` receipt can stop — would. The store is an in-memory fake
 * with the SQL guard's semantics (`claim` answers `true` once per run); the
 * real `UPDATE … WHERE goals_evaluated_at IS NULL` is exercised against
 * Postgres in `test/db/projection-store.test.ts`. The outbox is a recording
 * `Executor` that answers `append_domain_event` the way the database does, so
 * the events counted are the events `appendEvent` actually tried to write.
 */
import { DateOnly, Money, fixedClock, newId } from '@core/kernel';
import { silentLogger, type EventEnvelope, type Executor } from '@core/platform';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { ContributionPlan, EscalationPct } from '../src/contributions.ts';
import { GoalOffTrack, ProjectionCompleted } from '../src/events.ts';
import type { CashEarmark, Goal } from '../src/goals-store.ts';
import {
  GOAL_PACE_CONSUMED_EVENT_TYPES,
  GOAL_PACE_CONSUMER_NAME,
  createGoalPaceConsumer,
  evaluateGoalPace,
  type GoalEvaluationStore,
  type GoalFacts,
} from '../src/projection-service.ts';

const USER = 'a1946000-0000-7000-8000-00000000a046';
const AS_OF = DateOnly.parse('2026-09-25');
const CLOCK = fixedClock('2026-09-26T08:30:00Z');
const CORRELATION = '01920000-0000-7000-8000-0000000000c9';

const EMERGENCY = 'a1946000-0000-7000-8000-0000000000e1';
const CAR = 'a1946000-0000-7000-8000-0000000000e2';
const RETIREMENT = 'a1946000-0000-7000-8000-0000000000e3';

function usd(text: string): Money {
  return Money.parseAmount(text, 'USD');
}

function goal(id: string, kind: Goal['kind'], target: string, targetDate: string): Goal {
  return {
    id,
    kind,
    name: kind,
    target: usd(target),
    targetDate: DateOnly.parse(targetDate),
    priority: 3,
    fundedFromAccountIds: [],
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function monthly(goalId: string, amount: string): ContributionPlan {
  return {
    id: newId(),
    goalId,
    cadence: 'monthly',
    amount: usd(amount),
    escalationPct: '0' as EscalationPct,
    startsOn: DateOnly.parse('2026-01-01'),
    endsOn: null,
    source: 'USER',
    derivedAsOf: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function earmark(goalId: string, amount: string): CashEarmark {
  return {
    id: newId(),
    goalId,
    accountId: 'a1946000-0000-7000-8000-0000000000ac',
    name: 'set aside',
    amount: usd(amount),
    releasedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

/**
 * Emergency fund: $20,000 by 2027-09-30, $2,000 earmarked, $500 a month →
 * 12 months × $500 = $6,000 planned; $8,000 < $20,000 — **off track**.
 * Car: $5,000 by 2027-03-31, $1,000 earmarked, $1,000 a month → 6 × $1,000 +
 * $1,000 ≥ $5,000 — on track. Retirement: R2's, never evaluated here.
 */
const FACTS: GoalFacts = {
  goals: [
    goal(EMERGENCY, 'emergency_fund', '20000', '2027-09-30'),
    goal(CAR, 'purchase', '5000', '2027-03-31'),
    goal(RETIREMENT, 'retirement', '2000000', '2056-03-15'),
  ],
  contributions: new Map([
    [EMERGENCY, [monthly(EMERGENCY, '500')]],
    [CAR, [monthly(CAR, '1000')]],
  ]),
  earmarks: [earmark(EMERGENCY, '2000'), earmark(CAR, '1000')],
  balances: null,
};

/** The SQL guard's semantics: `true` once per run id, ever. */
function fakeStore(): GoalEvaluationStore & { readonly claims: string[] } {
  const claimed = new Set<string>();
  const claims: string[] = [];
  return {
    claims,
    async claim(_userId, runId) {
      claims.push(runId);
      if (claimed.has(runId)) return false;
      claimed.add(runId);
      return true;
    },
    facts: async () => FACTS,
  };
}

/** An `Executor` that answers `append_domain_event` and records what was appended. */
function recordingOutbox(): Executor & {
  readonly appended: { eventType: string; payload: unknown }[];
} {
  const dialect = new PgDialect();
  const appended: { eventType: string; payload: unknown }[] = [];
  return {
    appended,
    execute: async <TRow extends Record<string, unknown>>(query: SQL) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      if (!text.includes('append_domain_event')) {
        throw new Error(`unexpected statement in the outbox fake: ${text}`);
      }
      appended.push({ eventType: String(params[4]), payload: JSON.parse(String(params[6])) });
      return {
        rows: [{ out_seq: BigInt(appended.length), out_recorded_at: CLOCK.now() }],
      } as unknown as { rows: TRow[] };
    },
  };
}

function completed(runId: string, scenarioKind: 'baseline' | 'fork' = 'baseline'): EventEnvelope {
  const event = ProjectionCompleted.create(
    {
      runId,
      scenarioId: 'a1946000-0000-7000-8000-0000000000b1',
      scenarioKind,
      method: 'deterministic',
      asOfDate: AS_OF,
      seed: '12345',
      paths: 1,
      engineVersion: 'personalfi.deterministic/1',
      assumptionsVersion: `sha256:${'a'.repeat(64)}`,
      successProbability: '1.000000',
      durationMs: 3,
    },
    { userId: USER, aggregateId: runId, correlationId: CORRELATION },
    CLOCK,
  );
  return { ...event, seq: 1n, recordedAt: CLOCK.now() } as EventEnvelope;
}

function offTrackCount(outbox: ReturnType<typeof recordingOutbox>): number {
  return outbox.appended.filter((event) => event.eventType === GoalOffTrack.type).length;
}

describe('planning.GoalOffTrack (07 R6)', () => {
  it('a goal below its required pace emits GoalOffTrack exactly once per evaluation, not once per consumer delivery', async () => {
    const store = fakeStore();
    const outbox = recordingOutbox();
    const consumer = createGoalPaceConsumer({ storeFor: () => store, outboxFor: () => outbox });
    const context = { tx: outbox, logger: silentLogger, clock: CLOCK };
    expect(consumer.name).toBe(GOAL_PACE_CONSUMER_NAME);
    expect(consumer.filter).toEqual([...GOAL_PACE_CONSUMED_EVENT_TYPES]);

    // Evaluation 1: one baseline run completed.
    const first = completed('a1946000-0000-7000-8000-0000000000f1');
    await consumer.handler(first, context);
    const afterFirst = offTrackCount(outbox);

    // The same envelope again — a redelivery. Nothing new may be said.
    await consumer.handler(first, context);
    await consumer.handler(first, context);
    const afterRedelivery = offTrackCount(outbox);

    // Evaluation 2: a new baseline run (the next night). A new evaluation, so
    // the still-off-track goal is announced again — once.
    await consumer.handler(completed('a1946000-0000-7000-8000-0000000000f2'), context);
    const afterSecondEvaluation = offTrackCount(outbox);

    // A fork's run is a what-if and evaluates nothing, claims nothing.
    await consumer.handler(completed('a1946000-0000-7000-8000-0000000000f3', 'fork'), context);

    // Printed for the evidence (§4): event counts before and after the redelivery.
    console.log(
      JSON.stringify({ afterFirst, afterRedelivery, afterSecondEvaluation, claims: store.claims }),
    );

    expect(afterFirst).toBe(1);
    expect(afterRedelivery).toBe(1);
    expect(afterSecondEvaluation).toBe(2);
    expect(offTrackCount(outbox)).toBe(2);
    // Every delivery of a baseline run tried to claim; only two claims were new.
    expect(store.claims).toEqual([
      'a1946000-0000-7000-8000-0000000000f1',
      'a1946000-0000-7000-8000-0000000000f1',
      'a1946000-0000-7000-8000-0000000000f1',
      'a1946000-0000-7000-8000-0000000000f2',
    ]);

    // Only the goal that is behind, and ratios — never an amount — on the wire.
    const payloads = outbox.appended
      .filter((event) => event.eventType === GoalOffTrack.type)
      .map((event) => event.payload);
    expect(payloads[0]).toEqual({
      goalId: EMERGENCY,
      evaluationId: 'a1946000-0000-7000-8000-0000000000f1',
      asOfDate: '2026-09-25',
      fundedRatio: '0.1',
      requiredPace: '0.7',
      monthsRemaining: 12,
      fundedSource: 'earmarks',
    });
    expect(JSON.stringify(payloads)).not.toMatch(/minor|20000|2000000/);
  });

  it('pace is exact: funded + planned below target is off track, and R6 has its m and c', () => {
    const verdicts = evaluateGoalPace(FACTS, AS_OF);
    // Retirement is R2's (the projection's success probability), not a pace.
    expect(verdicts.map((verdict) => verdict.goalId).sort()).toEqual([EMERGENCY, CAR].sort());
    const emergency = verdicts.find((verdict) => verdict.goalId === EMERGENCY);
    const car = verdicts.find((verdict) => verdict.goalId === CAR);
    if (emergency?.status !== 'off_track' || car?.status !== 'on_track') {
      throw new Error(`unexpected verdicts ${JSON.stringify(verdicts)}`);
    }
    // $20,000 − $2,000 funded = $18,000 over 12 months: R6's "needs $1,500/mo".
    expect(emergency.requiredMonthly.minor).toBe(150_000n);
    // "…you're contributing $500".
    expect(emergency.plannedMonthly.minor).toBe(50_000n);
    expect(emergency.plannedBeforeTarget.minor).toBe(600_000n);
    expect(car.monthsRemaining).toBe(6);
    expect(car.fundedRatio).toBe('0.2');
    expect(car.requiredPace).toBe('0');
  });
});
