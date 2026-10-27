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

/**
 * Columns that are a **projection**, not data: omitted from the bundle and re-derived on import.
 *
 * WP 11.2b. `transactions.auto_*` is the ledger's copy of what the automatic categorisation tiers decided
 * (3 a merchant default, 4 the provider's category, 5 the classifier). The decisions themselves are
 * `category_assignments`, which the bundle already carries; the import re-derives the projection from them with
 * the same mapping the categorisation pass uses (`autoChangeOf`), exactly as it re-runs `projectEffective` for
 * `effective_*` rather than trusting what the export carried. A bundle that carried the columns could disagree
 * with its own assignments, and the projection would then be a second writer of what the assignments say.
 */
export const DERIVED_COLUMNS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'transactions',
    [
      'auto_category_id',
      'auto_tier',
      'auto_confidence',
      'auto_decided_at',
      'auto_assignment_id',
      'auto_superseded_at',
    ],
  ],
]);

export function isDerivedColumn(table: string, column: string): boolean {
  return DERIVED_COLUMNS.get(table)?.includes(column) ?? false;
}

/**
 * Defence in depth: a column named like a secret is dropped from *any* table.
 *
 * The `sealed` branch exists for `sealed_credentials`/`sealed_config`/
 * `sealed_secret`-shaped SecretBox envelope columns (D5) — every one of them
 * names "sealed" as a **prefix**: "the sealed thing is a `<noun>`". It must
 * not also catch a column that merely has "sealed" *somewhere in its name*
 * (WP 4.12b, C-7 — found twice, exercising this file's own `fetchStream`
 * against real fixtures: first `net_worth_daily.sealed_at` — "when this row
 * was sealed", not a secret — then `projection_runs.balances_sealed` — a
 * boolean, "sealed" as a **suffix**. Both were silently redacted on export;
 * both round trips then broke downstream, the first on
 * `net_worth_daily_one_open_day_idx`, the second on a `NOT NULL` violation on
 * import). Anchoring the branch to `^sealed_` — "sealed" at the very start,
 * followed by an underscore — matches every envelope column above and
 * excludes both false positives structurally, not by naming each one: a
 * future `sealed_<secret-shaped-noun>` column is still caught, and a future
 * `<anything>_sealed` boolean or `sealed_at`/`sealed_on`/`sealed_by`-shaped
 * timestamp/attribution column is not.
 */
const SENSITIVE_NAME_PATTERN = /^sealed_(?!at$)|credential|_secret$|access_token|api_key/iu;

export function isSensitiveColumn(table: string, column: string): boolean {
  if (SENSITIVE_COLUMNS.some((entry) => entry.table === table && entry.column === column)) {
    return true;
  }
  return SENSITIVE_NAME_PATTERN.test(column);
}

/**
 * The `ORDER BY` clause `bundle.ts`'s `fetchStream` uses for a table, keyed by
 * table name. Every table in `TABLE_ORDER` has an `id` column (`idColumn()`,
 * house convention) **except `projection_percentiles`**, whose primary key is
 * the composite `(run_id, period_index)` — one row per projected year, never
 * given its own id (WP 4.6, migration `0022_plan_projections.sql`). `fetchStream`
 * defaults to `id`; this is the one named exception, so a future table that
 * also lacks one is a deliberate addition here, not a query that happens to
 * work by accident on whichever table shape somebody tested first.
 */
export const STREAM_ORDER_BY: ReadonlyMap<string, string> = new Map([
  ['projection_percentiles', 'run_id, period_index'],
]);

