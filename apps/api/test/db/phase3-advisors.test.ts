// SPDX-License-Identifier: MIT
/**
 * WP 3.10a — the four snapshot readers, driven over a real database by the real
 * adapters, and a real advisor run on top of them.
 *
 * ## What this suite is for, and what the unit suite beside it cannot do
 *
 * `packages/contexts/insights/test/snapshot-arms.test.ts` proves the four
 * `#blockFor` arms behave, over in-memory ports typed against the interface.
 * That is the arm's test and it is not this one. **Nothing in the context can
 * prove the adapters in `apps/api/src/domain.ts` produce those types from real
 * rows** — a port implementation is only correct relative to a database, and
 * this repository's whole Phase 2 argument is that an advisor reading a block
 * nobody could fill is worse than an advisor reading nothing.
 *
 * So everything below goes through `createInsightsInvestmentsPort` and
 * `createInsightsMarketDataPort` against real tables:
 *
 *   * the accounts are linked over HTTP through `POST /connections`;
 *   * `securities`, `holdings` and `prices` are seeded with SQL, for the reason
 *     `investments-routes.test.ts`' header states at length — at this commit the
 *     only writer is WP 3.7's Plaid sync, and a second fake sync here would be a
 *     fixture asserting against itself. The rows are the ones the real writers
 *     write: a decimal-string quantity, a `NULL` basis where the basis is
 *     genuinely unknown, and a `prices.source` that is an observation;
 *   * the FRED adapter is the **real** `createFredSource`, over a fake
 *     transport. The only double in the chain is the socket, which is this
 *     repository's standing convention for a provider leg — and it is what lets
 *     the last test assert the licence sentence arrives verbatim from
 *     `ATTRIBUTIONS.fred.text` rather than from a literal a test wrote down.
 *
 * ## The finding this suite exists to record
 *
 * Three investing rules ship enabled and **cannot fire in this deployment**,
 * and not for a reason any scope flag expresses: `holdings.aggregate` has a
 * reader, but three of its fields have no source behind them —
 * `createInsightsInvestmentsPort` hardcodes `targets: []`, `idleCash: null` and
 * `employerStock: false`, each with a comment naming what is missing (there is
 * no `allocation_targets` table — `wp3.9-routes.md` §8 finding 1 — no dwell
 * history, and no employer-tag column). So I1, I3 and I5 are enabled, correct,
 * and structurally silent.
 *
 * `'the investing rules with no field behind them are silent, and it is these
 * three'` pinned that. It was deliberately an assertion about *silence*, which
 * is the hardest kind of claim to keep honest, so it was paired with the test
 * above it proving the same run is **not** silent for I4 — otherwise a broken
 * port would pass it for the wrong reason.
 *
 * ## WP 4.7 — the silence test, re-derived, then re-derived again
 *
 * `allocation_targets`, `security_tags` and idle-cash dwell now exist
 * (`packages/contexts/investments/src/{targets,tags,dwell}.ts`, migration
 * `0026_allocation_targets.sql`). WP 4.7 could not own `apps/api/src/domain.ts`,
 * so its own evidence (`docs/evidence/phase-4/wp4.7-gap-fields.md` §7.1)
 * specified the composition and this file drove the real advisor rules against
 * a **decorated** port — the real `createInsightsInvestmentsPort` result with
 * its three gap fields replaced by a test-local `wrapWithGapFieldSources`,
 * exactly so a rule could be shown firing on the reader before the wiring
 * batch that owns `domain.ts` existed.
 *
 * **The Wave B wiring batch composed the identical thing in `domain.ts`**
 * (targets and employer tags from `@ctx/investments`' new stores; idle cash
 * from this context's own `cashSnapshotHistory`/`cashPositionFor` plus
 * `@ctx/planning`'s `liveEarmarksByAccount`, both read only here at the
 * composition root). `wrapWithGapFieldSources` is retired: `'I1, I3 and I5 now
 * fire on the seed, and the rules with no field behind them are exactly the
 * ones still named'` below calls `createInsightsInvestmentsPort` directly, with
 * no decoration, so it is now a proof about production and not about a
 * stand-in for it — the thing WP 4.7's own evidence named as the point where
 * the decoration "becomes redundant with production."
 */
