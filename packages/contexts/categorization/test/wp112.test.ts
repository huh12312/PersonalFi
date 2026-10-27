// SPDX-License-Identifier: MIT
/**
 * WP 11.2, against a real database: the holder's pick teaches tiers 3 and 5;
 * the backfill teaches once; a merchant is asked about once per taxonomy
 * version; a suggestion lands on the abstention row and is never an
 * assignment; "Not this" records a negative example and touches nothing the
 * classifier reads; a rule clears the suggestion.
 */
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { createTestDatabase } from '@core/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyRule, categorizeTransactions, createRule, decisionInputOf } from '../src/service.ts';
import { backfillLearningFromPicks, learnFromPick } from '../src/learn.ts';
import { renameCategory } from '../src/categories.ts';
import { explainTransactions } from '../src/explain.ts';
import {
  applyCachedSuggestions,
  listResidueForSuggestion,
  merchantKeyOf,
  recordSuggestions,
  rejectSuggestion,
  residueFeaturesOf,
  suggestionTaxonomy,
} from '../src/suggestions.ts';
import { categoryIdsByKey, seedSystemTaxonomy } from '../src/seed-taxonomy.ts';
import type { CategorizableTransaction, CategorizationExecutor } from '../src/index.ts';
import {
  NO_DATABASE,
  countRows,
  inMemoryPort,
  testClock,
  transactionFixture,
  writeContext,
  type TestDatabase,
} from './harness.ts';

const FRESH = '00000000-0000-7000-8000-c00000000211';
const PAWS = '00000000-0000-7000-8000-c00000000212';

function fresh(overrides: Partial<CategorizableTransaction> = {}): CategorizableTransaction {
  return transactionFixture({
    payee: 'FRESH MARKET',
    rawDescriptor: 'FRESH MARKET 0042',
    merchantId: FRESH,
    amountMinor: -6_400n,
    ...overrides,
  });
}
function paws(overrides: Partial<CategorizableTransaction> = {}): CategorizableTransaction {
  return transactionFixture({
    payee: 'PAWS DEPOT',
    rawDescriptor: 'PAWS DEPOT',
    merchantId: PAWS,
    amountMinor: -2_900n,
    ...overrides,
  });
}

