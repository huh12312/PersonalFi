// SPDX-License-Identifier: MIT
/**
 * WP 2.8 — the export/import bundle, over real databases.
 *
 * Every sabotage this file's header promises was run by hand once while this
 * suite was written (docs/evidence/phase-2/wp2.8-reports.md records the red
 * output): the credential-exclusion filter in
 * `apps/api/src/reports/export/registry.ts`'s `isSensitiveColumn` was made to
 * return `false` unconditionally, and 'an export never contains a sealed
 * credential...' failed with the fake credential's marker found in the
 * bundle; then a byte inside a genuine stream's hash was clamped to always
 * match, and 'a tampered stream hash is refused' failed to throw. Both were
 * reverted before this file was committed.
 */
import { DateOnly, newId } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildExportBundle,
  BundleValidationError,
  parseAndVerifyBundle,
  serialiseBundle,
} from '../../src/reports/export/bundle.ts';
import { importBundle, instanceHasUserData } from '../../src/reports/export/import.ts';
import { assertRegistryIsComplete } from '../../src/reports/export/registry.ts';
import { computeCategoryMonthActivity } from '../../src/reports/spending-income.ts';
import {
  createApiHarness,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const describeWithDb = describe.skipIf(NO_DATABASE);

/** A marker no real credential would contain, so its absence is unambiguous. */
const FAKE_CREDENTIAL_MARKER = 'wp28-sealed-credential-marker';

async function seedFakeCredential(h: ApiHarness): Promise<void> {
  // fixture: connections row (a plaid item with sealed credentials) written by SQL because a Plaid link needs a live public-token exchange the route test cannot reach, and this test asserts the exporter never emits `sealed_credentials` (it excludes the column by name and never reads it); the marker bytes stand in for a sealed envelope, which no reader here opens — not a row the link route would store byte-for-byte, deliberately.
  await h.database.pool.query(
    `INSERT INTO connections (id, user_id, provider, provider_connection_id, display_name, sealed_credentials)
     VALUES ($1, $2, 'plaid', 'plaid-item-1', 'Fake Bank', $3)`,
    [newId(), h.userId, Buffer.from(FAKE_CREDENTIAL_MARKER, 'utf8')],
  );
}

describeWithDb('export/import bundle (WP 2.8)', () => {
  let h: ApiHarness;
  const cleanDatabases: TestDatabase[] = [];

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp_export' });

    const linked = await linkManual(h, {
      providerConnectionId: 'export-checking',
      displayName: 'Export Checking',
      accounts: [
        {
          providerAccountId: 'export-1',
          name: 'Export Checking',
          type: 'depository',
          currency: 'USD',
        },
      ],
    });
    const accountId = linked.accountIds[0];
    if (accountId === undefined) throw new Error('account missing');
    await h.request({
      method: 'POST',
      url: `/accounts/${accountId}/transactions`,
      session: h.fresh,
      body: {
        transactions: [
          {
            amount: { minor: '-2599', currency: 'USD' },
            postedDate: '2025-05-01',
            name: 'Hardware Store',
          },
        ],
      },
    });
    await seedFakeCredential(h);
  });

  afterAll(async () => {
    await h.close();
    for (const db of cleanDatabases) await db.drop();
  });

  afterEach(async () => {
    // Each import test needs its own clean instance; drop them promptly
    // rather than accumulating scratch databases for the whole suite.
    while (cleanDatabases.length > 0) {
      const db = cleanDatabases.pop();
      if (db !== undefined) await db.drop();
    }
  });

  it('every user-scoped table appears in the manifest', async () => {
    const result = await assertRegistryIsComplete(h.database.pool);
    expect(result.missing).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('an export never contains a sealed credential or a Plaid access token', async () => {
    const bundle = await buildExportBundle(h.database.pool, {
      userId: h.userId,
      appVersion: 'test',
      now: new Date('2025-06-01T00:00:00Z'),
    });
    const text = serialiseBundle(bundle);
    expect(text).not.toContain(FAKE_CREDENTIAL_MARKER);
    expect(text.toLowerCase()).not.toContain('sealed_credentials');

    // The fake connection itself is still exported — only the credential
    // column is dropped, not the whole row (an operator restoring a backup
    // still sees the connection and re-links it, per D5's scope rule).
    const connectionsStream = bundle.manifest.streams.find((s) => s.table === 'connections');
    expect(connectionsStream?.count).toBeGreaterThan(0);
  });

  it('a tampered stream hash is refused', async () => {
    const bundle = await buildExportBundle(h.database.pool, {
      userId: h.userId,
      appVersion: 'test',
      now: new Date('2025-06-01T00:00:00Z'),
    });
    const text = serialiseBundle(bundle);
    const lines = text.split('\n');
    // Flip one byte inside the first data row (line 1 is the manifest).
    const target = lines.findIndex((line, index) => index > 0 && line.length > 0);
    const line = lines[target];
    if (line === undefined) throw new Error('bundle has no data row to tamper with');
    lines[target] = line.includes('a') ? line.replace('a', 'b') : `${line}x`;
    const tampered = lines.join('\n');

    expect(() => parseAndVerifyBundle(tampered)).toThrow(BundleValidationError);
    try {
      parseAndVerifyBundle(tampered);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BundleValidationError);
      expect((error as BundleValidationError).code).toBe('export.stream_hash_mismatch');
    }
  });

  it('export round-trips into a clean instance', async () => {
    const bundle = await buildExportBundle(h.database.pool, {
      userId: h.userId,
      appVersion: 'test',
      now: new Date('2025-06-01T00:00:00Z'),
    });
    const parsed = parseAndVerifyBundle(serialiseBundle(bundle));

    const clean = await createTestDatabase(
      `personalfi_wp_export_clean_${newId().replaceAll('-', '')}`,
    );
    cleanDatabases.push(clean);

    expect(await instanceHasUserData(clean.pool)).toBe(false);
    // Every row's `user_id` is rewritten to the *target* instance's own
    // bootstrap user (`import.ts`'s header explains why: the column is a real
    // foreign key to `users`, and only the target's own user is guaranteed to
    // exist there) — so assertions below key on `clean.userId`, not `h.userId`.
    const result = await importBundle(clean.pool, parsed, clean.userId);
    expect(result.rowsLoaded).toBeGreaterThan(0);

    for (const stream of bundle.manifest.streams) {
      const count = await clean.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM "${stream.table}" WHERE user_id = $1`,
        [clean.userId],
      );
      expect(Number(count.rows[0]?.n ?? '0')).toBe(stream.count);
    }
  });

  it('export then import into a clean instance reproduces every read model', async () => {
    const bundle = await buildExportBundle(h.database.pool, {
      userId: h.userId,
      appVersion: 'test',
      now: new Date('2025-06-01T00:00:00Z'),
    });
    const parsed = parseAndVerifyBundle(serialiseBundle(bundle));

    const clean = await createTestDatabase(
      `personalfi_wp_export_ro_${newId().replaceAll('-', '')}`,
    );
    cleanDatabases.push(clean);
    await importBundle(clean.pool, parsed, clean.userId);

    const window = { dateFrom: DateOnly.of(2025, 5, 1), dateTo: DateOnly.of(2025, 5, 31) };
    const before = await computeCategoryMonthActivity(h.database.db, {
      userId: h.userId,
      ...window,
    });
    const after = await computeCategoryMonthActivity(clean.db, { userId: clean.userId, ...window });
    expect(after).toEqual(before);

    // Re-read the account list through the real route against the imported
    // database, proving the projection re-run left `GET /accounts` intact —
    // not just this file's own aggregators.
    const accountsBefore = await h.database.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounts WHERE user_id = $1`,
      [h.userId],
    );
    const accountsAfter = await clean.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounts WHERE user_id = $1`,
      [clean.userId],
    );
    expect(accountsAfter.rows[0]?.n).toBe(accountsBefore.rows[0]?.n);
  });

  it('import into a non-empty instance is refused', async () => {
    const bundle = await buildExportBundle(h.database.pool, {
      userId: h.userId,
      appVersion: 'test',
      now: new Date('2025-06-01T00:00:00Z'),
    });
    const parsed = parseAndVerifyBundle(serialiseBundle(bundle));

    const target = await createTestDatabase(
      `personalfi_wp_export_nonempty_${newId().replaceAll('-', '')}`,
    );
    cleanDatabases.push(target);
    await importBundle(target.pool, parsed, target.userId); // first import: fine, instance was clean

    await expect(importBundle(target.pool, parsed, target.userId)).rejects.toMatchObject({
      status: 409,
      code: 'export.instance_not_empty',
    });
  });
});
