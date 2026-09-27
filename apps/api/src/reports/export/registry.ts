// SPDX-License-Identifier: MIT
/**
 * The bundle's table registry: what gets exported, in what order, and which
 * columns never leave the box.
 *
 * ## Why a list at all, when the dispatch wants "not a hand list"
 *
 * The dispatch's exact test (`packages/db/test/migrate.test.ts`'s own pattern,
 * repeated for this WP) is "every user-scoped table appears in the manifest,
 * **computed from `information_schema`**" — the Phase 0/1 failure shape was a
 * hand-maintained list silently drifting from the schema it was supposed to
 * describe. `assertRegistryIsComplete` below is that check: it asks Postgres
 * which tables actually carry `user_id` (decision D6's own definition of
 * "user-scoped") and fails if `TABLE_ORDER` is missing one that is not in
 * `EXEMPT_TABLES`, with a reason attached to every exemption. `TABLE_ORDER`
 * itself is still a list, because *order* is not something `information_schema`
 * can hand back — the FK graph across five contexts has to be walked once, by a
 * person, and then defended by a test that never lets it silently drop a table.
 *
 * ## The order
 *
 * Grep across every context's `schema/*.ts` for every `.references(...)`
 * this repository actually declares (2026-09-19) turned up real FK constraints
 * only *within* three contexts — ledger, categorization, and nowhere else:
 * budgeting, recurring and connections declare **no** FK constraints between
 * their own tables (every cross-row pointer, e.g. `budget_lines.budget_period_id`,
 * is a plain `uuid` column, the same "opaque, no FK" choice `categoryId` makes
 * for a foreign context's table — table-ownership discipline extended to a
 * context's *own* tables). So the only orderings that are load-bearing are:
 *
 *   connections     → connection_accounts, sync_runs
 *   accounts        → account_balances, transactions_provider
 *   merchants       → transactions (effective_merchant_id)
 *   transactions_provider → transactions (current_fact_id)
 *   transactions    → transaction_splits, transfer_links, rejected_transfer_pairs,
 *                     ledger_dedup_keys
 *   categories      → provider_category_map, mcc_codes, category_assignments,
 *                     classifier_examples, merchant_profiles
 *   rules           → category_assignments, rule_runs
 *
 * `transactions.superseded_by_id` is self-referencing but carries **no** DB
 * foreign key (confirmed by the same grep), so a single insert pass in `id`
 * order needs no two-phase "insert null, then backfill" dance.
 *
 * ## What is deliberately not here
 *
 * - `connection_staged_facts` — the durable mirror of an in-process sync
 *   buffer (decision D-5). Re-derivable by re-syncing; not a read model input.
 * - Every `notifications.*` and `insights.*` table — outside WP 2.8's named
 *   scope (dispatch §3), and `insights` has not even migrated yet as this was
 *   written (no `packages/db/migrations/0012_*`).
 * - Identity, platform and audit bookkeeping — `packages/db/test/migrate.test.ts`'s
 *   own exemption set (the migration ledger, session/credential rows, the
 *   outbox, the job queue, feature flags, audit log): none of them is "data
 *   Chris entered or a provider returned" in the sense decision D6 means, and
 *   several are actively unsafe to hand back verbatim (session tokens).
 */
import type { Pool } from 'pg';

export interface SensitiveColumn {
  readonly table: string;
  readonly column: string;
  readonly reason: string;
}

/**
 * Columns excluded by name, per table. `sealed_credentials` is the encrypted
 * envelope a Plaid (or any provider's) access token lives inside — decision D5 —
 * so dropping the column is what "an export never contains a Plaid access
 * token" actually rests on: there is nowhere else in this schema such a token
 * could be.
 */
export const SENSITIVE_COLUMNS: readonly SensitiveColumn[] = [
  {
    table: 'connections',
    column: 'sealed_credentials',
    reason: 'the SecretBox-sealed provider credential (decision D5); never leaves the box.',
  },
];

/** Defence in depth: a column named like a secret is dropped from *any* table. */
const SENSITIVE_NAME_PATTERN = /sealed|credential|_secret$|access_token|api_key/iu;

export function isSensitiveColumn(table: string, column: string): boolean {
  if (SENSITIVE_COLUMNS.some((entry) => entry.table === table && entry.column === column)) {
    return true;
  }
  return SENSITIVE_NAME_PATTERN.test(column);
}

