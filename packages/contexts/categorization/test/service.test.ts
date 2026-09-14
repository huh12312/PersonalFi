// SPDX-License-Identifier: MIT
/**
 * The write paths a person actually touches: confirming a category, writing
 * "always categorise X as Y" from a transaction, previewing and then applying a
 * rule retroactively, retraining, and asking why.
 *
 * All against a real Postgres, because every interesting claim here is one:
 * merchant support accumulating in an `ON CONFLICT DO UPDATE` arm that has to
 * distinguish agreement from disagreement, a preview that runs the *same* code
 * path as the apply and therefore writes nothing, an explanation read back out of
 * a `jsonb` column rather than recomputed.
 */
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLD_MODEL } from '../src/classifier.ts';
import { CategorizationError } from '../src/errors.ts';
import {
  applyRule,
  categorizeTransactions,
  confirmAssignment,
  createRuleFromTransaction,
  explainAssignment,
  loadClassifier,
  loadMerchantDefaults,
  loadRules,
  retrainClassifier,
} from '../src/service.ts';
import { seedSystemTaxonomy } from '../src/seed-taxonomy.ts';
import type { CategorizableTransaction } from '../src/index.ts';
import {
  NO_DATABASE,
  assignmentsOf,
  categorizationDatabase,
  countRows,
  currentAssignmentOf,
  eventPayloads,
  inMemoryPort,
  testClock,
  transactionFixture,
  writeContext,
  type TestDatabase,
} from './harness.ts';

const COFFEE_PFC = {
  primary: 'FOOD_AND_DRINK',
  detailed: 'FOOD_AND_DRINK_COFFEE',
  confidence_level: 'HIGH',
};

const CHEWY_MERCHANT = '00000000-0000-7000-8000-c00000000042';

