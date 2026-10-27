// SPDX-License-Identifier: MIT
/**
 * WP 11.1, against a real database: the stored working behind "uncategorised",
 * the batch "why" read, the gold-set loader that never writes, and the facts
 * behind "make this a rule?".
 */
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@core/testkit';
import {
  categorizeTransactions,
  confirmAssignment,
  createRule,
  explainAssignment,
  retrainClassifier,
} from '../src/service.ts';
import { explainTransactions } from '../src/explain.ts';
import { loadGoldSet } from '../src/eval/load.ts';
import { replayGoldSet } from '../src/eval/replay.ts';
import { listRuleCandidates } from '../src/rule-candidates.ts';
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
import { DateOnly } from '@core/kernel';

const CHEWY = '00000000-0000-7000-8000-c00000000111';
const PETCO = '00000000-0000-7000-8000-c00000000112';
const MYSTERY = '00000000-0000-7000-8000-c00000000113';

function chewy(overrides: Partial<CategorizableTransaction> = {}): CategorizableTransaction {
  return transactionFixture({
    payee: 'CHEWY.COM',
    rawDescriptor: 'CHEWY.COM 800 FL',
    merchantId: CHEWY,
    amountMinor: -4_200n,
    ...overrides,
  });
}

/** Every table this package owns, counted — the "never writes" witness. */
const OWNED = [
  'category_assignments',
  'category_abstentions',
  'classifier_examples',
  'classifier_versions',
  'merchant_profiles',
  'rules',
  'rule_runs',
  'categories',
] as const;

async function counts(database: TestDatabase): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of OWNED) out[table] = await countRows(database, table);
  out['domain_events'] = await countRows(database, 'domain_events');
  return out;
}

