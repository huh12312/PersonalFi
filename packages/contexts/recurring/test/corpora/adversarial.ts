// SPDX-License-Identifier: MIT
/**
 * The adversarial corpus — 07 §2.12 tier 3, "the things that look recurring but
 * aren't".
 *
 * > biweekly paycheck-adjacent coffee habits, rent split via Venmo (same
 * > amount, monthly, but a transfer), mortgage/auto-pay (recurring but should be
 * > typed `LOAN_PAYMENT`, not `SUBSCRIPTION`), and quarterly estimated tax
 * > payments.
 *
 * Each family is *deliberately* indistinguishable from a subscription by shape.
 * Rent is $2,200 on the 1st of every month, for ever. Mortgage autopay is
 * $2,412.55 on the 1st, for ever. If the engine's only evidence were dates and
 * amounts, it would have to call both of them subscriptions, and 07 §2.12 is
 * clear that a false subscription is the expensive error.
 *
 * So `golden-streams.test.ts` runs this corpus **twice**:
 *
 *  1. with the merchant facts a real caller would supply (`P2P`, `LOAN`, `TAX`,
 *     `RETAIL`), which is the production path; and
 *  2. with **every** class forced to `UNKNOWN`, which is what happens the day a
 *     payee has no classification yet — the case where a detector that leans
 *     entirely on metadata quietly fails open.
 *
 * Both runs must yield zero `SUBSCRIPTION` streams. In run 2 the work is done by
 * the monthly-equivalent ceiling (rent, mortgage, tax) and by the amount model
 * and cadence score (coffee), which is why both defences exist.
 */

import { DateOnly, Money } from '@core/kernel';
import type { MerchantFacts, RecurringInput } from '../../src/index.ts';
import { mulberry32 } from './rng.ts';

export const ADVERSARIAL_TODAY = DateOnly.parse('2026-09-15');
export const ADVERSARIAL_SEED = 4242;

export const ADVERSARIAL_FAMILIES = Object.freeze({
  rentViaVenmo: 'adv-venmo',
  coffeeHabit: 'adv-coffee',
  mortgageAutopay: 'adv-mortgage',
  estimatedTax: 'adv-irs',
});

export interface AdversarialCorpus {
  readonly inputs: readonly RecurringInput[];
  readonly facts: ReadonlyMap<string, MerchantFacts>;
  readonly today: DateOnly;
  readonly merchantIds: readonly string[];
}

const START = DateOnly.parse('2023-09-01');
const END = DateOnly.parse('2026-09-15');

export function adversarialCorpus(seed: number = ADVERSARIAL_SEED): AdversarialCorpus {
  const rng = mulberry32(seed);
  const inputs: RecurringInput[] = [];
  let counter = 0;
  const push = (
    merchantId: string,
    accountId: string,
    date: DateOnly,
    minor: bigint,
    isTransfer = false,
  ): void => {
    counter += 1;
    inputs.push({
      transactionId: `adv-${String(counter).padStart(5, '0')}`,
      merchantId,
      accountId,
      amount: Money.of(minor, 'USD'),
      date,
      pending: false,
      isTransfer,
    });
  };

  // Rent, split with a housemate and paid through a P2P app. Monthly, fixed, on
  // the 1st — and not a service anybody sells.
  for (let month = 0; month < 36; month += 1) {
    const date = DateOnly.addMonths(DateOnly.parse('2023-09-01'), month);
    if (DateOnly.isAfter(date, END)) break;
    push(ADVERSARIAL_FAMILIES.rentViaVenmo, 'acc-checking', date, -220_000n);
  }

  // Mortgage autopay: the shape of a subscription, at twenty times the price.
  for (let month = 0; month < 36; month += 1) {
    const date = DateOnly.addMonths(DateOnly.parse('2023-09-03'), month);
    if (DateOnly.isAfter(date, END)) break;
    push(ADVERSARIAL_FAMILIES.mortgageAutopay, 'acc-checking', date, -241_255n);
  }

  // Quarterly estimated tax: four a year, same payee, large and fixed-ish.
  for (const anchor of ['2023-09-15', '2024-01-15', '2024-04-15', '2024-06-15', '2024-09-15',
    '2025-01-15', '2025-04-15', '2025-06-15', '2025-09-15', '2026-01-15', '2026-04-15', '2026-06-15']) {
    push(ADVERSARIAL_FAMILIES.estimatedTax, 'acc-checking', DateOnly.parse(anchor), -350_000n);
  }

  // The coffee habit: two or three visits a week, each a different amount, for
  // three years. The single most common false positive in every detector that
  // scores regularity without asking what regularity means.
  let cursor = START;
  while (DateOnly.isBefore(cursor, END)) {
    const visits = rng.int(2, 3);
    for (let visit = 0; visit < visits; visit += 1) {
      push(
        ADVERSARIAL_FAMILIES.coffeeHabit,
        'acc-visa',
        DateOnly.addDays(cursor, rng.int(0, 6)),
        BigInt(-rng.int(425, 785)),
      );
    }
    cursor = DateOnly.addDays(cursor, 7);
  }

  const facts = new Map<string, MerchantFacts>([
    [ADVERSARIAL_FAMILIES.rentViaVenmo, { class: 'P2P' }],
    [ADVERSARIAL_FAMILIES.mortgageAutopay, { class: 'LOAN' }],
    [ADVERSARIAL_FAMILIES.estimatedTax, { class: 'TAX' }],
    [ADVERSARIAL_FAMILIES.coffeeHabit, { class: 'RETAIL' }],
  ]);

  return {
    inputs,
    facts,
    today: ADVERSARIAL_TODAY,
    merchantIds: Object.values(ADVERSARIAL_FAMILIES),
  };
}

/** The same corpus with every classification removed. Run 2 of the gate. */
export function unclassifiedFacts(): ReadonlyMap<string, MerchantFacts> {
  return new Map<string, MerchantFacts>(
    Object.values(ADVERSARIAL_FAMILIES).map((merchantId) => [merchantId, { class: 'UNKNOWN' }]),
  );
}
