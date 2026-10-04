// SPDX-License-Identifier: MIT
/**
 * Life events — a dated, typed, signed amount on the plan's timeline (WP 4.6,
 * `plan_life_events`, migration 0022).
 *
 * An inheritance arrives, a home purchase leaves; the sign is the holder's
 * claim about direction and `plan_life_events_sign_matches_kind` refuses the
 * typo where a college bill is entered as income. Amounts are **today's
 * dollars** — the projection's basis (07 §5.2) — and belong to the holder's
 * plan, so every scenario sees them and every run's input digest includes them.
 *
 * ## What this file's own partition can and cannot do with one
 *
 * WP 4.4's `ProjectionPlan` has no one-time-flow input of its own; this file
 * only ever expresses a dated event through `otherIncome`, a typed income
 * stream over `[startAge, endAge)` whose semantics are exactly a lump sum's
 * when the range is one year: before retirement it is saved into `TAXABLE`
 * under the mid-year convention, and in retirement it offsets that year's
 * spending with any surplus deposited. So, at *this* layer:
 *
 *   * a **positive** event on or after the plan's start and before its end is
 *     applied as a one-year income stream at the holder's age on that date;
 *   * a **negative** event — a home purchase, college, a sabbatical — has no
 *     faithful expression as `otherIncome` (refused negative at the boundary,
 *     and bending it would push `TAXABLE` below zero instead of drawing down
 *     the withdrawal order), so `lifeEventsForPlan` below still partitions it
 *     into `unapplied` with the reason `outflow_not_modelled`;
 *   * an event dated before the plan's start (`before_as_of`) has already
 *     happened — its effect is in the sealed balances the run starts from — and
 *     one after the plan's last year (`after_plan_end`) is outside it.
 *
 * **WP 5.5 gave the engine a second, separate input for exactly this case**
 * (`oneOffs`, `src/engine/boundary.ts#toEnginePlan` → `deterministic.ts`'s
 * signed `oneOffByYear`, the one boundary crossing) and
 * `projection-service.ts#outflowsApplied` is the composition step that uses
 * it: every event this file partitions as `outflow_not_modelled` is
 * reclassified there into `applied` and carried as a dated one-off, so the
 * run a holder actually gets **does** include a negative event — a house
 * purchase is drawn down in its year, not silently dropped. What a direct
 * caller of `lifeEventsForPlan` sees in its raw `unapplied` list (this file,
 * alone) is therefore not the whole story; `outflowsApplied`'s own header has
 * it. The client worker's ported kernel does **not** gain `oneOffs`
 * (`docs/evidence/phase-5/wp5.5-planning.md` §6, deferred to Phase 9's shared
 * `@core/projection-kernel`), so a slider preview of a plan with a dated
 * outflow still diverges from the saved run — `GoalSliders.tsx` says so.
 *
 * A projection that silently dropped a $400,000 house purchase would be wrong
 * by the house. One that draws it down in its year, and says so in the run's
 * own record either way, is honest about exactly how.
 */
import {
  DateOnly,
  Money,
  newId,
  type Clock,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
} from '@core/kernel';
import { sql } from 'drizzle-orm';
import { LIFE_EVENT_KINDS, type LifeEventKind } from '../schema/projections.ts';
import { ageOn, type IncomePlan } from './engine/boundary.ts';
import { ProjectionRefused } from './projection-store.ts';
import type { PlanningExecutor } from './store.ts';

export const LIFE_EVENT_NAME_MAX_LENGTH = 96;

/** The direction each kind must have. `other` may be either. */
export const LIFE_EVENT_SIGN: Readonly<Record<LifeEventKind, 'inflow' | 'outflow' | 'either'>> =
  Object.freeze({
    inheritance: 'inflow',
    windfall: 'inflow',
    home_purchase: 'outflow',
    college: 'outflow',
    sabbatical: 'outflow',
    other: 'either',
  });