import {
  ATTRIBUTIONS,
  apiKeyOf,
  createFakeTransport,
  createFredSource,
  createProviderClient,
  jsonResponse,
  policyFor,
} from '@ctx/integrations';
import { DateOnly, money, newId, systemClock } from '@core/kernel';
import {
  SnapshotBuilder,
  createBuiltinRegistry,
  deriveTokenKey,
  grantScopes,
  isSnapshotRef,
  listInsights,
  parsePath,
  runAdvisors,
  type InsightsDependencies,
} from '@ctx/insights';
import { drizzleAllocationTargetsStore, drizzleSecurityTagsStore } from '@ctx/investments';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInsightsBudgetPort,
  createInsightsInvestmentsPort,
  createInsightsLedgerPort,
  createInsightsMarketDataPort,
  createInsightsRecurringPort,
} from '../../src/domain.ts';
import {
  NO_DATABASE,
  createApiHarness,
  linkManual,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const DAY_MS = 86_400_000;
const TOKEN_SECRET = 'wp-3-10a-advisors-test-secret'; // gitleaks:allow — synthetic advisor-token secret for a test harness

/** Synthetic, and never on a wire that leaves the process. */
const FRED_KEY = 'fredkey_0a1b2c3d4e5f60718293a4b5c6d7e8f9'; // gitleaks:allow — synthetic fixture

/**
 * The two scopes `snapshot_grants_scope_check` will not store a grant for.
 *
 * WP 3.10 added `liabilities.terms` and `market.rates` to `SCOPE_CATALOGUE`;
 * migration `0012_insights.sql` still enumerates only Phase 2's thirteen. The
 * constraint rejects the insert outright, so this is not a silent degradation —
 * it is a `23514` in the face of whoever wires consent. Owed a migration in
 * `packages/db` (not WP 3.10a's to write).
 */
// Empty since migration 0019 widened `snapshot_grants_scope_check` to contract 1.1.0's scopes;
// kept as the seam the next contract minor would use, pinned by the registration test.
const UNGRANTABLE_SCOPES: readonly string[] = [];
const PUBLIC_IP = () => Promise.resolve(['93.184.216.34']);

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

describe.skipIf(NO_DATABASE)('the nightly advisor run over a synced portfolio (WP 3.10a)', () => {
  let h: ApiHarness;
  let brokerageAccountId: string;
  let cardAccountId: string;
  let vtiSecurityId: string;

  /**
   * A `securities` row, written the way `SecurityResolver` writes one.
   *
   * `expense_ratio` is 0.95%, above `HIGH_EXPENSE_RATIO` (0.5%), because I2's
   * *relative* trigger cannot fire here at all: no comparable-fund table exists
   * in any Phase 3 source, so the adapter sets `peerExpenseRatio: null` and the
   * absolute trigger is the only one a real portfolio can reach.
   */
  async function insertSecurity(input: {
    readonly ticker: string;
    readonly name: string;
    readonly type: string;
    readonly assetClass: string;
    readonly expenseRatio: string | null;
  }): Promise<string> {
    const id = newId();
    await h.database.db.execute(sql`
      INSERT INTO securities (
        id, user_id, identity_kind, identity_key, ticker, name, type, currency,
        is_cash_equivalent, asset_class, region, sector, expense_ratio,
        classification_source, classification_depth, classification_flagged
      ) VALUES (
        ${id}::uuid, ${h.userId}::uuid, 'ticker',
        ${`ticker:${input.ticker}:${h.userId.slice(0, 8)}`},
        ${input.ticker}, ${input.name}, ${input.type}, 'USD', false,
        ${input.assetClass}, 'US', 'BROAD', ${input.expenseRatio},
        'LOCAL_SEED_TABLE', 0, false
      )
    `);
    return id;
  }

  async function insertHolding(input: {
    readonly accountId: string;
    readonly securityId: string;
    readonly quantity: string;
    readonly costBasisMinor: bigint | null;
    readonly institutionValueMinor: bigint;
  }): Promise<void> {
    await h.database.db.execute(sql`
      INSERT INTO holdings (
        id, user_id, account_id, security_id, quantity, institution_value_minor, currency,
        cost_basis_minor, cost_basis_is_user_supplied, cost_basis_source, as_of_date
      ) VALUES (
        ${newId()}::uuid, ${h.userId}::uuid, ${input.accountId}::uuid,
        ${input.securityId}::uuid, ${input.quantity}, ${input.institutionValueMinor}, 'USD',
        ${input.costBasisMinor}, false,
        ${input.costBasisMinor === null ? 'ESTIMATED' : 'BROKER'}, ${isoDay(0)}::date
      )
    `);
  }

  async function insertPrice(input: {
    readonly securityId: string;
    readonly close: string;
  }): Promise<void> {
    await h.database.db.execute(sql`
      INSERT INTO prices (
        id, user_id, security_id, price_date, source, close, currency, stale, observed_at
      ) VALUES (
        ${newId()}::uuid, ${h.userId}::uuid, ${input.securityId}::uuid,
        ${isoDay(0)}::date, 'tiingo', ${input.close}, 'USD', false, now()
      )
    `);
  }

  /**
   * A `holdings_snapshots` row, for WP 4.7's dwell reader — the history
   * `cashSnapshotHistory` reads to derive `idleDays`, exactly as it would in
   * production. `offsetDays` is negative for the past; `0` is today.
   */
  async function insertHoldingsSnapshot(input: {
    readonly accountId: string;
    readonly securityId: string;
    readonly offsetDays: number;
    readonly quantity: string;
    readonly institutionValueMinor: bigint;
  }): Promise<void> {
    await h.database.db.execute(sql`
      INSERT INTO holdings_snapshots (
        id, user_id, account_id, security_id, as_of_date, quantity, institution_value_minor, currency
      ) VALUES (
        ${newId()}::uuid, ${h.userId}::uuid, ${input.accountId}::uuid, ${input.securityId}::uuid,
        ${isoDay(input.offsetDays)}::date, ${input.quantity}, ${input.institutionValueMinor}, 'USD'
      )
    `);
  }

  /**
   * The real FRED adapter over a fake socket.
   *
   * `createInsightsMarketDataPort` takes a `FredSource`, and the one thing this
   * suite wants to prove about it is that the licence sentence it carries is
   * `ATTRIBUTIONS.fred.text` and not a string somebody retyped. A hand-rolled
   * stub implementing the interface would carry whatever *this file* said,
   * which would make the assertion circular.
   */
  function fredPort(): ReturnType<typeof createInsightsMarketDataPort> {
    const key = apiKeyOf('fred', FRED_KEY);
    // A distinct figure per series, so the `series_id → MarketRateKind`
    // mapping is actually proven: five series all answering `4.31` would make
    // a mis-joined kind invisible.
    const published: Readonly<Record<string, string>> = {
      DGS3MO: '5.12',
      DGS10: '4.31',
      SNDR: '3.75',
      TERMCBCCALLNS: '21.47',
      MORTGAGE30US: '6.34',
    };
    const transport = createFakeTransport((request) => {
      // One observation per series, dated today, published in percent.
      const seriesId = /series_id=([A-Z0-9]+)/u.exec(request.destination.path)?.[1] ?? 'DGS3MO';
      return jsonResponse({
        observations: [{ date: isoDay(0), value: published[seriesId] ?? '1.00' }],
      });
    });
    return createInsightsMarketDataPort({
      source: createFredSource({
        client: createProviderClient({
          provider: 'fred',
          policy: policyFor('fred'),
          transport: transport.transport,
          resolve: PUBLIC_IP,
          keys: [key],
        }),
        key,
        now: () => new Date(),
      }),
    });
  }

  function dependenciesOf(options: { readonly withFred: boolean }): InsightsDependencies {
    return {
      registry: createBuiltinRegistry(),
      ports: {
        ledger: createInsightsLedgerPort(h.database.db, systemClock),
        budget: createInsightsBudgetPort(h.database.db),
        recurring: createInsightsRecurringPort(h.database.db),
        // The real ones. This is the line the whole suite exists for.
        investments: createInsightsInvestmentsPort(h.database.db, systemClock),
        marketData: options.withFred
          ? fredPort()
          : createInsightsMarketDataPort({ source: undefined }),
      },
      settings: {
        advisorsEnabled: true,
        moduleEnabled: true,
        timeZone: 'UTC',
        baseCurrency: 'USD',
        tokenSecret: TOKEN_SECRET,
      },
    };
  }

  /** One snapshot, built by the real builder over the real ports. */
  async function snapshotOf(
    grantedScopes: readonly string[],
    options: { readonly withFred: boolean } = { withFred: false },
  ) {
    const dependencies = dependenciesOf(options);
    return new SnapshotBuilder(dependencies.ports).build({
      userId: h.userId,
      kind: 'builtin',
      grantedScopes: grantedScopes as never,
      today: DateOnly.parse(isoDay(0)),
      baseCurrency: 'USD',
      // The same derivation the service performs, so a `liability_ref` this
      // suite renders is the one a real run would mint.
      tokenKey: deriveTokenKey(TOKEN_SECRET, h.userId),
    });
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp310a-adv' });

    const linked = await linkManual(h, {
      providerConnectionId: 'wp310a-brokerage',
      displayName: 'Northwind Brokerage',
      accounts: [
        {
          providerAccountId: 'wp310a-taxable',
          name: 'Taxable Brokerage',
          type: 'investment',
          currency: 'USD',
        },
        // A liability, so `liabilities.terms` renders from the real adapter
        // too. It carries a balance and **no terms row**, which is the state
        // `createInsightsInvestmentsPort` documents at length: an account with
        // no `connection_sync_facts` liability fact is still a liability — it
        // owes money — and crosses with every term `null` rather than with a
        // fabricated APR. That is the shape D2 and D4 gate on, so it is the
        // shape worth rendering into the evidence.
        {
          providerAccountId: 'wp310a-card',
          name: 'Rewards Card',
          type: 'credit',
          currency: 'USD',
        },
      ],
      batch: {
        balances: [
          {
            providerAccountId: 'wp310a-card',
            // Negative in the ledger's sign convention; the block must state
            // what is *owed*, as a positive figure.
            current: money(-482_000n, 'USD'),
            available: null,
            limit: null,
            asOf: systemClock.now(),
          },
        ],
      },
    });
    brokerageAccountId = linked.accountIds[0] as string;
    cardAccountId = linked.accountIds[1] as string;

    // One position, the whole investable portfolio. Weight 1.0 is past I4's
    // 20% concentration threshold by a distance no rounding could close, which
    // is what makes the assertion about I4 a statement about the port rather
    // than about a boundary.
    vtiSecurityId = await insertSecurity({
      ticker: 'VTI',
      name: 'Vanguard Total Stock Market ETF',
      type: 'etf',
      assetClass: 'US_EQUITY',
      expenseRatio: '0.009500',
    });
    await insertHolding({
      accountId: brokerageAccountId,
      securityId: vtiSecurityId,
      quantity: '100.000000000000000000',
      costBasisMinor: 1_500_000n,
      institutionValueMinor: 2_500_000n,
    });
    await insertPrice({ securityId: vtiSecurityId, close: '250.00' });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  it('the nightly advisor run over a synced portfolio proposes an investing insight with resolvable evidence', async () => {
    const dependencies = dependenciesOf({ withFred: false });
    const context = {
      userId: h.userId,
      clock: systemClock,
      correlationId: newId(),
      causationId: null,
    };

    // The grants the nightly run would find. No consent route exists yet
    // (wp2.6-insights.md §6), so a test writes them the way
    // `registerBuiltinAdvisors` writes the advisor rows — through the context's
    // own store function, not raw SQL.
    //
    // **Filtered, and the filter is a defect this suite found.** `grantScopes`
    // is rejected by `snapshot_grants_scope_check` for `liabilities.terms` and
    // `market.rates`: migration `0012_insights.sql` enumerates the thirteen
    // Phase 2 scopes and WP 3.10 added two more to the catalogue without a
    // migration, so no user can be granted either one. That is owed a
    // migration in `packages/db`, which WP 3.10a does not own; it is pinned by
    // `'every advisor scope can actually be granted'` in
    // `apps/api/test/phase3-registration.test.ts` so it cannot be forgotten,
    // and named in `wp3.10a-snapshot-readers.md` §7.
    for (const entry of dependencies.registry.scheduled()) {
      const scopes = entry.manifest.requires_scopes.filter(
        (scope) => !UNGRANTABLE_SCOPES.includes(scope as string),
      );
      if (scopes.length === 0) continue;
      await grantScopes(h.database.db, context, entry.manifest.advisor_id, [...scopes]);
    }

    // The nightly fan-out: every scheduled advisor, trigger `schedule`. This is
    // the same list `createRunAllJob` enqueues one `insights.run` per.
    const results = await runAdvisors(h.database.db, context, dependencies, {
      advisorIds: dependencies.registry.scheduled().map((entry) => entry.manifest.advisor_id),
      trigger: 'schedule',
    });

    const concentration = results.find(
      (result) => result.advisorId === 'builtin.investing.concentration',
    );
    // `refused` would mean the advisor row is disabled or unregistered — which
    // is what WP 3.10a's catalogue change is — so assert the status, not just
    // the count. A disabled rule proposes zero and that is not the same fact.
    expect(concentration?.status, 'I4 must actually run, not be refused').toBe('completed');
    expect(concentration?.proposed, 'I4 must propose over a single-position portfolio').toBe(1);
    expect(concentration?.emittedScopes).toContain('holdings.aggregate');

    const proposed = await listInsights(h.database.db, {
      userId: h.userId,
      advisorIds: ['builtin.investing.concentration'],
      now: systemClock.now(),
    });
    expect(proposed).toHaveLength(1);
    const insight = proposed[0];
    expect(insight?.key).toBe('investing.concentration.VTI');

    // --- the evidence, and what "resolvable" means here ------------------
    //
    // The pipeline rejects an insight outright when a `snapshot:` ref does not
    // resolve, so a persisted row is already evidence that it did. That makes
    // the *existence* of these rows the proof and the assertions below the
    // description of it: every ref points into the snapshot, every path parses,
    // and every one carries the display the resolver read back out of the real
    // block — which is the thing a reviewer actually sees.
    const evidence = insight?.evidence ?? [];
    expect(evidence.length, 'an insight with no evidence is a claim').toBeGreaterThan(0);
    for (const row of evidence) {
      expect(row.sourceRef, `${insight?.key} has an evidence row with no ref`).not.toBeNull();
      const ref = row.sourceRef as string;
      expect(isSnapshotRef(ref), ref).toBe(true);
      expect(parsePath(ref.slice('snapshot:'.length)), ref).not.toBeNull();
      expect(row.resolvedDisplay, `${ref} resolved to nothing`).not.toBeNull();
    }
    // And they point at the block this work package landed, not at a Phase 2
    // one that happened to be granted too.
    expect(
      evidence.some((row) => (row.sourceRef ?? '').startsWith('snapshot:holdings_aggregate.')),
      'I4 must cite the block WP 3.10a landed',
    ).toBe(true);
  }, 180_000);

  it('the real ports render every new scope, and no identifier crosses', async () => {
    const built = await snapshotOf(
      ['holdings.aggregate', 'holdings.detail', 'liabilities.terms', 'market.rates'],
      { withFred: true },
    );

    // All four render, each from its real adapter over real rows.
    expect(Object.keys(built.snapshot).sort()).toEqual([
      'holdings_aggregate',
      'holdings_detail',
      'liabilities_terms',
      'market_rates',
    ]);

    // The liability crosses as a token and a positive amount owed, with every
    // term `null` because no `connection_sync_facts` liability fact exists for
    // it — read, never faked.
    const liability = (
      built.snapshot.liabilities_terms as {
        liabilities: readonly {
          liability_ref: string;
          kind: string;
          apr: number | null;
          current_balance: { minor: string };
        }[];
      }
    ).liabilities[0];
    expect(liability?.kind).toBe('credit_card');
    expect(liability?.apr).toBeNull();
    expect(liability?.current_balance.minor).toBe('482000');
    expect(liability?.liability_ref).not.toContain(cardAccountId);

    // Nothing that identifies a row, an account or a security crosses. Asserted
    // against the serialised snapshot rather than field by field: a leak added
    // to a type this test does not import is still a leak.
    const json = JSON.stringify(built.snapshot);
    expect(json).toContain('VTI');
    for (const identifier of [vtiSecurityId, brokerageAccountId, cardAccountId, h.userId]) {
      expect(json, `${identifier} crossed into the snapshot`).not.toContain(identifier);
    }
    expect(json).not.toContain('security_id');
    expect(json).not.toContain('account_id');
    // A uuid in any position at all. The three above are the ones this fixture
    // knows the value of; this catches a fourth nobody thought to name.
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu);
  }, 180_000);

  it('I1, I3 and I5 now fire on the seed, and the rules with no field behind them are exactly the ones still named', async () => {
    // The three sources WP 4.7 adds, seeded exactly the way a holder would set
    // them: a complete target set (VTI is 100% of investable assets, so a
    // 60/40 target drifts by 40pp — nowhere near the 5pp band), an
    // employer-stock tag on the one security this portfolio holds, and a cash
    // position that has sat above its threshold for longer than a fortnight
    // with nothing earmarked against it.
    await drizzleAllocationTargetsStore(h.database.db, systemClock).replaceAll(h.userId, [
      { assetClass: 'US_EQUITY', targetWeight: '0.60' },
      { assetClass: 'US_BOND', targetWeight: '0.40' },
    ]);
    await drizzleSecurityTagsStore(h.database.db, systemClock).set(
      h.userId,
      vtiSecurityId,
      'employer_stock',
    );
    const cashSecurityId = await insertSecurity({
      ticker: 'CASH-SWEEP',
      name: 'Brokerage cash sweep',
      type: 'cash',
      assetClass: 'CASH',
      expenseRatio: null,
    });
    await insertPrice({ securityId: cashSecurityId, close: '1.00' });
    // A live `holdings` row too, not only history: the real composition
    // (apps/api/src/domain.ts, WP 4.7 §7.1) derives today's cash from
    // `cashByAccount(set)` over the same valued live holdings `readHoldings`
    // returns — `holdings_snapshots` alone feeds the *dwell* history
    // (`cashSnapshotHistory` / `idleDaysOf`), never today's balance.
    await insertHolding({
      accountId: brokerageAccountId,
      securityId: cashSecurityId,
      quantity: '12000.000000000000000000',
      costBasisMinor: null,
      institutionValueMinor: 1_200_000n,
    });
    for (const offsetDays of [-20, -10, 0]) {
      await insertHoldingsSnapshot({
        accountId: brokerageAccountId,
        securityId: cashSecurityId,
        offsetDays,
        quantity: '12000.000000000000000000',
        institutionValueMinor: 1_200_000n,
      });
    }

    // Wave B's wiring batch composed WP 4.7's dwell + earmark reads (and its
    // targets/tags stores) straight into `createInsightsInvestmentsPort`
    // (apps/api/src/domain.ts) — the identical composition this suite used to
    // apply here as `wrapWithGapFieldSources`, now retired: `dependenciesOf`
    // builds the *real* port and this test runs it directly, so this is now
    // a proof about production rather than about a stand-in for it.
    const dependencies: InsightsDependencies = dependenciesOf({ withFred: true });

    const context = {
      userId: h.userId,
      clock: systemClock,
      correlationId: newId(),
      causationId: null,
    };
    const investing = dependencies.registry
      .scheduled()
      .filter((entry) => entry.manifest.advisor_id.startsWith('builtin.investing.'));
    for (const entry of investing) {
      // The investing family reads no ungrantable scope, so this loop needs no
      // filter — which is itself worth stating: the gap above is the debt and
      // crypto families' problem, not this one's.
      await grantScopes(h.database.db, context, entry.manifest.advisor_id, [
        ...entry.manifest.requires_scopes,
      ]);
    }

    const results = await runAdvisors(h.database.db, context, dependencies, {
      advisorIds: investing.map((entry) => entry.manifest.advisor_id),
      trigger: 'schedule',
    });
    const proposedBy = new Map(results.map((result) => [result.advisorId, result]));

    // Every one of them *ran*. Silence here is a rule deciding it has nothing
    // to say, never a rule that was refused or errored — which is a different
    // fact and would make the claims below meaningless.
    for (const result of results) expect(result.status, result.advisorId).toBe('completed');

    /**
     * The three WP 4.7 gave a source. Each now fires — the day-one silence
     * `wp3.10a-snapshot-readers.md` §7.2 measured is over.
     */
    const nowFiring = [
      'builtin.investing.drift', // I1 — allocation_targets
      'builtin.investing.idle_cash', // I3 — dwell + earmark composition
      'builtin.investing.employer_stock', // I5 — security_tags
    ];
    for (const advisorId of nowFiring) {
      expect(proposedBy.get(advisorId)?.proposed, `${advisorId} should now fire`).toBeGreaterThan(
        0,
      );
    }

    // The control, preserved: I4 and I2 fired before this work package and
    // must still fire on the same run, unaffected by the decoration above —
    // otherwise this test would prove nothing about the three it names.
    expect(proposedBy.get('builtin.investing.concentration')?.proposed).toBeGreaterThan(0);
    expect(proposedBy.get('builtin.investing.expense_ratio')?.proposed).toBeGreaterThan(0);

    // And the decoration touches exactly `targets`, `idleCash` and
    // `employerStock` — I6 needs no new field and fires on nothing here
    // (VTI's lot is a gain, not a loss), which the decoration did not change.
    expect(proposedBy.get('builtin.investing.loss_lot')?.proposed ?? 0).toBe(0);
  }, 180_000);

  it('market.rates carries the FRED licence sentence verbatim, from the constant', async () => {
    const built = await snapshotOf(['market.rates'], { withFred: true });
    const block = built.snapshot.market_rates as {
      attribution: string;
      attribution_url: string | null;
      rates: readonly { kind: string; rate: number; units: string; stale: boolean }[];
    };

    // Compared against the context's own constant, not against a literal this
    // file wrote down. 01 §4.3 makes the sentence a licence condition and a
    // paraphrase of a licence condition is a new licence condition.
    expect(block.attribution).toBe(ATTRIBUTIONS.fred.text);
    expect(block.attribution).toContain('®');
    expect(block.attribution_url).toBe(ATTRIBUTIONS.fred.linkUrl);

    // And the conversion the builder owns, over a figure that really came off
    // the (faked) wire as the string "5.12" in percent.
    const short = block.rates.find((row) => row.kind === 'short_term_risk_free');
    expect(short?.rate).toBe(0.0512);
    expect(short?.units).toBe('percent_per_annum');
    expect(short?.stale).toBe(false);

    // The `kind` join, proven by the figures rather than asserted: each series
    // published a different number, so a mis-joined kind shows up as the wrong
    // rate rather than as nothing at all. A rule selects by `kind` and never by
    // `series_id`, which is the whole reason this mapping lives in the adapter.
    expect(block.rates.find((row) => row.kind === 'credit_card_apr')?.rate).toBe(0.2147);
    expect(block.rates.find((row) => row.kind === 'mortgage_30y')?.rate).toBe(0.0634);
  }, 180_000);
});
