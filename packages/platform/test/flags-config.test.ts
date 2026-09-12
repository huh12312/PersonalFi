// SPDX-License-Identifier: MIT
import { mutableClock } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { latestConfigSnapshot, recordConfigSnapshot } from '../src/config-snapshot.ts';
import { createFlagService, PLATFORM_FLAGS, type FlagDefinition } from '../src/flags/flags.ts';
import { ADMIN_URL, createTestDatabase, recordingLogger, waitFor, type TestDatabase } from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

const DEFAULTS: readonly FlagDefinition[] = [
  ...PLATFORM_FLAGS,
  {
    key: 'module.budgeting',
    defaultEnabled: true,
    owner: 'budgeting',
    removeWhen: 'Phase 2 ships and budgets have run for a month',
  },
  {
    key: 'module.investments',
    defaultEnabled: false,
    owner: 'investments',
    removeWhen: 'Phase 3 ships',
  },
];

describeWithDb('feature flags', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp03_flags');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  beforeEach(async () => {
    await database.truncate();
  });

  it('falls back to the coded default when no row exists', async () => {
    const flags = createFlagService({ db: database.db, defaults: DEFAULTS });
    expect(await flags.isEnabled(database.userId, 'module.budgeting')).toBe(true);
    expect(await flags.isEnabled(database.userId, 'module.investments')).toBe(false);
    await flags.close();
  });

  it('lets a database row override the default', async () => {
    const flags = createFlagService({ db: database.db, defaults: DEFAULTS });
    await flags.set(database.db, database.userId, 'module.investments', true);
    expect(await flags.isEnabled(database.userId, 'module.investments')).toBe(true);
    await flags.close();
  });

  it('treats an unknown key as disabled and says so, rather than failing open', async () => {
    // A typo in a flag name must not silently enable a half-finished module.
    const logger = recordingLogger();
    const flags = createFlagService({ db: database.db, defaults: DEFAULTS, logger });
    expect(await flags.isEnabled(database.userId, 'module.budgetting')).toBe(false);
    expect(logger.lines.some((line) => line.level === 'warn')).toBe(true);
    await flags.close();
  });

  it('caches reads and stops serving stale values once the ttl passes', async () => {
    const clock = mutableClock('2026-03-01T12:00:00Z');
    const flags = createFlagService({ db: database.db, defaults: DEFAULTS, clock, ttlMs: 30_000 });
    expect(await flags.isEnabled(database.userId, 'module.investments')).toBe(false);

    // A write that bypasses the service entirely — another process, or psql.
    await database.db.execute(sql`
      INSERT INTO feature_flags (user_id, key, enabled)
      VALUES (${database.userId}::uuid, 'module.investments', true)
    `);
    expect(await flags.isEnabled(database.userId, 'module.investments'), 'still cached').toBe(false);

    clock.advanceMs(31_000);
    expect(await flags.isEnabled(database.userId, 'module.investments')).toBe(true);
    await flags.close();
  });

  /**
   * Cross-process invalidation is what stops "I turned the module on and the
   * worker did not notice" — a state that looks like a bug in the module rather
   * than a stale cache, and costs an hour to diagnose.
   */
  it('invalidates every process cache when any process writes a flag', async () => {
    const clock = mutableClock('2026-03-01T12:00:00Z');
    const apiSide = createFlagService({ db: database.db, defaults: DEFAULTS, clock, ttlMs: 600_000 });
    const workerSide = createFlagService({ db: database.db, defaults: DEFAULTS, clock, ttlMs: 600_000 });
    await workerSide.watch(database.pool);

    expect(await workerSide.isEnabled(database.userId, 'module.investments')).toBe(false);
    await apiSide.set(database.db, database.userId, 'module.investments', true);

    await waitFor(
      async () => (await workerSide.isEnabled(database.userId, 'module.investments')) === true,
      { timeoutMs: 8_000, what: 'the worker-side flag cache to be invalidated by NOTIFY' },
    );

    await apiSide.close();
    await workerSide.close();
  }, 30_000);

  it('returns every resolved flag for the settings UI', async () => {
    const flags = createFlagService({ db: database.db, defaults: DEFAULTS });
    const all = await flags.all(database.userId);
    expect(all['module.budgeting']).toBe(true);
    expect(all['platform.scheduler']).toBe(true);
    await flags.close();
  });

  it('gives every flag an owner and a removal criterion', () => {
    // A flag with no removal criterion is permanent configuration wearing a
    // flag's clothes, and the 90-day staleness warning has nothing to say to it.
    for (const definition of PLATFORM_FLAGS) {
      expect(definition.owner.length).toBeGreaterThan(0);
      expect(definition.removeWhen.length).toBeGreaterThan(0);
    }
  });
});

describeWithDb('config snapshots', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp03_config');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  beforeEach(async () => {
    await database.truncate();
  });

  it('records a boot and counts repeats of the same configuration', async () => {
    const payload = { LOG_LEVEL: 'info', HTTP_PORT: 8080, secretsPresent: ['database_url'] };

    const first = await recordConfigSnapshot(database.db, {
      role: 'api',
      payload,
      appVersion: '0.1.0',
    });
    expect(first.isNew).toBe(true);
    expect(first.bootCount).toBe(1);

    // A container restarting in a loop must bump a counter, not fill a table.
    const second = await recordConfigSnapshot(database.db, {
      role: 'api',
      payload: { HTTP_PORT: 8080, LOG_LEVEL: 'info', secretsPresent: ['database_url'] },
      appVersion: '0.1.0',
    });
    expect(second.isNew).toBe(false);
    expect(second.bootCount).toBe(2);
    expect(second.hash).toBe(first.hash);

    const rows = await database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM config_snapshots`,
    );
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('records a new row when something actually changed', async () => {
    await recordConfigSnapshot(database.db, {
      role: 'api',
      payload: { LOG_LEVEL: 'info' },
      appVersion: '0.1.0',
    });
    const changed = await recordConfigSnapshot(database.db, {
      role: 'api',
      payload: { LOG_LEVEL: 'debug' },
      appVersion: '0.1.0',
    });
    expect(changed.isNew).toBe(true);

    const latest = await latestConfigSnapshot(database.db, 'api');
    expect((latest?.['payload'] as { LOG_LEVEL: string }).LOG_LEVEL).toBe('debug');
  });

  it('keeps the api and worker records apart', async () => {
    const payload = { LOG_LEVEL: 'info' };
    await recordConfigSnapshot(database.db, { role: 'api', payload, appVersion: '0.1.0' });
    await recordConfigSnapshot(database.db, { role: 'worker', payload, appVersion: '0.1.0' });
    const rows = await database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM config_snapshots`,
    );
    expect(rows.rows[0]?.count).toBe('2');
  });
});