describe.skipIf(NO_DATABASE)('the categorization service', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;

  beforeAll(async () => {
    database = await categorizationDatabase('service');
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.truncate();
    clock = testClock();
    await seedSystemTaxonomy(database.db, { userId: database.userId, clock });
  });

  function context() {
    return writeContext(database, clock);
  }

  /** A Chewy purchase, differing only in id and amount. The corpus builder. */
  function chewy(overrides: Partial<CategorizableTransaction> = {}): CategorizableTransaction {
    return transactionFixture({
      payee: 'CHEWY.COM',
      rawDescriptor: 'CHEWY.COM 800-672-4399 FL',
      merchantId: CHEWY_MERCHANT,
      amountMinor: -4_250n,
      ...overrides,
    });
  }

  async function categorize(transactions: readonly CategorizableTransaction[]) {
    return categorizeTransactions(
      database.db,
      inMemoryPort(transactions),
      { transactionIds: transactions.map((transaction) => transaction.id) },
      context(),
    );
  }

  // -------------------------------------------------------------------------
  // Confirming
  // -------------------------------------------------------------------------

  describe('confirmAssignment', () => {
    it('records the user’s answer as the current one, and keeps what it replaced', async () => {
      const transaction = chewy({ providerCategory: COFFEE_PFC });
      await categorize([transaction]);

      const result = await confirmAssignment(
        database.db,
        { transactionId: transaction.id, categoryKey: 'family.pets', transaction },
        context(),
      );

      expect(result.categoryKey).toBe('family.pets');
      const rows = await assignmentsOf(database, transaction.id);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        version: 2,
        source: 'user',
        category_key: 'family.pets',
        is_current: true,
      });
      expect(rows[0]?.confirmed_at).not.toBeNull();
      // A user's edit is an instruction, not an estimate.
      expect(Number(rows[0]?.confidence)).toBe(1);
      expect(rows[1]).toMatchObject({ version: 1, is_current: false, source: 'provider' });
    });

    it('confirms a transaction nothing had categorised yet', async () => {
      const transaction = chewy();
      await confirmAssignment(
        database.db,
        { transactionId: transaction.id, categoryKey: 'family.pets', transaction },
        context(),
      );
      expect(await currentAssignmentOf(database, transaction.id)).toMatchObject({
        version: 1,
        source: 'user',
      });
    });

    it('feeds the classifier’s corpus, and counts a repeat rather than duplicating it', async () => {
      const first = chewy();
      const second = chewy({ id: newId() });

      const one = await confirmAssignment(
        database.db,
        { transactionId: first.id, categoryKey: 'family.pets', transaction: first },
        context(),
      );
      expect(one.featuresCounted).toBeGreaterThan(0);
      expect(await countRows(database, 'classifier_examples')).toBe(one.featuresCounted);

      await confirmAssignment(
        database.db,
        { transactionId: second.id, categoryKey: 'family.pets', transaction: second },
        context(),
      );

      // Same merchant, same amount bucket, same account: identical features, so
      // the second confirmation increments counts instead of adding rows.
      expect(await countRows(database, 'classifier_examples')).toBe(one.featuresCounted);
      const counts = await database.db.execute<{ feature: string; count: number }>(sql`
        SELECT feature, count FROM classifier_examples WHERE user_id = ${database.userId} AND feature = 't:chewy'
      `);
      expect(counts.rows[0]?.count).toBe(2);
    });

    it('learns the merchant’s default, and announces it exactly once', async () => {
      const transactions = [
        chewy(),
        chewy({ id: newId() }),
        chewy({ id: newId() }),
        chewy({ id: newId() }),
      ];
      const supports: number[] = [];
      for (const transaction of transactions) {
        const result = await confirmAssignment(
          database.db,
          { transactionId: transaction.id, categoryKey: 'family.pets', transaction },
          context(),
        );
        supports.push(result.merchantSupportCount);
      }

      // 04 §5.2's "≥ 3 prior transactions for this merchant share a user-assigned
      // category, adopt it".
      expect(supports).toEqual([1, 2, 3, 4]);

      const learned = await eventPayloads<{ supportCount: number; ledgerMerchantId: string }>(
        database,
        'categorization.MerchantDefaultLearned',
      );
      // Once, at the crossing — not on every confirmation. The difference
      // between an app that feels like it learned and one that nags.
      expect(learned).toHaveLength(1);
      expect(learned[0]).toMatchObject({ supportCount: 3, ledgerMerchantId: CHEWY_MERCHANT });

      const defaults = await loadMerchantDefaults(database.db, database.userId);
      expect(defaults.get(CHEWY_MERCHANT)).toMatchObject({
        categoryKey: 'family.pets',
        locked: false,
        supportCount: 4,
      });
    });

    it('resets the merchant’s support when the user disagrees with it', async () => {
      // Not a decrement: the user has just said the old answer was wrong, and
      // carrying its accumulated support forward would keep applying it.
      for (const transaction of [chewy(), chewy({ id: newId() }), chewy({ id: newId() })]) {
        await confirmAssignment(
          database.db,
          { transactionId: transaction.id, categoryKey: 'family.pets', transaction },
          context(),
        );
      }

      const correction = chewy({ id: newId() });
      const result = await confirmAssignment(
        database.db,
        {
          transactionId: correction.id,
          categoryKey: 'family.pet_medical',
          transaction: correction,
        },
        context(),
      );

      expect(result.merchantSupportCount).toBe(1);
      const defaults = await loadMerchantDefaults(database.db, database.userId);
      expect(defaults.get(CHEWY_MERCHANT)).toMatchObject({
        categoryKey: 'family.pet_medical',
        supportCount: 1,
      });
    });

    it('never moves a merchant default the user pinned', async () => {
      const first = chewy();
      await confirmAssignment(
        database.db,
        { transactionId: first.id, categoryKey: 'family.pets', transaction: first },
        context(),
      );
      await database.db.execute(sql`
        UPDATE merchant_profiles SET user_locked = TRUE
         WHERE user_id = ${database.userId} AND ledger_merchant_id = ${CHEWY_MERCHANT}
      `);

      const stray = chewy({ id: newId() });
      await confirmAssignment(
        database.db,
        { transactionId: stray.id, categoryKey: 'shopping.gifts', transaction: stray },
        context(),
      );

      const defaults = await loadMerchantDefaults(database.db, database.userId);
      // 07 §2.1's "source=USER, which always wins", applied to the category: one
      // transaction's confirmation must not silently move a stated intent about
      // the merchant.
      expect(defaults.get(CHEWY_MERCHANT)).toMatchObject({
        categoryKey: 'family.pets',
        locked: true,
        supportCount: 1,
      });
    });

    it('announces the confirmation to everyone downstream', async () => {
      const transaction = chewy();
      await confirmAssignment(
        database.db,
        { transactionId: transaction.id, categoryKey: 'family.pets', transaction },
        context(),
      );
      const changed = await eventPayloads<{ trigger: string; bySource: Record<string, number> }>(
        database,
        'categorization.AssignmentsChanged',
      );
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatchObject({ trigger: 'confirm', bySource: { user: 1 } });
    });

    it('refuses a category the engine may not assign', async () => {
      const transaction = chewy();
      await expect(
        confirmAssignment(
          database.db,
          { transactionId: transaction.id, categoryKey: 'family', transaction },
          context(),
        ),
      ).rejects.toMatchObject({ code: 'categorization.category_not_assignable' });

      await expect(
        confirmAssignment(
          database.db,
          { transactionId: transaction.id, categoryKey: 'nope.nothing', transaction },
          context(),
        ),
      ).rejects.toBeInstanceOf(CategorizationError);
    });
  });

  // -------------------------------------------------------------------------
  // Learning
  // -------------------------------------------------------------------------

  describe('retrainClassifier', () => {
    async function confirmMany(
      count: number,
      categoryKey: string,
      make: (index: number) => CategorizableTransaction,
    ): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        const transaction = make(index);
        await confirmAssignment(
          database.db,
          { transactionId: transaction.id, categoryKey, transaction },
          context(),
        );
      }
    }

    it('builds a model from the confirmed corpus and activates exactly one', async () => {
      await confirmMany(4, 'family.pets', () => chewy({ id: newId() }));
      await confirmMany(4, 'transport.fuel', () =>
        transactionFixture({
          id: newId(),
          payee: 'CHEVRON 1093882 AUSTIN TX',
          rawDescriptor: 'CHEVRON 1093882 AUSTIN TX',
          merchantId: '00000000-0000-7000-8000-c00000000043',
          amountMinor: -5_500n,
        }),
      );

      const first = await retrainClassifier(database.db, context());
      expect(first.version).toBe(1);
      expect(Object.keys(first.categoryCounts).sort()).toEqual(['family.pets', 'transport.fuel']);
      expect(first.totalExamples).toBe(8);

      const second = await retrainClassifier(database.db, context());
      expect(second.version).toBe(2);

      const active = await database.db.execute<{ count: string }>(sql`
        SELECT count(*) AS count FROM classifier_versions WHERE user_id = ${database.userId} AND is_active
      `);
      // A partial unique index enforces this; the assertion is that the write
      // path deactivates the old row rather than relying on the index to error.
      expect(Number(active.rows[0]?.count)).toBe(1);
      expect(await loadClassifier(database.db, database.userId)).toMatchObject({ version: 2 });
    });

    it('leaves a user with no confirmations on the cold model', async () => {
      expect(await loadClassifier(database.db, database.userId)).toBe(COLD_MODEL);
    });

    it('lets the trained model decide a transaction no other tier claims', async () => {
      await confirmMany(5, 'family.pets', () => chewy({ id: newId() }));
      await confirmMany(5, 'transport.fuel', () =>
        transactionFixture({
          id: newId(),
          payee: 'CHEVRON 1093882 AUSTIN TX',
          rawDescriptor: 'CHEVRON 1093882 AUSTIN TX',
          merchantId: '00000000-0000-7000-8000-c00000000043',
          amountMinor: -5_500n,
        }),
      );
      await retrainClassifier(database.db, context());

      // A *different* merchant id, so merchant memory has nothing to say, and no
      // provider category, so the tier above is silent too. Only the classifier
      // is left.
      const fresh = chewy({ id: newId(), merchantId: '00000000-0000-7000-8000-c00000000099' });
      const result = await categorize([fresh]);

      expect(result.bySource['classifier']).toBe(1);
      const assignment = await currentAssignmentOf(database, fresh.id);
      expect(assignment).toMatchObject({ category_key: 'family.pets', source: 'classifier' });
      // Never 1.0: that is reserved for the tiers that are instructions.
      expect(Number(assignment?.confidence)).toBeLessThan(1);
    });
  });

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------

  describe('createRuleFromTransaction', () => {
    it('writes "always categorise X as Y" against the cleaned name, not the noise', async () => {
      const transaction = transactionFixture({
        payee: 'SQ *BLUE BOTTLE COFFEE',
        rawDescriptor: 'SQ *BLUE BOTTLE COFFEE OAKLAND CA',
      });

      const rule = await createRuleFromTransaction(
        database.db,
        { transaction, categoryKey: 'dining.coffee' },
        context(),
      );

      // A rule written against `SQ *BLUE BOTTLE COFFEE OAKLAND CA` matches one
      // transaction; one written against `BLUE BOTTLE COFFEE` matches the
      // merchant, which is what the user meant by "always".
      expect(rule.conditions.all[0]).toEqual({
        type: 'payee',
        match: 'contains',
        value: 'BLUE BOTTLE COFFEE',
      });
      expect(rule.actions).toEqual([{ type: 'set_category', categoryKey: 'dining.coffee' }]);
      expect(rule.name).toBe('Always categorise Blue Bottle Coffee');
      expect(rule.createdFromTransactionId).toBe(transaction.id);

      const { rules, rejected } = await loadRules(database.db, database.userId);
      expect(rejected).toEqual([]);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toEqual(rule);
    });

    it('takes effect on the next categorisation pass', async () => {
      const transaction = transactionFixture({ providerCategory: COFFEE_PFC });
      await createRuleFromTransaction(
        database.db,
        { transaction, categoryKey: 'dining.restaurants' },
        context(),
      );

      await categorize([transaction]);

      expect(await currentAssignmentOf(database, transaction.id)).toMatchObject({
        source: 'rule',
        category_key: 'dining.restaurants',
      });
    });

    it('refuses to build a rule pointing at a category that is not a leaf', async () => {
      await expect(
        createRuleFromTransaction(
          database.db,
          { transaction: transactionFixture(), categoryKey: 'dining' },
          context(),
        ),
      ).rejects.toMatchObject({ code: 'categorization.category_not_assignable' });
      expect(await countRows(database, 'rules')).toBe(0);
    });
  });

  describe('applyRule', () => {
    /** Three Blue Bottle rows the provider has filed as restaurants. */
    function history(): CategorizableTransaction[] {
      return [
        transactionFixture({ providerCategory: COFFEE_PFC }),
        transactionFixture({ providerCategory: COFFEE_PFC, amountMinor: -720n }),
        transactionFixture({ providerCategory: COFFEE_PFC, amountMinor: -540n }),
      ];
    }

    it('previews without writing anything, then applies the same number', async () => {
      const transactions = history();
      await categorize(transactions);

      const rule = await createRuleFromTransaction(
        database.db,
        {
          transaction: transactions[0] as CategorizableTransaction,
          categoryKey: 'dining.restaurants',
        },
        context(),
      );

      const port = inMemoryPort(transactions);
      const preview = await applyRule(
        database.db,
        port,
        { ruleId: rule.id, retroactive: true, preview: true },
        context(),
      );

      expect(preview.preview).toBe(true);
      expect(preview.matchedCount).toBe(3);
      expect(preview.changedCount).toBe(3);
      expect(preview.sample).toHaveLength(3);
      // Nothing moved: every row still says what the provider said.
      for (const transaction of transactions) {
        expect(await currentAssignmentOf(database, transaction.id)).toMatchObject({
          source: 'provider',
          version: 1,
        });
      }
      expect(await eventPayloads(database, 'categorization.RuleApplied')).toEqual([]);

      const applied = await applyRule(
        database.db,
        port,
        { ruleId: rule.id, retroactive: true },
        context(),
      );
      // The preview ran the same code path with `dryRun` set, so the number the
      // user was shown is the number that happens.
      expect(applied.changedCount).toBe(preview.changedCount);
      expect(applied.matchedCount).toBe(preview.matchedCount);
      for (const transaction of transactions) {
        expect(await currentAssignmentOf(database, transaction.id)).toMatchObject({
          source: 'rule',
          category_key: 'dining.restaurants',
          version: 2,
        });
      }
    });

    it('records both runs, so a preview that disagreed with the apply is visible', async () => {
      const transactions = history();
      await categorize(transactions);
      const rule = await createRuleFromTransaction(
        database.db,
        {
          transaction: transactions[0] as CategorizableTransaction,
          categoryKey: 'dining.restaurants',
        },
        context(),
      );
      const port = inMemoryPort(transactions);

      await applyRule(
        database.db,
        port,
        { ruleId: rule.id, retroactive: true, preview: true },
        context(),
      );
      const applied = await applyRule(
        database.db,
        port,
        { ruleId: rule.id, retroactive: true },
        context(),
      );

      const runs = await database.db.execute<{
        id: string;
        mode: string;
        retroactive: boolean;
        matched_count: number;
        changed_count: number;
        finished_at: string | null;
      }>(
        sql`SELECT id, mode, retroactive, matched_count, changed_count, finished_at FROM rule_runs ORDER BY started_at, mode`,
      );

      expect(runs.rows.map((row) => row.mode)).toEqual(['apply', 'preview']);
      for (const row of runs.rows) {
        expect(row).toMatchObject({ retroactive: true, matched_count: 3, changed_count: 3 });
        expect(row.finished_at).not.toBeNull();
      }
      expect(runs.rows.some((row) => row.id === applied.runId)).toBe(true);

      const events = await eventPayloads<{
        matchedCount: number;
        changedCount: number;
        runId: string;
      }>(database, 'categorization.RuleApplied');
      // Exactly one: the preview never emits, because nothing happened.
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ matchedCount: 3, changedCount: 3, runId: applied.runId });
    });

    it('stamps the rule with what its last apply did', async () => {
      const transactions = history();
      await categorize(transactions);
      const rule = await createRuleFromTransaction(
        database.db,
        {
          transaction: transactions[0] as CategorizableTransaction,
          categoryKey: 'dining.restaurants',
        },
        context(),
      );
      await applyRule(
        database.db,
        inMemoryPort(transactions),
        { ruleId: rule.id, retroactive: true },
        context(),
      );

      const row = await database.db.execute<{
        last_applied_at: string | null;
        last_applied_count: number;
      }>(sql`SELECT last_applied_at, last_applied_count FROM rules WHERE id = ${rule.id}`);
      expect(row.rows[0]?.last_applied_count).toBe(3);
      expect(row.rows[0]?.last_applied_at).not.toBeNull();
    });

    it('cannot overrule the user, however retroactive it is', async () => {
      // The single most destructive thing this context can do to a history, and
      // the guard is `shouldReplace`: nothing outranks an explicit edit.
      const transactions = history();
      await categorize(transactions);
      const mine = transactions[1] as CategorizableTransaction;
      await confirmAssignment(
        database.db,
        { transactionId: mine.id, categoryKey: 'dining.bars', transaction: mine },
        context(),
      );

      const rule = await createRuleFromTransaction(
        database.db,
        {
          transaction: transactions[0] as CategorizableTransaction,
          categoryKey: 'dining.restaurants',
        },
        context(),
      );
      const applied = await applyRule(
        database.db,
        inMemoryPort(transactions),
        { ruleId: rule.id, retroactive: true },
        context(),
      );

      expect(applied.matchedCount).toBe(3);
      expect(applied.changedCount).toBe(2);
      expect(await currentAssignmentOf(database, mine.id)).toMatchObject({
        source: 'user',
        category_key: 'dining.bars',
      });
    });

    it('leaves the user’s own rows alone unless asked to be retroactive', async () => {
      const transactions = history();
      const overlaid = transactionFixture({
        providerCategory: COFFEE_PFC,
        userCategoryId: '00000000-0000-7000-8000-d00000000009',
      });
      const all = [...transactions, overlaid];

      const rule = await createRuleFromTransaction(
        database.db,
        {
          transaction: transactions[0] as CategorizableTransaction,
          categoryKey: 'dining.restaurants',
        },
        context(),
      );
      const applied = await applyRule(
        database.db,
        inMemoryPort(all),
        { ruleId: rule.id },
        context(),
      );

      expect(applied.matchedCount).toBe(3);
      expect(await assignmentsOf(database, overlaid.id)).toEqual([]);
    });

    it('says which rule it cannot find', async () => {
      await expect(
        applyRule(database.db, inMemoryPort([]), { ruleId: newId() }, context()),
      ).rejects.toMatchObject({ code: 'categorization.rule_not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // Explaining
  // -------------------------------------------------------------------------

  describe('explainAssignment', () => {
    it('returns the decision chain that was recorded at the time', async () => {
      const transaction = transactionFixture({ providerCategory: COFFEE_PFC });
      await categorize([transaction]);

      const explanation = await explainAssignment(database.db, {
        userId: database.userId,
        transactionId: transaction.id,
      });

      expect(explanation).toMatchObject({
        categoryKey: 'dining.coffee',
        categoryLabel: 'Coffee & Tea',
        source: 'provider',
        version: 1,
        ruleId: null,
        confirmedAt: null,
      });
      expect(explanation.confidence).toBeCloseTo(0.85, 4);
      const chain = explanation.chain as { source: string; won: boolean; detail: string }[];
      expect(chain.map((entry) => entry.source)).toEqual([
        'user',
        'rule',
        'merchant_default',
        'provider',
      ]);
      for (const entry of chain) expect(entry.detail.length).toBeGreaterThan(0);
      expect(explanation.history).toEqual([]);
    });

    it('reads the stored chain rather than re-deciding today', async () => {
      // The interesting case: the world changed after the decision. Recomputing
      // would present today's rule as the reason for a decision made under last
      // month's, and the difference between the two answers is the whole point.
      const transaction = transactionFixture({ providerCategory: COFFEE_PFC });
      await categorize([transaction]);
      await createRuleFromTransaction(
        database.db,
        { transaction, categoryKey: 'dining.restaurants' },
        context(),
      );

      const explanation = await explainAssignment(database.db, {
        userId: database.userId,
        transactionId: transaction.id,
      });
      expect(explanation.source).toBe('provider');
      const chain = explanation.chain as { source: string; detail: string }[];
      expect(chain.find((entry) => entry.source === 'rule')?.detail).toMatch(/rule\(s\) matched/u);
    });

    it('lists what the transaction used to be filed under', async () => {
      const transaction = transactionFixture({ providerCategory: COFFEE_PFC });
      await categorize([transaction]);
      await confirmAssignment(
        database.db,
        { transactionId: transaction.id, categoryKey: 'dining.bars', transaction },
        context(),
      );

      const explanation = await explainAssignment(database.db, {
        userId: database.userId,
        transactionId: transaction.id,
      });
      expect(explanation).toMatchObject({ source: 'user', categoryKey: 'dining.bars', version: 2 });
      expect(explanation.confirmedAt).not.toBeNull();
      expect(explanation.history).toEqual([
        expect.objectContaining({ version: 1, source: 'provider', categoryKey: 'dining.coffee' }),
      ]);
    });

    it('names the rule that decided, when one did', async () => {
      const transaction = transactionFixture({ providerCategory: COFFEE_PFC });
      const rule = await createRuleFromTransaction(
        database.db,
        { transaction, categoryKey: 'dining.restaurants' },
        context(),
      );
      await categorize([transaction]);

      const explanation = await explainAssignment(database.db, {
        userId: database.userId,
        transactionId: transaction.id,
      });
      expect(explanation.ruleId).toBe(rule.id);
      const chain = explanation.chain as { source: string; won: boolean; detail: string }[];
      expect(chain.find((entry) => entry.won)?.detail).toContain(
        'Always categorise Blue Bottle Coffee',
      );
    });

    it('says so when there is nothing to explain', async () => {
      await expect(
        explainAssignment(database.db, { userId: database.userId, transactionId: newId() }),
      ).rejects.toMatchObject({ code: 'categorization.assignment_not_found' });
    });
  });

  // -------------------------------------------------------------------------
  // The batch path itself
  // -------------------------------------------------------------------------

  describe('categorizeTransactions', () => {
    it('refuses to run against an unseeded taxonomy rather than writing nonsense', async () => {
      await database.db.execute(sql`DELETE FROM categories WHERE user_id = ${database.userId}`);
      await expect(
        categorize([transactionFixture({ providerCategory: COFFEE_PFC })]),
      ).rejects.toMatchObject({
        code: 'categorization.taxonomy_not_seeded',
      });
    });

    it('reports what it considered, wrote and skipped', async () => {
      const decided = transactionFixture({ providerCategory: COFFEE_PFC });
      const nothingToSay = transactionFixture({ payee: 'ZZQX', rawDescriptor: 'ZZQX' });
      const result = await categorize([decided, nothingToSay]);

      expect(result).toMatchObject({ considered: 2, written: 1, skipped: 1 });
      expect(result.bySource).toEqual({ provider: 1 });
    });

    it('scopes a pass to the accounts it was given', async () => {
      const mine = transactionFixture({ providerCategory: COFFEE_PFC });
      const theirs = transactionFixture({
        providerCategory: COFFEE_PFC,
        accountId: '00000000-0000-7000-8000-b00000000002',
      });

      await categorizeTransactions(
        database.db,
        inMemoryPort([mine, theirs]),
        { accountIds: [mine.accountId] },
        context(),
      );

      expect(await currentAssignmentOf(database, mine.id)).not.toBeNull();
      expect(await assignmentsOf(database, theirs.id)).toEqual([]);
    });

    it('ignores a rule marked "not on sync" during a sync, and honours it otherwise', async () => {
      const transaction = transactionFixture({ providerCategory: COFFEE_PFC });
      const rule = await createRuleFromTransaction(
        database.db,
        { transaction, categoryKey: 'dining.restaurants', runOnSync: false },
        context(),
      );
      expect(rule.runOnSync).toBe(false);

      await categorize([transaction]);
      expect(await currentAssignmentOf(database, transaction.id)).toMatchObject({
        source: 'provider',
      });

      await applyRule(
        database.db,
        inMemoryPort([transaction]),
        { ruleId: rule.id, retroactive: true },
        context(),
      );
      expect(await currentAssignmentOf(database, transaction.id)).toMatchObject({ source: 'rule' });
    });

    it('lets a learned merchant default beat the provider', async () => {
      for (const transaction of [chewy(), chewy({ id: newId() }), chewy({ id: newId() })]) {
        await confirmAssignment(
          database.db,
          { transactionId: transaction.id, categoryKey: 'family.pets', transaction },
          context(),
        );
      }

      // Same merchant, and a provider category that disagrees.
      const next = chewy({ id: newId(), providerCategory: COFFEE_PFC });
      await categorize([next]);

      const assignment = await currentAssignmentOf(database, next.id);
      expect(assignment).toMatchObject({ source: 'merchant_default', category_key: 'family.pets' });
      expect(Number(assignment?.confidence)).toBeGreaterThan(0.6);
      expect(Number(assignment?.confidence)).toBeLessThan(1);
    });

    it('stores confidence as a bounded numeric, never a float artefact', async () => {
      const transaction = transactionFixture({ providerCategory: COFFEE_PFC });
      await categorize([transaction]);
      const row = await database.db.execute<{ confidence: string }>(
        sql`SELECT confidence FROM category_assignments WHERE transaction_id = ${transaction.id}`,
      );
      // NUMERIC(5,4), as text from the driver — the schema-wide ban on float
      // columns applies to a confidence score as much as to money.
      expect(row.rows[0]?.confidence).toMatch(/^[01]\.\d{4}$/u);
    });
  });
});
