// SPDX-License-Identifier: MIT
import { z } from 'zod';

/**
 * URL search state for `/plan` (`src/routes/_app.plan.tsx`'s
 * `validateSearch`), the `_app.investments.tsx` shape: every piece of
 * screen state a reader could want to link to lives here.
 *
 * `goalTargetMinor`/`goalCurrency`/`goalDate` are this screen's stated
 * simplification, disclosed in `docs/evidence/phase-4/wp4.10-plan-ui.md`:
 * WP 4.8 published no `GET /plan/compare`-adjacent route for `cash_earmarks`
 * or a route that ties a saved `Goal` (`GET /goals`) to a projection's chart
 * directly, and building a full goal-management screen is outside this WP's
 * five named exit tests. The fan chart's dashed goal line and the dotted gap
 * line instead take an ad-hoc target — the exact shape
 * `POST /plan/required-savings`'s `objective: { kind: 'wealth_at' }` already
 * accepts with no `goalId` at all — so the feature the exit tests check
 * (the line renders, the crossing is labelled, the gap is clickable) needs
 * no goal CRUD UI to prove.
 */
export const planSearchSchema = z.object({
  /** The scenario whose fan chart is showing. Defaults to the baseline once scenarios load. */
  scenario: z.string().min(1).optional(),
  /** Two scenario ids for the side-by-side compare panel. */
  compareA: z.string().min(1).optional(),
  compareB: z.string().min(1).optional(),
  goalTargetMinor: z.string().regex(/^-?\d+$/).optional(),
  goalCurrency: z.string().length(3).optional(),
  /** `YYYY-MM-DD`. */
  goalDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** The required-savings solver's monthly ceiling, minor units. */
  maxMonthlyMinor: z.string().regex(/^\d+$/).optional(),
});

export type PlanSearch = z.infer<typeof planSearchSchema>;

export const DEFAULT_GOAL_CURRENCY = 'USD';
