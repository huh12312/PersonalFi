// SPDX-License-Identifier: MIT
import { DateOnly } from '@core/kernel';
import { createAccounts } from './accounts.ts';
import { generateInvestments } from './investments.ts';
import { createMerchants } from './merchants.ts';
import { mulberry32, randomUuid } from './prng.ts';
import { generateTransactions } from './transactions.ts';
import type { SeedDataset } from './types.ts';

type DateOnlyType = DateOnly;

export interface GenerateOptions {
  /** First day of the seed window. Defaults to a fixed anchor, not "today". */
  readonly startMonth?: DateOnlyType;
  /** How many months of history to generate. Defaults to 24 (Phase 1's 50k-row budget). */
  readonly monthCount?: number;
  readonly timezone?: string;
  readonly baseCurrency?: string;
}

/**
 * A fixed calendar anchor, not `Clock`/`systemClock`. Determinism means
 * "the same seed produces the same bytes on any day this runs", and a
 * generator whose window slid with the real calendar would fail that the day
 * after anyone ran it — this file has no `Clock` dependency at all.
 */
const DEFAULT_START_MONTH = DateOnly.of(2024, 10, 1);
const DEFAULT_MONTH_COUNT = 24;

/**
 * Generate 24 months of deterministic demo history for one household.
 *
 * Everything downstream of `mulberry32(seed)` is a pure function of the seed
 * and these options: same seed, same options, same dataset, byte for byte
 * (`generate.test.ts` asserts this directly). Accounts are created first,
 * then merchants, then transactions, then investments — in that fixed order —
 * because each draws from the same `Rng` and reordering the draws changes
 * every id and every random amount downstream of the reorder.
 */
export function generateDemoData(seed: number, options: GenerateOptions = {}): SeedDataset {
  const startMonth = options.startMonth ?? DEFAULT_START_MONTH;
  const monthCount = options.monthCount ?? DEFAULT_MONTH_COUNT;
  if (!Number.isInteger(monthCount) || monthCount < 1) {
    throw new RangeError(`monthCount must be a positive integer, got ${monthCount}`);
  }
  const today = DateOnly.endOfMonth(DateOnly.addMonths(startMonth, monthCount - 1));

  const rng = mulberry32(seed);
  const userId = randomUuid(rng);
  const accounts = createAccounts(rng, startMonth);
  const merchants = createMerchants(rng);
  const { transactions, recurringSeries, transfers, refunds } = generateTransactions(
    rng,
    accounts,
    merchants,
    startMonth,
    monthCount,
    today,
  );
  const { holdings, prices } = generateInvestments(rng, accounts, startMonth, monthCount, today);

  return {
    seed,
    userId,
    timezone: options.timezone ?? 'America/Los_Angeles',
    baseCurrency: options.baseCurrency ?? 'USD',
    startMonth,
    monthCount,
    accounts,
    merchants,
    transactions,
    holdings,
    prices,
    labels: { recurringSeries, transfers, refunds },
  };
}
