// SPDX-License-Identifier: MIT

/**
 * A business invariant refusing an operation.
 *
 * Maps to the `domain` family in docs/CONVENTIONS.md: 409/422, logged at `warn`.
 * Clients switch on `code`, never on `message` — user-facing copy gets rewritten a
 * dozen times and a client that parses it breaks every time.
 */
export type LedgerErrorCode =
  | 'ledger.account_not_found'
  | 'ledger.account_closed'
  | 'ledger.transaction_not_found'
  | 'ledger.currency_mismatch'
  | 'ledger.splits_do_not_sum'
  | 'ledger.transfer_same_account'
  | 'ledger.transfer_already_paired'
  | 'ledger.cursor_invalid'
  | 'ledger.invalid_auto_placement'
  // WP 11.6: a merchant name suggestion that is not this holder's, or no longer open to the call made.
  | 'ledger.merchant_name_suggestion_not_found'
  | 'ledger.merchant_name_suggestion_closed';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export function isLedgerError(value: unknown): value is LedgerError {
  return value instanceof LedgerError;
}
