// SPDX-License-Identifier: MIT
/**
 * Phase 3 gate C-7 (G3-7, MEDIUM; `docs/evidence/phase-3/gate-security-review.md`
 * §3.8, §6): the export bundle carried **no** Phase 3 table — `securities`,
 * `holdings`, `investment_transactions`, `cost_basis_lots`,
 * `basis_method_elections` (the sticky `AVERAGE_COST` tax election),
 * `price_source_priority`, `net_worth_daily` (the registry's own words: "a
 * recomputation cannot rebuild" a sealed day) or `wallet_addresses` — so an
 * export → import round trip at the Phase 3 close lost the entire portfolio
 * and every sealed net-worth day. `apps/api/src/reports/export/registry.ts`'s
 * `EXEMPT_TABLES` carried each as a *deferral*, named "exported with
 * holdings/lots by WP 3.7" or "by WP 4.12" — reasons that were never true
 * until this condition. WP 4.12b moves them (and the Phase 4 planning tables
 * `goals`, `goal_contributions`, `risk_profile`, `cash_earmarks`,
 * `plan_assumptions`, `plan_scenarios`, `plan_life_events`, `projection_runs`,
 * `projection_percentiles`) from `EXEMPT_TABLES` into `TABLE_ORDER`.
 *
 * `apps/api/test/db/export-import.test.ts` (WP 2.8) already proves the
 * generic round trip and `assertRegistryIsComplete` over its own fixture,
 * which seeds none of this batch — every one of these tables would report 0
 * rows there, and a round trip of nothing proves nothing. This file seeds one
 * row (or a small, meaningful set) in every table this condition names, and
 * is why the two tests the condition asks for by name are here rather than
 * as more rows in that file: `'net_worth_daily round-trips with its
 * correction provenance intact'` needs a two-revision correction chain, and
 * `'a full export round-trips the plan — goals, assumptions, scenarios and
 * runs — into a clean instance'` needs the planning batch's cross-table
 * composite foreign keys (`goal_contributions`/`cash_earmarks` -> `goals`,
 * `projection_runs` -> `plan_scenarios`, `projection_percentiles` ->
 * `projection_runs`) actually exercised, not merely declared.
 *
 * Every row below is inserted with plain SQL against the harness's own pool —
 * the same seeding shape `export-import.test.ts`'s `seedFakeCredential` uses
 * — because there is no Drizzle definition for `wallet_addresses` at all (it
 * lives only in `packages/db/migrations/0016_wallet_addresses.sql`; see
 * `packages/connectors/walletrpc/OWNERSHIP.md`), and using raw SQL for every
 * table keeps every constraint this file leans on (the `sha256:` shapes, the
 * well-formed-JSON functions, the composite FKs) visibly satisfied in one
 * place rather than split between Drizzle inserts and raw ones.
 *
 * `importBundle` preserves every row's `id` verbatim (only `user_id` is
 * rewritten) and `fetchStream` orders each table `ORDER BY id`, and every id
 * here is a `newId()` (`uuidv7`, time-ordered) — so a later row's
 * self/composite reference to an earlier one (`net_worth_daily.supersedes_id`,
 * `plan_scenarios.baseline_id` were it a fork) inserts in the correct order
 * automatically, the same property `registry.ts`'s own header now documents.
 */
import { money, newId, systemClock } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildExportBundle,
  parseAndVerifyBundle,
  serialiseBundle,
} from '../../src/reports/export/bundle.ts';
import { computeNetWorth, correctDay, createEarmark, sealDay, upsertOpenDay } from '@ctx/planning';
import { importBundle } from '../../src/reports/export/import.ts';
import { assertRegistryIsComplete } from '../../src/reports/export/registry.ts';
import { planningPortsFor } from '../../src/domain.ts';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const describeWithDb = describe.skipIf(NO_DATABASE);

