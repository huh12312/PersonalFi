// SPDX-License-Identifier: MIT
/**
 * The required-savings solve over the holder's baseline, shared by
 * `POST /plan/required-savings` (WP 4.8) and the advisory catalogue's
 * `goal.required_savings` (WP 11.5b), so the route and the catalogue cannot
 * answer one question two ways. Moved out of `routes/plan.ts` unchanged.
 *
 * Reads only: the baseline, the holder's resolved assumptions, the derived
 * inputs from the newest sealed day (or `asOf`), the life events; then WP
 * 4.6's `solveRequiredSavings`, which verifies its answer by running the plan
 * with it. Nothing is stored.
 */
import type { Database } from '@core/db';
import type { Clock, DateOnly, Money } from '@core/kernel';
import {
  ProjectionRefused,
  assembleBaselinePlan,
  createProjectionInputsReader,
  currentRegistry,
  getBaseline,
  lifeEventsForPlan,
  listLifeEvents,
  resolveForUser,
  solveRequiredSavings,
  type RequiredSavingsRequest,
  type RequiredSavingsResult,
} from '@ctx/planning';
import { planningRevealedPortsFor } from './domain.ts';

export async function solveRequiredSavingsFor(
  database: Database,
  input: {
    readonly userId: string;
    readonly timeZone: string;
    readonly clock: Clock;
    readonly objective: RequiredSavingsRequest['objective'];
    readonly maxMonthly: Money;
    readonly asOf: DateOnly | null;
    readonly allowOpenDay: boolean;
  },
): Promise<RequiredSavingsResult> {
  const baseline = await getBaseline(database, input.userId);
  if (baseline === null) {
    throw new ProjectionRefused(
      'planning.scenario_no_baseline',
      'state a baseline plan before solving for required savings',
    );
  }

  const resolved = await resolveForUser(
    database,
    { userId: input.userId, timeZone: input.timeZone },
    currentRegistry(),
  );
  const inputs = createProjectionInputsReader(
    database,
    planningRevealedPortsFor(database, {
      userId: input.userId,
      timeZone: input.timeZone,
      clock: input.clock,
    }),
  );
  const derived = await inputs.derivedInputs({
    userId: input.userId,
    asOf: input.asOf,
    allowOpenDay: input.allowOpenDay,
  });
  const assembled = assembleBaselinePlan(baseline.profile, derived);
  const events = lifeEventsForPlan(await listLifeEvents(database, input.userId), assembled.plan);
  const plan = {
    ...assembled.plan,
    otherIncome: [...assembled.plan.otherIncome, ...events.income],
  };
  return solveRequiredSavings(plan, resolved, {
    objective: input.objective,
    maxMonthly: input.maxMonthly,
  });
}
