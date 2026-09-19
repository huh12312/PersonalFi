// SPDX-License-Identifier: MIT
/**
 * `CCP[card]` — the credit-card payment envelope, 07 §1.3.
 *
 * > `CCP[card]` is auto-created 1:1 with each on-budget credit account and is
 * > not user-deletable. — 07 §1.3, line 130
 *
 * A credit-card payment line is not an envelope the user spends out of. It is
 * the pot the funding rule moves money into as credit purchases land, so that
 * "can I pay this statement in full without robbing another envelope?" has an
 * answer that is a number rather than a feeling.
 *
 * ## Identity II, and why this file exists at all
 *
 * ```
 * owed(card) = available(CCP[card]) + unfundedDebt(CCP[card])
 * ```
 *
 * Every dollar owed on a card is either earmarked to pay it or was borrowed with
 * no envelope money behind it. `owed` comes from `@ctx/ledger`'s balance for
 * that account, read through the port; both right-hand terms come from this
 * context's cascade. That makes it a genuine cross-system check rather than an
 * algebraic restatement — which matters, because the *other* invariant,
 * `Σ available + RTA + future = Σ balances`, is how Ready to Assign is defined
 * and therefore stays green even if the CCP lines are deleted outright. Identity
 * II is the one that goes red, and it is the sabotage recorded in the evidence
 * note.
 *
 * ## Two places this extends 07 §1.3 rather than transcribing it
 *
 * 1. **A refund larger than the CCP envelope holds.** §1.3 line 124 says
 *    `available(CCP[card]) -= min(txn.amount, available(CCP[card]))` and stops
 *    there. But the card's balance drops by the *whole* refund, so under that
 *    rule alone identity II breaks by the difference. The remainder retires
 *    unfunded debt, which is also what it means: money you borrowed and never
 *    covered has been handed back by the merchant.
 * 2. **A payment larger than the CCP envelope holds.** §1.3 line 119 is
 *    unconditional (`available(CCP[card]) -= X`) and this keeps it that way, so
 *    `available` goes negative. That is correct and identity II survives it: you
 *    paid the statement with money some other envelope was holding, and the
 *    negative is the honest record of it. It is also why a CCP line's rollover
 *    policy is `ROLLOVER_ALLOW_NEGATIVE` — 07 §1.2's "debt-like categories
 *    only". Under plain `ROLLOVER` the negative would be zeroed at the roll and
 *    identity II would break one period later.
 */
import { Money, type Money as MoneyType } from '@core/kernel';
import type { CardEffect } from './envelope.ts';

/** What a card's payment envelope carried in from the period before. */
export interface CardOpening {
  readonly creditAccountId: string;
  readonly available: MoneyType;
  readonly unfundedDebt: MoneyType;
}

export interface CardPeriodInput {
  readonly opening: CardOpening;
  /** Money the user (or auto-assign) put directly into this CCP line. */
  readonly assigned: MoneyType;
  /** Aggregated across every category that spent on this card this period. */
  readonly effects: readonly CardEffect[];
  /**
   * Statement payments that landed on this card this period, as a non-negative
   * magnitude. These arrive as *transfer* legs and are therefore excluded from
   * every category's `activity` — 07 §1.3 line 120, "balances move naturally via
   * the transfer; no category activity".
   */
  readonly payments: MoneyType;
}

export interface CardPeriodResult {
  readonly creditAccountId: string;
  readonly available: MoneyType;
  readonly unfundedDebt: MoneyType;
  readonly funded: MoneyType;
  readonly payments: MoneyType;
}

/**
 * Close one card's payment envelope over one period.
 *
 * Order is fixed and matters: funding in, then refunds out, then payments out.
 * Refunds before payments because a refund that lands before the statement is
 * paid reduces what must be paid, and running payments first would take the
 * money out of the envelope and then hand the refund to a pot that no longer
 * needs it.
 */
export function applyCardEffects(input: CardPeriodInput): CardPeriodResult {
  const code = input.opening.available.currency;
  const zero = Money.zero(code);

  let funded = zero;
  let borrowed = zero;
  let returned = zero;
  for (const effect of input.effects) {
    funded = Money.add(funded, effect.funded);
    borrowed = Money.add(borrowed, effect.borrowed);
    returned = Money.add(returned, effect.returned);
  }

  let availableNow = Money.add(Money.add(input.opening.available, input.assigned), funded);
  let unfundedDebt = Money.add(input.opening.unfundedDebt, borrowed);

  // Refunds: out of the envelope first, then against the debt. See extension 1.
  const fromEnvelope = Money.min(returned, Money.max(availableNow, zero));
  availableNow = Money.subtract(availableNow, fromEnvelope);
  const againstDebt = Money.min(Money.subtract(returned, fromEnvelope), unfundedDebt);
  unfundedDebt = Money.subtract(unfundedDebt, againstDebt);

  // Payments: unconditional, per §1.3 line 119. See extension 2.
  availableNow = Money.subtract(availableNow, Money.absolute(input.payments));

  return {
    creditAccountId: input.opening.creditAccountId,
    available: availableNow,
    unfundedDebt,
    funded,
    payments: Money.absolute(input.payments),
  };
}

/**
 * Identity II, as a function, so the service can assert it on every recompute
 * and the test can assert it against the ledger's own balance.
 *
 * `owed` is the *positive* magnitude of what the card balance says you owe —
 * `@ctx/ledger` stores a credit balance as a negative number, house convention,
 * so the adapter negates it once at the port boundary and never again.
 */
export function cardIdentityHolds(owed: MoneyType, card: CardPeriodResult): boolean {
  return Money.equals(owed, Money.add(card.available, card.unfundedDebt));
}