describeWithDb('export/import — the Phase 3 + Phase 4 tables (Phase 3 gate C-7)', () => {
  let h: ApiHarness;
  const cleanDatabases: TestDatabase[] = [];

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp412bc7v2' });
  });

  afterEach(async () => {
    while (cleanDatabases.length > 0) {
      const db = cleanDatabases.pop();
      if (db !== undefined) await db.drop();
    }
  });

  it('every user-scoped table appears in the manifest (no deferrals left for this batch)', async () => {
    const result = await assertRegistryIsComplete(h.database.pool);
    expect(result.missing).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('net_worth_daily round-trips with its correction provenance intact', async () => {
    // G9-15 (C9-9): both revisions are written by the production snapshot path —
    // `computeNetWorth` → `upsertOpenDay` → `sealDay` for the original day, then
    // `correctDay` (what `POST /net-worth/corrections` calls) for the correction —
    // over a balance that arrived through a linked manual connection. The earlier
    // hand-written revision 2 was left unsealed (`sealed_at NULL`), a row
    // `writeCorrection` never produces: it inserts every correction already sealed.
    const linked = await linkManual(h, {
      providerConnectionId: 'c9-nwd-roundtrip',
      displayName: 'Net-worth round-trip bank',
      accounts: [
        {
          providerAccountId: 'c9-nwd-checking',
          name: 'Checking',
          type: 'depository',
          currency: 'USD',
        },
      ],
      batch: {
        balances: [
          {
            providerAccountId: 'c9-nwd-checking',
            current: money(500_000n, 'USD'),
            available: null,
            limit: null,
            asOf: new Date('2025-12-30T00:00:00Z'),
          },
        ],
      },
    });
    expect(linked.accountIds).toHaveLength(1);
    const asOfDate = '2026-01-01';
    const ports = planningPortsFor(h.database.db, {
      userId: h.userId,
      timeZone: 'UTC',
      clock: systemClock,
    });
    const snapshot = await computeNetWorth(ports, {
      userId: h.userId,
      asOfDate,
      baseCurrency: 'USD',
    });
    await upsertOpenDay(h.database.db, { userId: h.userId, snapshot, clock: systemClock });
    await sealDay(h.database.db, { userId: h.userId, asOfDate, clock: systemClock });
    // A later balance observation (an FX/valuation fix, say) is what a holder
    // corrects the sealed day for.
    await correctDay(
      h.database.db,
      ports,
      {
        userId: h.userId,
        clock: systemClock,
        timeZone: 'UTC',
        baseCurrency: 'USD',
        correlationId: newId(),
      },
      { asOfDate, reason: 'a missed FX rate was backfilled' },
    );
    const source = (
      await h.database.pool.query<{
        id: string;
        revision: number;
        source: string;
        supersedes_id: string | null;
        net_worth_minor: string;
        sealed_at: Date | null;
      }>(
        `SELECT id, revision, source, supersedes_id, net_worth_minor, sealed_at
         FROM net_worth_daily WHERE user_id = $1 ORDER BY revision`,
        [h.userId],
      )
    ).rows;
    expect(source.map((row) => row.revision)).toEqual([1, 2]);
    const revision1Id = source[0]!.id;
    const revision2Id = source[1]!.id;

    const bundle = await buildExportBundle(h.database.pool, {
      userId: h.userId,
      appVersion: 'test',
      now: new Date('2026-01-02T00:00:00Z'),
    });
    const parsed = parseAndVerifyBundle(serialiseBundle(bundle));
    const netWorthStream = bundle.manifest.streams.find((s) => s.table === 'net_worth_daily');
    expect(netWorthStream?.count).toBe(2);

    const clean = await createTestDatabase(
      `personalfi_wp412b_c7_nwd_${newId().replaceAll('-', '')}`,
    );
    cleanDatabases.push(clean);
    await importBundle(clean.pool, parsed, clean.userId);

    const rows = await clean.pool.query<{
      id: string;
      revision: number;
      source: string;
      supersedes_id: string | null;
      correction_reason: string | null;
      net_worth_minor: bigint;
      sealed_at: Date | null;
    }>(
      `SELECT id, revision, source, supersedes_id, correction_reason, net_worth_minor, sealed_at
       FROM net_worth_daily WHERE user_id = $1 ORDER BY revision`,
      [clean.userId],
    );
    expect(rows.rows).toHaveLength(2);

    const [imported1, imported2] = rows.rows;
    expect(imported1?.id).toBe(revision1Id); // ids are preserved verbatim by importBundle
    // The provenance the production path stamped (a balance carried forward is
    // `interpolated`, honestly), kept verbatim.
    expect(imported1?.source).toBe(source[0]!.source);
    expect(imported1?.supersedes_id).toBeNull();
    expect(imported1?.sealed_at).not.toBeNull();

    expect(imported2?.id).toBe(revision2Id);
    expect(imported2?.revision).toBe(2);
    expect(imported2?.source).toBe('corrected');
    // The provenance: which revision this one replaces, and why — both must
    // survive the round trip, and the self-reference must resolve to the
    // *imported* revision 1's row (same id, verbatim), not to nothing.
    expect(imported2?.supersedes_id).toBe(revision1Id);
    expect(imported2?.correction_reason).toBe('a missed FX rate was backfilled');
    expect(imported2?.net_worth_minor).toBe(BigInt(source[1]!.net_worth_minor));
    // `writeCorrection` inserts a correction already sealed; the round trip keeps it so.
    expect(imported2?.sealed_at).not.toBeNull();
  });

  it('a full export round-trips the plan — goals, assumptions, scenarios and runs — into a clean instance', async () => {
    // Every plan row below is written by the production writer the holder's own
    // action goes through (G9-15, C9-9; the class WP 9.11's O-11 re-validation
    // exposed twice, `953074a` and `34647d6`): the routes for goals,
    // contributions, the questionnaire, overrides, the baseline, life events and
    // the projection, and `@ctx/planning`'s `createEarmark` (no earmark route
    // exists yet). Nothing here is a row hand-written by SQL, so nothing is a
    // document the production code would never have stored, and O-11's
    // re-validation on import runs over rows the routes themselves wrote.
    const linked = await linkManual(h, {
      providerConnectionId: 'c9-plan-roundtrip',
      displayName: 'Round-trip bank',
      accounts: [
        {
          providerAccountId: 'c9-plan-savings',
          name: 'Savings',
          type: 'depository',
          currency: 'USD',
        },
      ],
    });
    const earmarkAccountId = linked.accountIds[0] as string;
    const usd = (minor: string): { minor: string; currency: 'USD' } => ({ minor, currency: 'USD' });

    const goalResponse = await h.request({
      method: 'POST',
      url: '/goals',
      session: h.stale,
      body: {
        kind: 'retirement',
        name: 'Retire at 65',
        target: usd('200000000'),
        targetDate: '2050-01-01',
        priority: 1,
        fundedFromAccountIds: [earmarkAccountId],
      },
    });
    expectStatus(goalResponse, 201);
    const goalId = (goalResponse.json() as { id: string }).id;

    const contributionResponse = await h.request({
      method: 'POST',
      url: `/goals/${goalId}/contributions`,
      session: h.stale,
      body: { cadence: 'monthly', amount: usd('50000'), startsOn: '2026-01-01', source: 'USER' },
    });
    expectStatus(contributionResponse, 201);
    const contributionId = (contributionResponse.json() as { id: string }).id;

    // The questionnaire, answered through the route: it derives and stores the
    // score itself (the stored tolerance and scores are what O-11 re-scores).
    const instrument = await h.request({ method: 'GET', url: '/risk-profile', session: h.stale });
    expectStatus(instrument, 200);
    const items = (instrument.json() as { items: { id: string; options: { id: string }[] }[] })
      .items;
    const riskResponse = await h.request({
      method: 'PUT',
      url: '/risk-profile',
      session: h.stale,
      body: {
        answers: Object.fromEntries(items.map((item) => [item.id, item.options[1]!.id])),
        horizonYears: 30,
        liquidityNeed: 'medium',
      },
    });
    expectStatus(riskResponse, 200);

    const earmark = await createEarmark(
      h.database.db,
      { accounts: planningPortsFor(h.database.db, { userId: h.userId, timeZone: 'UTC' }).balances },
      { userId: h.userId, clock: systemClock, timeZone: 'UTC' },
      {
        goalId,
        accountId: earmarkAccountId,
        name: 'House down payment',
        amount: money(600_000n, 'USD'),
      },
    );
    const earmarkId = earmark.id;

    const overridesResponse = await h.request({
      method: 'PUT',
      url: '/assumptions/overrides',
      session: h.stale,
      body: { overrides: { 'capitalMarket.usEquity.expectedReturn': '0.055' } },
    });
    expectStatus(overridesResponse, 200);

    const scenarioResponse = await h.request({
      method: 'POST',
      url: '/plan/scenarios',
      session: h.stale,
      body: {
        kind: 'baseline',
        name: 'Baseline',
        profile: {
          birthDate: '1985-06-15',
          retirementAge: 65,
          planEndAge: 95,
          currency: 'USD',
          glidepath: { kind: 'age_based' },
          contributionGrowth: 'wage',
          annualSpending: usd('6000000'),
          withdrawalPolicy: 'guardrails',
          spendingFloor: 'essential_spend',
          taxDeferredRate: '0.15',
          socialSecurity: {
            monthlyPia: usd('280000'),
            claimAge: { years: 67, months: 0 },
            stressAfter2034: false,
          },
          pensions: [],
          contributions: null,
        },
      },
    });
    expectStatus(scenarioResponse, 201);
    const scenarioId = (scenarioResponse.json() as { id: string }).id;

    const lifeEventResponse = await h.request({
      method: 'POST',
      url: '/plan/life-events',
      session: h.stale,
      body: {
        kind: 'inheritance',
        name: 'From grandma',
        occursOn: '2030-03-01',
        amount: usd('500000'),
      },
    });
    expectStatus(lifeEventResponse, 201);
    const lifeEventId = (lifeEventResponse.json() as { id: string }).id;

    const runResponse = await h.request({
      method: 'POST',
      url: `/plan/scenarios/${scenarioId}/projections`,
      session: h.stale,
      body: { method: 'deterministic', allowOpenDay: true },
    });
    expectStatus(runResponse, 200);
    const runId = (runResponse.json() as { run: { id: string } }).run.id;

    // What the production writers stored, read back: the round trip below is
    // asserted against these, not against numbers the fixture made up.
    const stored = async (query: string, params: unknown[]) =>
      (await h.database.pool.query(query, params)).rows;
    const assumptionsRows = (await stored(
      `SELECT id, assumptions_version FROM plan_assumptions WHERE user_id = $1`,
      [h.userId],
    )) as { id: string; assumptions_version: string }[];
    expect(assumptionsRows).toHaveLength(1);
    const assumptionsId = assumptionsRows[0]!.id;
    const assumptionsVersion = assumptionsRows[0]!.assumptions_version;
    const [riskProfile] = (await stored(`SELECT id FROM risk_profile WHERE user_id = $1`, [
      h.userId,
    ])) as { id: string }[];
    const riskProfileId = riskProfile!.id;
    const sourcePercentiles = await stored(
      `SELECT period_index, p50_minor FROM projection_percentiles WHERE run_id = $1 ORDER BY period_index`,
      [runId],
    );

    const bundle = await buildExportBundle(h.database.pool, {
      userId: h.userId,
      appVersion: 'test',
      now: new Date('2026-01-02T00:00:00Z'),
    });
    const parsed = parseAndVerifyBundle(serialiseBundle(bundle));

    for (const table of [
      'goals',
      'goal_contributions',
      'risk_profile',
      'cash_earmarks',
      'plan_assumptions',
      'plan_scenarios',
      'plan_life_events',
      'projection_runs',
      'projection_percentiles',
    ]) {
      const stream = bundle.manifest.streams.find((s) => s.table === table);
      if (table === 'projection_percentiles') {
        // One row per projected year, as the service stores them.
        expect(stream?.count, `stream "${table}" missing or empty`).toBe(sourcePercentiles.length);
        expect(sourcePercentiles.length).toBeGreaterThan(0);
      } else {
        expect(stream?.count, `stream "${table}" missing or empty`).toBe(1);
      }
    }

    const clean = await createTestDatabase(
      `personalfi_wp412b_c7_plan_${newId().replaceAll('-', '')}`,
    );
    cleanDatabases.push(clean);
    const result = await importBundle(clean.pool, parsed, clean.userId);
    expect(result.tablesLoaded).toEqual(
      expect.arrayContaining([
        'goals',
        'goal_contributions',
        'risk_profile',
        'cash_earmarks',
        'plan_assumptions',
        'plan_scenarios',
        'plan_life_events',
        'projection_runs',
        'projection_percentiles',
      ]),
    );

    // The composite FKs actually held on import, not just on the source side:
    // a goal_contribution/cash_earmark whose goal_id did not resolve to the
    // *imported* goal's row (same id, different user_id) would have failed
    // the whole transaction rather than silently landing orphaned.
    const contribution = await clean.pool.query<{ goal_id: string }>(
      `SELECT goal_id FROM goal_contributions WHERE id = $1`,
      [contributionId],
    );
    expect(contribution.rows[0]?.goal_id).toBe(goalId);

    const run = await clean.pool.query<{ scenario_id: string; assumptions_version: string }>(
      `SELECT scenario_id, assumptions_version FROM projection_runs WHERE id = $1`,
      [runId],
    );
    expect(run.rows[0]?.scenario_id).toBe(scenarioId);
    // wp4.2 §9 item 6: assumptions_version round-trips verbatim, never rehashed.
    expect(run.rows[0]?.assumptions_version).toBe(assumptionsVersion);

    const percentiles = await clean.pool.query<{ period_index: number; p50_minor: string }>(
      `SELECT period_index, p50_minor FROM projection_percentiles WHERE run_id = $1 ORDER BY period_index`,
      [runId],
    );
    expect(percentiles.rows).toEqual(sourcePercentiles);

    // Every plan row the production writers stored arrived under its own id.
    for (const [table, id] of [
      ['goals', goalId],
      ['risk_profile', riskProfileId],
      ['cash_earmarks', earmarkId],
      ['plan_life_events', lifeEventId],
      ['plan_scenarios', scenarioId],
    ] as const) {
      const landed = await clean.pool.query(`SELECT id FROM ${table} WHERE id = $1`, [id]);
      expect(landed.rows, `${table} ${id} did not arrive`).toHaveLength(1);
    }

    const assumptions = await clean.pool.query<{ assumptions_version: string }>(
      `SELECT assumptions_version FROM plan_assumptions WHERE id = $1`,
      [assumptionsId],
    );
    expect(assumptions.rows[0]?.assumptions_version).toBe(assumptionsVersion);
  });

  it('the investments batch (securities through wallet_addresses) round-trips into a clean instance', async () => {
    const pool = h.database.pool;
    const securityId = newId();
    const identifierId = newId();
    const overlayId = newId();
    const holdingId = newId();
    const transactionId = newId();
    const lotId = newId();
    const electionId = newId();
    const priorityId = newId();
    const targetId = newId();
    const tagId = newId();
    // The account the holding, transaction, lot and election hang off is a real
    // one, linked through the route (G9-15, C9-9) — not an id nothing resolves.
    const brokerage = await linkManual(h, {
      providerConnectionId: 'c9-inv-roundtrip',
      displayName: 'Investments round-trip brokerage',
      accounts: [
        {
          providerAccountId: 'c9-inv-brokerage',
          name: 'Brokerage',
          type: 'investment',
          currency: 'USD',
        },
      ],
    });
    const accountId = brokerage.accountIds[0] as string;
    const connectionId = newId();
    const walletAddressId = newId();

    // fixture (C9-9): every row below is written by SQL because this test asserts the
    // exporter's stream completeness and the importer's verbatim, composite-FK-preserving
    // load — neither reads a security, lot, election, tag, target or wallet descriptor for
    // its content (O-11's re-validation interprets only plan_assumptions, risk_profile and
    // plan_scenarios, which the plan test above writes through their routes). The securities,
    // identifiers, holding, transaction, lot and election rows have the sync path's shape; the
    // wallet connection and its descriptor are a placeholder no `wallet_rpc` link would store.
    await pool.query(
      `INSERT INTO securities
         (id, user_id, identity_kind, identity_key, ticker, name, type, is_cash_equivalent,
          asset_class, region, sector, classification_source, classification_depth,
          classification_flagged)
       VALUES ($1, $2, 'ticker', 'ticker:VTI:wp412b', 'VTI', 'Vanguard Total Stock', 'etf', false,
               'US_EQUITY', 'US', 'Diversified', 'PROVIDER', 0, false)`,
      [securityId, h.userId],
    );
    await pool.query(
      `INSERT INTO security_identifiers
         (id, user_id, security_id, kind, value, identifier_key, confidence, first_seen_at,
          last_seen_at)
       VALUES ($1, $2, $3, 'ticker', 'VTI', 'ticker:VTI:wp412b', '1.0000', now(), now())`,
      [identifierId, h.userId, securityId],
    );
    await pool.query(
      `INSERT INTO security_overlay (id, user_id, security_id, note, locked_fields)
       VALUES ($1, $2, $3, 'wp412b fixture', '{}')`,
      [overlayId, h.userId, securityId],
    );
    await pool.query(
      `INSERT INTO holdings
         (id, user_id, account_id, security_id, quantity, currency, cost_basis_is_user_supplied,
          as_of_date)
       VALUES ($1, $2, $3, $4, '10.000000000000000000', 'USD', false, '2026-01-01')`,
      [holdingId, h.userId, accountId, securityId],
    );
    await pool.query(
      `INSERT INTO investment_transactions
         (id, user_id, account_id, security_id, provider, provider_transaction_id, type,
          quantity, amount_minor, fees_minor, currency, trade_date, source)
       VALUES ($1, $2, $3, $4, 'manual', 'wp412b-txn-1', 'BUY', '10.000000000000000000',
               -228500, 0, 'USD', '2026-01-01', 'USER')`,
      [transactionId, h.userId, accountId, securityId],
    );
    await pool.query(
      `INSERT INTO cost_basis_lots
         (id, user_id, account_id, security_id, open_date, holding_period_start_date, quantity,
          quantity_remaining, basis_minor, basis_consumed_minor, currency, basis_source,
          acquisition_type)
       VALUES ($1, $2, $3, $4, '2026-01-01', '2026-01-01', '10.000000000000000000',
               '10.000000000000000000', 228500, 0, 'USD', 'USER', 'BUY')`,
      [lotId, h.userId, accountId, securityId],
    );
    await pool.query(
      `INSERT INTO basis_method_elections
         (id, user_id, account_id, security_id, method, elected_on, elected_at)
       VALUES ($1, $2, $3, $4, 'AVERAGE_COST', '2026-01-01', now())`,
      [electionId, h.userId, accountId, securityId],
    );
    // `bootstrap-seed.ts` already seeded a default ladder (every security
    // kind, `seedPriceSourcePriority`) for this harness's account holder —
    // the whole point of `user_override`'s own rung-1 rule. Overwrite the
    // 'etf' rung 1 row rather than colliding with it, so this test exercises
    // the *user's own edit* to the ladder, which is exactly what this table
    // is for.
    await pool.query(
      `UPDATE price_source_priority SET id = $1, source = 'user_override'
       WHERE user_id = $2 AND security_kind = 'etf' AND rung = 1`,
      [priorityId, h.userId],
    );
    await pool.query(
      `INSERT INTO allocation_targets (id, user_id, asset_class, target_weight)
       VALUES ($1, $2, 'US_EQUITY', '0.6000000000')`,
      [targetId, h.userId],
    );
    await pool.query(
      `INSERT INTO security_tags (id, user_id, security_id, tag)
       VALUES ($1, $2, $3, 'watchlist')`,
      [tagId, h.userId, securityId],
    );
    await pool.query(
      `INSERT INTO connections (id, user_id, provider, provider_connection_id, display_name)
       VALUES ($1, $2, 'wallet_rpc', 'wp412b-wallet-1', 'wp412b watch-only wallet')`,
      [connectionId, h.userId],
    );
    await pool.query(
      `INSERT INTO wallet_addresses
         (id, user_id, connection_id, chain, descriptor, derivation_scheme)
       VALUES ($1, $2, $3, 'bitcoin', 'zpub-wp412b-fixture-descriptor', 'bip84')`,
      [walletAddressId, h.userId, connectionId],
    );

    const bundle = await buildExportBundle(h.database.pool, {
      userId: h.userId,
      appVersion: 'test',
      now: new Date('2026-01-02T00:00:00Z'),
    });
    const parsed = parseAndVerifyBundle(serialiseBundle(bundle));

    for (const table of [
      'securities',
      'security_identifiers',
      'security_overlay',
      'holdings',
      'investment_transactions',
      'cost_basis_lots',
      'basis_method_elections',
      'price_source_priority',
      'allocation_targets',
      'security_tags',
      'wallet_addresses',
    ]) {
      const stream = bundle.manifest.streams.find((s) => s.table === table);
      expect(stream?.count, `stream "${table}" missing or empty`).toBeGreaterThan(0);
    }

    const clean = await createTestDatabase(
      `personalfi_wp412b_c7_inv_${newId().replaceAll('-', '')}`,
    );
    cleanDatabases.push(clean);
    await importBundle(clean.pool, parsed, clean.userId);

    const lot = await clean.pool.query<{ security_id: string; basis_source: string }>(
      `SELECT security_id, basis_source FROM cost_basis_lots WHERE id = $1`,
      [lotId],
    );
    expect(lot.rows[0]?.security_id).toBe(securityId);
    expect(lot.rows[0]?.basis_source).toBe('USER');

    const election = await clean.pool.query<{ method: string }>(
      `SELECT method FROM basis_method_elections WHERE id = $1`,
      [electionId],
    );
    // The sticky AVERAGE_COST election — a tax election the user cannot take
    // back — round-trips verbatim, the exact residual the gate named.
    expect(election.rows[0]?.method).toBe('AVERAGE_COST');

    const wallet = await clean.pool.query<{ descriptor: string; connection_id: string }>(
      `SELECT descriptor, connection_id FROM wallet_addresses WHERE id = $1`,
      [walletAddressId],
    );
    expect(wallet.rows[0]?.descriptor).toBe('zpub-wp412b-fixture-descriptor');
    expect(wallet.rows[0]?.connection_id).toBe(connectionId);
  });
});
