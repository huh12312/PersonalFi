// SPDX-License-Identifier: MIT
/**
 * WP 11.1 — the rule suggestion's dismissal ladder, per merchant, against a
 * real Postgres.
 *
 * The advisor's key is `spending.rule_suggestion.<merchant token>`, so the
 * existing (advisor_id, key) ladder (07 §7.4: 30 days, 90 days, permanent) is
 * per merchant by construction. This proves it with the rows: the real
 * built-in, the real builder over an in-memory `CategorizationPort`, the real
 * `runAdvisor` and `reviewInsight`. Dismissing the pet store silences the pet
 * store for thirty days and leaves the bakery exactly where it was.
 */
import { createTestDatabase } from '@core/testkit';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { insightDismissals, insights } from '../../schema/index.ts';
import { advisorFor } from '../../src/advisors/catalogue.ts';
import { spendingRuleSuggestion } from '../../src/advisors/builtin/rule-suggestion/index.ts';
import { createAdvisorRegistry } from '../../src/registry.ts';
import { reviewInsight, runAdvisor, type InsightsDependencies } from '../../src/service.ts';
import { emptyPorts, inMemoryCategorizationPort } from '../../src/snapshot/ports.ts';
import { grantScopes, registerAdvisor } from '../../src/store.ts';
import {
  EPOCH,
  NO_DATABASE,
  USD,
  ZONE,
  clockAt,
  contextFor,
  type TestDatabase,
} from './harness.ts';

const PET_STORE = '01930000-0000-7000-8000-00000000a001';
const BAKERY = '01930000-0000-7000-8000-00000000a002';

function plusDays(days: number): string {
  return new Date(new Date(EPOCH).getTime() + days * 86_400_000).toISOString();
}

function dependencies(): InsightsDependencies {
  return {
    registry: createAdvisorRegistry([advisorFor(spendingRuleSuggestion)]),
    ports: {
      ...emptyPorts(),
      categorization: inMemoryCategorizationPort([
        {
          merchantId: PET_STORE,
          categoryId: '01930000-0000-7000-8000-00000000c001',
          categorySlug: 'shopping.pets',
          confirmations: 4,
          transactionIds: [
            '01930000-0000-7000-8000-000000010004',
            '01930000-0000-7000-8000-000000010003',
            '01930000-0000-7000-8000-000000010002',
            '01930000-0000-7000-8000-000000010001',
          ],
          coveredByRule: false,
          lockedDefault: false,
        },
        {
          merchantId: BAKERY,
          categoryId: '01930000-0000-7000-8000-00000000c002',
          categorySlug: 'food.bakery',
          confirmations: 3,
          transactionIds: [
            '01930000-0000-7000-8000-000000020003',
            '01930000-0000-7000-8000-000000020002',
            '01930000-0000-7000-8000-000000020001',
          ],
          coveredByRule: false,
          lockedDefault: false,
        },
      ]),
    },
    settings: {
      advisorsEnabled: true,
      moduleEnabled: true,
      timeZone: ZONE,
      baseCurrency: USD,
      tokenSecret: 'wp111-secret',
    },
  };
}

describe.skipIf(NO_DATABASE)('the rule suggestion, dismissed', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database ??= await createTestDatabase('wp111_ins_rule_suggestion');
    await database.truncate();
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  async function run(at: string) {
    return runAdvisor(database.db, contextFor(database.userId, clockAt(at)), dependencies(), {
      advisorId: spendingRuleSuggestion.manifest.advisor_id,
      trigger: 'schedule',
    });
  }

  it('silences the dismissed merchant for thirty days and no other', async () => {
    const context = contextFor(database.userId);
    await registerAdvisor(database.db, context, {
      manifest: spendingRuleSuggestion.manifest,
      enabled: true,
    });
    await grantScopes(database.db, context, spendingRuleSuggestion.manifest.advisor_id, [
      'categorization.rule_candidates',
    ]);

    const first = await run(EPOCH);
    expect(first.status).toBe('completed');
    expect(first.accepted).toBe(2);
    expect(first.inserted).toBe(2);
    expect(first.emittedScopes).toEqual(['categorization.rule_candidates']);

    const rows = await database.db.select().from(insights).orderBy(asc(insights.key));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.period === 'all_time')).toBe(true);
    expect(rows.every((row) => row.severity === 'info')).toBe(true);
    expect(rows.every((row) => row.status === 'pending_review')).toBe(true);
    const pets = rows.find((row) => row.summaryMd.includes('shopping.pets'));
    const bakery = rows.find((row) => row.summaryMd.includes('food.bakery'));
    expect(pets).toBeDefined();
    expect(bakery).toBeDefined();
    if (pets === undefined || bakery === undefined) return;

    const review = await reviewInsight(database.db, contextFor(database.userId, clockAt(EPOCH)), {
      insightId: pets.id,
      action: 'dismiss',
    });
    expect(review.dismissCount).toBe(1);
    expect(review.suppressedUntil?.toISOString()).toBe(plusDays(30));

    // The ladder is keyed on the pet store's insight key alone.
    const ladder = await database.db.select().from(insightDismissals);
    expect(ladder.map((row) => row.insightKey)).toEqual([pets.key]);

    // Day 29: the advisor still finds both; only the pet store is held back,
    // and the bakery's row is updated in place, not re-inserted.
    const inside = await run(plusDays(29));
    expect(inside.proposed).toBe(2);
    expect(inside.suppressed).toBe(1);
    expect(inside.accepted).toBe(1);
    expect(inside.inserted).toBe(0);
    const [petsAfter] = await database.db.select().from(insights).where(eq(insights.id, pets.id));
    expect(petsAfter?.status).toBe('dismissed');
    const [bakeryAfter] = await database.db
      .select()
      .from(insights)
      .where(eq(insights.id, bakery.id));
    expect(bakeryAfter?.status).toBe('pending_review');
    expect(bakeryAfter?.lastProposedAt.toISOString()).toBe(plusDays(29));

    // Day 30: the pet store is offered again.
    const outside = await run(plusDays(30));
    expect(outside.suppressed).toBe(0);
    expect(outside.accepted).toBe(2);
  });
});
