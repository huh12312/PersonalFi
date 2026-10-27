// SPDX-License-Identifier: MIT
/**
 * WP 11.2b, this context's half, against a real Postgres: what the categorisation pass hands the ledger so that
 * tiers 3-5 become the effective category.
 *
 * The ledger's projection (`transactions.auto_*`) is proven in `@ctx/ledger`'s own suite. What is proven here is the
 * contract between the two: the pass offers a placement for exactly the three automatic tiers, with the id and the
 * confidence it just stored (never a recomputed figure), clears it when a rule takes the row over or when every tier
 * abstains, offers nothing for a holder's own pick or a preview, and the reprojection (the backfill, the self-heal and
 * the import's twin) offers the same changes from the current assignments, idempotently.
 */
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIDENCE_FLOOR } from '../src/engine.ts';
import { reprojectAutoCategories } from '../src/auto-projection.ts';
import { explainTransactions } from '../src/explain.ts';
import {
  applyRule,
  categorizeTransactions,
  confirmAssignment,
  createRuleFromTransaction,
  retrainClassifier,
} from '../src/service.ts';
import { categoryIdsByKey, seedSystemTaxonomy } from '../src/seed-taxonomy.ts';
import type {
  AutoCategoryChangeInput,
  CategorizableTransaction,
  CategorizationExecutor,
} from '../src/index.ts';
import {
  NO_DATABASE,
  categorizationDatabase,
  currentAssignmentOf,
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
const CHEWY_MERCHANT = '00000000-0000-7000-8000-c00000000642';
const CHEVRON_MERCHANT = '00000000-0000-7000-8000-c00000000643';

describe.skipIf(NO_DATABASE)('WP 11.2b — tiers 3-5 reach the ledger as a placement', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;
  let ids: ReadonlyMap<string, string>;

  beforeAll(async () => {
    database = await categorizationDatabase('wp112b');
  });
  afterAll(async () => {
    await database.drop();
  });
  beforeEach(async () => {
    await database.truncate();
    clock = testClock();
    await seedSystemTaxonomy(database.db, { userId: database.userId, clock });
    ids = await categoryIdsByKey(database.db as unknown as CategorizationExecutor, database.userId);
  });
  const context = () => writeContext(database, clock);

  const chewy = (overrides: Partial<CategorizableTransaction> = {}) =>
    transactionFixture({
      payee: 'CHEWY.COM',
      rawDescriptor: 'CHEWY.COM 800-672-4399 FL',
      merchantId: CHEWY_MERCHANT,
      amountMinor: -4_250n,
      ...overrides,
    });

  async function categorize(
    rows: readonly CategorizableTransaction[],
    options: Parameters<typeof categorizeTransactions>[4] = {},
  ) {
    const port = inMemoryPort(rows);
    const result = await categorizeTransactions(
      database.db,
      port,
      { transactionIds: rows.map((row) => row.id) },
      context(),
      options,
    );
    const changes = port.autoCategoryWrites.flatMap((write) => write.changes);
    return { result, port, changes };
  }

  const placementOf = (changes: readonly AutoCategoryChangeInput[], id: string) =>
    changes.find((change) => change.transactionId === id);

  it('tier 4 (the provider): the placement carries the stored assignment id, category and confidence', async () => {
    const row = chewy({ providerCategory: COFFEE_PFC });
    const { changes, port } = await categorize([row]);
    const stored = await currentAssignmentOf(database, row.id);
    expect(stored?.source).toBe('provider');
    expect(placementOf(changes, row.id)?.placement).toEqual({
      assignmentId: stored?.id,
      categoryId: ids.get(stored?.category_key ?? ''),
      tier: 'provider',
      confidence: Number(stored?.confidence),
      decidedAt: new Date('2026-06-01T12:00:00.000Z'),
    });
    // Written on the pass's own transaction handle, so it commits with the assignment and before the event.
    expect(port.autoCategoryWrites[0]?.executor).toBeDefined();
  });

  it('tier 3 (a learned merchant default): projects, and the stored chain says from how many confirmations', async () => {
    for (let i = 0; i < 3; i += 1) {
      const prior = chewy({ id: newId() });
      await confirmAssignment(
        database.db,
        { transactionId: prior.id, categoryKey: 'family.pets', transaction: prior },
        context(),
      );
    }
    const row = chewy();
    const { changes } = await categorize([row]);
    const placement = placementOf(changes, row.id)?.placement;
    expect(placement).toMatchObject({
      tier: 'merchant_default',
      categoryId: ids.get('family.pets'),
    });
    const stored = await currentAssignmentOf(database, row.id);
    expect(placement?.confidence).toBe(Number(stored?.confidence));

    const [explained] = await explainTransactions(
      database.db as unknown as CategorizationExecutor,
      {
        userId: database.userId,
        transactionIds: [row.id],
      },
    );
    expect(explained?.status).toBe('assigned');
    expect(explained?.tiers.find((tier) => tier.won)).toMatchObject({
      source: 'merchant_default',
      facts: { support: 3, locked: false },
    });
  });

  it('tier 5 (the classifier): projects only at or above its floor, with the stored figure', async () => {
    for (let i = 0; i < 5; i += 1) {
      const pet = chewy({ id: newId() });
      await confirmAssignment(
        database.db,
        { transactionId: pet.id, categoryKey: 'family.pets', transaction: pet },
        context(),
      );
      const fuel = transactionFixture({
        id: newId(),
        payee: 'CHEVRON 1093882 AUSTIN TX',
        rawDescriptor: 'CHEVRON 1093882 AUSTIN TX',
        merchantId: CHEVRON_MERCHANT,
        amountMinor: -5_500n,
      });
      await confirmAssignment(
        database.db,
        { transactionId: fuel.id, categoryKey: 'transport.fuel', transaction: fuel },
        context(),
      );
    }
    await retrainClassifier(database.db, context());
    const row = chewy({ id: newId(), merchantId: '00000000-0000-7000-8000-c00000000699' });
    const { changes } = await categorize([row]);
    const placement = placementOf(changes, row.id)?.placement;
    expect(placement?.tier).toBe('classifier');
    expect(placement?.confidence).toBeGreaterThanOrEqual(DEFAULT_CONFIDENCE_FLOOR);
    const stored = await currentAssignmentOf(database, row.id);
    expect(placement?.confidence).toBe(Number(stored?.confidence));

    // Raise the floor above what the model can reach: the engine abstains, so nothing is offered.
    const unsure = chewy({ id: newId(), merchantId: '00000000-0000-7000-8000-c00000000698' });
    const { changes: none, result } = await categorize([unsure], { confidenceFloor: 0.9999 });
    expect(result.bySource['classifier']).toBeUndefined();
    expect(placementOf(none, unsure.id)?.placement ?? null).toBeNull();
  });

  it('tier 6: every tier abstaining on a never-assigned row clears (tier 6 leaves no placement); nothing is offered as a placement', async () => {
    const row = transactionFixture({ payee: 'ZZZ UNKNOWN LLC', rawDescriptor: 'ZZZ UNKNOWN LLC' });
    const { changes, result } = await categorize([row]);
    expect(result.abstained).toBe(1);
    expect(changes).toEqual([{ transactionId: row.id, placement: null }]);
  });

  it('an abstention never demotes: an existing placement is not cleared by a later pass that abstains', async () => {
    const row = chewy({ providerCategory: COFFEE_PFC });
    await categorize([row]);
    const { changes } = await categorize([{ ...row, providerCategory: null }]);
    expect(changes).toEqual([]);
  });

  it('a rule taking the row over clears the machine’s placement', async () => {
    const row = chewy({ providerCategory: COFFEE_PFC });
    const port = inMemoryPort([row]);
    await categorizeTransactions(database.db, port, { transactionIds: [row.id] }, context());
    const rule = await createRuleFromTransaction(
      database.db,
      { transaction: row, categoryKey: 'family.pets' },
      context(),
    );
    const before = port.autoCategoryWrites.length;
    await applyRule(database.db, port, { ruleId: rule.id, retroactive: true }, context());
    const after = port.autoCategoryWrites.slice(before).flatMap((write) => write.changes);
    expect(after).toEqual([{ transactionId: row.id, placement: null }]);
  });

  it("a holder's own pick (tier 1) and a preview offer nothing", async () => {
    const picked = chewy({
      providerCategory: COFFEE_PFC,
      userCategoryId: ids.get('family.pets') ?? null,
    });
    expect((await categorize([picked])).changes).toEqual([]);

    const row = chewy({ providerCategory: COFFEE_PFC });
    const preview = await categorize([row], { dryRun: true });
    expect(preview.changes).toEqual([]);
    expect(preview.port.autoCategoryWrites).toHaveLength(0);
  });

  it('a re-run of the same page offers nothing new (the pass is idempotent, so is the projection it feeds)', async () => {
    const row = chewy({ providerCategory: COFFEE_PFC });
    const first = await categorize([row]);
    expect(first.changes).toHaveLength(1);
    const second = await categorize([row]);
    expect(second.changes).toEqual([]);
  });

  it('reprojection: offers tiers 3-5 as placements and rules as clears, never a holder’s pick, and repeats exactly', async () => {
    const auto = chewy({ providerCategory: COFFEE_PFC });
    const ruled = chewy({ id: newId(), providerCategory: COFFEE_PFC });
    const picked = chewy({ id: newId() });
    const port = inMemoryPort([auto, ruled, picked]);
    await categorizeTransactions(
      database.db,
      port,
      { transactionIds: [auto.id, ruled.id] },
      context(),
    );
    const rule = await createRuleFromTransaction(
      database.db,
      { transaction: ruled, categoryKey: 'family.pets' },
      context(),
    );
    // The rule matches both by payee; narrow the claim to `ruled` by applying to the single row via a direct write.
    await database.db.execute(
      sql`UPDATE category_assignments SET is_current = FALSE WHERE transaction_id = ${ruled.id}`,
    );
    await database.db.execute(sql`
      INSERT INTO category_assignments (id, user_id, transaction_id, category_id, source, confidence, rule_id, evidence, decided_at, version, is_current)
      VALUES (${newId()}, ${database.userId}, ${ruled.id}, ${ids.get('family.pets') as string}, 'rule', 1.0000, ${rule.id}, '{"chain":[]}'::jsonb, now(), 2, TRUE)`);
    await confirmAssignment(
      database.db,
      { transactionId: picked.id, categoryKey: 'family.pets', transaction: picked },
      context(),
    );

    const reproject = inMemoryPort([]);
    const first = await reprojectAutoCategories(database.db, reproject, context());
    const offered = reproject.autoCategoryWrites.flatMap((write) => write.changes);
    expect(first.considered).toBe(2);
    expect(
      offered.map((change) => [change.transactionId, change.placement?.tier ?? null]).sort(),
    ).toEqual(
      [
        [auto.id, 'provider'],
        [ruled.id, null],
      ].sort(),
    );
    const stored = await currentAssignmentOf(database, auto.id);
    expect(placementOf(offered, auto.id)?.placement).toMatchObject({
      assignmentId: stored?.id,
      confidence: Number(stored?.confidence),
    });

    const again = inMemoryPort([]);
    await reprojectAutoCategories(database.db, again, context());
    expect(again.autoCategoryWrites.flatMap((write) => write.changes)).toEqual(offered);
  });
});
