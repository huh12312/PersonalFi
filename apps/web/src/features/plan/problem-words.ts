// SPDX-License-Identifier: MIT
/**
 * What the plan screen says when a plan request is refused (WP 9.7, G4-10).
 *
 * The API answers a refusal with an RFC 9457 problem whose `code` is stable and
 * whose `detail` is written for a log. The screen switches on `code`, never on
 * `detail` (`docs/CONVENTIONS.md`), and every code the plan routes can answer
 * has a sentence of its own here. The table is the only place those sentences
 * live; `ProjectionProblem.tsx` renders them and nothing else words an error.
 *
 * ## Where the codes come from
 *
 * The OpenAPI document does not enumerate problem codes (`Problem.code` is a
 * free `string`), so the list is the API's own typed tables: the unions and
 * status maps in `packages/contexts/planning/src/{projection-store.ts,
 * engine/boundary.ts,engine/worker-host.ts}` and `apps/api/src/routes/
 * domain-errors.ts`. `problem-words.test.ts` reads those files and fails when a
 * code has no entry, and `e2e/plan.spec.ts` drives every one of them through
 * the screen. A code with no entry still renders (`words: 'fallback'`), in
 * plain words and with its code, so an unforeseen refusal is never a spinner —
 * but the tests above fail, which is how the table stays complete.
 *
 * ## What each entry says
 *
 * `headline` is what is wrong, in the holder's terms. `advice` is what to do
 * about it, or, for a fault on PersonalFi's side, that it is not theirs. Neither
 * contains a number the server computed; the server's own `detail` is shown
 * beneath, verbatim, as the specific figure or field.
 */

export interface ProblemWords {
  readonly headline: string;
  readonly advice: string;
  /** `true`: a fault on PersonalFi's side or a transient one — a retry button is offered. */
  readonly retryable?: boolean;
}

const FAULT_ADVICE =
  'This is a fault in PersonalFi, not in your plan. Try again; if it repeats, quote the reference below.';