/** Dependency order. See the module header for the FK grep this rests on. */
export const TABLE_ORDER: readonly string[] = [
  // connections
  'connections',
  'connection_accounts',
  'sync_runs',
  // ledger
  'accounts',
  'account_balances',
  // WP 9.2 (0035): the holder's overlay on an account — holder data (a tax
  // treatment they set is a fact about their own accounts the provider cannot
  // restore), so it is EXPORTED, after `accounts` by its composite
  // (user_id, account_id) FK.
  'account_overrides',
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
  // WP 11.1 (0053): the stored working behind an abstention, the "why" the
  // Inbox reads. Exported with the assignments it stands in for; references
  // only users.
  'category_abstentions',
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
  // investments (Phase 3 WP 3.1/3.2/3.4, Phase 4 WP 4.7) — WP 4.12b, C-7.
  // securities -> security_identifiers/security_overlay (0013); securities ->
  // holdings/investment_transactions/cost_basis_lots/basis_method_elections/
  // holdings_snapshots (0014); price_source_priority has no security FK
  // (keyed by security_kind, a text enum — see 0015); securities ->
  // security_tags, a composite (user_id, security_id) FK (0026); no ordering
  // constraint from allocation_targets, which references only users.
  'securities',
  'security_identifiers',
  'security_overlay',
  'holdings',
  'investment_transactions',
  'cost_basis_lots',
  'basis_method_elections',
  'holdings_snapshots',
  'price_source_priority',
  'allocation_targets',
  'security_tags',
  // connectors (Phase 3 WP 3.6) — wallet_addresses -> connections (already
  // exported first, above), not securities.
  'wallet_addresses',
  // planning (Phase 3 WP 3.8, Phase 4 WP 4.1/4.2/4.6) — WP 4.12b, C-7.
  // net_worth_daily.supersedes_id self-references net_worth_daily (0017);
  // goal_contributions/cash_earmarks -> goals, composite (goal_id, user_id)
  // FKs (0020); plan_scenarios.baseline_id self-references plan_scenarios,
  // projection_runs -> plan_scenarios and projection_percentiles ->
  // projection_runs, both composite FKs (0022). Every self/parent reference
  // is satisfied by `fetchStream`'s own `ORDER BY id` — `newId()` is a
  // uuidv7, so ascending id order is chronological order, and every one of
  // these points from a later row to an earlier one it supersedes, belongs
  // to, or was computed from (never forward).
  'net_worth_daily',
  'goals',
  'goal_contributions',
  'risk_profile',
  'cash_earmarks',
  'plan_assumptions',
  'plan_scenarios',
  'plan_life_events',
  'projection_runs',
  'projection_percentiles',
  // insights (WP 9.6, O-9; migration 0038): the append-only history of the
  // holder's consent — every grant, revoke and re-grant of a scope to an
  // advisor. EXPORTED, unlike `snapshot_grants` (the state, re-given not
  // restored — see EXEMPT_TABLES): "what did I consent to, and when did I
  // change my mind" is the holder's own record, and a bundle that dropped it
  // would take with it the only proof of how a restored install's consent got
  // to be what it is. References only `users`, so any position is valid.
  // `step_up_session_id` names a session that will not exist on the other
  // side; it is a plain UUID with no foreign key, and says only "a sign-in did
  // this".
  'snapshot_grant_events',
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
  // Phase 3 WP 3.4's market data. `prices`/`fx_rates` are provider facts,
  // re-fetchable and — under Tiingo's personal tier — not redistributable
  // (wp3.4-market-data.md §4), so a bundle must not carry them; a restored
  // instance refills them on its next 03:45 refresh. `price_source_priority`
  // (the user's own ladder) is not exempt any more — see `TABLE_ORDER` above
  // (WP 4.12b, C-7). `market_data_runs` is excluded for good: importing
  // another deployment's run history would seed this install's rate budget
  // with calls it never made.
  [
    'prices',
    "market data (WP 3.4); provider facts, re-fetched on the next refresh; Tiingo's ToS forbids redistribution.",
  ],
  ['fx_rates', 'market data (WP 3.4); provider facts, re-fetched on the next refresh.'],
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
  ['advisors', "insights (WP 2.6); not named in this WP's export scope."],
  ['advisor_runs', "insights (WP 2.6); not named in this WP's export scope."],
  // WP 5.1 (migration 0028). Both deferred on the reason, not on scope:
  // an approval is consent to one payload shape on this install — like
  // `snapshot_grants` above it is re-given, not restored, and a restored
  // approval would let a model receive a shape nobody on the new instance
  // previewed. A retained payload exists only to be inspected for 30 days;
  // carrying it into a bundle would outlive the bound the table's own CHECK
  // enforces, and it is a copy of a snapshot, the most sensitive object the
  // app builds.
  [
    'advisor_payload_approvals',
    'consent to a payload shape on this install; re-given after a restore, never restored (WP 5.1).',
  ],
  [
    'advisor_run_payloads',
    'a 30-day retention of what an advisor was sent; exporting it would outlive its own bound (WP 5.1).',
  ],
  ['insights', "insights (WP 2.6); not named in this WP's export scope."],
  ['insight_evidence', "insights (WP 2.6); not named in this WP's export scope."],
  ['insight_actions', "insights (WP 2.6); not named in this WP's export scope."],
  ['insight_dismissals', "insights (WP 2.6); not named in this WP's export scope."],
  ['insight_feedback', "insights (WP 2.6); not named in this WP's export scope."],
  [
    'insight_outcomes',
    "insights (WP 2.6); not named in this WP's export scope. Outcome-verification state derived from insights and insight_feedback, both already exempt here (WP 5.9).",
  ],
  [
    'advisory_briefs',
    "insights (WP 2.6); not named in this WP's export scope. A weekly record derived from insights, already exempt here (WP 5.6).",
  ],
  [
    'advisory_brief_items',
    "insights (WP 2.6); not named in this WP's export scope. Snapshots insights and insight_evidence, both already exempt here (WP 5.6).",
  ],
  [
    'health_scores',
    "insights (WP 2.6); not named in this WP's export scope. A weekly score derived from the snapshot, not a view over data the holder entered (WP 5.8).",
  ],
  [
    'health_score_snapshots',
    'insights: the daily health score (WP 10.12), derived from the snapshot like health_scores above, not data the holder entered; a restore recomputes from the next day on and never backfills.',
  ],
  [
    'category_suggestion_cache',
    "categorization: a language model's answer per merchant (WP 11.2), derived from the residue and the model, not data the holder entered; a restore asks again under its own approval. A holder's 'Not this' lives here too and is not carried: the suggestion it hid may be offered once more after a restore.",
  ],
  [
    'category_suggestion_evals',
    "categorization: the precision gate's measurements (WP 11.2), evidence about one model on one install at a date; a restore measures again rather than inheriting another deployment's figures, and suggestions stay off until it does.",
  ],
  [
    'category_suggestion_settings',
    "categorization: the suggestion model choice and the separate hosted consent (WP 11.2). Like the narrator's consents, a consent is not carried to another install: a restore starts unticked, on the local model.",
  ],
  [
    'insight_explanations',
    'insights: a language model\'s "Explain this" wording per evidence digest (WP 11.3), derived from the insight or pillar and the model, not data the holder entered; a restore explains again under its own approval.',
  ],
  [
    'ops_control_checks',
    "insights: the GenAI controls self-test (WP 10.16), evidence that the narrator controls held on this install at a date; a restore proves them again on the new one rather than inheriting another deployment's proof.",
  ],
  [
    'net_worth_milestones',
    'planning: a round net-worth figure crossed (WP 10.13), derived from net_worth_daily by the snapshotter, not data the holder entered; a restore detects from the next crossing on and never backfills.',
  ],
  ['notification_channels', "notifications (WP 2.4); not named in this WP's export scope."],
  ['notification_rules', "notifications (WP 2.4); not named in this WP's export scope."],
  ['notification_outbox', "notifications (WP 2.4); not named in this WP's export scope."],
  ['delivery_attempts', "notifications (WP 2.4); not named in this WP's export scope."],
  // WP 9.1 (migration 0036). Neither carries a user_id column, so
  // `discoverUserScopedTables` would never flag either as missing — they are
  // named here anyway, as the dispatch asks (09 §3 "WP 9.1"), because a
  // reasoned deferral should not rest on an absence a future schema change
  // could quietly turn into one. Both are install telemetry (a backup
  // attempt, a restore-drill verdict), never the account holder's own data;
  // restoring a bundle onto a different install should not inherit another
  // deployment's backup or drill history.
  [
    'ops_backup_runs',
    "install telemetry (WP 9.1, CF-17): one row per backup.sh attempt on this deployment, not the account holder's data.",
  ],
  [
    'ops_restore_drills',
    "install telemetry (WP 9.1, CF-17): one row per restore-drill run on this deployment, not the account holder's data.",
  ],
  // WP 10.1 (migration 0041). A reasoned deferral, and the strongest kind: this
  // table holds the holder's own Plaid client id and secret, sealed under the
  // KEK (decision D5). A credential never leaves the install in an export - the
  // same treatment as `connections.sealed_credentials`, which `SENSITIVE_COLUMNS`
  // drops by name - and a restored instance has a different KEK, so the
  // envelopes would be unopenable ciphertext anyway. The holder re-enters the
  // keys in the Add connection menu on the new install.
  [
    'provider_credentials',
    "the holder's own provider API keys, sealed under this install's KEK (WP 10.1, D5): a credential never leaves the install in an export, and the envelopes could not be opened under another KEK; re-entered after a restore.",
  ],
  // WP 10.4 (migration 0043). A derived read model, not a record: the lot
  // consumer replaces an account's rows on every investment sync, from the
  // provider's own facts, so a restored install's first sync rebuilds it
  // exactly. Exporting it would carry a stale "could not identify" list into a
  // bundle that the next sync would overwrite anyway.
  [
    'unresolved_holdings',
    'a derived read model of positions the security resolver could not identify (WP 10.4), replaced on every investment sync; the first sync after a restore rebuilds it.',
  ],
  // WP 10.6 (migration 0044, D30). Both reasoned deferrals of the consent
  // kind: a consent to send the narrator's payload to a vendor is given on
  // *this* install, against the text it showed, beside a key sealed under this
  // install's KEK (which is not exported either). A restored install starts
  // with the narrator on its operator's environment, and the holder chooses
  // and consents again — an import never switches a hosted provider on.
  [
    'narrator_settings',
    "which language model narrates for the holder (WP 10.6, D30): chosen on this install beside keys that are never exported; a restored install starts on its operator's environment and the holder chooses again.",
  ],
  [
    'narrator_provider_consents',
    'the holder’s consent to a hosted narrator provider (WP 10.6, D30), given on this install against the text it showed; never carried to another install by an import — the holder consents again there.',
  ],
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
