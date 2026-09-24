// SPDX-License-Identifier: MIT
import { DateOnly, Quantity } from '@core/kernel';
import { formatScaledInteger, randomInt, randomUuid, type Rng } from './prng.ts';
import type { SeedAccount, SeedHolding, SeedPricePoint } from './types.ts';

type DateOnlyType = DateOnly;

/**
 * The walk is integer arithmetic over cents, not a float multiplied by
 * `1 + shock`.
 *
 * 08 §6.5 and the WP 3.14 numeric-boundary check: a price is a decimal string
 * over `NUMERIC(20,10)`, never an IEEE-754 double, and a *generator* is the
 * last place that should model one as a double — every fixture downstream
 * inherits whatever the generator decided a price is. The randomness still
 * comes from one `rng()` draw per step; what changed is that the draw picks a
 * whole number of basis points and the price itself never leaves `bigint`.
 */
interface SecuritySpec {
  readonly symbol: string;
  readonly accountType: 'brokerage' | 'crypto_exchange';
  /** Opening close, in cents. */
  readonly startCloseMinor: bigint;
  /** Per-step volatility in basis points: small for an index fund, large for crypto. */
  readonly volatilityBps: number;
  readonly quantity: string;
}

/** A gentle upward drift, in basis points per month. A demo household's portfolio should not look like a coin flip. */
const DRIFT_BPS = 40;
const BPS = 10_000n;

const SECURITIES: readonly SecuritySpec[] = [
  {
    symbol: 'VTI',
    accountType: 'brokerage',
    startCloseMinor: 22_000n,
    volatilityBps: 320,
    quantity: '48.5',
  },
  {
    symbol: 'VXUS',
    accountType: 'brokerage',
    startCloseMinor: 5_500n,
    volatilityBps: 280,
    quantity: '120.25',
  },
  {
    symbol: 'AAPL',
    accountType: 'brokerage',
    startCloseMinor: 18_000n,
    volatilityBps: 600,
    quantity: '15',
  },
  {
    symbol: 'BTC',
    accountType: 'crypto_exchange',
    startCloseMinor: 4_200_000n,
    volatilityBps: 1_400,
    quantity: '0.35',
  },
  {
    symbol: 'ETH',
    accountType: 'crypto_exchange',
    startCloseMinor: 230_000n,
    volatilityBps: 1_600,
    quantity: '4.2',
  },
];

function findAccount(
  accounts: readonly SeedAccount[],
  type: SecuritySpec['accountType'],
): SeedAccount {
  const found = accounts.find((account) => account.type === type);
  if (found === undefined) throw new Error(`no seeded account of type ${type}`);
  return found;
}

export interface GenerateInvestmentsResult {
  readonly holdings: SeedHolding[];
  readonly prices: SeedPricePoint[];
}

/**
 * A monthly close-price walk per security, plus one holding snapshot as of the
 * last day of the window.
 *
 * Deliberately monthly, not daily: `07 §5.5`'s portfolio analytics (TWR, MWR,
 * drift) need a price *series*, not necessarily a dense one, and a demo dataset
 * that took a daily random walk over 24 months for five securities would trade
 * seed-generation speed for a precision this package's consumers do not need.
 */
export function generateInvestments(
  rng: Rng,
  accounts: readonly SeedAccount[],
  startMonth: DateOnlyType,
  monthCount: number,
  today: DateOnlyType,
): GenerateInvestmentsResult {
  const holdings: SeedHolding[] = [];
  const prices: SeedPricePoint[] = [];

  for (const spec of SECURITIES) {
    const account = findAccount(accounts, spec.accountType);
    const securityId = randomUuid(rng);
    let closeMinor = spec.startCloseMinor;

    for (let monthOffset = 0; monthOffset < monthCount; monthOffset += 1) {
      const anchor = DateOnly.addMonths(startMonth, monthOffset);
      const closeOn = DateOnly.endOfMonth(anchor);
      // The window's last, possibly-partial month still gets one point, dated
      // "today" rather than a not-yet-arrived month-end.
      const pastToday = DateOnly.compare(closeOn, today) > 0;
      const date = pastToday ? today : closeOn;

      // A monthly-compounded random walk in basis points, floor-divided in
      // `bigint`: one draw per step, and the same draw count per security the
      // float version made, so the generator's position in the PRNG stream is
      // unchanged.
      const shockBps = randomInt(rng, -spec.volatilityBps, spec.volatilityBps);
      const step = (closeMinor * BigInt(DRIFT_BPS + shockBps)) / BPS;
      closeMinor = closeMinor + step;
      if (closeMinor < 1n) closeMinor = 1n;

      prices.push({
        securityId,
        symbol: spec.symbol,
        date,
        close: formatScaledInteger(closeMinor, 2),
      });

      if (pastToday) break;
    }

    holdings.push({
      accountId: account.id,
      securityId,
      symbol: spec.symbol,
      quantity: Quantity.of(spec.quantity),
      asOf: today,
    });
  }

  return { holdings, prices };
}