/** Dependency order. See the module header for the FK grep this rests on. */
export const TABLE_ORDER: readonly string[] = [
  // connections
  'connections',
  'connection_accounts',
  'sync_runs',
  // ledger
  'accounts',
  'account_balances',
  'merchants',
  'transactions_provider',
  'transactions',
  'transaction_splits',
  'transfer_links',
  'rejected_transfer_pairs',
  'ledger_dedup_keys',
  // categorization
  'categories',
  'provider_category_map',
  'mcc_codes',
  'rules',
  'rule_runs',
  'category_assignments',
  'classifier_examples',
  'classifier_versions',
  'merchant_profiles',
  // budgeting
  'budgets',
  'budget_periods',
  'budget_lines',
  'budget_line_actuals',
  'rollovers',
  'budget_alerts_state',
  // recurring
  'recurring_series',
  'recurring_occurrences',
  'recurring_candidates',
  'subscription_metadata',
  'price_change_events',
];

/**
 * Named, reasoned exceptions to "every user-scoped table is in `TABLE_ORDER`".
 *
 * The identity/platform names below (and the corrected `domain_events`,
 * `jobs`/`job_runs`/`schedules` — this file's first draft guessed
 * `sessions`/`credentials`/`outbox`/`job_queue`, which do not exist under
 * those names) were not guessed; they came from running
 * `discoverUserScopedTables` against a real migrated database and reading off
 * what it actually reported, in `export-import.test.ts`'s own
 * "every user-scoped table appears in the manifest" test — the mechanism this
 * file's header promises, exercising itself. The `insights.*` and
 * `notifications.*` tables are real too (both contexts have landed migrations
 * as of this writing) and are exempted on scope, not on absence: dispatch §3
 * names accounts, ledger facts, categories/rules, budgets and recurring for
 * this bundle, not those two contexts.
 */