export const PROBLEM_WORDS: Readonly<Record<string, ProblemWords>> = Object.freeze({
  // --- scenarios, life events, stored runs (projection-store.ts) ---------------------------
  'planning.scenario_not_found': {
    headline: 'That scenario no longer exists.',
    advice: 'Choose another scenario from the list, or reload the plan to see the current ones.',
  },
  'planning.scenario_invalid': {
    headline: "That scenario's saved settings could not be read.",
    advice: 'Save your baseline plan again from its form, or fork it afresh.',
  },
  'planning.scenario_no_baseline': {
    headline: 'There is no baseline plan yet.',
    advice: 'Every projection and every fork starts from your baseline. Create it first.',
  },
  'planning.scenario_levers_empty': {
    headline: 'A fork needs at least one change.',
    advice:
      'Change the retirement age, the annual spending or the return shift so the fork differs from the baseline.',
  },
  'planning.scenario_lever_invalid': {
    headline: "One of the fork's changes is outside what the plan allows.",
    advice: 'Check the retirement age, the spending and the return shift you entered.',
  },
  'planning.scenario_fork_of_fork': {
    headline: 'A fork can only branch from the baseline.',
    advice: 'Fork the baseline instead of another fork.',
  },
  'planning.scenario_baseline_not_deletable': {
    headline: 'The baseline plan cannot be deleted.',
    advice: 'Every fork and every stored run depends on it. Edit it instead.',
  },
  'planning.scenario_income_unknown': {
    headline: 'Your income could not be worked out, so a savings-rate change cannot be applied.',
    advice:
      'State an annual spending in the fork instead, or link an account that receives your income.',
  },
  'planning.life_event_not_found': {
    headline: 'That life event no longer exists.',
    advice: 'Reload the plan to see the current list.',
  },
  'planning.life_event_invalid': {
    headline: 'That life event could not be saved.',
    advice: 'Check its name, its date and its amount.',
  },
  'planning.life_event_sign_mismatch': {
    headline: "The amount's sign does not match the kind of life event.",
    advice:
      'An expense takes money out of the plan and a windfall puts money in; fix the sign or the kind.',
  },
  'planning.projection_not_found': {
    headline: 'That stored projection no longer exists.',
    advice: 'Run the projection again from the plan screen.',
  },
  'planning.projection_no_balances': {
    headline: 'There is no sealed net-worth day to start the projection from.',
    advice:
      'A projection starts from a day the nightly snapshot has sealed, never from a live balance. A new install seals its first day the morning after the first sync, so link an account and check back tomorrow.',
  },
  'planning.projection_balances_unsealed': {
    headline: 'The newest net-worth day is still open.',
    advice:
      'A projection from an open day would move when today does. It will run once the nightly snapshot has sealed that day.',
  },
  'planning.projection_spending_unknown': {
    headline: 'Your plan states no retirement spending, and none could be derived.',
    advice:
      'Deriving it needs twelve months of spending history. State your annual spending in your baseline plan to project now.',
  },
  'planning.projection_paths_invalid': {
    headline: 'The number of simulated paths is not allowed.',
    advice: 'Ask for a whole number of paths from 2 up to 1,000,000.',
  },
  'planning.projection_assumptions_stale': {
    headline:
      'Your saved overrides name a version of the assumptions that this build no longer holds.',
    advice:
      'Re-save your assumption overrides below to carry them onto the current file. They are not dropped, and nothing was recomputed behind your back.',
  },
  'planning.monte_carlo_unavailable': {
    headline: 'The Monte Carlo engine is not available on this install.',
    advice:
      'It needs the operator to fetch the pinned return series once (see the runbook). Until then the plan can only show a single deterministic path.',
  },
  'planning.monte_carlo_outcome_mismatch': {
    headline: 'The simulation answered a different request from the one that was made.',
    advice: FAULT_ADVICE,
    retryable: true,
  },
  'planning.projection_run_incomplete': {
    headline: 'The projection did not finish.',
    advice: FAULT_ADVICE,
    retryable: true,
  },

  // --- the engine's own input checks (engine/boundary.ts) -----------------------------------
  'planning.projection_currency_mismatch': {
    headline: 'An amount in the plan is in a different currency from the plan.',
    advice: "Every amount in a plan must use the plan's own currency.",
  },
  'planning.projection_amount_out_of_range': {
    headline: 'An amount in the plan is too large to project exactly.',
    advice: 'Check the amounts you entered for a misplaced digit.',
  },
  'planning.projection_rate_invalid': {
    headline: 'A rate in the plan is not a valid rate.',
    advice: 'Rates are shares between 0 and 1, for example 0.06 for six percent.',
  },
  'planning.projection_ages_invalid': {
    headline: 'The ages in the plan do not fit together.',
    advice: "Retirement must fall after today's age and before the age the plan ends.",
  },
  'planning.projection_negative_input': {
    headline: 'An amount that must be zero or more is negative.',
    advice: 'Check your spending, contributions and balances.',
  },
  'planning.projection_bucket_repeated': {
    headline: 'An account bucket appears twice in the withdrawal order.',
    advice: 'List each of the four buckets once.',
  },
  'planning.projection_order_invalid': {
    headline: 'The withdrawal order is not complete.',
    advice: 'It must name each of the four tax buckets exactly once.',
  },
  'planning.projection_floor_above_spending': {
    headline: 'Essential spending is higher than planned spending.',
    advice:
      'Raise the planned spending or lower the floor; a plan cannot start below its own floor.',
  },
  'planning.projection_claim_age_invalid': {
    headline: 'The Social Security claiming age is not one the benefit rules allow.',
    advice: 'Choose an age the benefit schedule covers.',
  },
  'planning.projection_target_outside_plan': {
    headline: "The goal date falls outside the plan's years.",
    advice: 'Choose a date between today and the age the plan ends.',
  },

  // --- the Monte Carlo envelope (engine/worker-host.ts) --------------------------------------
  'planning.montecarlo_paths_outside_envelope': {
    headline: 'More simulated paths were asked for than this install allows.',
    advice: 'Ask for fewer paths.',
  },
  'planning.montecarlo_horizon_outside_envelope': {
    headline: 'The plan spans more years than the simulation allows.',
    advice: 'Shorten the plan or move its end age earlier.',
  },
  'planning.montecarlo_cells_outside_envelope': {
    headline: "The paths times the years exceed the simulation's size limit.",
    advice: 'Use fewer paths or a shorter plan.',
  },
  'planning.montecarlo_seed_outside_envelope': {
    headline: 'The random seed is outside the range the simulation accepts.',
    advice: 'Leave the seed as the plan has it.',
  },
  'planning.montecarlo_series_invalid': {
    headline: 'The stored return series cannot be used.',
    advice: 'The operator needs to re-run the return-series fetch (see the runbook).',
  },
  'planning.montecarlo_crypto_invalid': {
    headline: 'The crypto assumptions cannot be used.',
    advice: 'Check the crypto return, volatility and tail settings among your assumptions.',
  },
  'planning.montecarlo_target_invalid': {
    headline: "The simulation's goal target is not valid.",
    advice: 'Check the goal amount and date.',
  },
  'planning.montecarlo_timeout': {
    headline: 'The simulation took too long and was stopped.',
    advice: 'Try again. A plan with fewer paths or fewer years finishes sooner.',
    retryable: true,
  },
  'planning.montecarlo_worker_failed': {
    headline: 'The simulation worker failed.',
    advice: FAULT_ADVICE,
    retryable: true,
  },

  // --- the assumptions file and the holder's overrides (apps/api domain-errors.ts) ----------
  'planning.assumptions_version_unknown': {
    headline:
      'Your saved overrides name a version of the assumptions that this build no longer holds.',
    advice:
      'Re-save your assumption overrides below to carry them onto the current file. They are not dropped.',
  },
  'planning.assumptions_year_unavailable': {
    headline: 'The assumptions file has no tax year for the year the plan needs.',
    advice:
      'The plan reaches past the tax years this build carries. Shorten it, or update PersonalFi.',
  },
  'planning.assumptions_path_unknown': {
    headline: 'That assumption cannot be overridden.',
    advice: 'Only the capital-market rates the engine reads can be changed.',
  },
  'planning.assumptions_value_invalid': {
    headline: 'That value is not allowed for this assumption.',
    advice: 'Enter a decimal share, for example 0.06 for six percent.',
  },
  // --- goals, contributions and the risk questionnaire (errors.ts; earmarks have no route) ---
  'planning.goal_not_found': {
    headline: 'That goal no longer exists.',
    advice: 'Reload the list to see the goals you have now.',
  },
  'planning.goal_invalid': {
    headline: 'That goal could not be saved.',
    advice: 'Check its name, its target amount and its date.',
  },
  'planning.goal_target_not_positive': {
    headline: "A goal's target must be more than zero.",
    advice: 'Enter the amount you want to have, for example 25000.',
  },
  'planning.goal_target_date_in_past': {
    headline: "A goal's date must be in the future.",
    advice: 'A date that has already passed is refused, never moved to today. Choose a later date.',
  },
  'planning.goal_funding_account_not_found': {
    headline: 'A funding account you chose does not exist.',
    advice: 'Choose from the accounts you have, or leave the funding accounts empty.',
  },
  'planning.goal_funding_account_closed': {
    headline: 'A funding account you chose is closed.',
    advice: 'Choose an open account.',
  },
  'planning.goal_retirement_already_live': {
    headline: 'You already have an active retirement goal.',
    advice:
      'Only one retirement goal can be active at a time. Mark the existing one achieved, paused or abandoned first, or edit it instead.',
  },
  'planning.contribution_not_found': {
    headline: 'That contribution no longer exists.',
    advice: 'Reload the goal to see its current contributions.',
  },
  'planning.contribution_invalid': {
    headline: 'That contribution could not be saved.',
    advice: 'Check its amount, its cadence and its dates.',
  },
  'planning.contribution_currency_mismatch': {
    headline: "A contribution must be in the goal's own currency.",
    advice: 'Enter the amount in the same currency as the goal target.',
  },
  'planning.contribution_escalation_invalid': {
    headline: 'The yearly increase is not a valid percentage.',
    advice:
      'Enter a plain percentage such as 3 or 3.25, up to 100, with at most four decimal places.',
  },
  'planning.risk_answers_invalid': {
    headline: 'The questionnaire is incomplete or has an answer it does not recognise.',
    advice: 'Answer every question by choosing one of the options listed for it.',
  },
  'planning.risk_income_invalid': {
    headline: 'The income you gave could not be used.',
    advice: 'Give a taxable income and a filing status together, or leave both blank.',
  },
});

