// SPDX-License-Identifier: MIT
/**
 * WP 3.14 §13 — **holdings reconcile to balances**, the one clause of the v0.5
 * rung (§2.3) that the exit-criteria audit found had no test at all.
 *
 * ## What is being claimed, and against what
 *
 * For every seeded investment account: the sum of its positions' market values,
 * read through the **real** `GET /accounts/{id}/holdings` route, equals that
 * account's latest balance, read through the **real** `GET /accounts` route, to
 * the cent — or the difference is explained by a reason from a closed list that
 * the test asserts by name.
 *
 * The two sides are deliberately computed by different machinery, or this would
 * assert only that one expression equals itself:
 *
 *   * **The balance** is recorded over HTTP (`POST /accounts/{id}/balance`, the
 *     same writer a sync uses) from `packages/seed/src/phase3-investments.ts`'s
 *     hand-computed `expectedMarketValue` literals — the ones
 *     `packages/seed/test/investments-ground-truth.test.ts` grades against
 *     `marketValueOf`. It is the institution's figure: what the statement says.
 *   * **The Σ** comes back out of the database through `readHoldings` →
 *     WP 3.4's price ladder → `valueHoldings`' single half-even rounding at the
 *     minor-unit boundary, serialised by the route's own Zod schema.
 *
 * A generator that lied, a ladder that picked the wrong rung, a rounding that
 * moved, or a route that dropped a position would separate the two.
 *
 * ## The closed list of reasons
 *
 * Straight out of `docs/evidence/phase-3/wp3.7-plaid-investments.md` §5, which
 * states the semantics this file mechanises: Σ(quantity × *our* price) per
 * account against the account's own balance, with every difference named.
 *
 * | Reason | What it means |
 * |---|---|
 * | `exact` | Agreement to the cent, nothing excluded. The only verdict that reconciles. |
 * | `unpriced_position_excluded` | A position has no price on any rung; `valueHoldings` drops it and names it (`price_unknown`). |
 * | `stale_position_excluded` | A price older than 24 h against the read-time clock (07 §6.1); dropped and named (`stale_price`) under the `as_of_now` basis. |
 * | `foreign_currency_not_converted` | D4: the account is in CAD, the report is in USD, and nothing converts at par. |
 * | `balance_missing` | No balance has ever been observed. Distinct from a zero balance. |
 * | `unexplained` | A difference with nothing to account for it. Always red. |
 *
 * **An excluded position can never produce a `reconciled` verdict**, even when
 * the arithmetic happens to land on zero. That rule is what the second test is
 * about, and it is written into `reconcile()` rather than into an assertion so
 * that it holds for every account on every run.
 *
 * ## Two route field gaps, computed around rather than edited away
 *
 * Routes are not this file's to change, so both are recorded here and in
 * `docs/evidence/phase-3/wp3.14-quality.md` §13 instead:
 *
 *  1. **No route reports a reconciliation.** Neither response carries a
 *     difference, a verdict or a tolerance, so `reconcile()` below computes the
 *     difference in the test from the two payloads. Relatedly,
 *     `holdings.institution_value_minor` — written by
 *     `packages/contexts/investments/src/lots-store.ts:337`, and the column the
 *     audit row pointed at — is **exposed on no route at all**, so the
 *     per-position half of WP 3.7 §5's table cannot be reconciled over HTTP.
 *     The account-level balance is used instead, which is what the criterion
 *     ("holdings reconcile to *balances*") actually names.
 *  2. **`excluded[].reason` under-describes the CAD case.** The seeded CAD
 *     position is quoted in CAD and comes back as `price_unknown`, not
 *     `currency_mismatch`, because `createPriceReader` filters observations by
 *     quote currency (`prices.ts` → `observationsForLadder(..., quoteCurrency,
 *     ...)`) before `valueHoldings`' currency check ever sees a row. The
 *     position is priced; it is just not priced in USD. Asserted as observed —
 *     the test pins the behaviour that exists, and the evidence note says why
 *     the label is thinner than the cause.
 *
 * ## Why the rows are written with SQL
 *
 * The same reason `investments-perf.test.ts`'s header gives: the only
 * production writer of `securities`, `holdings` and `prices` is WP 3.7's Plaid
 * sync, which cannot be driven from here. The **accounts** and the **balances**
 * are real — created by linking a `ManualConnector` over HTTP and written
 * through `POST /accounts/{id}/balance` — and both sides of the comparison are
 * read back through real routes, which is where the claim lives.
 */
