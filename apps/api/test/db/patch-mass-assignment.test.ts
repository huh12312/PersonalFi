// SPDX-License-Identifier: MIT
/**
 * G-18 / G-28 (ASVS 15.3.3, WP 9.14): a PATCH can never hand a row to another holder.
 *
 * Every PATCH body in the api is a Zod object that strips what it does not name, so a client-supplied
 * `userId` should never reach a handler; nothing failed if one did. This drives the shipped routes
 * (`buildApp` over a scratch database) with a real change AND the ownership columns spelled every way a
 * mass-assignment attempt spells them (`userId`, `user_id`, `ownerId`, `id`), naming ANOTHER holder, and
 * asserts on the rows, not on the status: the response may be 200 (stripped) or 400 (rejected), but the
 * row stays the caller's, keeps its id, the real change lands only when the request was accepted, and the
 * other holder never sees it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
  type TestSession,
} from '../helpers/api-harness.ts';

describe.skipIf(NO_DATABASE)('G-18: PATCH bodies cannot carry an owner', () => {
  let h: ApiHarness;
  let bobId: string;
  let bob: TestSession;
  let attack: Record<string, string>;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'g18_patch_owner' });
    bobId = await h.database.createUser('Bob');
    bob = await h.issueSession({ userId: bobId, fresh: true });
    attack = { userId: bobId, user_id: bobId, ownerId: bobId };
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  async function ownerOf(table: string, id: string): Promise<{ userId: string; n: number }> {
    const result = await h.database.pool.query<{ user_id: string }>(
      `SELECT user_id::text AS user_id FROM ${table} WHERE id = $1`,
      [id],
    );
    return { userId: result.rows[0]?.user_id ?? '', n: result.rowCount ?? 0 };
  }

  it('categories: the label changes, the owner and the id do not', async () => {
    const created = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: null, label: 'Mine alone', kind: 'expense' },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { category: { id: string } }).category.id;

    const patched = await h.request({
      method: 'PATCH',
      url: `/categories/${id}`,
      session: h.stale,
      body: { label: 'Still mine', ...attack, id: bobId },
    });
    expect([200, 400]).toContain(patched.statusCode);

    expect(await ownerOf('categories', id)).toEqual({ userId: h.userId, n: 1 });
    const bobs = await h.request({ method: 'GET', url: '/categories', session: bob });
    expect(bobs.body).not.toContain(id);
    expect(bobs.body).not.toContain('Still mine');
  });

  it('accounts: the flag changes, the owner does not', async () => {
    const link = await linkManual(h, {
      providerConnectionId: 'g18-patch-conn',
      displayName: 'G18 records',
      accounts: [
        { providerAccountId: 'g18', name: 'G18 cash', type: 'depository', currency: 'USD' },
      ],
    });
    const id = link.accountIds[0];
    if (id === undefined) throw new Error('linkManual returned no account');

    const patched = await h.request({
      method: 'PATCH',
      url: `/accounts/${id}`,
      session: h.stale,
      body: { includeInNetWorth: false, ...attack },
    });
    expect([200, 400]).toContain(patched.statusCode);

    expect(await ownerOf('accounts', id)).toEqual({ userId: h.userId, n: 1 });
    const bobs = await h.request({ method: 'GET', url: '/accounts', session: bob });
    expect(bobs.body).not.toContain(id);
  });

  it('goals: the name changes, the owner does not', async () => {
    const created = await h.request({
      method: 'POST',
      url: '/goals',
      session: h.stale,
      body: {
        kind: 'custom',
        name: 'G18 goal',
        target: { minor: '500000', currency: 'USD' },
        targetDate: new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10),
      },
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const patched = await h.request({
      method: 'PATCH',
      url: `/goals/${id}`,
      session: h.stale,
      body: { name: 'G18 goal, renamed', ...attack },
    });
    expect([200, 400]).toContain(patched.statusCode);

    expect(await ownerOf('goals', id)).toEqual({ userId: h.userId, n: 1 });
    const bobs = await h.request({ method: 'GET', url: '/goals', session: bob });
    expect(bobs.body).not.toContain(id);
  });

  it('rules: the name changes, the owner does not', async () => {
    const chart = (
      (await h.request({ method: 'GET', url: '/categories', session: h.stale })).json() as {
        categories: { key: string; assignable: boolean; parentId: string | null }[];
      }
    ).categories;
    const leaf = chart.find((c) => c.assignable && c.parentId !== null);
    if (leaf === undefined) throw new Error('the shipped taxonomy has no assignable leaf');
    const created = await h.request({
      method: 'POST',
      url: '/rules',
      session: h.stale,
      body: {
        name: 'G18 rule',
        conditions: { all: [{ type: 'payee', match: 'contains', value: 'g18' }], any: [] },
        actions: [{ type: 'set_category', categoryKey: leaf.key }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { rule: { id: string } }).rule.id;

    const patched = await h.request({
      method: 'PATCH',
      url: `/rules/${id}`,
      session: h.stale,
      body: { name: 'G18 rule, renamed', ...attack },
    });
    expect([200, 400]).toContain(patched.statusCode);

    expect(await ownerOf('rules', id)).toEqual({ userId: h.userId, n: 1 });
    const bobs = await h.request({ method: 'GET', url: '/rules', session: bob });
    expect(bobs.body).not.toContain(id);
  });
});
