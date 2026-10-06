// SPDX-License-Identifier: MIT
/**
 * WP 9.2 — the holder's overlay reaches the projection and the net-worth
 * valuation (CF-16, O-2), against a real Postgres.
 *
 * Two claims, each its own exit test:
 *
 *   1. A change to what the holder says an account is — its tax treatment, or
 *      its role or valuation — makes the stored baseline read **stale and name
 *      why**; nothing is recomputed behind their back.
 *   2. An account the holder asked to value by balance counts at that balance
 *      and is labelled so; an account valued by holdings that has none is named
 *      unvalued, never counted as zero.
 *
 * ## What is the shipped composition here, and what is not
 *
 * The overlay is stored by `@ctx/ledger` (real `setAccountOverrides`, real
 * `account_overrides` rows) and joined to the projection by planning's own
 * `withOverlay` — the function `apps/api/src/domain.ts`'s
 * `planningCashflowReaderFor` calls, not a copy of it. What this file *cannot*
 * import is `domain.ts` itself: a package may not reach into `apps/` by a
 * relative path (`personalfi/layer-imports`). So the two exit tests are
 * mirrored by name, through the real `app.ts` composition and its real routes,
 * in `apps/api/test/db/account-overrides-routes.test.ts` (C5-11). Here the
 * port is a thin reader over the real ledger tables; there the port is
 * `domain.ts`'s.
 *
 * Own scratch database (`personalfi_wp92_tax_override`), per docs/TESTING.md.
 */
import { DateOnly, Money, fixedClock, type Clock } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import {
  listAccountOverrides,
  listAccounts,
  overrideFingerprint,
  setAccountOverrides,
  clearAccountOverrides,
  upsertAccount,
} from '@ctx/ledger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withOverlay } from '../../src/account-overlay.ts';
import {
  computeNetWorth,
  summariseValuation,
  type BreakdownEntry,
  type NetWorthSnapshot,
} from '../../src/net-worth.ts';
import { defaultFlagsFor, type CashflowReader, type RevealedPorts } from '../../src/ports.ts';
import {
  readProjection,
  runProjection,
  createProjectionInputsReader,
  type ProjectionServiceDependencies,
} from '../../src/projection-service.ts';
import { saveBaseline, type BaselineProfile } from '../../src/scenarios.ts';
import { sealDay, upsertOpenDay, type PlanningExecutor } from '../../src/store.ts';
import { balancesReaderOf, portsOf, type FakeWorld } from '../fakes.ts';
import { ports as revealedPorts } from '../revealed-fixtures.ts';
import { CORRELATION_ID, NO_DATABASE } from './harness.ts';

const ZONE = 'America/New_York';
const CLOCK: Clock = fixedClock('2026-09-26T08:30:00Z');
const MARK = 'WP 9.2';

function usd(text: string): Money {
  return Money.parseAmount(text, 'USD');
}

const PROFILE: BaselineProfile = {
  birthDate: DateOnly.parse('1986-03-15'),
  retirementAge: 65,
  planEndAge: 95,
  currency: 'USD',
  glidepath: { kind: 'age_based' },
  contributionGrowth: 'wage',
  annualSpending: usd('60000'),
  withdrawalPolicy: 'constant_real',
  spendingFloor: 'none',
  taxDeferredRate: '0.15',
  socialSecurity: {
    monthlyPia: usd('2800'),
    claimAge: { years: 67, months: 0 },
    stressAfter2034: false,
  },
  pensions: [],
  contributions: null,
};

