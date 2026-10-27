// SPDX-License-Identifier: MIT
/**
 * WP 11.1 — "make this a rule?" end to end, over a real database.
 *
 * Every piece is the production one: the manual connector's rows go through
 * the real ledger (which resolves the merchants), the holder's confirmations
 * through `PATCH /transactions/{id}` (the overlay — the path a real install
 * files by hand through, which `listRuleCandidates` counts), the snapshot through
 * `createInsightsCategorizationPort` (the binding `modules.ts` gives the
 * nightly run), the grant through `PUT /advisors/{id}/grants` — so migration
 * 0054's widened CHECK is what accepts it — and the rule and the review
 * through their own HTTP routes.
 *
 * The claims:
 *
 *   1. Four confirmations of one merchant become one persisted, pending
 *      `spending.rule_suggestion.<token>` insight carrying a `create_rule_draft`
 *      action and evidence that names the category and the merchant's newest
 *      confirmed transaction by uuid; two confirmations of another become
 *      nothing.
 *   2. Saving the rule the insight drafted (`POST /transactions/{id}/rule`)
 *      and accepting the insight (`POST /insights/{id}/review`) leaves it
 *      `accepted`, and a re-run with the rule in place proposes nothing for
 *      that merchant — `covered_by_rule`, answered by `decide` over the real
 *      rule.
 */
import { manualTransaction } from '@connector/manual';
import { DateOnly, money, newId, systemClock } from '@core/kernel';
import { listCategories } from '@ctx/categorization';
import {
  RULE_SUGGESTION_ADVISOR_ID,
  createBuiltinRegistry,
  runAdvisor,
  type InsightsDependencies,
} from '@ctx/insights';
import { insightActions, insightEvidence, insights } from '@ctx/insights/schema';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCategorizationLedgerPort,
  createInsightsBudgetPort,
  createInsightsCategorizationPort,
  createInsightsInvestmentsPort,
  createInsightsLedgerPort,
  createInsightsMarketDataPort,
  createInsightsRecurringPort,
} from '../../src/domain.ts';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  linkManual,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const TOKEN_SECRET = 'wp-11-1-rule-suggestion-test-secret'; // gitleaks:allow — synthetic advisor-token secret for a test harness
const PETS = 'family.pets';
const COFFEE = 'dining.coffee';

