// SPDX-License-Identifier: MIT
/**
 * `@ctx/planning`'s typed refusals (WP 4.1).
 *
 * Codes are namespaced strings — the `@ctx/budgeting` and `@ctx/ledger`
 * precedent — so they reach an RFC 9457 problem document verbatim and a client
 * switches on `code`, never on `detail` (docs/CONVENTIONS.md "Errors").
 *
 * Every code carries its HTTP status and error family **here**, beside the
 * condition, rather than in a table in `apps/api` that has to be kept in step.
 * WP 4.8's `toDomainProblem` arm reads `PLANNING_ERROR_STATUS` and needs no
 * judgement of its own. The split follows CONVENTIONS' table:
 *
 *   * `domain` / 409 — the request is well formed and the *state* refuses it
 *     (a second live retirement goal; a contribution in another currency).
 *   * `domain` / 422 — the request is well formed and a business invariant
 *     refuses its *content* (a target date already past; a funding account that
 *     does not exist). These are the two the dispatch names, and neither is
 *     ever clamped: a past date is not moved to today and a missing account is
 *     not dropped from the list.
 *   * `user` / 400 or 404 — malformed input, or a goal id the caller does not
 *     own. "Not yours" and "does not exist" are deliberately the same 404, so a
 *     probe cannot learn that another holder's goal exists.
 */
export type PlanningErrorCode =
  | 'planning.goal_not_found'
  | 'planning.goal_invalid'
  | 'planning.goal_target_not_positive'
  | 'planning.goal_target_date_in_past'
  | 'planning.goal_funding_account_not_found'
  | 'planning.goal_funding_account_closed'
  | 'planning.goal_retirement_already_live'
  | 'planning.contribution_not_found'
  | 'planning.contribution_invalid'
  | 'planning.contribution_currency_mismatch'
  | 'planning.contribution_escalation_invalid'
  | 'planning.earmark_invalid'
  | 'planning.earmark_account_not_found'
  | 'planning.earmark_account_not_an_asset'
  | 'planning.earmark_currency_mismatch'
  | 'planning.earmark_not_found'
  | 'planning.risk_answers_invalid'
  | 'planning.risk_income_invalid';

export type PlanningErrorFamily = 'user' | 'domain';

export interface PlanningErrorStatus {
  readonly status: 400 | 404 | 409 | 422;
  readonly family: PlanningErrorFamily;
}

export const PLANNING_ERROR_STATUS: Readonly<Record<PlanningErrorCode, PlanningErrorStatus>> =
  Object.freeze({
    'planning.goal_not_found': { status: 404, family: 'user' },
    'planning.goal_invalid': { status: 400, family: 'user' },
    'planning.goal_target_not_positive': { status: 422, family: 'domain' },
    'planning.goal_target_date_in_past': { status: 422, family: 'domain' },
    'planning.goal_funding_account_not_found': { status: 422, family: 'domain' },
    'planning.goal_funding_account_closed': { status: 409, family: 'domain' },
    'planning.goal_retirement_already_live': { status: 409, family: 'domain' },
    'planning.contribution_not_found': { status: 404, family: 'user' },
    'planning.contribution_invalid': { status: 400, family: 'user' },
    'planning.contribution_currency_mismatch': { status: 409, family: 'domain' },
    'planning.contribution_escalation_invalid': { status: 422, family: 'domain' },
    'planning.earmark_invalid': { status: 400, family: 'user' },
    'planning.earmark_account_not_found': { status: 422, family: 'domain' },
    'planning.earmark_account_not_an_asset': { status: 422, family: 'domain' },
    'planning.earmark_currency_mismatch': { status: 409, family: 'domain' },
    'planning.earmark_not_found': { status: 404, family: 'user' },
    'planning.risk_answers_invalid': { status: 422, family: 'domain' },
    'planning.risk_income_invalid': { status: 422, family: 'domain' },
  });

export class PlanningError extends Error {
  readonly code: PlanningErrorCode;
  readonly status: PlanningErrorStatus['status'];
  readonly family: PlanningErrorFamily;

  constructor(code: PlanningErrorCode, message: string) {
    super(message);
    this.name = 'PlanningError';
    this.code = code;
    const { status, family } = PLANNING_ERROR_STATUS[code];
    this.status = status;
    this.family = family;
  }
}

export function isPlanningError(value: unknown): value is PlanningError {
  return value instanceof PlanningError;
}
