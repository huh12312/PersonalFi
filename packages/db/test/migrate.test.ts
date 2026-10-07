// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_MIGRATIONS_DIR,
  MigrationError,
  pendingMigrations,
  readMigrationFiles,
  runMigrations,
} from '../src/migrate.ts';
import { installTypeParsers } from '../src/types.ts';

const ADMIN_URL = process.env['DATABASE_URL'];

/**
 * These run against a real Postgres because the things worth testing here — the
 * advisory lock, the transaction boundary, the type parsers — do not exist in a
 * fake. `just db-up` provides one; CI provides a service container.
 */
const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

if (ADMIN_URL === undefined) {
  console.warn('DATABASE_URL is unset; skipping migration integration tests (run `just db-up`).');
}

/** Each test gets its own database so nothing depends on execution order. */
async function createScratchDatabase(name: string): Promise<string> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const url = new URL(ADMIN_URL as string);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropScratchDatabase(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.end();
}

const silent = { info: () => undefined, warn: () => undefined };

/** DDL only. The prose in `--` comments legitimately names types we ban in columns. */
function ddlOf(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('migration files', () => {
  it('are named and ordered so the history is unambiguous', () => {
    const files = readMigrationFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]?.version).toBe('0001');
    const versions = files.map((file) => file.version);
    expect([...versions].sort()).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('declare user_id on every user-scoped table (decision D6)', () => {
    // Bookkeeping tables are not user-scoped; everything else must be, from the
    // first migration, because retrofitting an ownership column means rewriting
    // every query in the app.
    //
    // The exemptions are deliberately few, and each one is a table that describes
    // *the deployment* rather than the account holder: the migration ledger, the
    // account holder's own row, how far each consumer has read, and what the
    // configuration looked like at a given boot. Adding to this set should feel
    // like a decision — if a table holds anything Chris entered or a provider
    // returned, it carries `user_id`.
    //
    // WP 9.1 (0036) adds two more deployment facts: when the last backup ran
    // and how the last restore drill went. Neither holds anything a holder
    // entered or a provider returned (status, sizes, counts, a verdict, an
    // RTO), and `GET /ops/backup-status` returns the same answer to every
    // session on purpose (`@core/platform` OWNERSHIP.md).
    const exempt = new Set([
      'schema_migrations',
      'users',
      'event_consumer_offsets',
      'config_snapshots',
      'ops_backup_runs',
      'ops_restore_drills',
    ]);
    for (const file of readMigrationFiles()) {
      const statements = ddlOf(file.sql)
        .split(/CREATE\s+TABLE/i)
        .slice(1);
      for (const statement of statements) {
        const name = /^\s*(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/i.exec(statement)?.[1];
        if (name === undefined || exempt.has(name)) continue;
        expect(statement, `${name} must carry user_id`).toMatch(/\buser_id\b/);
      }
    }
  });

  it('store money, quantities, dates and instants in the sanctioned types', () => {
    for (const file of readMigrationFiles()) {
      const ddl = ddlOf(file.sql);
      // Floats are a correctness bug in a ledger; there is no legitimate use.
      expect(ddl, file.path).not.toMatch(/\b(REAL|DOUBLE\s+PRECISION|FLOAT|MONEY)\b/i);
      // A naked TIMESTAMP loses the zone and silently shifts by the server offset.
      expect(ddl, file.path).not.toMatch(/\bTIMESTAMP\b(?!TZ)/i);
    }
  });
});

describeWithDb('runMigrations', () => {
  const databaseName = 'personalfi_migrate_test';
  let url: string;

  beforeAll(async () => {
    installTypeParsers();
    url = await createScratchDatabase(databaseName);
  }, 30_000);

  afterAll(async () => {
    await dropScratchDatabase(databaseName);
  }, 30_000);

  it('applies every migration to an empty database and records them', async () => {
    const result = await runMigrations({ databaseUrl: url, logger: silent });
    expect(result.applied.length).toBe(readMigrationFiles().length);
    expect(result.applied[0]?.version).toBe('0001');

    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
      );
      // Spelled out rather than counted, and alphabetical because the query is,
      // so adding a table is a deliberate edit here too. A migration that quietly
      // creates a table nobody expected is how an ownership claim and the schema
      // drift apart — and `lint:schema-ownership` only sees the claims, not what
      // actually landed in the database.
      //
      // 0001_init: feature_flags, schema_migrations, users.
      // 0002_identity: encryption_keys (@core/secretbox) and the nine
      //   @ctx/identity tables.
      // 0003_platform: config_snapshots, domain_events, event_consumer_offsets,
      //   job_runs, jobs, processed_events, schedules.
      // 0004_ledger: the nine @ctx/ledger tables — account_balances, accounts,
      //   ledger_dedup_keys, merchants, rejected_transfer_pairs,
      //   transaction_splits, transactions, transactions_provider,
      //   transfer_links.
      // 0005_connections: the three @ctx/connections tables — connection_accounts,
      //   connections, sync_runs.
      // 0006_categorization: the nine @ctx/categorization tables — categories,
      //   category_assignments, classifier_examples, classifier_versions,
      //   mcc_codes, merchant_profiles, provider_category_map, rule_runs, rules.
      // 0007_ledger_rule_category: one column on transactions (@ctx/ledger); no
      //   new table.
      // 0008_connections_staging: connection_staged_facts (@ctx/connections) —
      //   durable staging for the Manual/CSV connectors (decision D-5).
      // 0009_budgeting: the six @ctx/budgeting tables — budget_alerts_state,
      //   budget_line_actuals, budget_lines, budget_periods, budgets,
      //   rollovers. Also `CREATE EXTENSION btree_gist`, which the
      //   non-overlapping-periods EXCLUDE constraint needs; it creates no table
      //   in `public` and so does not appear below.
      // 0010_recurring: the five @ctx/recurring tables — price_change_events,
      //   recurring_candidates, recurring_occurrences, recurring_series,
      //   subscription_metadata. None of them carries a foreign key into
      //   another context's schema: `merchant_id` and `transaction_id` are
      //   opaque UUIDs, which is what makes "detection never creates a
      //   merchant" (decision D25) structural rather than a habit.
      // 0011_notifications: the four @ctx/notifications tables —
      //   delivery_attempts, notification_channels, notification_outbox,
      //   notification_rules. `notification_channels.sealed_config` is a
      //   SecretBox envelope (decision D5) and its host/port/scheme are
      //   deliberately *not* sealed, so the egress allow-list stays auditable
      //   without the KEK. Two UNIQUE indexes carry the load-bearing claims:
      //   (user_id, dedupe_key) is at-most-once delivery, and (user_id,
      //   channel_id, group_key, group_window_start) is digest coalescing —
      //   enforced by the outbox, not by each rule (08 §4.5).
      // 0012_insights: the eight @ctx/insights tables — advisor_runs,
      //   advisors, insight_actions, insight_dismissals, insight_evidence,
      //   insight_feedback, insights, snapshot_grants. None of them carries a
      //   foreign key into another context's schema: an insight's link back to
      //   the data is `insight_evidence.source_ref`, a *path into the snapshot
      //   we sent*, resolved by the API at render time. That is not squeamishness
      //   about joins — it is what makes "an advisor's evidence never cites data
      //   we did not send" checkable at all, because a ref that were a foreign
      //   key would resolve against the database and so would resolve for data
      //   the advisor never received.
      //   Three CHECKs carry claims the TypeScript also makes, so a row written
      //   by any path carries them: insight_actions_kind_is_not_an_action (the
      //   four non-acting members of 08 §4.3, with no execute/transfer/trade),
      //   insights_reviewed_has_timestamp (nothing leaves `pending_review`
      //   without a recorded review), and insight_dismissals_permanent_is_earned
      //   (the 30/90/permanent ladder's third rung is reachable only at three
      //   dismissals — a snooze never advances the count).
      // 0013_securities: the three @ctx/investments tables — securities,
      //   security_identifiers, security_overlay. Two constraints carry the
      //   load-bearing claims. `securities.identity_kind` is CHECKed against a
      //   list with **no `proprietary` member**, so a row cannot exist because
      //   a provider mentioned its own opaque id — D25's shape applied to
      //   securities, and the reason an unresolvable identifier fails loudly
      //   instead of minting a row. And `security_identifiers` has a UNIQUE
      //   (user_id, identifier_key), so one name points at exactly one
      //   security: two providers that agree on an ISIN cannot become two
      //   rows even if the resolver's lookup were wrong. `security_overlay` is
      //   04 §2.2's immutable-facts + mutable-overlay split applied to a
      //   security's metadata — a provider re-sync rewrites `securities` and
      //   cannot write here at all, which is what makes a user's asset-class
      //   override durable.
      // 0014_lots: the five WP 3.2 @ctx/investments tables — basis_method_elections,
      //   cost_basis_lots, holdings, holdings_snapshots, investment_transactions.
      //   `holdings` is what the institution *asserts*; `cost_basis_lots` is what
      //   we *computed* from `investment_transactions`, and keeping the two apart
      //   is what stops a re-sync silently rewriting a realised gain. Five
      //   constraints carry the load-bearing claims.
      //   `cost_basis_lots_unknown_basis_is_declared_estimated` and
      //   `cost_basis_lots_estimated_basis_carries_a_warning` are 04 §5.5 and
      //   07 §6.2 made structural: an unknown basis is NULL with
      //   `basis_source = 'ESTIMATED'` and a non-empty `basis_warning`, so a
      //   BROKER lot claiming a zero basis it never received cannot be inserted
      //   at all — which is the difference between "unavailable" and a
      //   fabricated 100% gain. `cost_basis_lots_remaining_within_quantity`
      //   bounds `quantity_remaining` above where its column CHECK bounds it
      //   below, so `'quantity_remaining is never negative'` is a property of
      //   Postgres and not only of the matcher.
      //   `cost_basis_lots_holding_period_starts_no_later_than_open` is the
      //   whole reason `holding_period_start_date` is a second column: a wash
      //   sale tacks the replaced lot's period on, which moves the start
      //   *earlier* than `open_date` and never later (07 §4.4, IRC §1091). And
      //   `investment_transactions_provider_key_idx`, UNIQUE on (user_id,
      //   account_id, provider, provider_transaction_id), is what makes a
      //   re-fetched date window harmless — 01 §5.5 records that there is no
      //   `/investments/transactions/sync`, so there is a window and an upsert
      //   and deliberately no cursor column.
      //   One trigger, `basis_method_elections_average_cost_is_sticky`, raises
      //   23514 with that constraint name when an AVERAGE_COST election is
      //   changed: 07 §4.4's stickiness enforced on every write path rather
      //   than in a dropdown. It is BEFORE UPDATE only, because a DELETE
      //   trigger would break the `users` cascade.
      //   None of the five carries a foreign key into another context's
      //   schema: `account_id` is an opaque UUID exactly as
      //   `recurring_series.merchant_id` is, which is what makes "the lot
      //   engine never creates an account" structural. `security_id` is a real
      //   foreign key because `securities` is this context's own table.
      // 0015_market_data: three @ctx/investments tables — fx_rates, prices,
      //   price_source_priority — plus market_data_runs, which is
      //   @ctx/integrations'. The split is 08 §1.3 #7: Investments publishes
      //   `PriceReader`/`FxReader` so it owns the data; Integrations does the
      //   fetching so it owns the record of a fetch, and rows cross that seam
      //   through an injected writer port rather than a table handle.
      //   Three constraints carry the load-bearing claims.
      //   `prices_source_is_an_observation` has **no `last_known` member**, so
      //   a carry-forward can only ever be a read-time label — 07 §6.1's "never
      //   recompute history from today's price", made structural.
      //   `fx_rates_is_a_real_pair` refuses `base_currency = quote_currency`,
      //   so the one legitimate 1.0 (USD->USD) is answered by `FxReader`
      //   without a row and no stored 1.0 can ever be mistaken for a fetched
      //   rate (D4, 08 §6.6: "never a silent 1.0"). And
      //   `price_source_priority_override_is_first` pins a user override to
      //   rung 1, because an override that is not first is not an override.
      //   Staleness is deliberately *not* a stored boolean: 07 §6.1's rule is
      //   about the clock at read time, so `prices.observed_at` is stored and
      //   the STALE verdict is computed. No column in any of the four holds an
      //   API key — provider keys are file secrets (D5) and never reach the
      //   database at all.
      // 0016_wallet_addresses: one @ctx/investments table — wallet_addresses.
      //   Claimed at WP 3.1 ("wallet_addresses lands in 0016 (WP 3.6) and is
      //   still a claim") and landed here: one watch-only Bitcoin
      //   xpub/ypub/zpub or Ethereum address per connection, plus BTC
      //   gap-limit scan state. `WalletRpcConnector`
      //   (`packages/connectors/walletrpc`) holds no database handle at all —
      //   an adapter never writes to the database — so it is not this table's
      //   owner despite landing its migration; its own OWNERSHIP.md says so
      //   explicitly. No column holds key material: `descriptor` is public
      //   (an xpub or a `0x…` address), and the connector's own refusal seam
      //   (`src/guard.ts`) is what keeps a private key from ever reaching it.
      //   Two constraints carry the load-bearing claims.
      //   `wallet_addresses_bitcoin_has_a_derivation_scheme` requires exactly
      //   one of {bitcoin + a scheme, ethereum + no scheme} — there is no
      //   derivation on the Ethereum side at all (08 §2.6: "by address").
      //   `wallet_addresses_ethereum_has_no_scan_state` keeps the BIP44
      //   gap-limit horizon columns meaningless for a chain with no address
      //   chain to scan.
      // 0017_net_worth_daily: one @ctx/planning table — net_worth_daily. The
      //   first table of a Phase 4 context, opened a phase early because
      //   08 §1.3 #8 names Planning's snapshotter its sole writer and the rule
      //   the table exists to enforce ("a past day is a snapshot, not a
      //   recomputation") is a planning rule that neither Ledger nor
      //   Investments is in a position to enforce. Every input arrives through
      //   an injected port — BalancesReader, HoldingsReader, PriceReader,
      //   FxReader — so no SQL in `packages/contexts/planning/` names another
      //   context's table, which is what `lint:schema-ownership` checks.
      //   Three mechanisms carry the load-bearing claims.
      //   `net_worth_daily_sealed_rows_are_immutable` is a BEFORE UPDATE
      //   trigger raising 23514 whenever OLD.sealed_at IS NOT NULL — the one
      //   guard that survives a writer nobody has written yet, and BEFORE
      //   UPDATE only so the `users` ON DELETE CASCADE still works (the
      //   0014_lots.sql precedent). `net_worth_daily_one_open_day_idx`, a
      //   partial UNIQUE on (user_id, as_of_date) WHERE sealed_at IS NULL,
      //   makes "the row the writer may touch" unambiguous. And
      //   `net_worth_breakdown_is_well_formed` — an IMMUTABLE function so a
      //   CHECK can reach a set-returning per-element rule — refuses a
      //   breakdown entry missing D4's fxRate/fxRateDate pair or any of
      //   07 §4.1's four booleans, and requires nativeMinor/baseMinor to be
      //   JSON *strings* because a JSON number rounds a BIGINT past 2^53.
      //   There is deliberately no `fx_rate_missing` column and no default: a
      //   missing rate is FxRateUnavailable and the day is not written for
      //   that account, never a silent 1.0 (08 §6.6).
      // 0018_connection_sync_facts: one @ctx/connections table —
      //   connection_sync_facts — plus a widened `sync_runs.operation` CHECK
      //   that adds `investment_txns` as a fifth leg. WP 3.7's dispatch entry
      //   said "Migrations. None" and missed two CHECK constraints: 0005's
      //   operation list had no `investment_txns` member, and 0008's
      //   `connection_staged_facts.kind` list has no holding/liability member
      //   and no `sync_run_id` column, so there was nowhere durable for the
      //   facts `InvestmentSyncPort.factsForRun(userId, syncRunId)` reads from
      //   another process. The table is keyed on the **provider's** natural
      //   key — three partial UNIQUE indexes, one per kind, of which
      //   `connection_sync_facts_investment_transaction_idx` on
      //   (connection_id, provider_transaction_id) is 01 §5.5's idempotency
      //   key made structural — and `sync_run_id` means "the run that last
      //   observed this", so re-fetching the same 24-month window nightly
      //   restates rows instead of appending 500 more.
      //   Six CHECKs carry the load-bearing claims.
      //   `connection_sync_facts_holding_is_a_position` refuses a holding with
      //   no security, no quantity or no value, so a position cannot become a
      //   number with nothing behind it; four `…_is_money` CHECKs refuse a
      //   minor amount without its currency; and
      //   `connection_sync_facts_investment_transaction_is_identified`
      //   requires the idempotency key, the fingerprint, the quantity, the
      //   price and the date together — 01 §5.5 makes the upsert the only
      //   protection against a re-fetched window, so the key is not optional.
      //   No column here is a float: `quantity` is NUMERIC(38,18), `price` is
      //   NUMERIC(20,10), `apr` is NUMERIC(9,6) and every money value is a
      //   BIGINT/CHAR(3) pair (D3).
      // 0019_snapshot_grant_scopes_v1_1: no table. Re-declares
      //   `snapshot_grants_scope_check` with advisor contract 1.1.0's two
      //   added scopes (`liabilities.terms`, `market.rates`); WP 3.10a hit
      //   the 23514 writing the first real grant. Parity with
      //   `ADVISOR_SCOPES` is asserted by apps/api's registration test.
      // 0020_planning_goals: four @ctx/planning tables — goals,
      //   goal_contributions, risk_profile, cash_earmarks (WP 4.1,
      //   docs/plan/04-phase-4-dispatch.md §3). Every one is user_id-scoped
      //   from its first migration; `risk_profile` stores a tax-bracket
      //   *band* and never the income that produced it (08 §4.2), and
      //   `tolerance` is derived from the stored answers, never typed in.
      // 0021_plan_assumptions: one @ctx/planning table — plan_assumptions
      //   (WP 4.2). Stores only the user's deltas against a named
      //   `assumptions_version` (the content hash of the checked-in file),
      //   never a copy of the defaults.
      // 0022_plan_projections: four @ctx/planning tables — plan_scenarios
      //   (lever deltas against a baseline, never a copy of the plan),
      //   plan_life_events (dated, typed, signed Money), projection_runs
      //   (seed, engine_version, assumptions_version, input_digest — the
      //   cache key's inputs, every one NOT NULL) and projection_percentiles
      //   (p5…p95 per period). WP 4.6. A run whose assumptions_version no
      //   longer resolves reads back stale with its version named, never
      //   recomputed against today's defaults.
      // 0024_snapshot_grant_scopes_v1_3: no table. Re-declares
      //   `snapshot_grants_scope_check` with advisor contract 1.3.0's added
      //   scope (`plan.projection`, WP 4.9's R2/R6/R7 input). 1.2.0 (WP
      //   4.12b's C-10, per-currency net-worth/cash blocks) added no scope and
      //   needed no widening. Parity with `ADVISOR_SCOPES` is asserted by
      //   apps/api's registration test, which reads the latest CHECK across
      //   migrations — the 0019 lesson mechanised.
      // 0025_investments_security_scoping: no table. Composite
      //   (user_id, security_id) FKs on holdings, cost_basis_lots,
      //   investment_transactions and prices (Phase 3 gate C-14);
      //   institution_value_minor made nullable for provider-unvalued
      //   holdings (C-2). Adds the UNIQUE (user_id, id) on securities that
      //   0026 below references — which is why WP 4.7's tables could not
      //   take the 0023 slot the dispatch reserved: 0023 runs before 0025
      //   and the FK target did not exist yet. 0023 is burned, not reused.
      // 0026_allocation_targets: two @ctx/investments tables —
      //   allocation_targets, security_tags (WP 4.7). Owned by investments,
      //   not planning, because 08 §1.6's arrows point down: drift is an
      //   investments analytic. `security_tags` references securities by the
      //   composite (user_id, id) key 0025 introduced; the employer tag is
      //   set by the holder and never inferred (07 I5).
      // 0027_wallet_addresses_seal_descriptor: no new table. Phase 3 gate
      //   C-13 (gate-security-review.md §4.1(c)): adds nullable
      //   `wallet_addresses.descriptor_sealed BYTEA`, drops `descriptor`'s
      //   NOT NULL, and a CHECK that one of the two is always present.
      //   Expand only — `docs/CONVENTIONS.md`'s backfill and contract steps
      //   are later releases; see the migration's own header and
      //   `docs/evidence/phase-4/wp4.12c-gate-conditions.md` §1.
      // 0028_advisor_run_control: two @ctx/insights tables —
      //   advisor_payload_approvals (the payload preview gate, 03 §8.3: one
      //   row per approved query shape, composite FK to advisors (user_id,
      //   advisor_id)) and advisor_run_payloads (the request a local_model or
      //   external run sent, bounded to 30 days by a CHECK, composite FK to
      //   advisor_runs (user_id, id) — the UNIQUE index it needs is created
      //   in the same file). advisor_runs gains cancel_requested_at,
      //   cancel_reason, llm_model, llm_prompt_hash and status `cancelled`;
      //   the refusal CHECK gains kind_disabled and payload_not_approved;
      //   advisors gains enabled_source (default | user | feedback). WP 5.1;
      //   references only 0012-era objects or its own (05 §4).
      // 0029_snapshot_grant_scopes_v1_4: no table. Re-declares
      //   `snapshot_grants_scope_check` with advisor contract 1.4.0's two added
      //   scopes (`transactions.anomalies` — S1/S5's exact-amount category
      //   baseline, never bucketed like `transactions.raw` — and `fees.summary` —
      //   the fee hunter's by-type/by-account breakdown). Ships in the same
      //   commit as the contract bump (05 §4's non-negotiable pairing). Parity
      //   with `ADVISOR_SCOPES` is asserted by apps/api's registration test,
      //   which reads the latest CHECK across migrations — the 0019 lesson
      //   mechanised, same as 0024's. WP 5.7.
      // 0030_insight_feedback_reasons: one @ctx/insights table —
      //   insight_outcomes (outcome verification and forward validation, 09
      //   ADV-4, 05 §1 cut line 2; one row per acceptance, composite FK to
      //   advisors (user_id, advisor_id), evaluated at most once —
      //   insight_outcomes_evaluated_has_outcome and
      //   insight_outcomes_evaluated_after_due pair outcome/evaluated_at and
      //   forbid evaluating before the horizon). insight_feedback gains
      //   reason_code (07 §8.3's seven-value taxonomy, backfilled from the
      //   three preset strings the web dialog stores, by exact match);
      //   advisors.quarantine_reason widened for the feedback loop's own
      //   trip, not_true_rate. WP 5.9; references only 0012-era objects or
      //   its own (05 §4).
      // 0031_insight_narrations: no new table. insights gains
      //   narrates_insight_id (WP 5.3: a narration — alternative wording a
      //   narrates_only advisor wrote — links to the finding it narrates and
      //   is never ranked; NULL is a finding), a user-scoped composite FK
      //   (user_id, narrates_insight_id) → insights (user_id, id) ON DELETE
      //   CASCADE over the UNIQUE index insights_narration_target_idx it
      //   creates, a not-self CHECK and a partial index for the card's lookup.
      //   References only 0012-era insights (05 §4).
      // 0032_advisory_briefs: two @ctx/insights tables — advisory_briefs (one
      //   row per (user, ISO week), inserted once and never updated: the
      //   `advisory_briefs_user_week_idx` unique index is the idempotency and
      //   immutability boundary `src/brief/store.ts#publishWeeklyBrief`'s
      //   `ON CONFLICT DO NOTHING` depends on) and advisory_brief_items (the
      //   ≤5 dollar-ranked actions and the urgent no-dollar attention strip,
      //   every displayed field snapshotted at publish time rather than
      //   joined — a Brief is a record of what was said, 07 §7.3 — composite
      //   FK to advisory_briefs (user_id, id); insight_id is nullable and
      //   ON DELETE SET NULL, the click-through only, never the source of a
      //   displayed field). WP 5.6; references only 0012-era objects or its
      //   own (05 §4).
      // 0033_health_scores: one @ctx/insights table — health_scores (one row
      //   per (user, ISO week), inserted once and never updated:
      //   health_scores_user_week_idx is the idempotency boundary
      //   src/health/store.ts#computeAndStoreHealthScore's ON CONFLICT DO
      //   NOTHING depends on, and what "direction of travel against the
      //   previous stored week" reads backward through). components/excluded
      //   are JSONB arrays mirroring HealthScoreResult exactly;
      //   health_scores_six_components_named pins "every row names exactly
      //   six components, computed or excluded" and
      //   health_scores_overall_requires_components pins overall IS NULL iff
      //   zero components were computable. No foreign key toward
      //   advisory_briefs/advisory_brief_items (0032) — computed alongside
      //   the Brief by the weekly job, not a child of it. WP 5.8; references
      //   only 0012-era objects (users) or its own (05 §4).
      // 0034_securities_composite_fks: no new table. Phase 4 gate G4-23
      //   (C-14's clause, WP 5.13a): the five `REFERENCES securities (id)`
      //   that 0025/0026 left bare — security_identifiers, security_overlay,
      //   holdings_snapshots, basis_method_elections and
      //   securities.merged_into_id — re-pointed at
      //   `securities_user_id_id_uniq (user_id, id)` so a row can never name
      //   another user's security; applied twice for idempotency, the
      //   cross-user merge sabotage red (wp5.13-carry-overs.md §3).
      // 0035_account_overrides: one @ctx/ledger table — account_overrides (the
      //   holder's overlay on an account: tax_treatment TAXABLE | TAX_DEFERRED |
      //   ROTH | HSA, role spending | savings | taxable | tax_deferred | tax_free |
      //   liability, valuation holdings | balance; one row per (user, account),
      //   present exactly when at least one field is set —
      //   account_overrides_not_empty). Composite FK (user_id, account_id) →
      //   accounts (user_id, id), which needs the one additive UNIQUE
      //   accounts_user_id_id_uniq it adds on accounts (0025/0026 convention, C-14).
      //   CF-16, O-2. WP 9.2; expand-only; references only 0001/0004 objects (09 §4).
      // 0036_ops_status: two install-wide @core/platform tables — ops_backup_runs
      //   (one row per backup.sh attempt: status ok/fail, finished_at,
      //   plaintext_bytes, toc_entries, reason; best-effort insert because WP
      //   9.4's pre-migration backup runs against older schemas where the table
      //   does not exist) and ops_restore_drills (one row per `just
      //   restore-drill`: verdict pass/fail, restored and live table counts,
      //   max migration, rto_seconds). No user_id: a backup is a fact about the
      //   deployment, not a holder; GET /ops/backup-status reads both (CF-17,
      //   D24, 09 §5.7). WP 9.1; references no other table (09 §4).
      // 0038_brief_actions_grant_events: one nullable column and one @ctx/insights
      //   table. advisory_brief_items.primary_action (CF-24: the item's first
      //   proposed action as the Brief said it, jsonb with a shape CHECK to the
      //   four non-acting kinds, written once at publish, NULL for every Brief
      //   published before this migration and read as "no action recorded", never
      //   as the live insight's action) and snapshot_grant_events (O-9: an
      //   append-only history of every grant, revoke and re_granted of a scope to
      //   an advisor, a trigger refusing UPDATE, step_up_session_id a plain UUID
      //   with no foreign key because the session will not exist on the far side
      //   of a restore). WP 9.6; expand-only; references only 0002/0012/0032
      //   objects or its own (09 §4); 0035 and this file never reference each other.
      // 0039_app_role (WP 9.11; CF-18 / G-01, G-25): the DML-only role `personalfi_app`, its grants and
      //   default privileges, `public.personalfi_app_grants()` (SECURITY DEFINER, re-run by api/worker at
      //   every boot because a --no-privileges restore drops grants and a fresh cluster lacks the role),
      //   and the append-only trigger `security_events_append_only`. Expand-only; no table, column or row.
      // 0040_plan_levers_search_path: no new table. F-94-6 (WP 9.4's upgrade
      //   chain, the HEAD restore drill): 0022's
      //   plan_scenario_levers_are_well_formed called
      //   plan_amount_json_is_well_formed unqualified, and pg_restore runs
      //   with an empty search_path, so no backup holding a plan_scenarios row
      //   restored from 0022 to 0036. CREATE OR REPLACE with the inner calls
      //   schema-qualified; expand-only. Regression:
      //   test/restore-search-path.test.ts. The orchestrator's (0040 was the
      //   plan's spare); 0037 (reserved for 9.3) went unused.
      expect(rows.map((row) => row.table_name)).toEqual([
        'account_balances',
        'account_overrides',
        'accounts',
        'advisor_payload_approvals',
        'advisor_run_payloads',
        'advisor_runs',
        'advisors',
        'advisory_brief_items',
        'advisory_briefs',
        'allocation_targets',
        'auth_attempts',
        'auth_lockouts',
        'basis_method_elections',
        'budget_alerts_state',
        'budget_line_actuals',
        'budget_lines',
        'budget_periods',
        'budgets',
        'cash_earmarks',
        'categories',
        'category_assignments',
        'classifier_examples',
        'classifier_versions',
        'config_snapshots',
        'connection_accounts',
        'connection_staged_facts',
        'connection_sync_facts',
        'connections',
        'cost_basis_lots',
        'delivery_attempts',
        'domain_events',
        'encryption_keys',
        'event_consumer_offsets',
        'feature_flags',
        'fx_rates',
        'goal_contributions',
        'goals',
        'health_scores',
        'holdings',
        'holdings_snapshots',
        'insight_actions',
        'insight_dismissals',
        'insight_evidence',
        'insight_feedback',
        'insight_outcomes',
        'insights',
        'investment_transactions',
        'job_runs',
        'jobs',
        'ledger_dedup_keys',
        'market_data_runs',
        'mcc_codes',
        'merchant_profiles',
        'merchants',
        'net_worth_daily',
        'notification_channels',
        'notification_outbox',
        'notification_rules',
        'ops_backup_runs',
        'ops_restore_drills',
        'plan_assumptions',
        'plan_life_events',
        'plan_scenarios',
        'price_change_events',
        'price_source_priority',
        'prices',
        'processed_events',
        'projection_percentiles',
        'projection_runs',
        'provider_category_map',
        'recovery_codes',
        'recurring_candidates',
        'recurring_occurrences',
        'recurring_series',
        'registration_tokens',
        'rejected_transfer_pairs',
        'risk_profile',
        'rollovers',
        'rule_runs',
        'rules',
        'schedules',
        'schema_migrations',
        'securities',
        'security_events',
        'security_identifiers',
        'security_overlay',
        'security_tags',
        'sessions',
        'snapshot_grant_events',
        'snapshot_grants',
        'subscription_metadata',
        'sync_runs',
        'totp_secrets',
        'transaction_splits',
        'transactions',
        'transactions_provider',
        'transfer_links',
        'users',
        'wallet_addresses',
        'webauthn_challenges',
        'webauthn_credentials',
      ]);

      const recorded = await client.query<{ version: string; checksum: string }>(
        'SELECT version, checksum FROM schema_migrations',
      );
      expect(recorded.rows).toHaveLength(readMigrationFiles().length);
      expect(recorded.rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await client.end();
    }
  });

  it('is idempotent: a second run applies nothing', async () => {
    const result = await runMigrations({ databaseUrl: url, logger: silent });
    expect(result.applied).toHaveLength(0);
    expect(result.alreadyApplied).toBe(readMigrationFiles().length);

    // The same check /ready performs before the API accepts traffic.
    const pool = new pg.Pool({ connectionString: url });
    try {
      expect(await pendingMigrations(pool)).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('round-trips the column types the kernel depends on', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(
        "INSERT INTO users (id, display_name) VALUES ('01920000-0000-7000-8000-000000000001', 'Chris')",
      );
      await client.query(
        "INSERT INTO feature_flags (user_id, key, enabled) VALUES ('01920000-0000-7000-8000-000000000001', 'module.investments', true)",
      );

      // BIGINT must come back as a bigint, not a string: unconfigured, "1234" + "567"
      // becomes "1234567" in a money column.
      const bigintRow = await client.query<{ amount: bigint }>(
        'SELECT 9007199254740993::bigint AS amount',
      );
      expect(typeof bigintRow.rows[0]?.amount).toBe('bigint');
      expect(bigintRow.rows[0]?.amount).toBe(9_007_199_254_740_993n);

      // DATE must stay a calendar date. Parsed into a Date object it would shift
      // a March 1st transaction into February for anyone west of UTC.
      const dateRow = await client.query<{ d: string }>("SELECT '2026-03-01'::date AS d");
      expect(dateRow.rows[0]?.d).toBe('2026-03-01');

      // NUMERIC(38,18) must survive as a string; a float loses the satoshi.
      const numericRow = await client.query<{ q: string }>(
        'SELECT 0.000000010000000000::numeric(38,18) AS q',
      );
      expect(numericRow.rows[0]?.q).toBe('0.000000010000000000');

      // TIMESTAMPTZ is a genuine instant and stays a Date.
      const instantRow = await client.query<{ created_at: Date }>(
        'SELECT created_at FROM users LIMIT 1',
      );
      expect(instantRow.rows[0]?.created_at).toBeInstanceOf(Date);
    } finally {
      await client.end();
    }
  });

  it('cascades feature flags when a user is deleted', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query("DELETE FROM users WHERE display_name = 'Chris'");
      const { rows } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM feature_flags',
      );
      expect(rows[0]?.count).toBe('0');
    } finally {
      await client.end();
    }
  });

  it('refuses to run when an applied migration has been edited', async () => {
    // Applied migrations are immutable. Silently re-running an edited file is how
    // two environments end up with different schemas and the same version number.
    const scratchDir = await mkdtemp(join(tmpdir(), 'pf-migrations-'));
    const original = join(DEFAULT_MIGRATIONS_DIR, '0001_initial.sql');
    writeFileSync(join(scratchDir, '0001_initial.sql'), readFileSync(original, 'utf8'));

    const driftName = 'personalfi_drift_test';
    const driftUrl = await createScratchDatabase(driftName);
    try {
      await runMigrations({ databaseUrl: driftUrl, migrationsDir: scratchDir, logger: silent });
      writeFileSync(
        join(scratchDir, '0001_initial.sql'),
        `${readFileSync(join(scratchDir, '0001_initial.sql'), 'utf8')}\n-- edited after merge\n`,
      );
      await expect(
        runMigrations({ databaseUrl: driftUrl, migrationsDir: scratchDir, logger: silent }),
      ).rejects.toThrow(/changed after it was applied/);
    } finally {
      await dropScratchDatabase(driftName);
      await rm(scratchDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('rolls a failing migration back rather than leaving a half-applied schema', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'pf-migrations-bad-'));
    writeFileSync(
      join(scratchDir, '0001_broken.sql'),
      'CREATE TABLE good_table (id UUID PRIMARY KEY);\nTHIS IS NOT SQL;\n',
    );
    const badName = 'personalfi_rollback_test';
    const badUrl = await createScratchDatabase(badName);
    try {
      await expect(
        runMigrations({ databaseUrl: badUrl, migrationsDir: scratchDir, logger: silent }),
      ).rejects.toThrow(MigrationError);

      const client = new pg.Client({ connectionString: badUrl });
      await client.connect();
      try {
        const { rows } = await client.query<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
        );
        // The bookkeeping table survives (it is created outside the transaction);
        // the migration's own table must not.
        expect(rows.map((r) => r.table_name)).not.toContain('good_table');
        const recorded = await client.query('SELECT * FROM schema_migrations');
        expect(recorded.rows).toHaveLength(0);
      } finally {
        await client.end();
      }
    } finally {
      await dropScratchDatabase(badName);
      await rm(scratchDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('serialises concurrent migrators with an advisory lock', async () => {
    // Two api containers starting at once must not both apply 0002.
    const raceName = 'personalfi_race_test';
    const raceUrl = await createScratchDatabase(raceName);
    try {
      const results = await Promise.all([
        runMigrations({ databaseUrl: raceUrl, logger: silent }),
        runMigrations({ databaseUrl: raceUrl, logger: silent }),
        runMigrations({ databaseUrl: raceUrl, logger: silent }),
      ]);
      const totalApplied = results.reduce((sum, result) => sum + result.applied.length, 0);
      expect(totalApplied).toBe(readMigrationFiles().length);
    } finally {
      await dropScratchDatabase(raceName);
    }
  }, 30_000);
});
