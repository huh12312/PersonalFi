// SPDX-License-Identifier: MIT
/**
 * In-memory implementations of the four ports, and a recorder over them.
 *
 * These are fakes rather than mocks: they answer from a small world of facts
 * with the same rules the real readers apply, so a test that passes against them
 * is testing the aggregate rather than testing a script of expected calls.
 * Two rules in particular are reproduced deliberately, because the engine
 * depends on them:
 *
 *   * `fx.rate` **throws** `FxRateUnavailable` when the pair has no row, in
 *     either direction, and answers the identity only when the codes are equal.
 *     A fake that returned 1.0 would make the §5 FX criterion unfalsifiable.
 *   * `prices.price` **returns `null`** when nothing can answer, because a
 *     security with no price is an ordinary state and 08 §3.7 requires the day
 *     to seal anyway.
 *
 * `recordingPorts` wraps a world and counts every call. It is what makes
 * `'an investment account is never backfilled by the transaction-subtraction
 * path'` a claim about behaviour rather than about a policy table: the test
 * asserts that `transactionsTotalOn` was never *called* for the brokerage,
 * which a lookup table cannot fake its way past.
 */
import { FxRateUnavailable } from '@ctx/investments';
import type {
  BalanceObservation,
  BalancesReader,
  FxQuote,
  FxReader,
  HoldingObservation,
  HoldingsReader,
  PlanningAccount,
  PriceQuote,
  PriceReader,
  SnapshotPorts,
} from '../src/ports.ts';

export interface FakeAccount {
  readonly accountId: string;
  readonly name: string;
  readonly kind: PlanningAccount['kind'];
  readonly side: PlanningAccount['side'];
  readonly currency: string;
  readonly flags: PlanningAccount['flags'];
  readonly closedAt?: string | null;
}

export interface FakeBalance {
  readonly accountId: string;
  readonly date: string;
  readonly currentMinor: string;
  readonly currency: string;
  readonly source?: BalanceObservation['source'];
}

export interface FakeHolding {
  readonly accountId: string;
  readonly securityId: string;
  readonly quantity: string;
  readonly asOfDate: string;
}

export interface FakePrice {
  readonly securityId: string;
  readonly date: string;
  readonly close: string;
  readonly currency: string;
  readonly staleness?: PriceQuote['staleness'];
  readonly rung?: string;
}

export interface FakeFxRate {
  readonly from: string;
  readonly to: string;
  /** The date this rate answers *for*; `rateDate` is when it was observed. */
  readonly date: string;
  readonly rate: string;
  readonly rateDate?: string;
  readonly source?: string;
}

/** A day's worth of facts, in the shape the fixture files use. */
export interface FakeWorld {
  readonly accounts: readonly FakeAccount[];
  readonly balances: readonly FakeBalance[];
  readonly holdings?: readonly FakeHolding[];
  readonly prices?: readonly FakePrice[];
  readonly fxRates?: readonly FakeFxRate[];
  /** Signed minor-unit totals per `${accountId}|${date}`, for the backfill path. */
  readonly transactions?: Readonly<Record<string, string>>;
}

export function balancesReaderOf(world: FakeWorld): BalancesReader {
  return {
    async accounts(): Promise<readonly PlanningAccount[]> {
      return world.accounts.map((account) => ({
        accountId: account.accountId,
        name: account.name,
        kind: account.kind,
        side: account.side,
        currency: account.currency,
        flags: account.flags,
        closedAt:
          account.closedAt === undefined || account.closedAt === null
            ? null
            : new Date(`${account.closedAt}T00:00:00Z`),
      }));
    },

    async balanceOnOrBefore(
      _userId: string,
      accountId: string,
      date: string,
    ): Promise<BalanceObservation | null> {
      const forAccount = world.balances.filter((row) => row.accountId === accountId);
      if (forAccount.length === 0) return null;
      // The freshest observation on or before the date; failing that, the
      // *earliest* one after it, which is what the ledger has on a fresh
      // install and is exactly the case 04 §5.4's backfill exists for.
      const onOrBefore = forAccount
        .filter((row) => row.date <= date)
        .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      const after = forAccount
        .filter((row) => row.date > date)
        .sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      const chosen = onOrBefore ?? after;
      if (chosen === undefined) return null;
      return {
        accountId: chosen.accountId,
        date: chosen.date,
        currentMinor: BigInt(chosen.currentMinor),
        currency: chosen.currency,
        source: chosen.source ?? 'provider',
      };
    },

    async transactionsTotalOn(_userId: string, accountId: string, date: string): Promise<bigint> {
      return BigInt(world.transactions?.[`${accountId}|${date}`] ?? '0');
    },
  };
}

