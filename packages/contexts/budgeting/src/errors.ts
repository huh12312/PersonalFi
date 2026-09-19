// SPDX-License-Identifier: MIT
/**
 * This context's error type.
 *
 * Codes are namespaced strings rather than an enum so they can be carried
 * verbatim into an API problem document and logged without a lookup table.
 *
 * `budgeting.identity_violation` and `budgeting.card_identity_violation` are the
 * two that matter. They are thrown from inside the recompute transaction, *after*
 * the arithmetic and *before* the write, so a budget that has noticed its own
 * numbers do not add up writes nothing and says so. That is deliberate and it is
 * the opposite of the usual instinct: a silently-repaired identity is a bug that
 * survives to the next gate.
 */
export type BudgetingErrorCode =
  | 'budgeting.budget_not_found'
  | 'budgeting.period_not_found'
  | 'budgeting.period_not_opened'
  | 'budgeting.period_closed'
  | 'budgeting.line_not_found'
  | 'budgeting.currency_mismatch'
  | 'budgeting.balance_unreported'
  | 'budgeting.identity_violation'
  | 'budgeting.card_identity_violation';

export class BudgetingError extends Error {
  readonly code: BudgetingErrorCode;

  constructor(code: BudgetingErrorCode, message: string) {
    super(message);
    this.name = 'BudgetingError';
    this.code = code;
  }
}

export function isBudgetingError(value: unknown): value is BudgetingError {
  return value instanceof BudgetingError;
}
