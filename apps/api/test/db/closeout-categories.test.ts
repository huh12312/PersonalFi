// SPDX-License-Identifier: MIT
/**
 * `GET /categories` and the boot pass behind it — gate condition D-6 (finding
 * N-3), over a real database and through the real application.
 *
 * ## What the re-gate actually found
 *
 * The write path worked: `PATCH /transactions/{id}` with a `categoryId` was
 * proven, in a browser, against the running deployment, to persist and read
 * back. What did not exist was anything to pick *from* —
 * `Object.keys(openapi.paths).filter(p => /categor/.test(p))` was `[]` and
 * `select count(*) from categories` was `0` — so the app shipped a taxonomy
 * nobody could reach. The two halves of the fix are a route and a boot pass, and
 * either one alone leaves the picker empty, so this file tests them together and
 * never calls `seedSystemTaxonomy` before the assertion that matters.
 *
 * ## The strongest claim here is the one with no arrange step
 *
 * The first test does no setup at all. `createApiHarness` creates a scratch
 * database, runs the migrations, inserts one user, and calls `app.ready()` —
 * which is `main.ts`'s own boot sequence, and which fires the `onReady` hook in
 * `app.ts`. If that hook did not exist, or if it seeded the wrong user, or if it
 * swallowed an error into an empty table, the very first assertion goes red
 * against an empty array. That is exactly the shape of the defect the re-gate
 * found from the outside, reproduced from the inside.
 */
import { FLAT_TAXONOMY, UNCATEGORISED_KEY, ensureTaxonomy } from '@ctx/categorization';
import { systemClock } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface WireCategory {
  readonly id: string;
  readonly key: string;
  readonly parentId: string | null;
  readonly label: string;
  readonly kind: string;
  readonly sort: number;
  readonly isSystem: boolean;
  readonly archivedAt: string | null;
  readonly assignable: boolean;
}