export interface LifeEvent {
  readonly id: string;
  readonly kind: LifeEventKind;
  readonly name: string;
  readonly occursOn: DateOnlyType;
  /** Signed, today's dollars: positive arrives, negative leaves. */
  readonly amount: MoneyType;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewLifeEventInput {
  readonly kind: string;
  readonly name: string;
  readonly occursOn: string;
  readonly amount: MoneyType;
}

export interface ValidLifeEvent {
  readonly kind: LifeEventKind;
  readonly name: string;
  readonly occursOn: DateOnlyType;
  readonly amount: MoneyType;
}

function invalid(message: string): ProjectionRefused {
  return new ProjectionRefused('planning.life_event_invalid', message);
}

/** Every rule the table's CHECKs hold, restated so the refusal names the field. */
export function validateLifeEvent(input: NewLifeEventInput): ValidLifeEvent {
  if (!(LIFE_EVENT_KINDS as readonly string[]).includes(input.kind)) {
    throw invalid(`kind must be one of ${LIFE_EVENT_KINDS.join(', ')}`);
  }
  const kind = input.kind as LifeEventKind;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name === '' || name.length > LIFE_EVENT_NAME_MAX_LENGTH) {
    throw invalid(`name must be 1–${String(LIFE_EVENT_NAME_MAX_LENGTH)} characters`);
  }
  if (typeof input.occursOn !== 'string' || !DateOnly.is(input.occursOn)) {
    throw invalid('occursOn must be a calendar date, YYYY-MM-DD');
  }
  if (typeof input.amount?.minor !== 'bigint' || Money.isZero(input.amount)) {
    throw invalid('amount must be a non-zero Money');
  }
  const sign = LIFE_EVENT_SIGN[kind];
  if (
    (sign === 'inflow' && !Money.isPositive(input.amount)) ||
    (sign === 'outflow' && !Money.isNegative(input.amount))
  ) {
    throw new ProjectionRefused(
      'planning.life_event_sign_mismatch',
      `a ${kind} ${sign === 'inflow' ? 'arrives' : 'leaves'}: its amount must be ` +
        `${sign === 'inflow' ? 'positive' : 'negative'} (the sign is the direction)`,
    );
  }
  return { kind, name, occursOn: DateOnly.parse(input.occursOn), amount: input.amount };
}

interface RawLifeEvent extends Record<string, unknown> {
  id: string;
  kind: string;
  name: string;
  occurs_on: string;
  amount_minor: string | bigint;
  currency: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function lifeEventOf(raw: RawLifeEvent): LifeEvent {
  return Object.freeze({
    id: raw.id,
    kind: raw.kind as LifeEventKind,
    name: raw.name,
    occursOn: DateOnly.parse(String(raw.occurs_on).slice(0, 10)),
    amount: Money.of(BigInt(raw.amount_minor), raw.currency.trim()),
    createdAt: new Date(raw.created_at),
    updatedAt: new Date(raw.updated_at),
  });
}

const COLUMNS = sql`id, kind, name, occurs_on, amount_minor, currency, created_at, updated_at`;

export async function createLifeEvent(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly event: NewLifeEventInput; readonly clock: Clock },
): Promise<LifeEvent> {
  const valid = validateLifeEvent(input.event);
  const now = input.clock.now().toISOString();
  const result = await executor.execute<RawLifeEvent>(sql`
    INSERT INTO plan_life_events (id, user_id, kind, name, occurs_on, amount_minor, currency,
                                  created_at, updated_at)
    VALUES (${newId()}::uuid, ${input.userId}::uuid, ${valid.kind}, ${valid.name},
            ${valid.occursOn}::date, ${valid.amount.minor.toString()}::bigint,
            ${valid.amount.currency}, ${now}::timestamptz, ${now}::timestamptz)
    RETURNING ${COLUMNS}
  `);
  const raw = result.rows[0];
  if (raw === undefined) throw new Error('plan_life_events insert returned no row');
  return lifeEventOf(raw);
}

/** Every life event of the holder, in date order. */
export async function listLifeEvents(
  executor: PlanningExecutor,
  userId: string,
): Promise<readonly LifeEvent[]> {
  const result = await executor.execute<RawLifeEvent>(sql`
    SELECT ${COLUMNS} FROM plan_life_events
     WHERE user_id = ${userId}::uuid
     ORDER BY occurs_on, id
  `);
  return result.rows.map(lifeEventOf);
}

/**
 * Move an event on the timeline (the draggable life event), or restate it.
 * PATCH semantics: an absent field keeps its value, and the result is
 * re-validated whole so a move cannot produce a row the CHECKs would refuse.
 */