describe.skipIf(NO_DATABASE)(`${MARK} — the holder's overlay reaches the projection`, () => {
  let database: TestDatabase;
  let ira: string; // the provider calls it an IRA: TAX_DEFERRED by default
  let brokerage: string;
  let scenarioId: string;

  const context = () => ({ clock: CLOCK, correlationId: CORRELATION_ID });
  const executor = (tx: unknown) => tx as PlanningExecutor;

  /** The CashflowReader the shipped binding builds, over the real ledger tables. */
  function ledgerCashflow(tx: PlanningExecutor): CashflowReader {
    return {
      async accounts(userId) {
        const [rows, overrides] = await Promise.all([
          listAccounts(tx, { userId, includeClosed: true }),
          listAccountOverrides(tx, { userId }),
        ]);
        const byId = new Map(overrides.map((override) => [override.accountId, override]));
        return rows.map((row) =>
          withOverlay(
            {
              accountId: row.id,
              name: row.name,
              kind: 'investment',
              side: row.classification,
              currency: row.currency.trim(),
              flags: defaultFlagsFor('investment'),
              closedAt: null,
            },
            { subtype: row.subtype, override: byId.get(row.id) ?? null },
          ),
        );
      },
      async historyStarts() {
        return new Map();
      },
      async inflows() {
        return [];
      },
    };
  }

  function dependencies(tx: PlanningExecutor): ProjectionServiceDependencies {
    const revealed: RevealedPorts = {
      cashflow: ledgerCashflow(tx),
      spending: revealedPorts([], []).spending,
    };
    return {
      inputs: createProjectionInputsReader(tx, revealed),
      monteCarlo: null,
      clock: CLOCK,
      timeZone: ZONE,
    };
  }

  const run = (acceptAccountChanges = false) =>
    database.db.transaction((tx) =>
      runProjection(executor(tx), dependencies(executor(tx)), {
        userId: database.userId,
        scenarioId,
        method: 'deterministic',
        correlationId: CORRELATION_ID,
        ...(acceptAccountChanges ? { acceptAccountChanges: true } : {}),
      }),
    );

  const read = async (runId: string) =>
    readProjection(database.db as unknown as PlanningExecutor, {
      userId: database.userId,
      runId,
      timeZone: ZONE,
      accountOverrides: overrideFingerprint(
        await listAccountOverrides(database.db, { userId: database.userId }),
      ),
    });

  const runCount = async () =>
    Number(
      (
        await database.db.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM projection_runs`,
        )
      ).rows[0]?.n,
    );

  const holder = () => ({ userId: database.userId });

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp92_tax_override');
  }, 300_000);
  afterAll(async () => {
    await database.drop();
  });
  beforeEach(async () => {
    await database.truncate();
    const seed = async (name: string, providerAccountId: string, subtype: string) =>
      (
        await database.db.transaction((tx) =>
          upsertAccount(
            tx,
            {
              userId: database.userId,
              provider: 'plaid',
              providerAccountId,
              name,
              type: 'investment',
              subtype,
              currency: 'USD',
            },
            context(),
          ),
        )
      ).accountId;
    ira = await seed('Rollover', 'pa-ira', 'ira');
    brokerage = await seed('Brokerage', 'pa-brokerage', 'brokerage');

    const entry = (accountId: string, minor: string): BreakdownEntry => ({
      accountId,
      currency: 'USD',
      nativeMinor: minor,
      baseMinor: minor,
      fxRate: '1',
      fxRateDate: '2026-09-24',
      onBudget: false,
      inNetWorth: true,
      isLiquid: false,
      isInvestable: true,
      side: 'asset',
      kind: 'investment',
      valuation: 'quantity_times_price',
      stalePrice: false,
    });
    const snapshot: NetWorthSnapshot = {
      asOfDate: '2026-09-24',
      baseCurrency: 'USD',
      assetsMinor: 35_000_000n,
      liabilitiesMinor: 0n,
      netWorthMinor: 35_000_000n,
      liquidMinor: 0n,
      investableMinor: 35_000_000n,
      onBudgetMinor: 0n,
      breakdown: [entry(brokerage, '10000000'), entry(ira, '25000000')],
      source: 'observed',
      stalePrice: false,
      accountsCounted: 2,
      accountsUnvalued: 0,
      unvalued: [],
    };
    await database.db.transaction(async (tx) => {
      await upsertOpenDay(executor(tx), { userId: database.userId, snapshot, clock: CLOCK });
      await sealDay(executor(tx), {
        userId: database.userId,
        asOfDate: '2026-09-24',
        clock: CLOCK,
      });
    });
    scenarioId = (
      await database.db.transaction((tx) =>
        saveBaseline(executor(tx), {
          userId: database.userId,
          name: 'My plan',
          profile: PROFILE,
          clock: CLOCK,
        }),
      )
    ).id;
  });

  it('after a tax-treatment change the stored baseline reads stale and names why', async () => {
    // The provider says IRA, so the $250,000 starts in TAX_DEFERRED.
    const first = await run();
    expect(first.status).toBe('computed');
    const bucketsOf = (outcome: Awaited<ReturnType<typeof run>>) =>
      (
        outcome.run?.input as {
          plan: { buckets: { bucket: string; startingBalance: { minor: string } }[] };
        }
      ).plan.buckets.map((bucket) => [bucket.bucket, bucket.startingBalance.minor]);
    expect(bucketsOf(first)).toEqual([
      ['TAXABLE', '10000000'],
      ['TAX_DEFERRED', '25000000'],
    ]);
    const firstRunId = first.run?.id ?? '';
    expect((await read(firstRunId)).staleness).toBeNull();

    // The holder says it is a Roth IRA. Same provider facts, same balances.
    await database.db.transaction((tx) =>
      setAccountOverrides(tx, { ...holder(), accountId: ira, taxTreatment: 'ROTH' }, context()),
    );

    // The stored baseline reads stale, and names the account, the field and both values.
    const stale = await read(firstRunId);
    expect(stale.staleness).toEqual({
      reason: 'account_overrides_changed',
      changes: [{ accountId: ira, field: 'taxTreatment', from: null, to: 'ROTH' }],
    });

    // Asking again does not recompute behind the holder's back: the stored run
    // comes back, stale, and no engine ran and no row was written.
    const asked = await run();
    expect(asked.status).toBe('stale');
    expect(asked.run?.id).toBe(firstRunId);
    expect(asked.status === 'stale' ? asked.staleness.reason : null).toBe(
      'account_overrides_changed',
    );
    expect(await runCount()).toBe(1);

    // Only when the holder says they know does a new run exist — from the new treatment.
    const accepted = await run(true);
    expect(accepted.status).toBe('computed');
    expect(accepted.run?.id).not.toBe(firstRunId);
    expect(accepted.run?.inputDigest).not.toBe(first.run?.inputDigest);
    expect(bucketsOf(accepted)).toEqual([
      ['TAXABLE', '10000000'],
      ['ROTH', '25000000'],
    ]);
    expect((await read(accepted.run?.id ?? '')).staleness).toBeNull();
    expect(await runCount()).toBe(2);

    // Clearing returns to the subtype's: the *new* run is now the stale one, and
    // the first run, computed from exactly that state, reads fresh again.
    await database.db.transaction((tx) =>
      clearAccountOverrides(tx, { ...holder(), accountId: ira }, context()),
    );
    expect((await read(firstRunId)).staleness).toBeNull();
    expect((await read(accepted.run?.id ?? '')).staleness).toEqual({
      reason: 'account_overrides_changed',
      changes: [{ accountId: ira, field: 'taxTreatment', from: 'ROTH', to: null }],
    });
  });

  it('a role or a valuation change makes the baseline stale too, though it moves no bucket', async () => {
    const first = await run();
    const firstRunId = first.run?.id ?? '';

    await database.db.transaction((tx) =>
      setAccountOverrides(tx, { ...holder(), accountId: brokerage, role: 'taxable' }, context()),
    );
    expect((await read(firstRunId)).staleness).toEqual({
      reason: 'account_overrides_changed',
      changes: [{ accountId: brokerage, field: 'role', from: null, to: 'taxable' }],
    });

    await database.db.transaction((tx) =>
      setAccountOverrides(
        tx,
        { ...holder(), accountId: brokerage, role: 'taxable', valuation: 'balance' },
        context(),
      ),
    );
    expect((await read(firstRunId)).staleness).toMatchObject({
      reason: 'account_overrides_changed',
      changes: [
        { accountId: brokerage, field: 'role', from: null, to: 'taxable' },
        { accountId: brokerage, field: 'valuation', from: null, to: 'balance' },
      ],
    });
    expect((await run()).status).toBe('stale');
  });

  it('a holder with no overrides digests, caches and reads back exactly as before', async () => {
    const first = await run();
    expect(first.run?.input).not.toHaveProperty('accountOverrides');
    const second = await run();
    expect(second.status).toBe('cached');
    expect(second.run?.id).toBe(first.run?.id);
    expect((await read(first.run?.id ?? '')).staleness).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The net-worth valuation
// ---------------------------------------------------------------------------

describe(`${MARK} — valuation by balance, and what is never counted as zero`, () => {
  const DAY = '2026-09-28';
  const BY_BALANCE = 'a1946000-0000-7000-8000-00000000a001';
  const BY_HOLDINGS_NONE = 'a1946000-0000-7000-8000-00000000a002';
  const BALANCE_BUT_PRICED = 'a1946000-0000-7000-8000-00000000a003';
  const BALANCE_NONE = 'a1946000-0000-7000-8000-00000000a004';
  const CHECKING = 'a1946000-0000-7000-8000-00000000a005';
  const SECURITY = 'a1946000-0000-7000-8000-00000000b001';

  const account = (accountId: string, name: string, kind: 'investment' | 'cash') => ({
    accountId,
    name,
    kind,
    side: 'asset' as const,
    currency: 'USD',
    flags: defaultFlagsFor(kind),
  });

  const world: FakeWorld = {
    accounts: [
      account(BY_BALANCE, 'Typed 401(k)', 'investment'),
      account(BY_HOLDINGS_NONE, 'Brokerage, nothing synced', 'investment'),
      account(BALANCE_BUT_PRICED, 'Priced brokerage', 'investment'),
      account(BALANCE_NONE, 'Never reported', 'investment'),
      account(CHECKING, 'Checking', 'cash'),
    ],
    balances: [
      {
        accountId: BY_BALANCE,
        date: '2026-09-26',
        currentMinor: '56000000',
        currency: 'USD',
        source: 'manual',
      },
      // A typed balance on an account valued by holdings: it must count nowhere.
      {
        accountId: BY_HOLDINGS_NONE,
        date: '2026-09-26',
        currentMinor: '1000000',
        currency: 'USD',
        source: 'manual',
      },
      {
        accountId: BALANCE_BUT_PRICED,
        date: '2026-09-26',
        currentMinor: '99900000',
        currency: 'USD',
        source: 'manual',
      },
      { accountId: CHECKING, date: DAY, currentMinor: '300000', currency: 'USD' },
    ],
    holdings: [
      { accountId: BALANCE_BUT_PRICED, securityId: SECURITY, quantity: '10', asOfDate: DAY },
    ],
    prices: [{ securityId: SECURITY, date: DAY, close: '100', currency: 'USD' }],
  };

  /** What the shipped balances reader adds: the holder's valuation basis, where set. */
  const valuationOf: Record<string, 'holdings' | 'balance'> = {
    [BY_BALANCE]: 'balance',
    [BALANCE_BUT_PRICED]: 'balance',
    [BALANCE_NONE]: 'balance',
  };
  const ports = () => {
    const base = portsOf(world);
    return {
      ...base,
      balances: {
        ...balancesReaderOf(world),
        async accounts(userId: string, asOf: string) {
          return (await balancesReaderOf(world).accounts(userId, asOf)).map((entry) => ({
            ...entry,
            ...(valuationOf[entry.accountId] === undefined
              ? {}
              : { valuation: valuationOf[entry.accountId] as 'holdings' | 'balance' }),
          }));
        },
      },
    };
  };

  it('an account valued by balance counts at that balance and is labelled so; one valued by holdings with none is named unvalued, never zero', async () => {
    const snapshot = await computeNetWorth(ports(), {
      userId: 'u',
      asOfDate: DAY,
      baseCurrency: 'USD',
    });
    const byId = new Map(snapshot.breakdown.map((entry) => [entry.accountId, entry]));

    // Counted at the typed balance, carried forward from its day, and labelled.
    expect(byId.get(BY_BALANCE)).toMatchObject({
      nativeMinor: '56000000',
      valuation: 'carry_forward',
      valuedBy: 'balance_override',
    });
    // Holdings win whenever they price: the typed $999,000 counts nowhere, and carries no label.
    expect(byId.get(BALANCE_BUT_PRICED)).toMatchObject({ nativeMinor: '100000' });
    expect(byId.get(BALANCE_BUT_PRICED)).not.toHaveProperty('valuedBy');
    // Valued by holdings with none: left out of every total and named — its typed $10,000 is not a zero and not a number.
    expect(byId.has(BY_HOLDINGS_NONE)).toBe(false);
    expect(snapshot.unvalued).toEqual([
      { accountId: BY_HOLDINGS_NONE, reason: 'no_priced_holding' },
      { accountId: BALANCE_NONE, reason: 'no_balance' },
    ]);
    expect(snapshot.accountsUnvalued).toBe(2);
    expect(snapshot.accountsCounted).toBe(3);
    // The total is exactly the three counted accounts: 560,000 + 1,000 + 3,000.
    expect(snapshot.assetsMinor).toBe(56_000_000n + 100_000n + 300_000n);
    // Cash is untouched: no label on an account valued the way its class says.
    expect(byId.get(CHECKING)).not.toHaveProperty('valuedBy');

    // The live summary the screens read names the same accounts, by the same valuation.
    const summary = await summariseValuation(ports(), { userId: 'u', asOfDate: DAY });
    expect(summary.byBalance).toEqual([{ accountId: BY_BALANCE, name: 'Typed 401(k)' }]);
    expect(summary.unvalued.map((entry) => [entry.accountId, entry.reason])).toEqual([
      [BY_HOLDINGS_NONE, 'no_priced_holding'],
      [BALANCE_NONE, 'no_balance'],
    ]);
  });

  it('a day with no override stores the bytes it always did', async () => {
    const plain = await computeNetWorth(portsOf(world), {
      userId: 'u',
      asOfDate: DAY,
      baseCurrency: 'USD',
    });
    expect(JSON.stringify(plain.breakdown)).not.toContain('valuedBy');
    expect(plain.unvalued.map((entry) => entry.accountId)).toEqual([
      BY_BALANCE,
      BY_HOLDINGS_NONE,
      BALANCE_NONE,
    ]);
  });
});
