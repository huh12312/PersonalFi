// SPDX-License-Identifier: MIT
/**
 * `publishWeeklyBrief` against a real Postgres (05-phase-5-dispatch.md §3 WP
 * 5.6; migration 0032): idempotence, immutability, and that a published
 * item's retirement effect always names what computed it.
 *
 * A custom scenario rather than `harness.ts`'s `scenario()`/`selfCiting`: the
 * Brief needs an insight that claims a dollar figure and a proposed action,
 * which `selfCiting` deliberately carries neither of (`harness.ts`'s own
 * header — "keeps the persistence suites about persistence"). Built the same
 * way `selfCiting` is: one number, `80000` minor units, placed in the
 * snapshot (a single cash account's balance) and cited back verbatim, so it
 * is traceable without a derivation.
 */
import { Money, fixedClock } from '@core/kernel';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AdvisorManifest } from '../../src/contract/manifest.ts';
import type { AdvisorRequest } from '../../src/contract/request.ts';
import type { Insight } from '../../src/contract/response.ts';
import { createAdvisorRegistry } from '../../src/registry.ts';
import { runAdvisor, type InsightsDependencies } from '../../src/service.ts';
import { grantScopes, registerAdvisor } from '../../src/store.ts';
import {
  inMemoryBudgetPort,
  inMemoryInvestmentsPort,
  inMemoryLedgerPort,
  inMemoryMarketDataPort,
  inMemoryRecurringPort,
} from '../../src/snapshot/ports.ts';
import { assembleBrief } from '../../src/brief/assembly.ts';
import {
  RETIREMENT_EFFECT_ASSUMPTION,
  type RetirementImpactAnswer,
  type RetirementImpactPort,
} from '../../src/brief/ports.ts';
import {
  findBriefByWeek,
  loadAdvisorKinds,
  loadCandidates,
  listBriefItems,
  publishWeeklyBrief,
} from '../../src/brief/store.ts';
import { baseManifest, responseFor, stubAdvisor } from '../fixtures.ts';
import {
  ACCOUNT_ID,
  EPOCH,
  GRANTED_SCOPES,
  NO_DATABASE,
  USD,
  ZONE,
  clockAt,
  contextFor,
  insightsDatabase,
  type TestDatabase,
} from './harness.ts';

const IMPACT_MINOR = 80_000n; // $800 — matches the sole account's balance exactly.
const ISO_WEEK = '2026-W39';

function worthyInsight(): Insight {
  return {
    key: 'subscription.annual_cost.example',
    period: '2026-09',
    type: 'subscription.annual_cost',
    severity: 'notable',
    title: 'A subscription worth reviewing',
    summary_md: 'This subscription is worth a look.',
    confidence: 1,
    confidence_basis: 'deterministic',
    horizon: 'this_year',
    requires_review: true,
    impact: {
      annualized: { minor: IMPACT_MINOR.toString(), currency: USD },
      one_time: null,
      basis: 'Matches the cash balance on record.',
      derivation_id: null,
    },
    evidence: [
      {
        kind: 'metric',
        label: 'Cash on hand',
        value: '$800.00',
        source_ref: 'snapshot:cash_summary.total',
        url: null,
      },
    ],
    derivations: [],
    proposed_actions: [
      {
        kind: 'suggest_only',
        label: 'Review this subscription',
        rationale_md: 'Worth a look if no longer used.',
        url: null,
      },
    ],
    caveats: [],
    expires_at: null,
  } satisfies Insight;
}

/** One cash account holding exactly `IMPACT_MINOR` — never `harness.ts`'s zero-balance `portsFor`. */
function worthyDependencies(): { manifest: AdvisorManifest; dependencies: InsightsDependencies } {
  const manifest = baseManifest();
  const advisor = stubAdvisor(manifest, (request: AdvisorRequest) =>
    responseFor(request, [worthyInsight()]),
  );
  const dependencies: InsightsDependencies = {
    registry: createAdvisorRegistry([advisor]),
    ports: {
      ledger: inMemoryLedgerPort({
        accounts: [
          {
            id: ACCOUNT_ID,
            type: 'checking',
            isCash: true,
            balance: Money.of(IMPACT_MINOR, USD),
            apy: null,
            closed: false,
          },
        ],
      }),
      budget: inMemoryBudgetPort(null),
      recurring: inMemoryRecurringPort([]),
      investments: inMemoryInvestmentsPort({}),
      marketData: inMemoryMarketDataPort(null),
    },
    settings: {
      advisorsEnabled: true,
      moduleEnabled: true,
      timeZone: ZONE,
      baseCurrency: USD,
      tokenSecret: 'test-secret',
    },
  };
  return { manifest, dependencies };
}

const COMPUTED_ANSWER: RetirementImpactAnswer = Object.freeze({
  kind: 'computed' as const,
  engineVersion: 'engine-brief-db-test',
  assumptionsVersion: `sha256:${'c'.repeat(64)}`,
  plannedRetirementAge: 65,
  baseline: { kind: 'earliest' as const, age: 65, engineRuns: 3 },
  withAction: { kind: 'earliest' as const, age: 64, engineRuns: 3 },
  yearsEarlier: 1,
  monthsOfSpending: {
    months: 10,
    atAge: 65,
    wealthDifference: Money.of(400_000n, USD),
    firstYearSpending: Money.of(4_800_000n, USD),
    derivation: 'test derivation',
  },
  assumption: RETIREMENT_EFFECT_ASSUMPTION,
});

