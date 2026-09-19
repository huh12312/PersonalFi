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