export function holdingsReaderOf(world: FakeWorld): HoldingsReader {
  const all = world.holdings ?? [];
  return {
    async positionsOnOrBefore(
      _userId: string,
      accountId: string,
      date: string,
    ): Promise<readonly HoldingObservation[]> {
      // One row per security: the position's *existence* on or before the date,
      // which is the question `computeNetWorth` asks. The quantity it then uses
      // comes from `bracketingObservations`, never from here.
      const seen = new Map<string, HoldingObservation>();
      for (const row of all) {
        if (row.accountId !== accountId || row.asOfDate > date) continue;
        const existing = seen.get(row.securityId);
        if (existing === undefined || row.asOfDate > existing.asOfDate) {
          seen.set(row.securityId, { ...row });
        }
      }
      return [...seen.values()].sort((a, b) => (a.securityId < b.securityId ? -1 : 1));
    },

    async bracketingObservations(
      _userId: string,
      accountId: string,
      securityId: string,
      date: string,
    ): Promise<{ before: HoldingObservation | null; after: HoldingObservation | null }> {
      const forSecurity = all
        .filter((row) => row.accountId === accountId && row.securityId === securityId)
        .sort((a, b) => (a.asOfDate < b.asOfDate ? -1 : 1));
      const before = [...forSecurity].reverse().find((row) => row.asOfDate <= date) ?? null;
      const after = forSecurity.find((row) => row.asOfDate > date) ?? null;
      return { before, after };
    },
  };
}

export function priceReaderOf(world: FakeWorld): PriceReader {
  const all = world.prices ?? [];
  return {
    async price(securityId: string, date: string, currency: string): Promise<PriceQuote | null> {
      const candidates = all
        .filter(
          (row) => row.securityId === securityId && row.currency === currency && row.date <= date,
        )
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      const chosen = candidates[0];
      if (chosen === undefined) return null;
      const carriedForward = chosen.date !== date;
      return {
        close: chosen.close,
        currency: chosen.currency,
        priceDate: chosen.date,
        staleness: chosen.staleness ?? (carriedForward ? 'STALE' : 'FRESH'),
        rung: chosen.rung ?? (carriedForward ? 'last_known' : 'tiingo'),
        carriedForward,
      };
    },
  };
}

export function fxReaderOf(world: FakeWorld): FxReader {
  const all = world.fxRates ?? [];
  return {
    async rate(from: string, to: string, date: string): Promise<FxQuote> {
      // The one legitimate 1.0 in the system, reachable only when the two codes
      // are literally equal — exactly as `@ctx/investments`' reader does it.
      if (from === to) return { rate: '1', rateDate: date, source: 'identity' };

      const direct = all
        .filter((row) => row.from === from && row.to === to && row.date <= date)
        .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      if (direct !== undefined) {
        return {
          rate: direct.rate,
          rateDate: direct.rateDate ?? direct.date,
          source: direct.source ?? 'fred',
        };
      }

      throw new FxRateUnavailable(from, to, date, [`${from}/${to}`, `${to}/${from} (inverted)`]);
    },
  };
}

export function portsOf(world: FakeWorld): SnapshotPorts {
  return {
    balances: balancesReaderOf(world),
    holdings: holdingsReaderOf(world),
    prices: priceReaderOf(world),
    fx: fxReaderOf(world),
  };
}

/** Every call the aggregate made, so a test can assert on one it must never make. */
export interface PortCallLog {
  readonly transactionsTotalOn: string[];
  readonly balanceOnOrBefore: string[];
  readonly price: string[];
  readonly fxRate: string[];
}

export function recordingPorts(world: FakeWorld): {
  readonly ports: SnapshotPorts;
  readonly calls: PortCallLog;
} {
  const inner = portsOf(world);
  const calls: PortCallLog = {
    transactionsTotalOn: [],
    balanceOnOrBefore: [],
    price: [],
    fxRate: [],
  };

  return {
    calls,
    ports: {
      balances: {
        accounts: (userId, asOf) => inner.balances.accounts(userId, asOf),
        balanceOnOrBefore: (userId, accountId, date) => {
          calls.balanceOnOrBefore.push(`${accountId}|${date}`);
          return inner.balances.balanceOnOrBefore(userId, accountId, date);
        },
        transactionsTotalOn: (userId, accountId, date) => {
          calls.transactionsTotalOn.push(`${accountId}|${date}`);
          return inner.balances.transactionsTotalOn(userId, accountId, date);
        },
      },
      holdings: inner.holdings,
      prices: {
        price: (securityId, date, currency) => {
          calls.price.push(`${securityId}|${date}`);
          return inner.prices.price(securityId, date, currency);
        },
      },
      fx: {
        rate: (from, to, date) => {
          calls.fxRate.push(`${from}/${to}|${date}`);
          return inner.fx.rate(from, to, date);
        },
      },
    },
  };
}
