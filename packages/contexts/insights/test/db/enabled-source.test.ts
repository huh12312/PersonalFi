// SPDX-License-Identifier: MIT
/**
 * `advisors.enabled_source` (WP 5.1): a catalogue default follows the
 * catalogue until a human — or WP 5.9's feedback loop — overrides it.
 *
 * `apps/api`'s `registerBuiltinAdvisors` re-registers the whole catalogue with
 * `enabled: entry.defaultEnabled` on every api boot (`bootstrap-seed.ts`,
 * `app.ts`'s `onReady`). Before this column the conflict branch wrote that
 * value unconditionally, so a restart undid a user's own switch — the red
 * this test was first run against (docs/evidence/phase-5/wp5.1-run-control.md
 * §7). With it, the boot pass moves only rows nobody touched: a wave released
 * in a later phase reaches an existing install, and a human's answer — even
 * one that happens to equal the default — is never overwritten.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { advisors } from '../../schema/index.ts';
import { registerAdvisor, setAdvisorEnabled } from '../../src/store.ts';
import { baseManifest } from '../fixtures.ts';
import { NO_DATABASE, contextFor, insightsDatabase, type TestDatabase } from './harness.ts';

describe.skipIf(NO_DATABASE)('advisors.enabled_source', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database ??= await insightsDatabase('enabled_src');
    await database.truncate();
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  async function enabledOf(advisorId: string): Promise<boolean | undefined> {
    const rows = await database.db
      .select({ enabled: advisors.enabled })
      .from(advisors)
      .where(and(eq(advisors.userId, database.userId), eq(advisors.advisorId, advisorId)));
    return rows[0]?.enabled;
  }

  it('a changed catalogue default reaches rows nobody touched and never a row a human set', async () => {
    const context = contextFor(database.userId);
    const manifest = (id: string) => baseManifest({ advisor_id: id });

    // Release N's catalogue.
    const releaseN: Record<string, boolean> = {
      'builtin.wave.untouched_off': false, // released later: default flips to on
      'builtin.wave.untouched_on': true, // withdrawn later: default flips to off
      'builtin.wave.human_off': true, // a human switches it off
      'builtin.wave.human_on': false, // a human switches it on
      'builtin.wave.human_same': false, // a human says "off" — equal to the default
    };
    for (const [id, enabled] of Object.entries(releaseN)) {
      await registerAdvisor(database.db, context, { manifest: manifest(id), enabled });
    }

    await setAdvisorEnabled(database.db, context, 'builtin.wave.human_off', false);
    await setAdvisorEnabled(database.db, context, 'builtin.wave.human_on', true);
    await setAdvisorEnabled(database.db, context, 'builtin.wave.human_same', false);

    // Release N+1's catalogue, re-registered the way every api boot does it.
    const releaseN1: Record<string, boolean> = {
      'builtin.wave.untouched_off': true,
      'builtin.wave.untouched_on': false,
      'builtin.wave.human_off': true,
      'builtin.wave.human_on': false,
      'builtin.wave.human_same': true,
    };
    for (const [id, enabled] of Object.entries(releaseN1)) {
      await registerAdvisor(database.db, context, {
        manifest: { ...manifest(id), version: '1.1.0' },
        enabled,
      });
    }

    // Untouched rows follow the catalogue, both directions.
    expect(await enabledOf('builtin.wave.untouched_off')).toBe(true);
    expect(await enabledOf('builtin.wave.untouched_on')).toBe(false);
    // A human's answer stands, including one that equalled the old default.
    expect(await enabledOf('builtin.wave.human_off')).toBe(false);
    expect(await enabledOf('builtin.wave.human_on')).toBe(true);
    expect(await enabledOf('builtin.wave.human_same')).toBe(false);
  }, 30_000);
});
