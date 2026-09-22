// SPDX-License-Identifier: MIT
/**
 * Condition **C-5** (docs/evidence/phase-2/gate-security-review.md §5, G2-3):
 * "a newly created budget line did not reflect already-posted activity until
 * a dirty recompute was forced; the reviewer tested this explicitly."
 *
 * ## The bug
 *
 * `POST /budgets/lines` (`routes/budgets.ts`) always called `recomputeDirty`
 * after inserting the line — the module comment even claimed "every write
 * below is followed by `recomputeDirty` so the cached `available`/`activity`
 * columns this route also reads never go stale." That is true only when the
 * *period* is already marked dirty. `recomputeDirty` walks
 * `dirtyPeriods` — `budgetPeriods.dirty = true` rows — and a brand-new line's
 * own `budget_lines.dirty` column (schema default `true`) is invisible to it:
 * two different tables, two different flags, and only one of them was ever
 * set here.
 *
 * The gate's reviewer hit this by hand: categorise a transaction, open the
 * budget (which lazily creates it and recomputes once — clean, because no
 * envelope exists yet to compute), *then* create the envelope for that
 * category. Before the fix, the new line reads back with zero activity
 * despite the transaction sitting right there in the ledger; a second,
 * unrelated write that happens to mark the period dirty again is the only
 * thing that makes the number correct.
 *
 * ## The fix
 *
 * `routes/budgets.ts`'s create-line handler now calls `markDirtyFrom` for the
 * line's own period, immediately before `recomputeDirty` — the same call the
 * consumer (`consumer.ts`) already makes for a ledger event, applied to the
 * one write path that used to skip it.
 *
 * **Sabotage.** Comment out the `markDirtyFrom` call added by this work
 * package (`routes/budgets.ts`, just above the `recomputeDirty` call in
 * `POST /budgets/lines`) and the assertion on `line.activity` below fails:
 * `expected { minor: '0', currency: 'USD' } to equal { minor: '-5000', ... }`.
 * Observed red before this fix landed and green after
 * (docs/evidence/phase-3/wp3.13-carry-overs.md, condition C-5).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface WireCategory {
  readonly id: string;
  readonly assignable: boolean;
}
interface WireLine {
  readonly id: string;
  readonly categoryId: string | null;
  readonly activity: { minor: string; currency: string };
  readonly available: { minor: string; currency: string };
}
interface WirePeriod {
  readonly id: string;
  readonly lines: readonly WireLine[];
}

async function firstAssignableCategoryId(h: ApiHarness): Promise<string> {
  const response = await h.request({ method: 'GET', url: '/categories', session: h.stale });
  expectStatus(response, 200);
  const { categories } = response.json() as { categories: WireCategory[] };
  const leaf = categories.find((category) => category.assignable);
  if (leaf === undefined) throw new Error('no assignable category seeded');
  return leaf.id;
}

describe.skipIf(NO_DATABASE)(
  'a budget line created after its activity already posted reflects it immediately (C-5)',
  () => {
    let h: ApiHarness;

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'budgetdirty' });
    }, 120_000);

    afterAll(async () => {
      await h.close();
    }, 60_000);

    it('a line created mid-period, after its category was already spent in, comes back dirty-recomputed with no extra call', async () => {
      const categoryId = await firstAssignableCategoryId(h);

      // 1. Post and categorise a transaction *before any budget exists at
      //    all* — `createBudgetingConsumer`'s own comment: "No budget yet is
      //    the normal state of a fresh install, not an error," and it returns
      //    without touching anything. This is what keeps the period clean at
      //    step 3 below, rather than the categorisation event itself dirtying
      //    it first and masking the bug this test pins.
      const link = await linkManual(h, {
        providerConnectionId: 'budget-dirty-conn',
        displayName: 'Dirty-Cascade Checking',
        accounts: [
          { providerAccountId: 'checking', name: 'Checking', type: 'depository', currency: 'USD' },
        ],
      });
      const accountId = link.accountIds[0];
      if (accountId === undefined) throw new Error('linkManual returned no account');

      // The identity check at recompute refuses an on-budget account with no
      // balance observation at all (`budgeting.balance_unreported`) — nothing
      // to do with this test's own claim, just a prerequisite every on-budget
      // account needs once a budget exists to recompute against.
      const balance = await h.request({
        method: 'POST',
        url: `/accounts/${accountId}/balance`,
        session: h.fresh,
        body: { current: { minor: '200000', currency: 'USD' } },
      });
      expectStatus(balance, 200);

      const today = new Date().toISOString().slice(0, 10);
      const posted = await h.request({
        method: 'POST',
        url: `/accounts/${accountId}/transactions`,
        session: h.fresh,
        body: {
          transactions: [
            { amount: { minor: '-5000', currency: 'USD' }, postedDate: today, name: 'Groceries' },
          ],
        },
      });
      expectStatus(posted, 201);
      const transactionId = (posted.json() as { addedTransactionIds: string[] })
        .addedTransactionIds[0];
      if (transactionId === undefined) throw new Error('no transaction id returned');

      const categorised = await h.request({
        method: 'PATCH',
        url: `/transactions/${transactionId}`,
        session: h.stale,
        body: { categoryId },
      });
      expectStatus(categorised, 200);

      // 2. First-ever `GET /budgets/current` lazily creates the budget and
      //    opens the period; the period's own `dirty` default (`true`) makes
      //    this call recompute once, with zero lines to update — it clears
      //    `budgetPeriods.dirty` without ever touching `categoryId`'s
      //    activity, since no envelope claims that category yet.
      const current = await h.request({ method: 'GET', url: '/budgets/current', session: h.stale });
      expectStatus(current, 200);
      const { period } = current.json() as { period: WirePeriod };
      expect(period.lines.find((line) => line.categoryId === categoryId)).toBeUndefined();

      // 3. Create the envelope for `categoryId` now — mid-period, strictly
      //    after the activity that belongs in it. No second call, no manual
      //    recompute: this is the one write the gate found broken.
      const created = await h.request({
        method: 'POST',
        url: '/budgets/lines',
        session: h.stale,
        body: { periodId: period.id, categoryId },
      });
      expectStatus(created, 201);
      const line = (created.json() as { line: WireLine }).line;

      expect(line.activity).toEqual({ minor: '-5000', currency: 'USD' });
      expect(line.available).toEqual({ minor: '-5000', currency: 'USD' });
    });
  },
);
