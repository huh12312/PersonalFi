// SPDX-License-Identifier: MIT
import { DateOnly } from '@core/kernel';
import { randomUuid, type Rng } from './prng.ts';
import type { AccountType, SeedAccount } from './types.ts';

/** The branded `DateOnly` type and its namespace object share one name (`@core/kernel`). */
type DateOnlyType = DateOnly;

interface AccountSpec {
  readonly type: AccountType;
  readonly name: string;
  readonly currency: string;
}

/** One of each account type a demo household plausibly has (07 §3.1). */
const SPECS: readonly AccountSpec[] = [
  { type: 'checking', name: 'Everyday Checking', currency: 'USD' },
  { type: 'savings', name: 'High-Yield Savings', currency: 'USD' },
  { type: 'credit_card', name: 'Rewards Visa', currency: 'USD' },
  { type: 'brokerage', name: 'Brokerage', currency: 'USD' },
  { type: 'crypto_exchange', name: 'Crypto Exchange', currency: 'USD' },
  { type: 'mortgage', name: 'Home Mortgage', currency: 'USD' },
];

/**
 * Every account opens before the seed window starts, and none close — a
 * "closed account" is realistic but is deliberately left for a caller to graft
 * on, since it interacts with duplicate-detection (Phase 1) in ways a generic
 * demo dataset does not need to model by default.
 */
export function createAccounts(rng: Rng, startMonth: DateOnlyType): SeedAccount[] {
  const openedOn = DateOnly.addMonths(startMonth, -6);
  return SPECS.map((spec) => ({
    id: randomUuid(rng),
    type: spec.type,
    name: spec.name,
    currency: spec.currency,
    openedOn,
    closedOn: null,
  }));
}
