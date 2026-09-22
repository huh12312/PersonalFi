// SPDX-License-Identifier: MIT
/**
 * D2-1 (docs/evidence/phase-1/gate-security-review.md §9.4, MEDIUM) and its
 * Phase 2 sequel, condition **C-1**
 * (docs/evidence/phase-2/gate-security-review.md §5): a fresh install never
 * seeded a user's per-user state (taxonomy, advisor catalogue, schedules)
 * until the *next* api/worker restart.
 *
 * ## What changed under C-1
 *
 * D2-1's original fix was two independent lazy repairs — one in
 * `GET /categories`, a second in `GET /advisors` for G2-1's later, identical
 * shape — plus a belt-and-braces `ensureTaxonomy` call in
 * `bin/bootstrap-user.ts`. The gate's condition was that two lazy repairs for
 * one root cause is itself a defect: the fix belongs at the moment a user is
 * *created*, not at the next read. Both lazy repairs are deleted now
 * (`routes/categories.ts`, `routes/insights.ts`); the single call site is
 * `apps/api/src/bootstrap-seed.ts`'s `seedUserState`, called once from
 * `bin/bootstrap-user.ts` and kept, unconditionally, as `app.ts`'s `onReady`
 * repair pass for installs that predate this file.
 * `apps/api/test/db/phase3-cold-install.test.ts` is the test that proves the
 * *root* fix end to end (build the app, create the user through the real
 * bootstrap path, read categories/advisors/schedules with no restart); this
 * file keeps the narrower, longstanding claims the two repairs used to carry.
 *
 * **Sabotage.** Test 1 below is now a negative: it proves the lazy repair is
 * actually gone, not merely hard to trigger — comment `seedUserState`'s call
 * back in at `routes/categories.ts` and it fails. Test 2 proves
 * `bootstrap-user.ts` still calls the (now single) composition-root seeding
 * function; comment out that call and it fails.
 */
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

describe.skipIf(NO_DATABASE)('GET /categories carries no lazy repair (C-1)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'taxboot' });
  }, 300_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('a user inserted straight into `users` after boot reads an empty chart, not a lazily-repaired one', async () => {
    // `app.ready()` already ran the `onReady` pass, for the harness's own
    // primary user, before this test starts — exactly what `just up` does.
    // This second user is created straight into `users` *after* that boot
    // pass and *never* through `bootstrap-seed.ts`'s `seedUserState` — the
    // one thing that still seeds a user's taxonomy today. If `GET /categories`
    // grew its lazy repair back, this would read the full chart instead.
    const laterUserId = await h.database.createUser('Created After Boot, Raw Insert');
    const laterSession = await h.issueSession({ userId: laterUserId });

    const response = await h.request({
      method: 'GET',
      url: '/categories',
      session: laterSession,
    });
    expectStatus(response, 200);
    const categories = (response.json() as { categories: { key: string }[] }).categories;
    expect(categories).toHaveLength(0);
  });
});

describe('bootstrap-user seeds a new user through the single composition-root function (C-1)', () => {
  it('calls seedUserState right after createPrimary, not only through the api onReady pass', () => {
    const source = repoFile('apps/api/src/bin/bootstrap-user.ts');

    expect(
      /import\s*\{\s*seedUserState\s*\}\s*from\s*'\.\.\/bootstrap-seed\.ts';/.test(source),
      'apps/api/src/bin/bootstrap-user.ts no longer imports seedUserState from bootstrap-seed.ts.',
    ).toBe(true);
    expect(
      /import\s*\{\s*ensureTaxonomy\s*\}\s*from\s*'@ctx\/categorization';/.test(source),
      'bootstrap-user.ts still imports ensureTaxonomy directly — C-1 moved that call into the ' +
        'single seedUserState composition root; a direct import here would mean two call sites ' +
        'again.',
    ).toBe(false);

    // The branch that actually creates a new primary user — as opposed to the
    // `reissue` branch, which runs for a user that already exists and whose
    // state (if any install ever needed it) was already handled.
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
      createBlock?.includes('seedUserState('),
      'bootstrap-user.ts creates the primary user but never seeds its per-user state — the api ' +
        '`onReady` pass only seeds a user that already existed the last time the api booted, so ' +
        'the account this command just made would read an empty picker (`GET /categories`) and ' +
        'an empty catalogue (`GET /advisors`) until the next restart. This is condition C-1, ' +
        'gate-security-review.md §5.',
    ).toBe(true);
  });
});