describe.skipIf(NO_DATABASE)(
  'WP 11.2 — learning from picks, and suggestions for the residue',
  () => {
    let database: TestDatabase;
    let clock: ReturnType<typeof testClock>;
    let groceries: string;
    let other: string;

    beforeAll(async () => {
      database = await createTestDatabase(`wp112_catg_${newId().replaceAll('-', '').slice(-12)}`);
    });
    afterAll(async () => {
      await database.drop();
    });
    beforeEach(async () => {
      await database.truncate();
      clock = testClock();
      await seedSystemTaxonomy(database.db, { userId: database.userId, clock });
      const ids = await categoryIdsByKey(
        database.db as unknown as CategorizationExecutor,
        database.userId,
      );
      groceries = ids.get('groceries.supermarkets') as string;
      other = ids.get('shopping.other_shopping') as string;
    });
    const context = () => writeContext(database, clock);
    const executor = () => database.db as unknown as CategorizationExecutor;

    // -------------------------------------------------------------------------
    // §1 — the learning path
    // -------------------------------------------------------------------------

    it('a pick produces classifier examples and a confirmed user assignment, once', async () => {
      const picked = fresh({ userCategoryId: groceries });
      const port = inMemoryPort([picked]);
      expect(await countRows(database, 'classifier_examples')).toBe(0);
      const outcome = await learnFromPick(
        database.db,
        port,
        { transactionId: picked.id, categoryId: groceries },
        context(),
      );
      expect(outcome).toBe('learned');
      const examples = await countRows(database, 'classifier_examples');
      expect(examples).toBeGreaterThan(0);
      const confirmed = await database.db.execute<{ source: string; confirmed: boolean }>(sql`
      SELECT source, confirmed_at IS NOT NULL AS confirmed FROM category_assignments WHERE is_current
    `);
      expect(confirmed.rows).toEqual([{ source: 'user', confirmed: true }]);

      // A redelivered event teaches nothing.
      const sum = async () =>
        (
          await database.db.execute<{ total: string }>(
            sql`SELECT COALESCE(SUM(count), 0) AS total FROM classifier_examples`,
          )
        ).rows[0]?.total;
      const before = await sum();
      expect(
        await learnFromPick(
          database.db,
          port,
          { transactionId: picked.id, categoryId: groceries },
          context(),
        ),
      ).toBe('already_learned');
      expect(await sum()).toBe(before);
    });

    it('a stale event (the holder changed their mind since) teaches nothing', async () => {
      const picked = fresh({ userCategoryId: other });
      const outcome = await learnFromPick(
        database.db,
        inMemoryPort([picked]),
        { transactionId: picked.id, categoryId: groceries },
        context(),
      );
      expect(outcome).toBe('stale');
      expect(await countRows(database, 'classifier_examples')).toBe(0);
    });

    it('three picks of one merchant become a learned merchant default that files the fourth', async () => {
      const picks = [1, 2, 3].map(() => fresh({ userCategoryId: groceries }));
      const port = inMemoryPort(picks);
      for (const pick of picks) {
        await learnFromPick(
          database.db,
          port,
          { transactionId: pick.id, categoryId: groceries },
          context(),
        );
      }
      const profile = await database.db.execute<{ default_support_count: number }>(sql`
      SELECT default_support_count FROM merchant_profiles WHERE ledger_merchant_id = ${FRESH}
    `);
      expect(profile.rows[0]?.default_support_count).toBe(3);
      const learned = await database.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM domain_events WHERE event_type = 'categorization.MerchantDefaultLearned'
    `);
      expect(Number(learned.rows[0]?.n)).toBe(1);

      const fourth = fresh();
      await categorizeTransactions(
        database.db,
        inMemoryPort([fourth]),
        { transactionIds: [fourth.id] },
        context(),
      );
      const decided = await database.db.execute<{ source: string }>(sql`
      SELECT source FROM category_assignments WHERE transaction_id = ${fourth.id} AND is_current
    `);
      expect(decided.rows[0]?.source).toBe('merchant_default');
    });

    it('the backfill replays standing picks once, idempotently, with a count', async () => {
      const uncategorisedId = (await categoryIdsByKey(executor(), database.userId)).get(
        'uncategorised',
      );
      const rows = [
        fresh({ userCategoryId: groceries }),
        fresh({ userCategoryId: groceries }),
        paws({ userCategoryId: other }),
        paws(),
        ...(uncategorisedId === undefined ? [] : [paws({ userCategoryId: uncategorisedId })]),
      ];
      const port = inMemoryPort(rows);
      const first = await backfillLearningFromPicks(database.db, port, context());
      expect(first).toEqual({
        picks: uncategorisedId === undefined ? 3 : 4,
        learned: 3,
        alreadyLearned: 0,
        skipped: uncategorisedId === undefined ? 0 : 1,
      });
      const snapshot = async () =>
        (
          await database.db.execute(
            sql`SELECT feature, category_id, count FROM classifier_examples ORDER BY feature, category_id`,
          )
        ).rows;
      const after = await snapshot();
      const second = await backfillLearningFromPicks(database.db, port, context());
      expect(second).toMatchObject({ learned: 0, alreadyLearned: 3 });
      expect(await snapshot()).toEqual(after);
    });

    // -------------------------------------------------------------------------
    // §2/§3 — the residue, the cache, where a suggestion lands
    // -------------------------------------------------------------------------

    async function residueOf(rows: readonly CategorizableTransaction[]) {
      const port = inMemoryPort(rows);
      await categorizeTransactions(
        database.db,
        port,
        { transactionIds: rows.map((r) => r.id) },
        context(),
      );
      const taxonomy = await suggestionTaxonomy(executor(), database.userId);
      return {
        port,
        taxonomy,
        residue: await listResidueForSuggestion(
          executor(),
          port,
          database.userId,
          taxonomy.version,
        ),
      };
    }

    it('groups the residue by merchant and asks about a merchant once per taxonomy version', async () => {
      const rows = [fresh(), fresh(), paws()];
      const { port, taxonomy, residue } = await residueOf(rows);
      expect(residue.misses.map((m) => [m.merchantKey, m.transactionIds.length])).toEqual(
        [
          ['fresh market', 2],
          ['depot paws', 1],
        ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );

      const freshMerchant = residue.misses.find((m) => m.merchantKey === 'fresh market');
      const recorded = await recordSuggestions(database.db, context(), {
        taxonomyVersion: taxonomy.version,
        model: 'fake@sha256:test',
        runId: null,
        answers: [
          {
            merchantKey: 'fresh market',
            transactionIds: freshMerchant?.transactionIds ?? [],
            verdict: 'suggested',
            categoryId: groceries,
            reason: 'A market name.',
            refusal: null,
          },
          {
            merchantKey: 'depot paws',
            transactionIds: [rows[2]?.id as string],
            verdict: 'abstained',
            categoryId: null,
            reason: null,
            refusal: null,
          },
        ],
      });
      expect(recorded).toEqual({ cached: 2, shown: 2 });

      // Asked once: both merchants are hits now.
      const again = await listResidueForSuggestion(
        executor(),
        port,
        database.userId,
        taxonomy.version,
      );
      expect(again.misses).toEqual([]);
      expect(again.hits).toHaveLength(2);

      // A second answer for the same merchant at the same version is ignored.
      const twice = await recordSuggestions(database.db, context(), {
        taxonomyVersion: taxonomy.version,
        model: 'fake@sha256:test',
        runId: null,
        answers: [
          {
            merchantKey: 'fresh market',
            transactionIds: [],
            verdict: 'abstained',
            categoryId: null,
            reason: null,
            refusal: null,
          },
        ],
      });
      expect(twice).toEqual({ cached: 0, shown: 0 });

      // A new row at a known merchant gets the cached answer, without a new ask.
      const third = fresh();
      const withThird = await residueOf([...rows, third]);
      expect(withThird.residue.misses).toEqual([]);
      expect(await applyCachedSuggestions(database.db, context(), withThird.residue.hits)).toBe(1);

      // A renamed category is a new taxonomy version: the merchants may be asked again.
      await renameCategory(
        executor(),
        { userId: database.userId, categoryId: groceries, label: 'Food shops' },
        { clock },
      );
      const renamed = await suggestionTaxonomy(executor(), database.userId);
      expect(renamed.version).not.toBe(taxonomy.version);
      expect(
        (await listResidueForSuggestion(executor(), port, database.userId, renamed.version)).misses,
      ).toHaveLength(2);
    });

    it('a suggestion is not an assignment: the row stays uncategorised, with the chip in its explanation', async () => {
      const row = fresh();
      const { taxonomy, residue } = await residueOf([row]);
      await recordSuggestions(database.db, context(), {
        taxonomyVersion: taxonomy.version,
        model: 'fake@sha256:test',
        runId: null,
        answers: [
          {
            merchantKey: residue.misses[0]?.merchantKey as string,
            transactionIds: [row.id],
            verdict: 'suggested',
            categoryId: groceries,
            reason: 'A market name.',
            refusal: null,
          },
        ],
      });
      expect(await countRows(database, 'category_assignments')).toBe(0);
      const [explained] = await explainTransactions(executor(), {
        userId: database.userId,
        transactionIds: [row.id],
      });
      expect(explained).toMatchObject({
        status: 'abstained',
        categoryKey: null,
        suggestion: { source: 'model', categoryId: groceries, reason: 'A market name.' },
      });
    });

    it('"Not this" records the negative example, clears the merchant\'s chips, and leaves the classifier alone', async () => {
      const rows = [fresh(), fresh()];
      const { port, taxonomy, residue } = await residueOf(rows);
      await recordSuggestions(database.db, context(), {
        taxonomyVersion: taxonomy.version,
        model: 'fake@sha256:test',
        runId: null,
        answers: [
          {
            merchantKey: 'fresh market',
            transactionIds: residue.misses[0]?.transactionIds ?? [],
            verdict: 'suggested',
            categoryId: groceries,
            reason: 'A market name.',
            refusal: null,
          },
        ],
      });
      const examplesBefore = await countRows(database, 'classifier_examples');
      expect(
        await rejectSuggestion(
          database.db,
          port,
          { transactionId: rows[0]?.id as string },
          context(),
        ),
      ).toBe('rejected');
      const chips = await database.db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM category_abstentions WHERE suggested_category_id IS NOT NULL`,
      );
      expect(Number(chips.rows[0]?.n)).toBe(0);
      const cache = await database.db.execute<{ rejected: boolean }>(
        sql`SELECT rejected_at IS NOT NULL AS rejected FROM category_suggestion_cache`,
      );
      expect(cache.rows).toEqual([{ rejected: true }]);
      expect(await countRows(database, 'classifier_examples')).toBe(examplesBefore);
      expect(await countRows(database, 'category_assignments')).toBe(0);
      // And a rejected answer is never put back from the cache.
      const again = await listResidueForSuggestion(
        executor(),
        port,
        database.userId,
        taxonomy.version,
      );
      expect(await applyCachedSuggestions(database.db, context(), again.hits)).toBe(0);
    });

    it('a rule written for the merchant later clears the suggestion with the abstention', async () => {
      const row = fresh();
      const { port, taxonomy, residue } = await residueOf([row]);
      await recordSuggestions(database.db, context(), {
        taxonomyVersion: taxonomy.version,
        model: 'fake@sha256:test',
        runId: null,
        answers: [
          {
            merchantKey: residue.misses[0]?.merchantKey as string,
            transactionIds: [row.id],
            verdict: 'suggested',
            categoryId: other,
            reason: 'A guess.',
            refusal: null,
          },
        ],
      });
      const rule = await createRule(database.db, {
        userId: database.userId,
        name: 'FRESH MARKET is groceries',
        conditions: { all: [{ type: 'payee', match: 'contains', value: 'FRESH MARKET' }], any: [] },
        actions: [{ type: 'set_category', categoryKey: 'groceries.supermarkets' }],
      });
      await applyRule(database.db, port, { ruleId: rule.id, retroactive: true }, context());
      expect(await countRows(database, 'category_abstentions')).toBe(0);
    });

    it('the payload the model would be shown is built from the classifier features only', () => {
      const features = residueFeaturesOf(decisionInputOf(fresh()));
      expect(merchantKeyOf(features)).toBe('fresh market');
    });
  },
);