export async function updateLifeEvent(
  executor: PlanningExecutor,
  input: {
    readonly userId: string;
    readonly lifeEventId: string;
    readonly patch: {
      readonly name?: string;
      readonly occursOn?: string;
      readonly amount?: MoneyType;
    };
    readonly clock: Clock;
  },
): Promise<LifeEvent> {
  const found = await executor.execute<RawLifeEvent>(sql`
    SELECT ${COLUMNS} FROM plan_life_events
     WHERE user_id = ${input.userId}::uuid AND id = ${input.lifeEventId}::uuid
     FOR UPDATE
  `);
  const current = found.rows[0];
  if (current === undefined) {
    throw new ProjectionRefused(
      'planning.life_event_not_found',
      `no life event ${input.lifeEventId}`,
    );
  }
  const existing = lifeEventOf(current);
  const valid = validateLifeEvent({
    kind: existing.kind,
    name: input.patch.name ?? existing.name,
    occursOn: input.patch.occursOn ?? existing.occursOn,
    amount: input.patch.amount ?? existing.amount,
  });
  const result = await executor.execute<RawLifeEvent>(sql`
    UPDATE plan_life_events
       SET name = ${valid.name}, occurs_on = ${valid.occursOn}::date,
           amount_minor = ${valid.amount.minor.toString()}::bigint,
           currency = ${valid.amount.currency},
           updated_at = ${input.clock.now().toISOString()}::timestamptz
     WHERE user_id = ${input.userId}::uuid AND id = ${input.lifeEventId}::uuid
    RETURNING ${COLUMNS}
  `);
  const raw = result.rows[0];
  if (raw === undefined) throw new Error('plan_life_events update returned no row');
  return lifeEventOf(raw);
}

export async function deleteLifeEvent(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly lifeEventId: string },
): Promise<void> {
  const result = await executor.execute<{ id: string }>(sql`
    DELETE FROM plan_life_events
     WHERE user_id = ${input.userId}::uuid AND id = ${input.lifeEventId}::uuid
    RETURNING id
  `);
  if (result.rows.length === 0) {
    throw new ProjectionRefused(
      'planning.life_event_not_found',
      `no life event ${input.lifeEventId}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Into the engine's inputs
// ---------------------------------------------------------------------------

export type UnappliedReason =
  'before_as_of' | 'after_plan_end' | 'outflow_not_modelled' | 'currency_mismatch';

/** One dated inflow the engine can express: a positive amount on a date. */
export interface OneTimeInflow {
  readonly key: string;
  readonly occursOn: DateOnlyType;
  readonly amount: MoneyType;
}

export interface LifeEventPartition {
  /** One-year income streams, in date order: what the engine is handed. */
  readonly income: readonly IncomePlan[];
  readonly applied: readonly { readonly id: string; readonly age: number }[];
  readonly unapplied: readonly { readonly id: string; readonly reason: UnappliedReason }[];
}

/**
 * A positive dated amount → a one-year `otherIncome` stream, or the reason it
 * cannot be one. Shared by life events and the `one_time_windfall` lever so
 * the two can never disagree about what a lump sum means.
 */
export function oneTimeInflow(
  inflow: OneTimeInflow,
  plan: {
    readonly birthDate: DateOnlyType;
    readonly asOf: DateOnlyType;
    readonly planEndAge: number;
    readonly currency: string;
  },
): { readonly stream: IncomePlan; readonly age: number } | { readonly reason: UnappliedReason } {
  if (inflow.amount.currency !== plan.currency) return { reason: 'currency_mismatch' };
  if (DateOnly.isBefore(inflow.occursOn, plan.asOf)) return { reason: 'before_as_of' };
  const age = ageOn(plan.birthDate, inflow.occursOn);
  if (age >= plan.planEndAge) return { reason: 'after_plan_end' };
  if (!Money.isPositive(inflow.amount)) return { reason: 'outflow_not_modelled' };
  return {
    age,
    stream: Object.freeze({
      name: inflow.key,
      startAge: age,
      endAge: age + 1,
      annual: inflow.amount,
    }),
  };
}

/** Partition the holder's events into what the engine is handed and what it is not, named. */
export function lifeEventsForPlan(
  events: readonly LifeEvent[],
  plan: {
    readonly birthDate: DateOnlyType;
    readonly asOf: DateOnlyType;
    readonly planEndAge: number;
    readonly currency: string;
  },
): LifeEventPartition {
  const income: IncomePlan[] = [];
  const applied: { id: string; age: number }[] = [];
  const unapplied: { id: string; reason: UnappliedReason }[] = [];
  const ordered = [...events].sort(
    (a, b) => DateOnly.compare(a.occursOn, b.occursOn) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const event of ordered) {
    const outcome = oneTimeInflow(
      { key: `life_event:${event.id}`, occursOn: event.occursOn, amount: event.amount },
      plan,
    );
    if ('reason' in outcome) {
      unapplied.push({ id: event.id, reason: outcome.reason });
    } else {
      income.push(outcome.stream);
      applied.push({ id: event.id, age: outcome.age });
    }
  }
  return Object.freeze({
    income: Object.freeze(income),
    applied: Object.freeze(applied),
    unapplied: Object.freeze(unapplied),
  });
}