describe.skipIf(NO_DATABASE)('the rule suggestion over a real database (WP 11.1)', () => {
  let h: ApiHarness;
  let petsCategoryId: string;
  let petTransactionIds: readonly string[];

  function dependenciesOf(): InsightsDependencies {
    return {
      registry: createBuiltinRegistry(),
      ports: {
        ledger: createInsightsLedgerPort(h.database.db, systemClock),
        budget: createInsightsBudgetPort(h.database.db),
        recurring: createInsightsRecurringPort(h.database.db),
        investments: createInsightsInvestmentsPort(h.database.db, systemClock),
        marketData: createInsightsMarketDataPort({ source: undefined }),
        // The line this suite exists for.
        categorization: createInsightsCategorizationPort(h.database.db, systemClock),
      },
      settings: {
        advisorsEnabled: true,
        moduleEnabled: true,
        timeZone: 'UTC',
        baseCurrency: 'USD',
        tokenSecret: TOKEN_SECRET,
      },
    };
  }

  async function run() {
    return runAdvisor(
      h.database.db,
      { userId: h.userId, clock: systemClock, correlationId: newId(), causationId: null },
      dependenciesOf(),
      { advisorId: RULE_SUGGESTION_ADVISOR_ID, trigger: 'manual' },
    );
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp111_rulesug' });

    const pet = (day: number) =>
      manualTransaction({
        providerAccountId: 'checking',
        amount: money(-2_499n, 'USD'),
        postedDate: DateOnly.of(2026, 8, day),
        name: 'PAWS AND CLAWS PET SUPPLY',
      });
    const cafe = (day: number) =>
      manualTransaction({
        providerAccountId: 'checking',
        amount: money(-475n, 'USD'),
        postedDate: DateOnly.of(2026, 8, day),
        name: 'CORNER CAFE ROASTERS',
      });
    await linkManual(h, {
      providerConnectionId: 'wp111-conn',
      displayName: 'Rule Suggestion Bank',
      accounts: [
        { providerAccountId: 'checking', name: 'Everyday', type: 'depository', currency: 'USD' },
      ],
      batch: { added: [pet(3), pet(10), pet(17), pet(24), cafe(5), cafe(12)] },
    });

    const categories = await listCategories(h.database.db, h.userId);
    const idOf = (key: string): string => {
      const found = categories.find((category) => category.key === key);
      if (found === undefined) throw new Error(`the shipped taxonomy has no ${key}`);
      return found.id;
    };
    petsCategoryId = idOf(PETS);

    // The holder files each one by hand, oldest first, through the route a
    // real install uses.
    const port = createCategorizationLedgerPort(h.database.db, systemClock);
    const page = await port.listForCategorization({ userId: h.userId });
    const byDate = [...page.items].sort((a, b) => a.date.localeCompare(b.date));
    expect(byDate).toHaveLength(6);
    expect(byDate.every((transaction) => transaction.merchantId !== null)).toBe(true);
    for (const transaction of byDate) {
      const categoryKey = transaction.payee.toUpperCase().includes('PET') ? PETS : COFFEE;
      const patched = await h.request({
        method: 'PATCH',
        url: `/transactions/${transaction.id}`,
        session: h.stale,
        body: { categoryId: idOf(categoryKey) },
      });
      expectStatus(patched, 200);
    }
    petTransactionIds = byDate
      .filter((transaction) => transaction.payee.toUpperCase().includes('PET'))
      .map((transaction) => transaction.id)
      .reverse();
    expect(petTransactionIds).toHaveLength(4);

    // The holder's consent, through the route — 0054's CHECK is what lets
    // this row be stored at all.
    const granted = await h.request({
      method: 'PUT',
      url: `/advisors/${RULE_SUGGESTION_ADVISOR_ID}/grants`,
      session: h.fresh,
      body: { scopes: ['categorization.rule_candidates'] },
    });
    expectStatus(granted, 200);
    expect((granted.json() as { granted: string[] }).granted).toEqual([
      'categorization.rule_candidates',
    ]);
  }, 300_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('proposes one rule for the merchant filed four times, and none for the one filed twice', async () => {
    const result = await run();
    expect(result.status).toBe('completed');
    expect(result.emittedScopes).toEqual(['categorization.rule_candidates']);
    expect(result.rejected).toBe(0);
    expect(result.accepted).toBe(1);

    const rows = await database().select().from(insights);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) return;
    expect(row.advisorId).toBe(RULE_SUGGESTION_ADVISOR_ID);
    expect(row.key).toMatch(/^spending\.rule_suggestion\.MERCHANT_[0-9a-f]{12}$/u);
    expect(row.period).toBe('all_time');
    expect(row.severity).toBe('info');
    expect(row.status).toBe('pending_review');
    expect(row.summaryMd).toBe(
      `You have filed this merchant under ${PETS} 4 times by hand. A rule would file it there ` +
        'automatically from now on — nothing changes until you save one.',
    );
    // D22: the merchant's name is in no field of the row.
    expect(JSON.stringify(row).toUpperCase()).not.toContain('PAWS');

    const actions = await database()
      .select()
      .from(insightActions)
      .where(eq(insightActions.insightId, row.id));
    expect(actions.map((action) => [action.kind, action.label])).toEqual([
      ['create_rule_draft', 'Create rule'],
    ]);

    // What the web prefills the rule editor from: the category row and the
    // first transaction row, each carrying its uuid.
    const evidence = await database()
      .select()
      .from(insightEvidence)
      .where(eq(insightEvidence.insightId, row.id))
      .orderBy(asc(insightEvidence.position));
    expect(evidence.map((item) => item.value).slice(0, 2)).toEqual(['4', petsCategoryId]);
    // Every confirmation is cited, by uuid; the order is the reader's.
    expect(
      evidence
        .slice(2)
        .map((item) => item.value)
        .sort(),
    ).toEqual([...petTransactionIds].sort());
    expect(evidence[1]?.sourceRef).toBe('snapshot:rule_candidates.merchants[0].category_ref');
    expect(evidence[2]?.sourceRef).toBe(
      'snapshot:rule_candidates.merchants[0].transactions[0].transaction_ref',
    );
  });

  it('accepting after saving the drafted rule closes it, and a re-run proposes nothing more', async () => {
    const [row] = await database().select().from(insights);
    expect(row).toBeDefined();
    if (row === undefined) return;

    // The rule the insight drafted: its newest transaction, its category.
    const newest = petTransactionIds[0] ?? '';
    const created = await h.request({
      method: 'POST',
      url: `/transactions/${newest}/rule`,
      session: h.stale,
      body: { categoryKey: PETS },
    });
    expectStatus(created, 201);

    const reviewed = await h.request({
      method: 'POST',
      url: `/insights/${row.id}/review`,
      session: h.stale,
      body: { action: 'accept' },
    });
    expectStatus(reviewed, 200);
    expect((reviewed.json() as { status: string }).status).toBe('accepted');

    const again = await run();
    expect(again.status).toBe('completed');
    expect(again.proposed).toBe(0);
    expect(again.accepted).toBe(0);

    const rows = await database().select().from(insights);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('accepted');
  });

  function database() {
    return h.database.db;
  }
});