export const EXEMPT_TABLES: ReadonlyMap<string, string> = new Map([
  ['connection_staged_facts', 're-derivable by re-sync; not a read-model input (decision D-5).'],
  ['schema_migrations', 'the migration ledger; describes the deployment, not the account holder.'],
  ['users', 'identity; the export is scoped to one already-known user, not a user list.'],
  ['sessions', 'live session tokens; re-issuing them is what step-up/login already does.'],
  ['recovery_codes', 'single-use by design; restoring used ones would defeat the property.'],
  ['feature_flags', 'deployment configuration, restored by the operator, not by this bundle.'],
  ['audit_log', "the deployment's own audit trail, not the account holder's financial data."],
  // --- identity/auth: security state, not financial data ---------------------
  ['auth_attempts', 'security telemetry (rate limiting), not user data.'],
  ['auth_lockouts', 'security state; re-derived by the auth flow, not restored.'],
  ['totp_secrets', 'a TOTP secret is re-enrolled, never restored, like a passkey.'],
  ['webauthn_challenges', 'single-use, short-lived ceremony state.'],
  ['webauthn_credentials', 'passkey public keys; re-enrolled on a new instance, never restored.'],
  ['registration_tokens', 'single-use enrolment tokens.'],
  ['security_events', "the account's own security audit trail, not financial data."],
  ['snapshot_grants', 'a scoped, time-limited read grant; re-issued, not restored.'],
  ['encryption_keys', 'DEK/KEK material; decision D5 — key loss means re-link, never export.'],
  // --- platform: process/deployment state, not data ---------------------------
  [
    'domain_events',
    'the transactional outbox; replaying it into a second instance double-fires every consumer.',
  ],
  ['jobs', 'in-flight background work; meaningless once detached from its process.'],
  ['job_runs', 'job execution history; operational telemetry, not user data.'],
  ['schedules', 'cron-style schedule state; deployment configuration.'],
  ['processed_events', "a consumer's own replay offset; meaningless on a different instance."],
  ['locks', 'advisory locking state, not data.'],
  ['config_snapshots', 'boot-time configuration snapshots, not user data.'],
  // --- out of this WP's named scope (dispatch §3), not out of existence -------
  // Phase 3 WP 3.1's securities master. These join the bundle in FK order
  // (securities → security_identifiers/security_overlay) with the holdings and
  // lots WP 3.7 exports; exporting the master without the positions that
  // reference it would be half a fact. The manifest-completeness test below
  // caught their arrival the day 0013 landed, which is what it is for.
  ['securities', 'investments (WP 3.1); exported with holdings/lots by WP 3.7.'],
  ['security_identifiers', 'investments (WP 3.1); exported with holdings/lots by WP 3.7.'],
  ['security_overlay', 'investments (WP 3.1); exported with holdings/lots by WP 3.7.'],
  // Phase 3 WP 3.2's positions and lots — the "holdings/lots" the three rows
  // above are waiting for. They join the bundle together, in FK order, when
  // WP 3.7 wires the investments export; until then the manifest test names
  // them here so a reviewer sees the gap rather than the test hiding it.
  ['holdings', 'investments (WP 3.2); exported with securities by WP 3.7.'],
  ['holdings_snapshots', 'investments (WP 3.2); exported with securities by WP 3.7.'],
  ['investment_transactions', 'investments (WP 3.2); exported with securities by WP 3.7.'],
  ['cost_basis_lots', 'investments (WP 3.2); exported with securities by WP 3.7.'],
  [
    'basis_method_elections',
    'investments (WP 3.2); the sticky AVERAGE_COST election is user state; exported by WP 3.7.',
  ],
  // Phase 4 WP 4.7's allocation-target and security-tag tables (migration
  // 0026, owned by @ctx/investments — 08 §1.6's arrows point down, so this is
  // Investments' user state, not Planning's). User-authored the same way the
  // WP 3.2 rows above are: a stored target set and an employer-stock tag are
  // both facts a holder set on purpose, and neither is recomputable from
  // anything else in the schema. Deferred, never excluded, for the same
  // reason WP 4.1's row above it is — WP 4.12's export batch adds them with
  // the rest of the investments batch.
  ['allocation_targets', 'investments (WP 4.7); exported by WP 4.12.'],
  ['security_tags', 'investments (WP 4.7); exported by WP 4.12.'],
  // Phase 3 WP 3.4's market data. `prices`/`fx_rates` are provider facts,
  // re-fetchable and — under Tiingo's personal tier — not redistributable
  // (wp3.4-market-data.md §4), so a bundle must not carry them; a restored
  // instance refills them on its next 03:45 refresh. `price_source_priority`
  // is the user's own ladder and is exported with the WP 3.7 batch.
  // `market_data_runs` is excluded for good: importing another deployment's
  // run history would seed this install's rate budget with calls it never made.
  [
    'prices',
    "market data (WP 3.4); provider facts, re-fetched on the next refresh; Tiingo's ToS forbids redistribution.",
  ],
  ['fx_rates', 'market data (WP 3.4); provider facts, re-fetched on the next refresh.'],
  ['price_source_priority', 'investments (WP 3.4); the user-edited ladder; exported by WP 3.7.'],
  [
    'market_data_runs',
    "market data (WP 3.4); another deployment's run history would seed this one's rate budget with calls it never made.",
  ],
  // Phase 3 WP 3.7's provider fact staging (migration 0018) — the sibling of
  // `connection_staged_facts` above and exempt for the same reason, not a new
  // one: every row is a restatement of what the provider said on the last
  // sync, and the *next* sync rewrites all of them. Nothing here is a
  // derivation the user could lose. What must survive a round trip is what the
  // lot engine computed **from** these facts — `investment_transactions` and
  // `cost_basis_lots`, both already listed above — and a bundle carrying the
  // provider's raw assertions alongside them would restore two copies of the
  // same truth, one of which would be stale the moment the connection synced.
  [
    'connection_sync_facts',
    're-derivable by re-sync; the provider’s last statement, not a derivation (the connection_staged_facts reason, WP 3.7).',
  ],
  // Phase 3 WP 3.6's watch-only wallet descriptors (migration 0016). An
  // xpub/ypub/zpub is **not** a credential — it is public information a block
  // explorer would show anyone, and there is no key material column here to
  // leak (08 §2.6) — so the reason this is deferred rather than excluded is
  // ordinary: the row is meaningless without the `connections` row its
  // `connection_id` references, and `connections` is itself not in this WP's
  // export scope. The two travel together or not at all.
  [
    'wallet_addresses',
    'investments (WP 3.6); a wallet descriptor is meaningless without its connections row, which this WP does not export either.',
  ],
  // Phase 3 WP 3.8's net-worth read model (migration 0017). Derived, in the
  // strict sense: every row is recomputable from `accounts`, `account_balances`,
  // `holdings`, `prices` and `fx_rates`. Deferred rather than excluded for one
  // reason that is not derivability — a **sealed** row is a historical
  // assertion (08 §3.5) made against prices that may no longer be fetchable,
  // and corrections carry `supersedes_id`/`correction_reason` provenance a
  // recomputation cannot reconstruct. So this belongs in a bundle eventually,
  // with its revision ladder intact, and dropping it silently would lose
  // exactly the part that cannot be rebuilt.
  [
    'net_worth_daily',
    'planning (WP 3.8); sealed rows are historical assertions with correction provenance a recomputation cannot rebuild — exported with the investments batch, not dropped.',
  ],
  // Phase 4 WP 4.1 (migration 0020) and WP 4.2 (0021). These are the
  // user-authored rows 08 §7.3 calls "the truly irreplaceable data" — a goal,
  // a risk answer set, an assumptions delta — so they are deferred, never
  // excluded: WP 4.12's export batch (docs/plan/04-phase-4-dispatch.md §3
  // "WP 4.12", C-7 in the Phase 3 gate) adds them with the Phase 3 tables,
  // `plan_assumptions.assumptions_version` round-tripping verbatim (wp4.2
  // §9 item 6). Landed here as deferrals so the completeness check names them
  // the day WP 4.12 forgets one, exactly as it named the Phase 3 tables.
  ['goals', 'planning (WP 4.1); user-authored — exported by WP 4.12 with the Phase 3 batch.'],
  [
    'goal_contributions',
    'planning (WP 4.1); user-authored — exported by WP 4.12 with the Phase 3 batch.',
  ],
  [
    'risk_profile',
    'planning (WP 4.1); user-authored — exported by WP 4.12 with the Phase 3 batch.',
  ],
  [
    'cash_earmarks',
    'planning (WP 4.1); user-authored — exported by WP 4.12 with the Phase 3 batch.',
  ],
  [
    'plan_assumptions',
    'planning (WP 4.2); user deltas against a named version — exported by WP 4.12, assumptions_version verbatim.',
  ],
  // Phase 4 WP 4.6 (migration 0022). The same deferral, for the same reason:
  // a saved scenario and a life event are the holder's own plan, and a stored
  // run's seed + engine_version + assumptions_version is what makes a saved
  // projection re-openable byte for byte (D20) — so the runs travel with the
  // scenarios, never recomputed on import.
  [
    'plan_scenarios',
    'planning (WP 4.6); user-authored — exported by WP 4.12 (the baseline profile and lever deltas, verbatim).',
  ],
  [
    'plan_life_events',
    'planning (WP 4.6); user-authored — exported by WP 4.12 with the Phase 3 batch.',
  ],
  [
    'projection_runs',
    'planning (WP 4.6); user-authored — exported by WP 4.12 with seed, engine_version and assumptions_version verbatim, never recomputed on import.',
  ],
  [
    'projection_percentiles',
    'planning (WP 4.6); user-authored — exported by WP 4.12 with the run it belongs to.',
  ],
  ['advisors', "insights (WP 2.6); not named in this WP's export scope."],
  ['advisor_runs', "insights (WP 2.6); not named in this WP's export scope."],
  ['insights', "insights (WP 2.6); not named in this WP's export scope."],
  ['insight_evidence', "insights (WP 2.6); not named in this WP's export scope."],
  ['insight_actions', "insights (WP 2.6); not named in this WP's export scope."],
  ['insight_dismissals', "insights (WP 2.6); not named in this WP's export scope."],
  ['insight_feedback', "insights (WP 2.6); not named in this WP's export scope."],
  ['notification_channels', "notifications (WP 2.4); not named in this WP's export scope."],
  ['notification_rules', "notifications (WP 2.4); not named in this WP's export scope."],
  ['notification_outbox', "notifications (WP 2.4); not named in this WP's export scope."],
  ['delivery_attempts', "notifications (WP 2.4); not named in this WP's export scope."],
]);

/**
 * Every table Postgres reports as user-scoped (has a `user_id` column,
 * decision D6's own definition), from `information_schema` — never a
 * maintained list, so a table added anywhere and forgotten here is caught
 * mechanically rather than trusted to a reviewer's memory.
 */
export async function discoverUserScopedTables(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ table_name: string }>(
    `SELECT DISTINCT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'user_id'
     ORDER BY table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

export interface RegistryCompleteness {
  readonly complete: boolean;
  /** User-scoped tables neither exported nor exempted. A non-empty list is a bug. */
  readonly missing: string[];
}

/** The self-check: exported ∪ exempted must equal every user-scoped table. */
export async function assertRegistryIsComplete(pool: Pool): Promise<RegistryCompleteness> {
  const discovered = await discoverUserScopedTables(pool);
  const known = new Set([...TABLE_ORDER, ...EXEMPT_TABLES.keys()]);
  const missing = discovered.filter((table) => !known.has(table));
  return { complete: missing.length === 0, missing };
}