describe.skipIf(NO_DATABASE)(
  'WP 11.1 — stored working, explanations, gold set, rule candidates',
  () => {
    let database: TestDatabase;
    let clock: ReturnType<typeof testClock>;

    beforeAll(async () => {
      // Scratch name prefixed per the WP's database rule.
      database = await createTestDatabase(`wp111_catg_${newId().replaceAll('-', '').slice(-12)}`);
    });

    afterAll(async () => {
      await database.drop();
    });

    beforeEach(async () => {
      await database.truncate();
      clock = testClock();
      await seedSystemTaxonomy(database.db, { userId: database.userId, clock });
    });

    const context = () => writeContext(database, clock);

    it('records the working when every tier abstains, and reads it back as the line', async () => {
      const mystery = transactionFixture({
        payee: 'ODDITY',
        rawDescriptor: 'ODDITY',
        merchantId: MYSTERY,
      });
      const port = inMemoryPort([mystery]);
      await categorizeTransactions(database.db, port, { transactionIds: [mystery.id] }, context());

      expect(await countRows(database, 'category_assignments')).toBe(0);
      expect(await countRows(database, 'category_abstentions')).toBe(1);

      const [explained] = await explainTransactions(
        database.db as unknown as CategorizationExecutor,
        {
          userId: database.userId,
          transactionIds: [mystery.id],
        },
      );
      expect(explained).toMatchObject({ status: 'abstained', source: 'none' });
      expect(explained?.line).toBe(
        'Every tier abstained: no rules yet, merchant never confirmed, no bank category, ' +
          'classifier has no confirmed examples yet.',
      );
      expect(explained?.tiers.map((tier) => tier.source)).toEqual([
        'user',
        'rule',
        'merchant_default',
        'provider',
        'classifier',
        'none',
      ]);
    });

    it('reads the stored line even after the world changed, rather than re-deciding', async () => {
      const mystery = transactionFixture({
        payee: 'ODDITY',
        rawDescriptor: 'ODDITY',
        merchantId: MYSTERY,
      });
      const port = inMemoryPort([mystery]);
      await categorizeTransactions(database.db, port, { transactionIds: [mystery.id] }, context());
      // A rule now exists that would file it — but nothing re-ran, so the stored
      // working (and so the line) is still what decided.
      await createRule(database.db, {
        userId: database.userId,
        name: 'ODDITY is shopping',
        conditions: { all: [{ type: 'payee', match: 'contains', value: 'ODDITY' }], any: [] },
        actions: [{ type: 'set_category', categoryKey: 'shopping.other_shopping' }],
      });
      const [explained] = await explainTransactions(
        database.db as unknown as CategorizationExecutor,
        {
          userId: database.userId,
          transactionIds: [mystery.id],
        },
      );
      expect(explained?.line).toContain('no rules yet');
    });

    it('rewrites the working only when it changes, and drops it once assigned', async () => {
      const mystery = transactionFixture({
        payee: 'ODDITY',
        rawDescriptor: 'ODDITY',
        merchantId: MYSTERY,
      });
      const port = inMemoryPort([mystery]);
      await categorizeTransactions(database.db, port, { transactionIds: [mystery.id] }, context());
      const before = await database.db.execute<{ decided_at: Date }>(
        sql`SELECT decided_at FROM category_abstentions`,
      );
      clock.advanceMs(86_400_000);
      await categorizeTransactions(database.db, port, { transactionIds: [mystery.id] }, context());
      const after = await database.db.execute<{ decided_at: Date }>(
        sql`SELECT decided_at FROM category_abstentions`,
      );
      expect(after.rows[0]?.decided_at).toEqual(before.rows[0]?.decided_at);

      await confirmAssignment(
        database.db,
        { transactionId: mystery.id, categoryKey: 'shopping.other_shopping', transaction: mystery },
        context(),
      );
      expect(await countRows(database, 'category_abstentions')).toBe(0);
      const [explained] = await explainTransactions(
        database.db as unknown as CategorizationExecutor,
        {
          userId: database.userId,
          transactionIds: [mystery.id],
        },
      );
      expect(explained).toMatchObject({ status: 'assigned', source: 'user' });
      expect(explained?.line).toBe('You chose this category.');
    });

    it('a preview writes no working', async () => {
      const mystery = transactionFixture({
        payee: 'ODDITY',
        rawDescriptor: 'ODDITY',
        merchantId: MYSTERY,
      });
      await categorizeTransactions(
        database.db,
        inMemoryPort([mystery]),
        { transactionIds: [mystery.id] },
        context(),
        { dryRun: true },
      );
      expect(await countRows(database, 'category_abstentions')).toBe(0);
    });

    it('says so honestly when no pass has recorded anything', async () => {
      const [explained] = await explainTransactions(
        database.db as unknown as CategorizationExecutor,
        {
          userId: database.userId,
          transactionIds: [newId()],
        },
      );
      expect(explained).toMatchObject({ status: 'not_recorded', source: null, tiers: [] });
    });

    it('explainAssignment names the WP 11.1 features that moved a classifier decision', async () => {
      // Confirm Chewy on the 2nd and Chevron on the 25th, then ask about a
      // Chewy-tokened row: the stored chain must name its signals, `dm:` included.
      const examples = [
        ...Array.from({ length: 4 }, (_, i) =>
          chewy({ date: DateOnly.parse(`2026-05-0${String(i + 2)}`), merchantId: null }),
        ),
        ...Array.from({ length: 4 }, (_, i) =>
          transactionFixture({
            payee: 'CHEWY.COM',
            rawDescriptor: 'CHEWY.COM 800 FL',
            merchantId: null,
            amountMinor: -90_000n,
            date: DateOnly.parse(`2026-05-2${String(i + 2)}`),
          }),
        ),
      ];
      for (const [index, transaction] of examples.entries()) {
        await confirmAssignment(
          database.db,
          {
            transactionId: transaction.id,
            categoryKey: index < 4 ? 'family.pets' : 'shopping.other_shopping',
            transaction,
          },
          context(),
        );
      }
      await retrainClassifier(database.db, context());
      const fresh = chewy({ merchantId: null, date: DateOnly.parse('2026-06-03') });
      await categorizeTransactions(
        database.db,
        inMemoryPort([fresh]),
        { transactionIds: [fresh.id] },
        context(),
      );
      const explanation = await explainAssignment(database.db, {
        userId: database.userId,
        transactionId: fresh.id,
      });
      expect(explanation.source).toBe('classifier');
      const tier = explanation.chain.find(
        (entry) => (entry as { source?: string }).source === 'classifier',
      ) as { detail: string; facts: { signals: string } };
      expect(tier.detail).toMatch(/dm:early|b:/u);
      expect(tier.facts.signals.split(' ').length).toBeGreaterThan(0);
      for (const signal of tier.facts.signals.split(' ')) expect(tier.detail).toContain(signal);
    });

    it('loads the gold set, replays it, and writes nothing — not a row, not an event', async () => {
      const corpus = [
        ...Array.from({ length: 3 }, () => chewy()),
        transactionFixture({ payee: 'PETCO', rawDescriptor: 'PETCO 123', merchantId: PETCO }),
      ];
      for (const transaction of corpus) {
        await confirmAssignment(
          database.db,
          { transactionId: transaction.id, categoryKey: 'family.pets', transaction },
          context(),
        );
      }
      const before = await counts(database);
      const loaded = await database.db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        return loadGoldSet(
          tx as unknown as CategorizationExecutor,
          inMemoryPort(corpus),
          database.userId,
        );
      });
      expect(loaded.examples).toHaveLength(4);
      expect(loaded.missingTransactions).toBe(0);
      const report = replayGoldSet(loaded.examples, {
        rules: loaded.rules,
        lockedMerchantDefaults: loaded.lockedMerchantDefaults,
      });
      expect(report.total).toBe(4);
      expect(await counts(database)).toEqual(before);
    });

    it('reads the holder’s answers from the ledger overlay too (the API never confirms)', async () => {
      const idByKey = await categoryIdsByKey(
        database.db as unknown as CategorizationExecutor,
        database.userId,
      );
      const pets = idByKey.get('family.pets') as string;
      const overlaid = Array.from({ length: 3 }, () => chewy({ userCategoryId: pets }));
      const port = inMemoryPort([...overlaid, transactionFixture({ merchantId: MYSTERY })]);
      const executor = database.db as unknown as CategorizationExecutor;
      const loaded = await loadGoldSet(executor, port, database.userId);
      expect(loaded.examples).toHaveLength(3);
      expect(loaded).toMatchObject({ fromOverlay: 3, fromConfirmed: 0, missingTransactions: 0 });
      expect(loaded.examples.every((entry) => entry.expectedKey === 'family.pets')).toBe(true);
      const candidates = await listRuleCandidates(executor, port, database.userId);
      expect(candidates).toEqual([
        expect.objectContaining({
          merchantId: CHEWY,
          categoryKey: 'family.pets',
          confirmations: 3,
        }),
      ]);
    });

    it('lists merchants confirmed to one category, with rule cover and lock', async () => {
      const corpus = Array.from({ length: 4 }, () => chewy());
      const twice = [
        transactionFixture({ payee: 'PETCO', rawDescriptor: 'PETCO 123', merchantId: PETCO }),
        transactionFixture({ payee: 'PETCO', rawDescriptor: 'PETCO 456', merchantId: PETCO }),
      ];
      for (const transaction of [...corpus, ...twice]) {
        await confirmAssignment(
          database.db,
          { transactionId: transaction.id, categoryKey: 'family.pets', transaction },
          context(),
        );
      }
      const port = inMemoryPort([...corpus, ...twice]);
      const executor = database.db as unknown as CategorizationExecutor;
      const listed = await listRuleCandidates(executor, port, database.userId);
      expect(listed.map((row) => [row.merchantId, row.confirmations, row.coveredByRule])).toEqual([
        [CHEWY, 4, false],
        [PETCO, 2, false],
      ]);
      expect(listed[0]?.transactionIds).toHaveLength(4);

      await createRule(database.db, {
        userId: database.userId,
        name: 'Chewy is pets',
        conditions: { all: [{ type: 'payee', match: 'contains', value: 'CHEWY' }], any: [] },
        actions: [{ type: 'set_category', categoryKey: 'family.pets' }],
      });
      const after = await listRuleCandidates(executor, port, database.userId);
      expect(after.find((row) => row.merchantId === CHEWY)?.coveredByRule).toBe(true);
    });
  },
);
