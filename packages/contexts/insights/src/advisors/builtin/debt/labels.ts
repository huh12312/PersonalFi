// SPDX-License-Identifier: MIT
/**
 * A liability kind, in words.
 *
 * `liabilities_terms.liabilities[].kind` is a wire enum — `credit_card`,
 * `line_of_credit` — and "a credit_card balance of $3,800" is a database value
 * in a sentence. The mapping is total over the enum and introduces no numeral,
 * so nothing it produces has to be traced; the *ref* in the evidence row still
 * cites the enum value itself, which is what a reviewer checks against.
 */
import type { LiabilityKind } from '../../../contract/snapshot.ts';

const LABELS: Readonly<Record<LiabilityKind, string>> = Object.freeze({
  credit_card: 'credit card',
  student_loan: 'student loan',
  mortgage: 'mortgage',
  auto_loan: 'car loan',
  personal_loan: 'personal loan',
  line_of_credit: 'line of credit',
  other: 'loan',
});

export function kindLabel(kind: LiabilityKind): string {
  return LABELS[kind];
}

/** `true` for the kinds that revolve, which is where 07's card thresholds apply. */
export function isRevolving(kind: LiabilityKind): boolean {
  return kind === 'credit_card' || kind === 'line_of_credit';
}
