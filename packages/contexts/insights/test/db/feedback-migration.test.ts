// SPDX-License-Identifier: MIT
/**
 * Migration `0030_insight_feedback_reasons.sql`'s one-time backfill, against a
 * real Postgres taken through the actual before/after transition — not a
 * scratch database created already at the latest schema, which
 * `@core/testkit`'s `createTestDatabase` always is (`runMigrations` with no
 * version cap). This suite drives `@core/db`'s `runMigrations` directly, once
 * over every file *before* 0030 and once more including it, so the `UPDATE`
 * statements this test asserts on are the exact ones a real deploy runs over
 * real historical rows — not a re-implementation of them.
 *
 * `insight_feedback` has a hard FK to `insights`, so a valid seed needs one
 * real row there too (`insights`' own NOT NULL columns, minimally). No `pg`
 * import: `@ctx/insights` does not depend on it directly, so admin and seed
 * queries go through `@core/db`'s `createPool`/`createDatabase`, the same
 * surface `store.ts` uses.
 *
 * **Sabotage record**, red on the first try, restored — recorded in full in
 * docs/evidence/phase-5/wp5.9-feedback.md: the migration's `NOT_ACTIONABLE`
 * `UPDATE` statement (`'Not useful'` → `NOT_ACTIONABLE`) deleted from the
 * file. `byReason.get('Not useful')` read `null` instead of
 * `'NOT_ACTIONABLE'` — the exact shape a silently-dropped preset mapping
 * would take in production: the row, the note and the dismissal itself all
 * still there, just never classified.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, readMigrationFiles, runMigrations } from '@core/db';
import { newId } from '@core/kernel';
import { NO_DATABASE } from './harness.ts';

const ADMIN_URL = process.env['TEST_ADMIN_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const silent = { info: () => undefined, warn: () => undefined };
const DB_NAME = 'personalfi_wp_ins_feedback_migration';

/** A fresh directory holding copies of every migration file at or below `maxVersion`. */
async function migrationsDirThrough(maxVersion: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wp5-9-migrations-'));
  for (const file of readMigrationFiles()) {
    if (file.version > maxVersion) continue;
    writeFileSync(join(dir, `${file.version}_${file.name}.sql`), readFileSync(file.path));
  }
  return dir;
}

describe.skipIf(NO_DATABASE)('migration 0030: the preset-reason backfill', () => {
  let pool: ReturnType<typeof createPool>;
  let db: ReturnType<typeof createDatabase>;
  let preDir: string;
  let throughDir: string;
  let userId: string;
  let insightId: string;

  beforeAll(async () => {
    const adminPool = createPool({
      databaseUrl: ADMIN_URL as string,
      applicationName: 'wp5-9-migration-test-admin',
      max: 1,
    });
    const admin = createDatabase(adminPool);
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE "${DB_NAME}"`));
    await adminPool.end();

    const url = new URL(ADMIN_URL as string);
    url.pathname = `/${DB_NAME}`;
    const databaseUrl = url.toString();

    // Everything up to, but not including, 0030 — the state a real database
    // was in the moment before this migration ran.
    preDir = await migrationsDirThrough('0029');
    await runMigrations({ databaseUrl, migrationsDir: preDir, logger: silent });

    pool = createPool({ databaseUrl, applicationName: 'wp5-9-migration-test', max: 4 });
    db = createDatabase(pool);

    userId = newId();
    await db.execute(sql`
      INSERT INTO users (id, display_name) VALUES (${userId}::uuid, ${'Migration Test'})
    `);

    insightId = newId();
    const digest = `sha256:${'0'.repeat(64)}`;
    await db.execute(sql`
      INSERT INTO insights (
        id, user_id, advisor_id, advisor_version, key, period, type, severity,
        title, summary_md, confidence, confidence_basis, horizon, input_digest
      ) VALUES (
        ${insightId}::uuid, ${userId}::uuid, 'builtin.example', '1.0.0', 'k', 'all_time',
        'example.finding', 'notable', 't', 's', 0.9, 'deterministic', 'this_year', ${digest}
      )
    `);

    // Four pre-0030 feedback rows: the three preset strings the web dialog
    // has been storing, and one custom, free-text dismissal.
    const presets = [
      "That's wrong",
      'Already handled',
      'Not useful',
      'the whole category is wrong, not just this row',
    ];
    for (const reason of presets) {
      await db.execute(sql`
        INSERT INTO insight_feedback
          (id, user_id, insight_id, advisor_id, insight_key, action, reason, correlation_id)
        VALUES (
          ${newId()}::uuid, ${userId}::uuid, ${insightId}::uuid, 'builtin.example', 'k',
          'dismiss', ${reason}, ${newId()}::uuid
        )
      `);
    }

    // Fifth row: no reason at all — a dismissal is still a dismissal.
    await db.execute(sql`
      INSERT INTO insight_feedback
        (id, user_id, insight_id, advisor_id, insight_key, action, correlation_id)
      VALUES (
        ${newId()}::uuid, ${userId}::uuid, ${insightId}::uuid, 'builtin.example', 'k',
        'dismiss', ${newId()}::uuid
      )
    `);

    // Now apply 0030 over that historical data — the actual migration this
    // test is about.
    throughDir = await migrationsDirThrough('0030');
    await runMigrations({ databaseUrl, migrationsDir: throughDir, logger: silent });
  }, 60_000);

  afterAll(async () => {
    // Close this suite's own pool before the FORCE drop below — otherwise
    // Postgres terminates it out from under us and pg surfaces that as an
    // unhandled error on the client's socket, not as a rejection anything
    // here can catch.
    await pool?.end();

    const adminPool = createPool({
      databaseUrl: ADMIN_URL as string,
      applicationName: 'wp5-9-migration-test-admin-teardown',
      max: 1,
    });
    const admin = createDatabase(adminPool);
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`));
    await adminPool.end();
    if (preDir !== undefined) await rm(preDir, { recursive: true, force: true });
    if (throughDir !== undefined) await rm(throughDir, { recursive: true, force: true });
  }, 30_000);

  it('the three stored preset reasons map to codes and every other stored reason survives as a note', async () => {
    const result = await db.execute<{ reason: string | null; reason_code: string | null }>(sql`
      SELECT reason, reason_code FROM insight_feedback ORDER BY created_at
    `);
    const rows = result.rows;
    expect(rows).toHaveLength(5);

    const byReason = new Map(rows.map((row) => [row.reason, row.reason_code]));
    expect(byReason.get("That's wrong")).toBe('NOT_TRUE');
    expect(byReason.get('Already handled')).toBe('ALREADY_KNOW');
    expect(byReason.get('Not useful')).toBe('NOT_ACTIONABLE');

    // Every other stored reason — custom text, or none — survives untouched,
    // with no code invented for it.
    expect(byReason.get('the whole category is wrong, not just this row')).toBeNull();
    expect(byReason.get(null)).toBeNull();

    // Row counts: exactly three backfilled, two left alone.
    const mapped = rows.filter((row) => row.reason_code !== null);
    const unmapped = rows.filter((row) => row.reason_code === null);
    expect(mapped).toHaveLength(3);
    expect(unmapped).toHaveLength(2);
  });
});
