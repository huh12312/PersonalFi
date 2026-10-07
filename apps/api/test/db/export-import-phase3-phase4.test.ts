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
import { newId } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildExportBundle,
  parseAndVerifyBundle,
  serialiseBundle,
} from '../../src/reports/export/bundle.ts';
import { RISK_INSTRUMENT, RISK_INSTRUMENT_VERSION, deriveTolerance } from '@ctx/planning';
import { importBundle } from '../../src/reports/export/import.ts';
import { assertRegistryIsComplete } from '../../src/reports/export/registry.ts';
import { createApiHarness, NO_DATABASE, type ApiHarness } from '../helpers/api-harness.ts';

const describeWithDb = describe.skipIf(NO_DATABASE);

/** `sha256:` + 64 lowercase hex — every content-hash-shaped column this batch needs. */
function fakeSha256(label: string): string {
  const hex = Buffer.from(label.padEnd(32, '.'), 'utf8')
    .toString('hex')
    .slice(0, 64)
    .padEnd(64, '0');
  return `sha256:${hex}`;
}

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
    const pool = h.database.pool;
    const revision1Id = newId();
    const revision2Id = newId();

    const breakdown = (accountId: string, minor: string) => [
      {
        accountId,
        currency: 'USD',
        nativeMinor: minor,
        baseMinor: minor,
        fxRate: '1.0',
        fxRateDate: '2026-01-01',
        onBudget: true,
        inNetWorth: true,
        isLiquid: true,
        isInvestable: false,
      },
    ];
    const accountId = newId();

    // Revision 1: the original, sealed observation.
    await pool.query(
      `INSERT INTO net_worth_daily
         (id, user_id, as_of_date, revision, base_currency, assets_minor, liabilities_minor,
          net_worth_minor, liquid_minor, investable_minor, on_budget_minor, breakdown, source,
          accounts_counted, accounts_unvalued, sealed_at)
       VALUES ($1, $2, '2026-01-01', 1, 'USD', 500000, 0, 500000, 500000, 0, 500000, $3,
               'observed', 1, 0, now())`,
      [revision1Id, h.userId, JSON.stringify(breakdown(accountId, '500000'))],
    );
    // Revision 2: a correction of the same day, provenance-bearing (08 §3.5).
    // Left open (sealed_at NULL) — the current, unsealed correction.
    await pool.query(
      `INSERT INTO net_worth_daily
         (id, user_id, as_of_date, revision, base_currency, assets_minor, liabilities_minor,
          net_worth_minor, liquid_minor, investable_minor, on_budget_minor, breakdown, source,
          accounts_counted, accounts_unvalued, supersedes_id, correction_reason)
       VALUES ($1, $2, '2026-01-01', 2, 'USD', 523920, 0, 523920, 523920, 0, 523920, $3,
               'corrected', 1, 0, $4, 'a missed FX rate was backfilled')`,
      [revision2Id, h.userId, JSON.stringify(breakdown(accountId, '523920')), revision1Id],
    );

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
    expect(imported1?.source).toBe('observed');
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
    expect(imported2?.net_worth_minor).toBe(523920n);
    expect(imported2?.sealed_at).toBeNull();
  });

  it('a full export round-trips the plan — goals, assumptions, scenarios and runs — into a clean instance', async () => {
    const pool = h.database.pool;
    const goalId = newId();
    const contributionId = newId();
    const riskProfileId = newId();
    const earmarkId = newId();
    const assumptionsId = newId();
    const scenarioId = newId();
    const lifeEventId = newId();
    const runId = newId();
    const earmarkAccountId = newId();
    const assumptionsVersion = fakeSha256('wp412b-plan-assumptions');

    await pool.query(
      `INSERT INTO goals
         (id, user_id, kind, name, target_minor, currency, target_date, priority, status)
       VALUES ($1, $2, 'retirement', 'Retire at 65', 200000000, 'USD', '2050-01-01', 1, 'active')`,
      [goalId, h.userId],
    );
    await pool.query(
      `INSERT INTO goal_contributions
         (id, user_id, goal_id, cadence, amount_minor, currency, escalation_pct, starts_on, source)
       VALUES ($1, $2, $3, 'monthly', 50000, 'USD', '0', '2026-01-01', 'USER')`,
      [contributionId, h.userId, goalId],
    );
    // The row must be one the questionnaire route could have written: every
    // item of the real instrument answered, and the stored scores derived by
    // the production scorer — WP 9.11's O-11 re-validation refuses anything
    // else on import (this fixture used to carry an invented item id and
    // invented scores, which is exactly the parallel construction P5-1 warns
    // about).
    const riskAnswers = {
      instrument: RISK_INSTRUMENT_VERSION,
      items: Object.fromEntries(RISK_INSTRUMENT.map((item) => [item.id, item.options[1]!.id])),
    };
    const riskDerived = deriveTolerance(riskAnswers);
    await pool.query(
      `INSERT INTO risk_profile
         (id, user_id, tolerance, composite_score, unpenalised_score, consistency_penalty,
          horizon_years, liquidity_need, answers, answered_at)
       VALUES ($1, $2, $3, $4, $5, $6, 30, 'medium', $7, now())`,
      [
        riskProfileId,
        h.userId,
        riskDerived.tolerance,
        riskDerived.compositeScore,
        riskDerived.unpenalisedScore,
        riskDerived.consistencyPenalty,
        JSON.stringify(riskAnswers),
      ],
    );
    await pool.query(
      `INSERT INTO cash_earmarks
         (id, user_id, goal_id, account_id, name, amount_minor, currency)
       VALUES ($1, $2, $3, $4, 'House down payment', 600000, 'USD')`,
      [earmarkId, h.userId, goalId, earmarkAccountId],
    );
    await pool.query(
      `INSERT INTO plan_assumptions (id, user_id, assumptions_version, deltas)
       VALUES ($1, $2, $3, $4)`,
      [
        assumptionsId,
        h.userId,
        assumptionsVersion,
        JSON.stringify({ 'capitalMarket.usEquity.expectedReturn': '0.055' }),
      ],
    );
    await pool.query(
      `INSERT INTO plan_scenarios (id, user_id, kind, name, profile, seed)
       VALUES ($1, $2, 'baseline', 'Baseline', $3, '123456789')`,
      [scenarioId, h.userId, JSON.stringify({ birthDate: '1985-06-15' })],
    );
    await pool.query(
      `INSERT INTO plan_life_events
         (id, user_id, kind, name, occurs_on, amount_minor, currency)
       VALUES ($1, $2, 'inheritance', 'From grandma', '2030-03-01', 500000, 'USD')`,
      [lifeEventId, h.userId],
    );
    await pool.query(
      `INSERT INTO projection_runs
         (id, user_id, scenario_id, scenario_kind, method, cache_key, seed, engine_version,
          assumptions_version, assumptions_overrides, input_digest, input, paths, as_of_date,
          balances_sealed, currency, success_probability, duration_ms)
       VALUES ($1, $2, $3, 'baseline', 'deterministic', $4, '123456789', 'v1', $5, $6, $7, $8,
               1, '2026-01-01', true, 'USD', '0.850000', 100)`,
      [
        runId,
        h.userId,
        scenarioId,
        fakeSha256('wp412b-cache-key'),
        assumptionsVersion,
        JSON.stringify({}),
        fakeSha256('wp412b-input-digest'),
        JSON.stringify({ birthDate: '1985-06-15' }),
      ],
    );
    await pool.query(
      `INSERT INTO projection_percentiles
         (run_id, user_id, period_index, age, calendar_year, currency, p50_minor)
       VALUES ($1, $2, 0, 41, 2026, 'USD', 100000000)`,
      [runId, h.userId],
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
      expect(stream?.count, `stream "${table}" missing or empty`).toBe(1);
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

    const percentile = await clean.pool.query<{ run_id: string; p50_minor: bigint }>(
      `SELECT run_id, p50_minor FROM projection_percentiles WHERE run_id = $1`,
      [runId],
    );
    expect(percentile.rows[0]?.run_id).toBe(runId);
    expect(percentile.rows[0]?.p50_minor).toBe(100000000n);

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
    const accountId = newId();
    const connectionId = newId();
    const walletAddressId = newId();

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