describe.skipIf(NO_DATABASE)('GET /categories (gate condition D-6)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'categories' });
  }, 300_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  async function list(
    session = h.stale,
    query = '',
  ): Promise<{ status: number; categories: WireCategory[] }> {
    const response = await h.request({ method: 'GET', url: `/categories${query}`, session });
    return {
      status: response.statusCode,
      categories:
        response.statusCode === 200
          ? (response.json() as { categories: WireCategory[] }).categories
          : [],
    };
  }

  it('serves the whole shipped taxonomy on a fresh database, with no seeding step', async () => {
    const { status, categories } = await list();
    expect(status).toBe(200);

    // Non-vacuous by construction: the empty array is precisely the bug, so the
    // count is asserted against the shipped constant rather than "greater than
    // zero". A category added to `TAXONOMY` in a later release appears here on
    // the next boot, which is why the pass runs every boot and not once.
    expect(categories).not.toHaveLength(0);
    expect(categories).toHaveLength(FLAT_TAXONOMY.length);
    expect(new Set(categories.map((c) => c.key))).toEqual(
      new Set(FLAT_TAXONOMY.map((entry) => entry.key)),
    );
    expect(categories.every((c) => c.isSystem)).toBe(true);

    // Display order, as the picker will render it: `sort` is non-decreasing, so
    // the client groups by walking the list rather than by re-sorting it.
    const sorts = categories.map((c) => c.sort);
    expect([...sorts].sort((a, b) => a - b)).toEqual(sorts);

    // Every `parentId` resolves to a row in the same response. A dangling parent
    // would render as an orphaned group heading in `CategoryPicker`.
    const ids = new Set(categories.map((c) => c.id));
    const parented = categories.filter((c) => c.parentId !== null);
    expect(parented.length).toBeGreaterThan(0);
    expect(parented.filter((c) => !ids.has(c.parentId ?? ''))).toEqual([]);

    // `assignable` is the read model's own computation, not a client rule: a
    // heading with children is a grouping, a leaf is a destination, and
    // `uncategorised` is childless on purpose because "we do not know" does not
    // decompose.
    const byKey = new Map(categories.map((c) => [c.key, c]));
    const headings = categories.filter((c) => c.parentId === null && c.key !== UNCATEGORISED_KEY);
    expect(headings.length).toBeGreaterThan(0);
    expect(headings.every((c) => !c.assignable)).toBe(true);
    expect(parented.every((c) => c.assignable)).toBe(true);
    expect(byKey.get(UNCATEGORISED_KEY)?.assignable).toBe(true);
  });

  it('is idempotent across boots: a second pass inserts nothing and changes no id', async () => {
    const before = await list();
    // What a restart does. The re-gate's fix is worthless if the second boot
    // duplicates the chart or re-issues ids that `category_assignments` and the
    // transactions overlay already point at.
    const again = await ensureTaxonomy(h.database.db, {
      userIds: [h.database.userId],
      clock: systemClock,
    });
    expect(again.categoriesInserted).toBe(0);

    const after = await list();
    expect(after.categories.map((c) => c.id)).toEqual(before.categories.map((c) => c.id));
  });

  it('refuses an unauthenticated caller with 401', async () => {
    const response = await h.request({ method: 'GET', url: '/categories' });
    expectStatus(response, 401);
    const problem = response.json() as { code?: string };
    expect(problem.code).toBeDefined();
  });

  it('hides an archived category unless it is asked for', async () => {
    const baseline = await list();
    const victim = baseline.categories.find((c) => c.parentId !== null);
    expect(victim).toBeDefined();

    await h.database.db.execute(sql`
      UPDATE categories SET archived_at = now()
       WHERE user_id = ${h.database.userId} AND id = ${victim?.id ?? ''}
    `);

    // A picker must not offer a category the user retired…
    const hidden = await list();
    expect(hidden.categories.map((c) => c.id)).not.toContain(victim?.id);
    expect(hidden.categories).toHaveLength(baseline.categories.length - 1);

    // …and a management screen must still be able to see it, because a budget
    // from March still points at it and has to say what it meant.
    const shown = await list(h.stale, '?includeArchived=true');
    const found = shown.categories.find((c) => c.id === victim?.id);
    expect(found).toBeDefined();
    expect(found?.archivedAt).not.toBeNull();

    await h.database.db.execute(sql`
      UPDATE categories SET archived_at = NULL
       WHERE user_id = ${h.database.userId} AND id = ${victim?.id ?? ''}
    `);
  });

  it('gives a second user their own chart and never the first user’s rows', async () => {
    const otherUserId = await h.database.createUser('Second Holder');

    // The boot pass seeds the users identity names, and identity's only
    // enumeration today is `findPrimary` — because `createPrimary` refuses a
    // second user outright. So a row inserted straight into `users` (which only
    // a test can do) has no chart, and gets a 200 with an empty list rather than
    // somebody else's categories. Asserted rather than glossed over: "empty" and
    // "the first user's" are very different failures and this pins which one.
    const otherSession = await h.issueSession({ userId: otherUserId });
    const beforeSeeding = await list(otherSession);
    expect(beforeSeeding.status).toBe(200);
    expect(beforeSeeding.categories).toEqual([]);

    // What a multi-user build's boot pass does: the same call, more ids.
    // `ensureTaxonomy` takes a list precisely so this is the only line that
    // changes when identity grows a reader that returns more than one.
    const pass = await ensureTaxonomy(h.database.db, {
      userIds: [h.database.userId, otherUserId],
      clock: systemClock,
    });
    expect(pass.users).toBe(2);
    // The first user's chart already exists, so only the second user's rows are
    // new — which is the idempotency claim and the per-user claim at once.
    expect(pass.categoriesInserted).toBe(FLAT_TAXONOMY.length);

    const mine = await list();
    const theirs = await list(otherSession);
    expect(theirs.categories).toHaveLength(FLAT_TAXONOMY.length);

    // Same chart, disjoint rows (decision D6: `user_id` on every user-scoped
    // table). The id sets must not intersect at all — a shared id would mean one
    // user's rename showed up on the other's picker.
    expect(theirs.categories.map((c) => c.key)).toEqual(mine.categories.map((c) => c.key));
    const mineIds = new Set(mine.categories.map((c) => c.id));
    expect(theirs.categories.filter((c) => mineIds.has(c.id))).toEqual([]);

    // And the route scopes by the session, not by anything a caller supplies:
    // every id it handed the second user belongs to the second user in the
    // table. Checked in SQL, because "the response looks right" and "the rows
    // are theirs" are different claims and only the second one is the invariant.
    const owners = await h.database.db.execute<{ user_id: string; count: string }>(sql`
      SELECT user_id, count(*) AS count
        FROM categories
       WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(
         theirs.categories.map((c) => c.id),
       )}::jsonb)::uuid)
       GROUP BY user_id
    `);
    expect(owners.rows).toHaveLength(1);
    expect(owners.rows[0]?.user_id).toBe(otherUserId);
    expect(Number(owners.rows[0]?.count)).toBe(FLAT_TAXONOMY.length);
  });
});
