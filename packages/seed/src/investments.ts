// SPDX-License-Identifier: MIT
import { DateOnly, Quantity } from '@core/kernel';
import { randomFloat, randomUuid, type Rng } from './prng.ts';
import type { SeedAccount, SeedHolding, SeedPricePoint } from './types.ts';

type DateOnlyType = DateOnly;

interface SecuritySpec {
  readonly symbol: string;
  readonly accountType: 'brokerage' | 'crypto_exchange';
  readonly startPrice: number;
  /** Per-day volatility as a fraction of price; small for an index fund, large for crypto. */
  readonly dailyVolatility: number;
  readonly quantity: string;
}

const SECURITIES: readonly SecuritySpec[] = [
  {
    symbol: 'VTI',
    accountType: 'brokerage',
    startPrice: 220,
    dailyVolatility: 0.008,
    quantity: '48.5',
  },
  {
    symbol: 'VXUS',
    accountType: 'brokerage',
    startPrice: 55,
    dailyVolatility: 0.007,
    quantity: '120.25',
  },
  {
    symbol: 'AAPL',
    accountType: 'brokerage',
    startPrice: 180,
    dailyVolatility: 0.015,
    quantity: '15',
  },
  {
    symbol: 'BTC',
    accountType: 'crypto_exchange',
    startPrice: 42_000,
    dailyVolatility: 0.035,
    quantity: '0.35',
  },
  {
    symbol: 'ETH',
    accountType: 'crypto_exchange',
    startPrice: 2_300,
    dailyVolatility: 0.04,
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
    let price = spec.startPrice;

    for (let monthOffset = 0; monthOffset < monthCount; monthOffset += 1) {
      const anchor = DateOnly.addMonths(startMonth, monthOffset);
      const closeOn = DateOnly.endOfMonth(anchor);
      // The window's last, possibly-partial month still gets one point, dated
      // "today" rather than a not-yet-arrived month-end.
      const pastToday = DateOnly.compare(closeOn, today) > 0;
      const date = pastToday ? today : closeOn;

      // A monthly-compounded random walk, drifting gently upward on average
      // (a demo household's portfolio should not look like a coin flip).
      const drift = 0.004;
      const shock = randomFloat(rng, -spec.dailyVolatility, spec.dailyVolatility) * 4;
      price = Math.max(0.01, price * (1 + drift + shock));

      prices.push({ securityId, symbol: spec.symbol, date, close: price.toFixed(2) });

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
