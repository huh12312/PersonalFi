// SPDX-License-Identifier: MIT
/**
 * G-29 (WP 9.10; fixed in WP 9.14): the soak report's canary guards only the rows its seed reaches.
 * WP 9.1's own record is that the canary stayed green until the seed gained a pending row (S1a/S1b): a
 * leak through a column the seed never filled is invisible to it. The report's three layers are the
 * select-list parser, the output-column whitelist and this canary; the first two are structural, this makes
 * the third structural too.
 *
 * Every text-like column (text, varchar, char, jsonb, bytea, arrays) of EVERY table the report's SQL reads
 * must be classified in `soak-canary-columns.ts` as either
 *   - SEEDED: the soak seed (`soak-report.test.ts`) puts a `CANARY-…` value in it, and that test proves the
 *     value is there after seeding; or
 *   - NOT_FREE_TEXT: a code, enum, id, hash, key or sealed blob that cannot carry what a holder typed, with
 *     the reason.
 * A new query over a new table, or a migration adding a text column to a table the report reads, fails here
 * until someone classifies it, which is the moment someone has to ask whether the seed reaches it.
 */
import { SOAK_QUERIES } from '../../../../scripts/soak/report.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHarness, NO_DATABASE, type ApiHarness } from '../helpers/api-harness.ts';
import { NOT_FREE_TEXT, NOT_READ_BY_THE_REPORT, SEEDED } from './soak-canary-columns.ts';

/** `FROM x` / `JOIN x` names that are real tables (CTE names are the queries' own). */
function tablesReadBy(sql: string): Set<string> {
  const ctes = new Set(
    [...sql.matchAll(/\b([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)].map((m) => (m[1] ?? '').toLowerCase()),
  );
  const tables = new Set<string>();
  for (const match of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/gi)) {
    const name = (match[1] ?? '').toLowerCase();
    if (!ctes.has(name) && name !== 'lateral' && name !== 'generate_series') tables.add(name);
  }
  return tables;
}

describe.skipIf(NO_DATABASE)(
  'the soak canary reaches every free-text column the report can read (G-29)',
  () => {
    let h: ApiHarness;
    const referenced = new Set<string>();
    for (const query of SOAK_QUERIES) for (const t of tablesReadBy(query.sql)) referenced.add(t);

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'wp914_soak_canary' });
    }, 120_000);

    afterAll(async () => {
      await h?.close();
    });

    it('the report reads the tables this test thinks it does (a parse that finds nothing proves nothing)', () => {
      for (const expected of [
        'transactions',
        'sync_runs',
        'connections',
        'security_events',
        'ops_backup_runs',
      ]) {
        expect(referenced.has(expected), expected).toBe(true);
      }
    });

    it('every text-like column of every table the report reads is classified', async () => {
      const result = await h.database.pool.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
          AND (data_type IN ('text', 'character varying', 'character', 'jsonb', 'json', 'bytea', 'ARRAY')
               OR data_type = 'USER-DEFINED')
        ORDER BY table_name, column_name`,
        [[...referenced]],
      );
      const classified = new Set([...Object.keys(SEEDED), ...Object.keys(NOT_FREE_TEXT)]);
      const unclassified = result.rows
        .map((row) => `${row.table_name}.${row.column_name}`)
        .filter((column) => !classified.has(column));
      expect(
        unclassified,
        'classify each in apps/api/test/db/soak-canary-columns.ts: SEEDED (and seed it) or NOT_FREE_TEXT (with the reason)',
      ).toEqual([]);
    });

    it('nothing is classified that does not exist, or twice', async () => {
      const result = await h.database.pool.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
      );
      const exists = new Set(result.rows.map((row) => `${row.table_name}.${row.column_name}`));
      const both = Object.keys(SEEDED).filter((column) => column in NOT_FREE_TEXT);
      expect(both, 'classified as both seeded and not free text').toEqual([]);
      const stale = [...Object.keys(SEEDED), ...Object.keys(NOT_FREE_TEXT)].filter(
        (column) => !exists.has(column),
      );
      expect(stale, 'classified columns that no longer exist').toEqual([]);
    });

    it('a table named as not read by the report exists, is not read by it, and says why (WP 11.5c)', async () => {
      const result = await h.database.pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      );
      const exists = new Set(result.rows.map((row) => row.table_name));
      for (const [table, reason] of Object.entries(NOT_READ_BY_THE_REPORT)) {
        expect(exists.has(table), table).toBe(true);
        expect(
          referenced.has(table),
          `${table} is read by the soak report now: classify its columns and drop it from NOT_READ_BY_THE_REPORT`,
        ).toBe(false);
        expect(reason.length, table).toBeGreaterThanOrEqual(12);
      }
    });

    it('every NOT_FREE_TEXT entry carries a reason', () => {
      for (const [column, reason] of Object.entries(NOT_FREE_TEXT)) {
        expect(reason.length, column).toBeGreaterThanOrEqual(12);
      }
    });
  },
);
