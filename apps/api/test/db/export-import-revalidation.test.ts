// SPDX-License-Identifier: MIT
/**
 * WP 9.11, O-11 (Phase 4 gate; ASVS V2): an import re-validates the plan rows
 * a bundle carries through the same functions the routes use, and refuses a
 * column name that is not a column.
 *
 * The bundle's per-stream SHA-256s are a checksum, not a MAC: a crafted bundle
 * with recomputed hashes verifies, so `parseAndVerifyBundle` is not the place
 * this can be enforced. Each case below takes a genuine export of plan rows
 * written through the real routes, tampers one row the way a crafted bundle
 * would (hashes are irrelevant past the parse — this hands `importBundle` the
 * parsed result directly, which is exactly what a recomputed-hash bundle
 * yields), and asserts a 400 naming the table and row, and **nothing loaded**.
 * The untampered bundle imports (the positive control).
 */
import { newId } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildExportBundle,
  parseAndVerifyBundle,
  serialiseBundle,
  type ParsedBundle,
} from '../../src/reports/export/bundle.ts';
import { importBundle } from '../../src/reports/export/import.ts';
import type { RawRow } from '../../src/reports/export/codec.ts';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

describe.skipIf(NO_DATABASE)('O-11: import re-validates plan rows', () => {
  let h: ApiHarness;
  let genuine: ParsedBundle;
  const targets: TestDatabase[] = [];

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp911_import' });
    expectStatus(
      await h.request({
        method: 'PUT',
        url: '/assumptions/overrides',
        session: h.stale,
        body: { overrides: { 'capitalMarket.usEquity.expectedReturn': '0.0550' } },
      }),
      200,
    );
    expectStatus(
      await h.request({
        method: 'PUT',
        url: '/risk-profile',
        session: h.stale,
        body: {
          answers: {
            'drawdown.stated': 'buy_more',
            'drawdown.revealed': 'sold_all',
            'volatility.stated': 'range_wide',
            'volatility.revealed': 'stocks_60_to_80',
            'risk_identity.stated': 'willing',
            'risk_identity.revealed': 'mostly_stocks',
          },
          horizonYears: 20,
          liquidityNeed: 'medium',
        },
      }),
      200,
    );
    const bundle = await buildExportBundle(h.database.pool, {
      userId: h.userId,
      appVersion: 'test',
      now: new Date('2026-10-01T00:00:00Z'),
    });
    genuine = parseAndVerifyBundle(serialiseBundle(bundle));
    expect(genuine.rowsByTable.get('plan_assumptions')?.length).toBe(1);
    expect(genuine.rowsByTable.get('risk_profile')?.length).toBe(1);
  }, 120_000);

  afterEach(async () => {
    while (targets.length > 0) await targets.pop()?.drop();
  }, 30_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  async function target(): Promise<TestDatabase> {
    const db = await createTestDatabase(
      `personalfi_wp911_imp_${newId().replaceAll('-', '').slice(-12)}`,
    );
    targets.push(db);
    return db;
  }

  /** The genuine bundle with one table's first row replaced. */
  function tampered(table: string, change: (row: RawRow) => RawRow): ParsedBundle {
    const rowsByTable = new Map(genuine.rowsByTable);
    const rows = [...(rowsByTable.get(table) ?? [])];
    const first = rows[0];
    if (first === undefined) throw new Error(`no ${table} row to tamper with`);
    rows[0] = change({ ...first });
    rowsByTable.set(table, rows);
    return { manifest: genuine.manifest, rowsByTable };
  }

  async function plannedRows(db: TestDatabase): Promise<number> {
    const result = await db.pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM plan_assumptions) + (SELECT count(*) FROM risk_profile)
            + (SELECT count(*) FROM accounts) AS n`,
    );
    return Number(result.rows[0]?.n ?? -1);
  }

  async function refusal(
    bundle: ParsedBundle,
  ): Promise<{ code: unknown; detail: unknown; rows: number }> {
    const db = await target();
    try {
      await importBundle(db.pool, bundle, db.userId);
    } catch (error) {
      const problem = error as {
        code?: unknown;
        problem?: { code?: unknown; detail?: unknown };
        detail?: unknown;
        message?: string;
      };
      return {
        code: problem.code ?? problem.problem?.code,
        detail: problem.detail ?? problem.problem?.detail ?? problem.message,
        rows: await plannedRows(db),
      };
    }
    return { code: 'imported', detail: null, rows: await plannedRows(db) };
  }

  it('positive control: the genuine bundle imports, plan rows included', async () => {
    const db = await target();
    const result = await importBundle(db.pool, genuine, db.userId);
    expect(result.tablesLoaded).toEqual(
      expect.arrayContaining(['plan_assumptions', 'risk_profile']),
    );
  }, 60_000);

  it('an override outside the route’s bounds (a 500 % expected equity return) is refused, nothing loaded', async () => {
    const out = await refusal(
      tampered('plan_assumptions', (row) => ({
        ...row,
        deltas: { 'capitalMarket.usEquity.expectedReturn': '5' },
      })),
    );
    expect(out.code).toBe('export.bundle_row_invalid');
    expect(String(out.detail)).toContain('plan_assumptions row 1');
    expect(out.rows).toBe(0);
  }, 60_000);

  it('an override of a path that is not overridable is refused, nothing loaded', async () => {
    const out = await refusal(
      tampered('plan_assumptions', (row) => ({
        ...row,
        deltas: { 'tax.federal.brackets': '0.01' },
      })),
    );
    expect(out.code).toBe('export.bundle_row_invalid');
    expect(out.rows).toBe(0);
  }, 60_000);

  it('a risk profile whose stored tolerance its answers do not score to is refused, nothing loaded', async () => {
    const genuineTolerance = genuine.rowsByTable.get('risk_profile')?.[0]?.['tolerance'];
    const forged = genuineTolerance === 'aggressive' ? 'conservative' : 'aggressive';
    const out = await refusal(tampered('risk_profile', (row) => ({ ...row, tolerance: forged })));
    expect(out.code).toBe('export.bundle_row_invalid');
    expect(String(out.detail)).toContain('risk_profile row 1');
    expect(out.rows).toBe(0);
  }, 60_000);

  it('a column name that is not a column of the table (the INSERT interpolates it) is refused', async () => {
    const out = await refusal(
      tampered('risk_profile', (row) => ({
        ...row,
        ['tolerance") VALUES (NULL); --']: 'x',
      })),
    );
    expect(out.code).toBe('export.bundle_column_unknown');
    expect(out.rows).toBe(0);
  }, 60_000);
});
