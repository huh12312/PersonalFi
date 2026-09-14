// SPDX-License-Identifier: MIT
/**
 * This context's errors.
 *
 * One class with a `code`, matching `@ctx/ledger`'s shape, because clients switch
 * on `code` and never on `detail` (docs/CONVENTIONS.md: "user-facing copy gets
 * rewritten a dozen times"). Each code maps to one of the four RFC 9457 families
 * the API layer knows how to render.
 */

export type CategorizationErrorCode =
  /** `user` — the request named something that is not there. */
  | 'categorization.category_not_found'
  | 'categorization.rule_not_found'
  | 'categorization.assignment_not_found'
  /** `user` — the request was understood and is not allowed. */
  | 'categorization.rule_invalid'
  | 'categorization.category_not_assignable'
  /** `domain` — a business invariant refuses. */
  | 'categorization.taxonomy_not_seeded'
  | 'categorization.system_category_immutable';

export class CategorizationError extends Error {
  readonly code: CategorizationErrorCode;
  /** Machine-readable context for the problem-details `errors` member. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: CategorizationErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'CategorizationError';
    this.code = code;
    this.details = details;
  }
}

export function isCategorizationError(error: unknown): error is CategorizationError {
  return error instanceof CategorizationError;
}
