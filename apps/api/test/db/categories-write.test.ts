// SPDX-License-Identifier: MIT
/**
 * `POST`/`PATCH`/`DELETE /categories` — WP 2.5's write half of the chart of
 * categories (closeout-architecture.md §4: "No `POST /categories`. The picker
 * is read-only, and 05 §5.2's searchable combobox with a 'create new category'
 * escape hatch still needs a write route to be worth building").
 *
 * The claims:
 *
 * 1. **The two-level `CHECK` (migration 0006) is enforced before the write.**
 *    A category may have at most two levels; a third is refused with a
 *    problem detail a client can act on, not a raw constraint violation.
 * 2. **Archiving preserves history.** `DELETE /categories/{id}` archives, and
 *    a transaction already filed under it keeps resolving to the same id
 *    after the archive — a report from before the archive must still say what
 *    it meant.
 */
import { manualTransaction } from '@connector/manual';
import { DateOnly, money } from '@core/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  problemOf,
  type ApiHarness,
  type TestSession,
} from '../helpers/api-harness.ts';

const CHECKING = 'checking';

interface WireCategory {
  readonly id: string;
  readonly key: string;
  readonly parentId: string | null;
  readonly label: string;
  readonly archivedAt: string | null;
  readonly assignable: boolean;
}

describe.skipIf(NO_DATABASE)('POST/PATCH/DELETE /categories (WP 2.5)', () => {
  let h: ApiHarness;

  async function categories(
    session: TestSession = h.stale,
    includeArchived = false,
  ): Promise<WireCategory[]> {
    const response = await h.request({
      method: 'GET',
      url: `/categories${includeArchived ? '?includeArchived=true' : ''}`,
      session,
    });
    expectStatus(response, 200);
    return (response.json() as { categories: WireCategory[] }).categories;
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'catwrite' });
  }, 300_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('a third level is refused', async () => {
    const heading = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: null, label: 'Top Level Heading', kind: 'expense' },
    });
    expectStatus(heading, 201);
    const headingCategory = (heading.json() as { category: WireCategory }).category;
    expect(headingCategory.parentId).toBeNull();

    const leaf = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: headingCategory.id, label: 'Second Level Leaf' },
    });
    expectStatus(leaf, 201);
    const leafCategory = (leaf.json() as { category: WireCategory }).category;
    expect(leafCategory.parentId).toBe(headingCategory.id);

    // The leaf already has a parent of its own; a category under *it* would be
    // a third level, and the two-level `CHECK` refuses it before the insert.
    const thirdLevel = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: leafCategory.id, label: 'Third Level' },
    });
    expect(thirdLevel.statusCode).toBe(422);
    expect(problemOf(thirdLevel)['code']).toBe('categorization.category_third_level_refused');

    // And nothing was created: the chart is unchanged apart from the two rows
    // this test made on purpose.
    const chart = await categories();
    expect(chart.some((c) => c.label === 'Third Level')).toBe(false);
  });

  it('archiving a category in use leaves its assignments resolvable', async () => {
    const created = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: null, label: 'Soon Retired', kind: 'expense' },
    });
    expectStatus(created, 201);
    const category = (created.json() as { category: WireCategory }).category;

    const link = await linkManual(h, {
      providerConnectionId: 'catwrite-conn',
      displayName: 'Archive Test Bank',
      accounts: [
        { providerAccountId: CHECKING, name: 'Everyday', type: 'depository', currency: 'USD' },
      ],
      batch: {
        added: [
          manualTransaction({
            providerAccountId: CHECKING,
            amount: money(-1_234n, 'USD'),
            postedDate: DateOnly.of(2026, 2, 1),
            name: 'SOMETHING TO CATEGORISE',
          }),
        ],
      },
    });
    void link;

    const list = await h.request({ method: 'GET', url: '/transactions', session: h.stale });
    expectStatus(list, 200);
    const target = (list.json() as { items: { id: string; name: string }[] }).items.find((t) =>
      t.name.toUpperCase().includes('SOMETHING TO CATEGORISE'),
    );
    expect(target).toBeDefined();

    const patched = await h.request({
      method: 'PATCH',
      url: `/transactions/${target?.id ?? ''}`,
      session: h.stale,
      body: { categoryId: category.id },
    });
    expectStatus(patched, 200);
    expect((patched.json() as { categoryId: string | null }).categoryId).toBe(category.id);

    const archived = await h.request({
      method: 'DELETE',
      url: `/categories/${category.id}`,
      session: h.stale,
    });
    expectStatus(archived, 200);
    const archiveResult = archived.json() as {
      category: WireCategory;
      changed: boolean;
      childrenArchived: number;
    };
    expect(archiveResult.changed).toBe(true);
    expect(archiveResult.category.archivedAt).not.toBeNull();

    // Gone from the default (picker) list…
    const visible = await categories();
    expect(visible.some((c) => c.id === category.id)).toBe(false);

    // …but still there, and still itself, for a management screen or an old
    // report that has to say what a March transaction meant.
    const everything = await categories(h.stale, true);
    const stillThere = everything.find((c) => c.id === category.id);
    expect(stillThere).toBeDefined();
    expect(stillThere?.archivedAt).not.toBeNull();
    expect(stillThere?.label).toBe('Soon Retired');

    // The assignment itself never moved or nulled out.
    const detail = await h.request({
      method: 'GET',
      url: `/transactions/${target?.id ?? ''}`,
      session: h.stale,
    });
    expectStatus(detail, 200);
    expect((detail.json() as { categoryId: string | null }).categoryId).toBe(category.id);

    // Archiving twice is a no-op the second time, not an error.
    const archiveAgain = await h.request({
      method: 'DELETE',
      url: `/categories/${category.id}`,
      session: h.stale,
    });
    expectStatus(archiveAgain, 200);
    expect((archiveAgain.json() as { changed: boolean }).changed).toBe(false);
  });

  it('refuses every category write without a session, with 401', async () => {
    const noSession = {
      accessToken: 'not-a-real-session-token',
      csrf: 'x'.repeat(40),
      fresh: false,
    };
    const someId = '00000000-0000-4000-8000-000000000000';
    const attempts = [
      {
        method: 'POST' as const,
        url: '/categories',
        session: noSession,
        body: { parentId: null, label: 'x' },
      },
      {
        method: 'PATCH' as const,
        url: `/categories/${someId}`,
        session: noSession,
        body: { label: 'x' },
      },
      { method: 'DELETE' as const, url: `/categories/${someId}`, session: noSession },
    ];
    for (const attempt of attempts) {
      const response = await h.request(attempt);
      expect(response.statusCode).toBe(401);
    }
  });

  it('a category may not be renamed or archived by another user', async () => {
    const mine = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: null, label: 'Only Mine' },
    });
    expectStatus(mine, 201);
    const category = (mine.json() as { category: WireCategory }).category;

    const otherUserId = await h.database.createUser('Category Interloper');
    const otherSession = await h.issueSession({ userId: otherUserId });

    const rename = await h.request({
      method: 'PATCH',
      url: `/categories/${category.id}`,
      session: otherSession,
      body: { label: 'Hijacked' },
    });
    expect(rename.statusCode).toBe(404);

    const archive = await h.request({
      method: 'DELETE',
      url: `/categories/${category.id}`,
      session: otherSession,
    });
    expect(archive.statusCode).toBe(404);

    const stillMine = await categories();
    expect(stillMine.find((c) => c.id === category.id)?.label).toBe('Only Mine');
  });
});