/** Counts calls; always answers the same computed effect. */
function fakePort(): { readonly port: RetirementImpactPort; readonly callCount: () => number } {
  let calls = 0;
  return {
    callCount: () => calls,
    port: {
      async effectOf() {
        calls += 1;
        return COMPUTED_ANSWER;
      },
    },
  };
}

describe.skipIf(NO_DATABASE)('publishWeeklyBrief', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database ??= await insightsDatabase('brief');
    await database.truncate();
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  async function seedOneInsight(): Promise<void> {
    const { manifest, dependencies } = worthyDependencies();
    const context = contextFor(database.userId, clockAt(EPOCH));
    await registerAdvisor(database.db, context, { manifest, enabled: true });
    await grantScopes(database.db, context, manifest.advisor_id, [...GRANTED_SCOPES]);
    const result = await runAdvisor(database.db, context, dependencies, {
      advisorId: manifest.advisor_id,
      trigger: 'schedule',
    });
    expect(result.status, JSON.stringify(result)).toBe('completed');
    expect(result.inserted, JSON.stringify(result.rejections)).toBe(1);
  }

  async function assembleForWeek(now: Date) {
    const [candidates, advisorKinds] = await Promise.all([
      loadCandidates(database.db, database.userId, now),
      loadAdvisorKinds(database.db, database.userId),
    ]);
    return assembleBrief({
      candidates,
      advisorKindOf: (advisorId) => advisorKinds.get(advisorId),
      dismissRateOf: () => 0,
      carriedIdentities: new Set(),
      currencyCode: USD,
      historyDays: 60,
    });
  }

  it('the Brief is idempotent per ISO week and immutable once published', async () => {
    await seedOneInsight();
    const now = new Date(EPOCH);
    const assembled = await assembleForWeek(now);
    expect(assembled.ranked).toHaveLength(1);

    const { port, callCount } = fakePort();
    const first = await publishWeeklyBrief(database.db, {
      userId: database.userId,
      isoWeek: ISO_WEEK,
      currencyCode: USD,
      assembled,
      retirementEffectOf: (candidate) =>
        port.effectOf({
          userId: database.userId,
          action: { kind: 'extra_annual', annual: candidate.annualizedImpact ?? Money.zero(USD) },
        }),
      clock: fixedClock(EPOCH),
    });
    expect(first.alreadyPublished).toBe(false);
    const callsAfterFirst = callCount();
    expect(callsAfterFirst).toBe(1);

    const itemsAfterFirst = await listBriefItems(database.db, database.userId, first.id);
    expect(itemsAfterFirst).toHaveLength(1);

    // A second publish for the same week: no new row, no new items, and —
    // because the short-circuit runs before any engine work — the port is
    // never called again either.
    const second = await publishWeeklyBrief(database.db, {
      userId: database.userId,
      isoWeek: ISO_WEEK,
      currencyCode: USD,
      assembled,
      retirementEffectOf: (candidate) =>
        port.effectOf({
          userId: database.userId,
          action: { kind: 'extra_annual', annual: candidate.annualizedImpact ?? Money.zero(USD) },
        }),
      clock: fixedClock(EPOCH),
    });
    expect(second.alreadyPublished).toBe(true);
    expect(second.id).toBe(first.id);
    expect(callCount()).toBe(callsAfterFirst);

    const itemsAfterSecond = await listBriefItems(database.db, database.userId, first.id);
    expect(itemsAfterSecond).toHaveLength(1);
    expect(itemsAfterSecond[0]?.id).toBe(itemsAfterFirst[0]?.id);

    const stored = await findBriefByWeek(database.db, database.userId, ISO_WEEK);
    expect(stored?.id).toBe(first.id);
  });

  it('every retirement effect on a published Brief names the engine and assumptions versions that computed it', async () => {
    await seedOneInsight();
    const now = new Date(EPOCH);
    const assembled = await assembleForWeek(now);
    const { port } = fakePort();

    const published = await publishWeeklyBrief(database.db, {
      userId: database.userId,
      isoWeek: ISO_WEEK,
      currencyCode: USD,
      assembled,
      retirementEffectOf: (candidate) =>
        port.effectOf({
          userId: database.userId,
          action: { kind: 'extra_annual', annual: candidate.annualizedImpact ?? Money.zero(USD) },
        }),
      clock: fixedClock(EPOCH),
    });

    const items = await listBriefItems(database.db, database.userId, published.id);
    expect(items).toHaveLength(1);
    const effect = items[0]?.retirementEffect;
    expect(effect?.kind).toBe('computed');
    if (effect?.kind === 'computed') {
      expect(effect.engineVersion).toBe(COMPUTED_ANSWER.engineVersion);
      expect(effect.assumptionsVersion).toBe(COMPUTED_ANSWER.assumptionsVersion);
    }
  });
});
