// SPDX-License-Identifier: MIT
/**
 * D2-1 (docs/evidence/phase-1/gate-security-review.md §9.4, MEDIUM): a fresh
 * install never seeded the taxonomy for a user created after boot.
 *
 * ## What the re-walk found
 *
 * `ensureTaxonomy` ran only at api `onReady`, and the RUNBOOK bootstraps the
 * account holder *after* `up` — so `GET /categories` stayed `[]` until
 * somebody restarted the api. Every screen that needs a category (05 §5.2's
 * picker, WP 2.5's rule and manual-entry routes, every Phase 2 screen after
 * it) inherits an empty chart on the one path every real install actually
 * takes: cold boot, then bootstrap.
 *
 * ## The two new call sites
 *
 * 1. `GET /categories` (`routes/categories.ts`) lazily repairs a session's
 *    user with zero rows — covers *every* user-creation path, present or
 *    future, with no api restart. Proven below against a real database.
 * 2. `apps/api/src/bin/bootstrap-user.ts` calls `ensureTaxonomy` immediately
 *    after `createPrimary`, for the specific, common case of the very first
 *    account holder — belt and braces with (1), and cheap insurance against a
 *    screen that reads the taxonomy through some path other than `GET
 *    /categories` one day. Proven below against the script's own source,
 *    which is the same shape `regate-worker-boot.test.ts` already uses for a
 *    composition-root claim that a runtime rebuild cannot make more true.
 *
 * The api's `onReady` pass (`app.ts`) is unchanged and stays as the idempotent
 * repair for an install that already has users when a new release adds
 * categories to `TAXONOMY` — `closeout-categories.test.ts` keeps that claim.
 *
 * **Sabotage.** Deleting either call site turns exactly the test naming it
 * red: comment out the lazy-repair block in `routes/categories.ts` and the
 * first test below fails; comment out the `ensureTaxonomy` call in
 * `bootstrap-user.ts` and the second does. Both were observed red before this
 * WP added them and green after.
 */
import { FLAT_TAXONOMY } from '@ctx/categorization';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), 'utf8');

describe.skipIf(NO_DATABASE)('a user created after boot has a taxonomy (D2-1, call site 1)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'taxboot' });
  }, 300_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('a user created after boot has a taxonomy without an api restart', async () => {
    // `app.ready()` already ran the `onReady` pass, for the harness's own
    // primary user, before this test starts — exactly what `just up` does.
    // This second user is created straight into `users` *after* that boot
    // pass, the way `bootstrap-user` creates the real account holder, and
    // nothing here restarts the application in between.
    const laterUserId = await h.database.createUser('Created After Boot');
    const laterSession = await h.issueSession({ userId: laterUserId });

    const response = await h.request({
      method: 'GET',
      url: '/categories',
      session: laterSession,
    });
    expectStatus(response, 200);
    const categories = (response.json() as { categories: { key: string }[] }).categories;

    // Non-vacuous: the empty array is precisely D2-1, so this is asserted
    // against the shipped constant rather than "greater than zero".
    expect(categories).toHaveLength(FLAT_TAXONOMY.length);
    expect(new Set(categories.map((c) => c.key))).toEqual(
      new Set(FLAT_TAXONOMY.map((entry) => entry.key)),
    );
  });
});

describe('bootstrap-user seeds the taxonomy for the user it creates (D2-1, call site 2)', () => {
  it('calls ensureTaxonomy right after createPrimary, not only through the api onReady pass', () => {
    const source = repoFile('apps/api/src/bin/bootstrap-user.ts');

    expect(
      /import\s*\{\s*ensureTaxonomy\s*\}\s*from\s*'@ctx\/categorization';/.test(source),
      'apps/api/src/bin/bootstrap-user.ts no longer imports ensureTaxonomy.',
    ).toBe(true);

    // The branch that actually creates a new primary user — as opposed to the
    // `reissue` branch, which runs for a user that already exists and whose
    // taxonomy (if any install ever needed one) was already handled.
    const createBlock = /if \(user === null\) \{([\s\S]*?)\n {2}\} else \{/.exec(source)?.[1];
    expect(
      createBlock,
      'bootstrap-user.ts restructured its create-vs-reissue branch; this test’s regex needs ' +
        'to move with it.',
    ).toBeDefined();

    expect(
      createBlock?.includes('createPrimary('),
      'the create-user branch no longer calls createPrimary; sanity-checking the regex matched ' +
        'the right block.',
    ).toBe(true);

    expect(
      createBlock?.includes('ensureTaxonomy('),
      'bootstrap-user.ts creates the primary user but never seeds the taxonomy for it — the api ' +
        '`onReady` pass only seeds a user that already existed the last time the api booted, so ' +
        'the account this command just made would read an empty picker (`GET /categories`) until ' +
        'the next restart. This is D2-1, gate-security-review.md §9.4.',
    ).toBe(true);
  });
});