import { newId } from '@core/kernel';
import { generatePhase3Investments } from '@core/seed';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  linkManual,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const DAY_MS = 86_400_000;
const SEED = 3_14;
const dataset = generatePhase3Investments(SEED);

/** The days priced at `closeOnAsOf` with a *fresh* `observed_at`. See `seedPrices`. */
const RECENT_DAY_OFFSETS = [0, -1, -2] as const;

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The wire, as this test reads it
// ---------------------------------------------------------------------------

interface WireMoney {
  readonly minor: string;
  readonly currency: string;
}

interface WireAccount {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly balance: { readonly current: WireMoney; readonly asOf: string } | null;
}

interface WireExcluded {
  readonly holdingId: string;
  readonly symbol: string | null;
  readonly reason: string;
}

interface WirePosition {
  readonly holdingId: string;
  readonly securityId: string;
  readonly symbol: string | null;
  readonly quantity: string;
  readonly marketValue: WireMoney | null;
  readonly stale: boolean;
  readonly price: { readonly close: string; readonly currency: string } | null;
}

interface WireAccountHoldings {
  readonly accountId: string;
  readonly asOf: string;
  readonly currency: string;
  readonly total: WireMoney;
  readonly positions: readonly WirePosition[];
  readonly excluded: readonly WireExcluded[];
}

// ---------------------------------------------------------------------------
// The reconciliation itself
// ---------------------------------------------------------------------------

type ReconcileReason =
  | 'exact'
  | 'unpriced_position_excluded'
  | 'stale_position_excluded'
  | 'foreign_currency_not_converted'
  | 'balance_missing'
  | 'unexplained';

interface Reconciliation {
  readonly accountName: string;
  readonly balance: WireMoney | null;
  /** Σ of `positions[].marketValue`, in the *report's* currency. */
  readonly sum: WireMoney;
  /** `balance − sum` in minor units, or `null` when the two are incomparable. */
  readonly differenceMinor: bigint | null;
  readonly verdict: 'reconciled' | 'unreconciled';
  readonly reason: ReconcileReason;
  /** Every security the report refused to value, by ticker. Never empty when unreconciled on an exclusion. */
  readonly namedSecurities: readonly string[];
}

/**
 * Compare one account's positions to its balance.
 *
 * Computed here and not read off a field because no route reports it — gap 1 in
 * the header. `symbol ?? holdingId` so a security with no ticker is still
 * *named*: an unreconciled account that cannot say which position broke it is
 * only marginally better than a silent one.
 */
function reconcile(
  accountName: string,
  account: WireAccount,
  holdings: WireAccountHoldings,
): Reconciliation {
  let sumMinor = 0n;
  for (const position of holdings.positions) {
    if (position.marketValue === null) continue;
    sumMinor += BigInt(position.marketValue.minor);
  }
  const sum: WireMoney = { minor: sumMinor.toString(), currency: holdings.currency };
  const named = holdings.excluded.map((row) => row.symbol ?? row.holdingId);
  const base = { accountName, balance: account.balance?.current ?? null, sum } as const;

  if (account.balance === null) {
    return {
      ...base,
      differenceMinor: null,
      verdict: 'unreconciled',
      reason: 'balance_missing',
      namedSecurities: named,
    };
  }
  // D4, first: two currencies are not a small difference, they are no
  // comparison at all. Subtracting them would be the par conversion the §5
  // "never" list forbids.
  if (account.balance.current.currency !== holdings.currency) {
    return {
      ...base,
      differenceMinor: null,
      verdict: 'unreconciled',
      reason: 'foreign_currency_not_converted',
      namedSecurities: named,
    };
  }

  const differenceMinor = BigInt(account.balance.current.minor) - sumMinor;

  // The rule the second test is named for: an excluded position always leaves
  // the account unreconciled, *including* when the remainder happens to equal
  // the balance. An exclusion that could be cancelled out by arithmetic is a
  // silent reconciliation by another route.
  if (holdings.excluded.length > 0) {
    const reasons = new Set(holdings.excluded.map((row) => row.reason));
    const reason: ReconcileReason = reasons.has('price_unknown')
      ? 'unpriced_position_excluded'
      : reasons.has('stale_price')
        ? 'stale_position_excluded'
        : 'unexplained';
    return { ...base, differenceMinor, verdict: 'unreconciled', reason, namedSecurities: named };
  }

  return differenceMinor === 0n
    ? { ...base, differenceMinor, verdict: 'reconciled', reason: 'exact', namedSecurities: [] }
    : {
        ...base,
        differenceMinor,
        verdict: 'unreconciled',
        reason: 'unexplained',
        namedSecurities: [],
      };
}