export interface DescribedProblem {
  /** `table`: this module has a sentence for the code. `fallback`: it does not (the tests fail on that). */
  readonly words: 'table' | 'fallback';
  readonly headline: string;
  readonly advice: string;
  readonly retryable: boolean;
  readonly code: string | null;
  /** The server's own `detail`, verbatim — the specific field or figure. Never the headline. */
  readonly detail: string | null;
  /** The quotable reference (`correlationId`) when the server sent one. */
  readonly reference: string | null;
}

interface ProblemLike {
  readonly code?: unknown;
  readonly status?: unknown;
  readonly detail?: unknown;
  readonly correlationId?: unknown;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Wording for a refusal whose code this table does not know, chosen by status alone. */
function byStatus(status: number | null): Pick<ProblemWords, 'headline' | 'advice' | 'retryable'> {
  if (status !== null && status >= 500) {
    return {
      headline: 'The server could not answer this request.',
      advice: 'Try again. If it keeps happening, quote the reference below.',
      retryable: true,
    };
  }
  if (status === 401) {
    return {
      headline: 'Your session is no longer valid.',
      advice: 'Sign in again to continue.',
    };
  }
  if (status === 404) {
    return {
      headline: 'The plan could not find what was asked for.',
      advice: 'Reload the plan screen.',
    };
  }
  if (status !== null && status >= 400) {
    return {
      headline: 'The plan refused this request.',
      advice: 'Check what you entered and try again.',
    };
  }
  return {
    headline: 'The plan could not be reached.',
    advice: 'Check your connection and try again.',
    retryable: true,
  };
}

/**
 * Turns whatever a query threw into the sentence the screen shows. A thrown
 * value that is not a problem document at all (a dropped connection, a
 * non-JSON body) is worded as unreachable, never swallowed.
 */
export function describeProblem(error: unknown): DescribedProblem {
  const problem: ProblemLike =
    typeof error === 'object' && error !== null ? (error as ProblemLike) : {};
  const code = asText(problem.code);
  const status = typeof problem.status === 'number' ? problem.status : null;
  const entry = code === null ? undefined : PROBLEM_WORDS[code];
  const words = entry ?? byStatus(status);
  return {
    words: entry === undefined ? 'fallback' : 'table',
    headline: words.headline,
    advice: words.advice,
    retryable: words.retryable === true,
    code,
    detail: asText(problem.detail),
    reference: asText(problem.correlationId),
  };
}
