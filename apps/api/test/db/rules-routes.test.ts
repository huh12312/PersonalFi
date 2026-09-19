// SPDX-License-Identifier: MIT
/**
 * `/rules` and `POST /transactions/{id}/rule` — WP 2.5's REST surface over the
 * rule language `@ctx/categorization` has carried since WP 1.4 with no route
 * (wp1.4 evidence §9: "the wiring test above inserts a rule with raw SQL for
 * exactly this reason").
 *
 * The claims:
 *
 * 1. **A preview costs nothing and promises the truth.** `POST /rules/preview`
 *    runs the exact code path `POST /rules/{id}/apply` runs, `dryRun`, so the
 *    count it shows is the count the later apply actually produces.
 * 2. **A rule cannot reach across users.** `set_category` may only name a
 *    category this session's user owns — checked in the database, not by
 *    trusting the key's shape, because a custom category's key is user-chosen
 *    text with no format that says "this is somebody else's".
 * 3. **A session is enough.** No route here needs a step-up assertion (see
 *    `rules.ts`'s module comment) — a stolen cookie can already `PATCH
 *    /transactions/{id}`'s category, and a rule is the same shape of write.
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
  readonly assignable: boolean;
  readonly parentId: string | null;
}

interface WireRule {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly createdFromTransactionId: string | null;
}

interface ApplyResult {
  readonly ruleId: string;
  readonly runId: string;
  readonly preview: boolean;
  readonly matchedCount: number;
  readonly changedCount: number;
  readonly sample: readonly { transactionId: string; payee: string }[];
}

describe.skipIf(NO_DATABASE)('/rules and POST /transactions/{id}/rule (WP 2.5)', () => {
  let h: ApiHarness;
  let leafCategoryKey: string;

  async function categories(session: TestSession = h.stale): Promise<WireCategory[]> {
    const response = await h.request({ method: 'GET', url: '/categories', session });
    expectStatus(response, 200);
    return (response.json() as { categories: WireCategory[] }).categories;
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'rules' });

    await linkManual(h, {
      providerConnectionId: 'rules-conn',
      displayName: 'Rules Bank',
      accounts: [
        { providerAccountId: CHECKING, name: 'Everyday', type: 'depository', currency: 'USD' },
      ],
      batch: {
        added: [
          manualTransaction({
            providerAccountId: CHECKING,
            amount: money(-450n, 'USD'),
            postedDate: DateOnly.of(2026, 1, 5),
            name: 'COFFEE SHOP DOWNTOWN',
          }),
          manualTransaction({
            providerAccountId: CHECKING,
            amount: money(-475n, 'USD'),
            postedDate: DateOnly.of(2026, 1, 12),
            name: 'COFFEE SHOP DOWNTOWN',
          }),
          manualTransaction({
            providerAccountId: CHECKING,
            amount: money(-8_000n, 'USD'),
            postedDate: DateOnly.of(2026, 1, 15),
            name: 'GROCERY WAREHOUSE',
          }),
        ],
      },
    });

    const chart = await categories();
    const leaf = chart.find((c) => c.assignable && c.parentId !== null);
    if (leaf === undefined) throw new Error('the shipped taxonomy has no assignable leaf');
    leafCategoryKey = leaf.key;
  }, 300_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('preview count equals the later apply count', async () => {
    const created = await h.request({
      method: 'POST',
      url: '/rules',
      session: h.stale,
      body: {
        name: 'Coffee shop → category',
        conditions: { all: [{ type: 'payee', match: 'contains', value: 'coffee shop' }], any: [] },
        actions: [{ type: 'set_category', categoryKey: leafCategoryKey }],
      },
    });
    expectStatus(created, 201);
    const rule = (created.json() as { rule: WireRule }).rule;
    expect(rule.name).toBe('Coffee shop → category');

    const preview = await h.request({
      method: 'POST',
      url: '/rules/preview',
      session: h.stale,
      body: { ruleId: rule.id },
    });
    expectStatus(preview, 200);
    const previewResult = preview.json() as ApplyResult;
    expect(previewResult.preview).toBe(true);
    // Both coffee-shop rows, and neither grocery row.
    expect(previewResult.matchedCount).toBe(2);
    expect(previewResult.sample.every((s) => s.payee.toUpperCase().includes('COFFEE'))).toBe(true);

    // A preview writes nothing: applying right after sees the identical count,
    // not one row fewer because the preview already "used it up".
    const applied = await h.request({
      method: 'POST',
      url: `/rules/${rule.id}/apply`,
      session: h.stale,
      body: {},
    });
    expectStatus(applied, 200);
    const applyResult = applied.json() as ApplyResult;
    expect(applyResult.preview).toBe(false);
    expect(applyResult.changedCount).toBe(previewResult.matchedCount);
    expect(applyResult.matchedCount).toBe(previewResult.matchedCount);

    // Re-running preview afterwards still *matches* the same two rows — the
    // rule tier's own category is not the user's overlay (`userCategoryId`),
    // so the "already categorised" skip only ever fires for a user's own
    // edit, per `applyRule`'s own comment — but nothing would actually
    // *change* this time: the rule already decided these rows, so a dry run
    // of the identical decision writes zero.
    const secondPreview = await h.request({
      method: 'POST',
      url: '/rules/preview',
      session: h.stale,
      body: { ruleId: rule.id },
    });
    expectStatus(secondPreview, 200);
    const secondResult = secondPreview.json() as ApplyResult;
    expect(secondResult.matchedCount).toBe(previewResult.matchedCount);
    expect(secondResult.changedCount).toBe(0);
  });

  it("a rule may not be created for another user's category", async () => {
    const otherUserId = await h.database.createUser('Second Holder');
    const otherSession = await h.issueSession({ userId: otherUserId, fresh: true });

    const theirCategory = await h.request({
      method: 'POST',
      url: '/categories',
      session: otherSession,
      body: { parentId: null, label: 'Widgets And Whatnot' },
    });
    expectStatus(theirCategory, 201);
    const theirKey = (theirCategory.json() as { category: WireCategory }).category.key;

    // Not a system key (every user has one of those) and not one of my own —
    // this is exactly the shape the ownership check exists to catch.
    const mine = await categories();
    expect(mine.some((c) => c.key === theirKey)).toBe(false);

    const attempt = await h.request({
      method: 'POST',
      url: '/rules',
      session: h.stale,
      body: {
        name: 'Reach across users',
        conditions: { all: [{ type: 'payee', match: 'contains', value: 'x' }], any: [] },
        actions: [{ type: 'set_category', categoryKey: theirKey }],
      },
    });
    expect(attempt.statusCode).toBe(422);
    expect(problemOf(attempt)['code']).toBe('categorization.category_not_assignable');

    const list = await h.request({ method: 'GET', url: '/rules', session: h.stale });
    expectStatus(list, 200);
    expect(
      (list.json() as { rules: WireRule[] }).rules.some((r) => r.name === 'Reach across users'),
    ).toBe(false);
  });

  it('"always categorise like this" builds a rule from one transaction', async () => {
    const groceryTx = (
      await h.request({ method: 'GET', url: '/transactions', session: h.stale })
    ).json() as { items: { id: string; name: string }[] };
    const target = groceryTx.items.find((t) => t.name.toUpperCase().includes('GROCERY'));
    expect(target).toBeDefined();

    const response = await h.request({
      method: 'POST',
      url: `/transactions/${target?.id ?? ''}/rule`,
      session: h.stale,
      body: { categoryKey: leafCategoryKey },
    });
    expectStatus(response, 201);
    const rule = (response.json() as { rule: WireRule }).rule;
    expect(rule.createdFromTransactionId).toBe(target?.id);

    const preview = await h.request({
      method: 'POST',
      url: '/rules/preview',
      session: h.stale,
      body: { ruleId: rule.id, retroactive: true },
    });
    expectStatus(preview, 200);
    expect((preview.json() as ApplyResult).matchedCount).toBeGreaterThanOrEqual(1);
  });

  it('refuses every mutating and reading rules route without a session, with 401', async () => {
    // A syntactically valid but non-existent id: with a bogus-but-well-formed
    // session, the auth guard must refuse before anything asks the database
    // whether the id is real.
    //
    // A mutating request carries a fake session (rather than none) on purpose:
    // the root CSRF hook runs *before* any route handler and answers an
    // anonymous `POST`/`PATCH`/`DELETE` with its own 403 (`csrf_failed`), which
    // is a true and different claim from "not authenticated" —
    // `connections-routes.test.ts`'s "rejects an anonymous import at the CSRF
    // gate" pins that one. This test's claim is specifically the route's own
    // guard, so it supplies a same-origin CSRF pair that lets the request past
    // the gate and into a handler that has never heard of this session token.
    const someId = '00000000-0000-4000-8000-000000000000';
    const noSession = {
      accessToken: 'not-a-real-session-token',
      csrf: 'x'.repeat(40),
      fresh: false,
    };
    const validRuleBody = {
      name: 'x',
      conditions: { all: [{ type: 'payee', match: 'contains', value: 'x' }], any: [] },
      actions: [{ type: 'set_category', categoryKey: 'x' }],
    };
    const attempts = [
      { method: 'GET' as const, url: '/rules', session: noSession },
      // Schema-valid bodies throughout: a `400` from body validation would run
      // *before* the guard and prove nothing about the guard itself.
      { method: 'POST' as const, url: '/rules', session: noSession, body: validRuleBody },
      {
        method: 'PATCH' as const,
        url: `/rules/${someId}`,
        session: noSession,
        body: { name: 'x' },
      },
      { method: 'DELETE' as const, url: `/rules/${someId}`, session: noSession },
      {
        method: 'POST' as const,
        url: '/rules/preview',
        session: noSession,
        body: { ruleId: someId },
      },
      { method: 'POST' as const, url: `/rules/${someId}/apply`, session: noSession, body: {} },
    ];
    for (const attempt of attempts) {
      const response = await h.request(attempt);
      expect(response.statusCode).toBe(401);
      expect(problemOf(response)['code']).toBe('not_authenticated');
    }
  });

  it('a rule belonging to one user is invisible and unreachable to another', async () => {
    const mineList = await h.request({ method: 'GET', url: '/rules', session: h.stale });
    const mine = (mineList.json() as { rules: WireRule[] }).rules[0];
    expect(mine).toBeDefined();

    const otherUserId = await h.database.createUser('Third Holder');
    const otherSession = await h.issueSession({ userId: otherUserId });

    const theirList = await h.request({ method: 'GET', url: '/rules', session: otherSession });
    expectStatus(theirList, 200);
    expect((theirList.json() as { rules: WireRule[] }).rules).toEqual([]);

    const patch = await h.request({
      method: 'PATCH',
      url: `/rules/${mine?.id ?? ''}`,
      session: otherSession,
      body: { name: 'Hijacked' },
    });
    expect(patch.statusCode).toBe(404);

    // `DELETE` is idempotent by design (`deleteRule`'s own `WHERE id = … AND
    // user_id = …`, mirroring `archiveCategory`'s `changed: boolean`): a
    // second user's delete of a rule that is not theirs is a 200 saying
    // nothing happened, not a 404 confirming the id exists.
    const del = await h.request({
      method: 'DELETE',
      url: `/rules/${mine?.id ?? ''}`,
      session: otherSession,
    });
    expectStatus(del, 200);
    expect((del.json() as { deleted: boolean }).deleted).toBe(false);

    // And it is still there for its actual owner.
    const stillMine = await h.request({ method: 'GET', url: '/rules', session: h.stale });
    expect((stillMine.json() as { rules: WireRule[] }).rules.some((r) => r.id === mine?.id)).toBe(
      true,
    );
  });
});
