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
    const exempt = new Set([
      'schema_migrations',
      'users',
      'event_consumer_offsets',
      'config_snapshots',
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
      expect(rows.map((row) => row.table_name)).toEqual([
        'account_balances',
        'accounts',
        'auth_attempts',
        'auth_lockouts',
        'budget_alerts_state',
        'budget_line_actuals',
        'budget_lines',
        'budget_periods',
        'budgets',
        'categories',
        'category_assignments',
        'classifier_examples',
        'classifier_versions',
        'config_snapshots',
        'connection_accounts',
        'connection_staged_facts',
        'connections',
        'domain_events',
        'encryption_keys',
        'event_consumer_offsets',
        'feature_flags',
        'job_runs',
        'jobs',
        'ledger_dedup_keys',
        'mcc_codes',
        'merchant_profiles',
        'merchants',
        'price_change_events',
        'processed_events',
        'provider_category_map',
        'recovery_codes',
        'recurring_candidates',
        'recurring_occurrences',
        'recurring_series',
        'registration_tokens',
        'rejected_transfer_pairs',
        'rollovers',
        'rule_runs',
        'rules',
        'schedules',
        'schema_migrations',
        'security_events',
        'sessions',
        'subscription_metadata',
        'sync_runs',
        'totp_secrets',
        'transaction_splits',
        'transactions',
        'transactions_provider',
        'transfer_links',
        'users',
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