function formatMinor(value: WireMoney | null): string {
  if (value === null) return '—';
  const negative = value.minor.startsWith('-');
  const digits = (negative ? value.minor.slice(1) : value.minor).padStart(3, '0');
  const major = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${value.currency} ${major}.${digits.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// What every account must come out as, declared before anything runs
// ---------------------------------------------------------------------------

interface AccountExpectation {
  /** The seeded account's name; the join key between the seed and the ledger. */
  readonly name: string;
  /** The institution's figure, recorded over HTTP. Cross-checked against Σ of the seed's declared values. */
  readonly balance: WireMoney;
  /** What the route's own arithmetic must produce, in the report's currency. */
  readonly sum: WireMoney;
  readonly verdict: 'reconciled' | 'unreconciled';
  readonly reason: ReconcileReason;
  readonly namedSecurities: readonly string[];
  readonly why: string;
}

const EXPECTED: readonly AccountExpectation[] = [
  {
    name: 'Taxable Brokerage',
    balance: { minor: '1831536', currency: 'USD' },
    sum: { minor: '1831536', currency: 'USD' },
    verdict: 'reconciled',
    reason: 'exact',
    namedSecurities: [],
    why: '3 VTI × $305.12 = $915.36, 20 AAPL × $245.00 = $4,900.00, and the $12,500.00 cash sweep — $18,315.36 to the cent. The sweep is in the denominator, which is the whole of the "cash sweep position" row in wp3.7 §5.',
  },
  {
    name: 'Rollover IRA',
    balance: { minor: '747100', currency: 'USD' },
    sum: { minor: '747100', currency: 'USD' },
    verdict: 'reconciled',
    reason: 'exact',
    namedSecurities: [],
    why: '100 BND × $71.50 = $7,150.00 plus 5 VXUS × $64.20 = $321.00. VXUS was transferred in with no basis: what it *cost* is unavailable (04 §5.5) and what it is *worth* is not, so it reconciles like any other position.',
  },
  {
    name: 'Crypto Exchange',
    balance: { minor: '315000', currency: 'USD' },
    sum: { minor: '315000', currency: 'USD' },
    verdict: 'reconciled',
    reason: 'exact',
    namedSecurities: [],
    why: '1.000000000000000000 ETH × $3,150.00 = $3,150.00 — an 18-decimal quantity rounded once, at the minor-unit boundary.',
  },
  {
    name: 'CAD Brokerage',
    balance: { minor: '708000', currency: 'CAD' },
    sum: { minor: '0', currency: 'USD' },
    verdict: 'unreconciled',
    reason: 'foreign_currency_not_converted',
    namedSecurities: ['XIC'],
    why: 'the statement says CAD 7,080.00; the report is USD and there is no USD quote for XIC, so the position is excluded and named rather than counted at par. D4 and the §5 "never" list: a missing conversion surfaces, it does not default to 1.0.',
  },
];

/** The cash sweep, by minor units — the hole a denominator that dropped cash would open. */
const CASH_SWEEP_MINOR = 1_250_000n;

describe.skipIf(NO_DATABASE)('holdings reconcile to balances (WP 3.14 §13)', () => {
  let h: ApiHarness;
  /** Seeded account name → the ledger's account id. */
  const accountIdOf = new Map<string, string>();
  /** Seeded security id → the `securities` row id. */
  const securityIdOf = new Map<string, string>();
  let holdingRows = 0;
  let priceRows = 0;

  async function getAccounts(): Promise<readonly WireAccount[]> {
    const response = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    expectStatus(response, 200);
    return (response.json() as { accounts: WireAccount[] }).accounts;
  }

  async function getAccountHoldings(accountId: string): Promise<WireAccountHoldings> {
    const response = await h.request({
      method: 'GET',
      url: `/accounts/${accountId}/holdings`,
      session: h.stale,
    });
    expectStatus(response, 200);
    return response.json() as WireAccountHoldings;
  }

  /** Both real routes, then the arithmetic no route does. */
  async function reconcileByName(name: string): Promise<Reconciliation> {
    const accountId = accountIdOf.get(name);
    if (accountId === undefined) throw new Error(`no linked account named ${name}`);
    const account = (await getAccounts()).find((row) => row.id === accountId);
    if (account === undefined) throw new Error(`GET /accounts did not return ${name}`);
    const holdings = await getAccountHoldings(accountId);
    // The route's own `total` and the sum of its own positions must agree, or
    // everything below is reconciling against a number the response contradicts.
    expect(holdings.accountId, name).toBe(accountId);
    return reconcile(name, account, holdings);
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp314-reconcile' });

    // --- accounts: real, linked over HTTP, exactly as every other suite does.
    const investmentAccounts = dataset.accounts.filter(
      (account) => account.kind !== 'liability' && account.kind !== 'manual_asset',
    );
    await linkManual(h, {
      providerConnectionId: 'wp314-reconcile-conn',
      displayName: 'Seeded Brokerage',
      accounts: investmentAccounts.map((account) => ({
        providerAccountId: account.id,
        name: account.name,
        type: 'investment' as const,
        currency: account.currency,
      })),
    });

    const accountRows = await h.database.db.execute<{ id: string; provider_account_id: string }>(
      sql`SELECT id, provider_account_id FROM accounts WHERE user_id = ${h.userId}::uuid`,
    );
    const ledgerIdOf = new Map(accountRows.rows.map((row) => [row.provider_account_id, row.id]));
    for (const account of investmentAccounts) {
      const id = ledgerIdOf.get(account.id);
      if (id !== undefined) accountIdOf.set(account.name, id);
    }

    // --- securities.
    for (const security of dataset.securities) {
      const id = newId();
      securityIdOf.set(security.id, id);
      await h.database.db.execute(sql`
        INSERT INTO securities (
          id, user_id, identity_kind, identity_key, ticker, name, type, currency,
          is_cash_equivalent, asset_class, region, sector, chain, contract,
          classification_source, classification_depth, classification_flagged
        ) VALUES (
          ${id}::uuid, ${h.userId}::uuid, 'ticker',
          ${`ticker:${security.symbol}:${h.userId.slice(0, 8)}`},
          ${security.symbol}, ${security.name}, ${security.type}, ${security.currency},
          ${security.isCashEquivalent}, ${security.assetClass}, ${security.region},
          ${security.sector}, ${security.chain}, ${security.contract},
          'LOCAL_SEED_TABLE', 0, false
        )
      `);
    }

    // --- holdings. `institution_value_minor` is written because the sync writes
    // it; no route exposes it, which is gap 1 in the header.
    for (const holding of dataset.holdings) {
      const accountId = ledgerIdOf.get(holding.accountId);
      const securityId = securityIdOf.get(holding.securityId);
      if (accountId === undefined || securityId === undefined) continue;
      await h.database.db.execute(sql`
        INSERT INTO holdings (
          id, user_id, account_id, security_id, quantity, institution_value_minor, currency,
          cost_basis_minor, cost_basis_is_user_supplied, cost_basis_source, as_of_date
        ) VALUES (
          ${newId()}::uuid, ${h.userId}::uuid, ${accountId}::uuid, ${securityId}::uuid,
          ${holding.quantity}, ${BigInt(holding.expectedMarketValue.minor)}, ${holding.currency},
          NULL, false, 'ESTIMATED', ${isoDay(0)}::date
        )
      `);
      holdingRows += 1;
    }

    // --- prices.
    priceRows = await seedPrices();

    // --- balances, through the real route, from the seed's declared values.
    for (const expectation of EXPECTED) {
      const accountId = accountIdOf.get(expectation.name);
      if (accountId === undefined) throw new Error(`no linked account named ${expectation.name}`);
      const response = await h.request({
        method: 'POST',
        url: `/accounts/${accountId}/balance`,
        session: h.fresh,
        body: { current: expectation.balance },
      });
      expectStatus(response, 200);
    }
  }, 600_000);

  /**
   * The seed's own series, plus three recent days quoted at `closeOnAsOf`.
   *
   * The three recent days are not padding. `observed_at`, not `price_date`, is
   * what 07 §6.1's 24-hour rule reads, so a series that stops at a month-end is
   * *entirely* STALE at read time and every position would be excluded — which
   * would make this file pass by reporting four unreconciled accounts. And the
   * cash sweep needs one of them in particular: the `cash` ladder is
   * `['user_override', 'last_known']`, so the only rung that can answer for
   * CASH is `last_known`, which takes the most recent observation *strictly
   * before* the day asked for. Three days covers that whichever day
   * `todayFor()` resolves to.
   *
   * The source per security is the rung its ladder actually names — `coingecko`
   * for crypto (D17), `tiingo` otherwise. A row under a source the ladder does
   * not list is a row the reader will never return.
   */
  async function seedPrices(): Promise<number> {
    const today = isoDay(0);
    let written = 0;
    for (const security of dataset.securities) {
      const securityId = securityIdOf.get(security.id);
      if (securityId === undefined) continue;
      const source = security.type === 'crypto' ? 'coingecko' : 'tiingo';
      const history = dataset.prices.filter(
        (point) => point.securityId === security.id && point.date < today,
      );
      for (const point of history) {
        await h.database.db.execute(sql`
          INSERT INTO prices (id, user_id, security_id, price_date, source, close, currency, stale, observed_at)
          VALUES (${newId()}::uuid, ${h.userId}::uuid, ${securityId}::uuid, ${point.date}::date,
                  ${source}, ${point.close}, ${security.currency}, false,
                  ${`${point.date}T21:00:00.000Z`}::timestamptz)
          ON CONFLICT DO NOTHING
        `);
        written += 1;
      }
      for (const offset of RECENT_DAY_OFFSETS) {
        await h.database.db.execute(sql`
          INSERT INTO prices (id, user_id, security_id, price_date, source, close, currency, stale, observed_at)
          VALUES (${newId()}::uuid, ${h.userId}::uuid, ${securityId}::uuid, ${isoDay(offset)}::date,
                  ${source}, ${security.closeOnAsOf}, ${security.currency}, false, now())
          ON CONFLICT (user_id, security_id, price_date, source, currency)
          DO UPDATE SET close = EXCLUDED.close, observed_at = EXCLUDED.observed_at
        `);
        written += 1;
      }
    }
    return written;
  }

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('the seeded portfolio is in the database and every seeded investment account is covered', async () => {
    // A reconciliation over an empty table reconciles perfectly and proves
    // nothing, so the rows are counted before anything is compared.
    expect(holdingRows).toBe(dataset.holdings.length);
    expect(holdingRows).toBeGreaterThan(0);
    expect(priceRows).toBeGreaterThan(100);

    // Every seeded account that can hold a position has an expectation, and the
    // two that cannot are exactly the manual asset and the liability — whose
    // balances are criterion (a)'s subject, not this one's.
    const investmentNames = dataset.accounts
      .filter((account) => account.kind !== 'liability' && account.kind !== 'manual_asset')
      .map((account) => account.name)
      .sort();
    expect([...EXPECTED].map((row) => row.name).sort()).toEqual(investmentNames);
    expect(
      dataset.accounts
        .filter((account) => account.kind === 'liability' || account.kind === 'manual_asset')
        .map((account) => account.kind)
        .sort(),
    ).toEqual(['liability', 'manual_asset']);

    // And every declared balance really is the sum of the seed's own declared
    // market values — so the table above cannot drift away from the generator.
    for (const expectation of EXPECTED) {
      const seedAccount = dataset.accounts.find((account) => account.name === expectation.name);
      expect(seedAccount, expectation.name).toBeDefined();
      const declared = dataset.holdings
        .filter((holding) => holding.accountId === seedAccount?.id)
        .reduce((total, holding) => total + BigInt(holding.expectedMarketValue.minor), 0n);
      expect(declared.toString(), `${expectation.name}: Σ of the seed's declared values`).toBe(
        expectation.balance.minor,
      );
    }
  });

  it('holdings reconcile to balances on the seed', async () => {
    const table: string[] = [];

    for (const expectation of EXPECTED) {
      const result = await reconcileByName(expectation.name);
      const where = `${expectation.name}: ${expectation.why}`;

      table.push(
        `| ${expectation.name} | ${formatMinor(result.balance)} | ${formatMinor(result.sum)} | ` +
          `${result.differenceMinor === null ? 'incomparable' : formatMinor({ minor: result.differenceMinor.toString(), currency: result.sum.currency })} | ` +
          `${result.verdict} / ${result.reason}${result.namedSecurities.length > 0 ? ` (${result.namedSecurities.join(', ')})` : ''} |`,
      );

      expect(result.balance, where).toEqual(expectation.balance);
      expect(result.sum, where).toEqual(expectation.sum);
      expect(result.verdict, where).toBe(expectation.verdict);
      expect(result.reason, where).toBe(expectation.reason);
      expect(result.namedSecurities, where).toEqual(expectation.namedSecurities);
      // To the cent, spelled separately from the verdict: a `reconciled`
      // verdict with a non-zero difference would be a bug in `reconcile`.
      if (expectation.verdict === 'reconciled') expect(result.differenceMinor, where).toBe(0n);
    }

    process.stdout.write(
      `\nholdings reconcile to balances (seed ${String(SEED)}):\n` +
        `| Account | Balance | Σ holdings | Difference | Verdict / reason |\n` +
        `| --- | --- | --- | --- | --- |\n${table.join('\n')}\n`,
    );

    // --- The route's own total must equal the sum of its own positions.
    for (const expectation of EXPECTED) {
      const accountId = accountIdOf.get(expectation.name) ?? '';
      const holdings = await getAccountHoldings(accountId);
      const positionsSum = holdings.positions.reduce(
        (total, position) =>
          position.marketValue === null ? total : total + BigInt(position.marketValue.minor),
        0n,
      );
      expect(BigInt(holdings.total.minor), `${expectation.name}: total vs Σ positions`).toBe(
        positionsSum,
      );
      expect(holdings.total.currency, expectation.name).toBe('USD');
    }

    // --- The cash sweep is in the denominator, and that is load-bearing.
    //
    // wp3.7 §5's second row: a sweep is not a quote, it is face value, and a
    // reconciliation that valued only the *investable* positions would report a
    // $12,500.00 hole in an account that is in fact correct. Asserted as a
    // counterfactual so the clause cannot pass by accident.
    const taxable = await getAccountHoldings(accountIdOf.get('Taxable Brokerage') ?? '');
    const cash = taxable.positions.find((position) => position.symbol === 'CASH');
    expect(cash, 'the seeded cash sweep position').toBeDefined();
    expect(cash?.marketValue).toEqual({ minor: CASH_SWEEP_MINOR.toString(), currency: 'USD' });
    expect(cash?.stale, 'a sweep priced at face value is not stale').toBe(false);
    const withoutCash = taxable.positions
      .filter((position) => position.symbol !== 'CASH')
      .reduce(
        (total, position) =>
          position.marketValue === null ? total : total + BigInt(position.marketValue.minor),
        0n,
      );
    expect(BigInt(taxable.total.minor) - withoutCash).toBe(CASH_SWEEP_MINOR);

    // --- D4, asserted rather than assumed.
    //
    // The CAD account must not have been valued at par: CAD 7,080.00 counted as
    // USD 7,080.00 is precisely the "never" the §5 list names, and it would show
    // up here as a total of 708000 rather than of 0.
    const cad = await getAccountHoldings(accountIdOf.get('CAD Brokerage') ?? '');
    expect(cad.currency).toBe('USD');
    expect(cad.total.minor, 'a CAD position must not be counted as USD at 1.0').not.toBe('708000');
    expect(cad.total.minor).toBe('0');
    expect(cad.excluded.map((row) => row.symbol)).toEqual(['XIC']);
    // Gap 2 in the header: the position *is* priced, in CAD, and the reason the
    // wire gives for dropping it is nevertheless `price_unknown`, because the
    // reader filters by quote currency before the valuation's currency check
    // runs. Pinned as observed.
    expect(cad.excluded.map((row) => row.reason)).toEqual(['price_unknown']);
    const xic = cad.positions.find((position) => position.symbol === 'XIC');
    expect(xic?.marketValue, 'an unvaluable position reports null, never a zero').toBeNull();
    expect(xic?.quantity).toBe('200.000000000000000000');
  });

  it('a holding whose price is missing is reported as unreconciled, never silently reconciled', async () => {
    const bnd = dataset.securities.find((security) => security.symbol === 'BND');
    const securityId = securityIdOf.get(bnd?.id ?? '');
    expect(securityId, 'the seeded BND security').toBeDefined();
    if (securityId === undefined) return;

    // Before: the IRA reconciles to the cent. Establishing that first is what
    // makes the deletion below a control rather than a coincidence.
    const before = await reconcileByName('Rollover IRA');
    expect(before.verdict).toBe('reconciled');
    expect(before.differenceMinor).toBe(0n);

    // Every row, every date, every source: leaving one behind would let the
    // `last_known` rung answer and the position would stay priced.
    const saved = await h.database.db.execute<{
      id: string;
      price_date: string;
      source: string;
      close: string;
      currency: string;
      stale: boolean;
      observed_at: string;
    }>(sql`
      SELECT id::text AS id, price_date::text AS price_date, source, close::text AS close,
             currency, stale, observed_at::text AS observed_at
        FROM prices
       WHERE user_id = ${h.userId}::uuid AND security_id = ${securityId}::uuid
    `);
    expect(saved.rows.length).toBeGreaterThan(0);

    try {
      await h.database.db.execute(
        sql`DELETE FROM prices WHERE user_id = ${h.userId}::uuid AND security_id = ${securityId}::uuid`,
      );

      const holdings = await getAccountHoldings(accountIdOf.get('Rollover IRA') ?? '');
      const after = await reconcileByName('Rollover IRA');

      // 1. The account is flagged, and the flag names the security.
      expect(after.verdict).toBe('unreconciled');
      expect(after.reason).toBe('unpriced_position_excluded');
      expect(after.namedSecurities).toEqual(['BND']);
      expect(holdings.excluded).toEqual([
        {
          holdingId: expect.any(String) as unknown as string,
          symbol: 'BND',
          reason: 'price_unknown',
        },
      ]);

      // 2. The position reports `null`, not a zero. A zero would be a valuation
      //    this system never made, and it would reconcile the account down to a
      //    $7,150.00 difference with nothing named — 04 §5.5's shape, applied to
      //    price rather than to basis.
      const position = holdings.positions.find((row) => row.symbol === 'BND');
      expect(position, 'the BND position is still reported, unpriced').toBeDefined();
      expect(position?.marketValue).toBeNull();
      expect(position?.price).toBeNull();
      expect(position?.stale).toBe(true);

      // 3. It was not silently reconciled: the balance still says $7,471.00, the
      //    valued Σ is $321.00, and the whole of the difference is the missing
      //    position's own $7,150.00 — accounted for, by name.
      expect(after.balance).toEqual({ minor: '747100', currency: 'USD' });
      expect(after.sum).toEqual({ minor: '32100', currency: 'USD' });
      expect(after.differenceMinor).toBe(715_000n);
      expect(after.differenceMinor).not.toBe(0n);
    } finally {
      for (const row of saved.rows) {
        await h.database.db.execute(sql`
          INSERT INTO prices (id, user_id, security_id, price_date, source, close, currency, stale, observed_at)
          VALUES (${row.id}::uuid, ${h.userId}::uuid, ${securityId}::uuid, ${row.price_date}::date,
                  ${row.source}, ${row.close}, ${row.currency}, ${row.stale},
                  ${row.observed_at}::timestamptz)
          ON CONFLICT DO NOTHING
        `);
      }
    }

    // And the restore really restored: the same account reconciles again, which
    // is also what keeps this test from poisoning anything that runs after it.
    const restored = await reconcileByName('Rollover IRA');
    expect(restored.verdict).toBe('reconciled');
    expect(restored.reason).toBe('exact');
    expect(restored.differenceMinor).toBe(0n);
  });
});
