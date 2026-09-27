// SPDX-License-Identifier: MIT
/**
 * WP 4.9 — the three planning snapshot arms driven over a real database by the
 * real composition-root port, the one new scope granted through the real
 * consent route, and the retirement wave run on top.
 *
 * ## What this suite is for
 *
 * `packages/contexts/insights/test/snapshot-arms.test.ts` proves the builder's
 * three planning arms over in-memory ports. It cannot prove that
 * `createInsightsPlanningPort` produces those types from real rows — that goal
 * pace is WP 4.6's verdict over WP 4.1's goals and a sealed net-worth day, that
 * the projection block is the newest *baseline* run through `readProjection`,
 * that the RMD age comes out of WP 4.2's file for the holder's birth year —
 * and nothing about minimisation is true until it is true of real ids.
 *
 * ## Cross-user scoping, every predicate (dispatch §5 item 8, the WP 3.9 S1 rule)
 *
 * The port adds two reads of its own, and each is a scoping statement:
 *
 *   * `newestNetWorthDay` — `user_id` (one predicate). Bob has a newer
 *     net-worth day than Alice; dropping the predicate would read Bob's date,
 *     find no Alice row on it, and report Alice's funded goal as unfunded.
 *   * `newestBaselineRunId` — `user_id` **and** `scenario_id`, then
 *     `readProjection` re-reads the run by `(user_id, id)`. Alice has a fork
 *     run newer than her baseline run, and Bob has a run newer than both.
 *
 * `'goals.list reads only …'` and `'plan.projection is the newest baseline run
 * …'` are built so each dropped predicate — individually and together — has a
 * row it would wrongly pick. The sabotage record (which went red, which stayed
 * green and why) is in `docs/evidence/phase-4/wp4.9-advisor-catalog-v3.md` §6.
 */
import { DateOnly, money, newId, systemClock } from '@core/kernel';
import {
  SnapshotBuilder,
  createBuiltinRegistry,
  deriveTokenKey,
  grantScopes,
  isSnapshotRef,
  listInsights,
  parsePath,
  runAdvisors,
  type AdvisorScope,
  type InsightsDependencies,
} from '@ctx/insights';
import { computeNetWorth, sealDay, upsertOpenDay } from '@ctx/planning';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createInsightsBudgetPort,
  createInsightsInvestmentsPort,
  createInsightsLedgerPort,
  createInsightsMarketDataPort,
  createInsightsPlanningPort,
  createInsightsRecurringPort,
  planningPortsFor,
} from '../../src/domain.ts';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  linkManual,
  type ApiHarness,
  type TestSession,
} from '../helpers/api-harness.ts';

const DAY_MS = 86_400_000;
const TOKEN_SECRET = 'wp-4-9-advisors-test-secret'; // gitleaks:allow — synthetic advisor-token secret for a test harness
const ZONE = 'UTC';
const PLANNING_SCOPES: readonly AdvisorScope[] = ['goals.list', 'risk.profile', 'plan.projection'];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

const RETIREMENT_ADVISORS = [
  'builtin.retirement.savings_rate',
  'builtin.retirement.success_probability',
  'builtin.retirement.rmd_window',
  'builtin.retirement.claiming_age',
  'builtin.retirement.goal_pace',
  'builtin.retirement.withdrawal_guardrail',
] as const;

function day(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

function moneyJson(minor: string): { minor: string; currency: string } {
  return { minor, currency: 'USD' };
}

interface RunWire {
  readonly id: string;
  readonly method: string;
  readonly paths: number;
  readonly successProbability: string;
}

interface OutcomeWire {
  readonly status: string;
  readonly run: RunWire | null;
  readonly percentiles: readonly { index: number; p50: { minor: string } }[];
}

describe.skipIf(NO_DATABASE)('the retirement wave over a real database (WP 4.9)', () => {
  let h: ApiHarness;
  let bob: TestSession;
  let bobId: string;
  let checkingId: string;
  let iraId: string;
  let aliceGoalId: string;
  let aliceBaselineId: string;
  let aliceBaselineRun: RunWire;
  let aliceBaselineTerminalP50: bigint;
  let monteCarloAvailable = false;

  function portsOf() {
    return {
      ledger: createInsightsLedgerPort(h.database.db, systemClock),
      budget: createInsightsBudgetPort(h.database.db),
      recurring: createInsightsRecurringPort(h.database.db),
      investments: createInsightsInvestmentsPort(h.database.db, systemClock),
      marketData: createInsightsMarketDataPort({ source: undefined }),
      // The line this suite exists for.
      planning: createInsightsPlanningPort(h.database.db, systemClock, { timeZone: ZONE }),
    };
  }

  function dependenciesOf(): InsightsDependencies {
    return {
      registry: createBuiltinRegistry(),
      ports: portsOf(),
      settings: {
        advisorsEnabled: true,
        moduleEnabled: true,
        timeZone: ZONE,
        baseCurrency: 'USD',
        tokenSecret: TOKEN_SECRET,
      },
    };
  }

  async function snapshotOf(
    userId: string,
    grantedScopes: readonly AdvisorScope[],
    kind: 'builtin' | 'external' = 'builtin',
  ) {
    return new SnapshotBuilder(portsOf()).build({
      userId,
      kind,
      grantedScopes,
      today: DateOnly.parse(day(0)),
      baseCurrency: 'USD',
      tokenKey: deriveTokenKey(TOKEN_SECRET, userId),
    });
  }

  async function writeDay(userId: string, asOfDate: string, seal: boolean): Promise<void> {
    const ports = planningPortsFor(h.database.db, { userId, timeZone: ZONE, clock: systemClock });
    const snapshot = await computeNetWorth(ports, { userId, asOfDate, baseCurrency: 'USD' });
    await upsertOpenDay(h.database.db, { userId, snapshot, clock: systemClock });
    if (seal) await sealDay(h.database.db, { userId, asOfDate, clock: systemClock });
  }

  async function project(
    session: TestSession,
    scenarioId: string,
    preferMonteCarlo: boolean,
  ): Promise<OutcomeWire> {
    if (preferMonteCarlo) {
      const response = await h.request({
        method: 'POST',
        url: `/plan/scenarios/${scenarioId}/projections`,
        session,
        body: { method: 'monte_carlo', paths: 500 },
      });
      // 409 `planning.monte_carlo_unavailable`: a checkout with no cached
      // return series. Recorded, never substituted silently — R2 then has no
      // probability to read and its assertion below says so by name.
      if (response.statusCode === 200) {
        monteCarloAvailable = true;
        return response.json() as OutcomeWire;
      }
      expect(response.statusCode).toBe(409);
    }
    const response = await h.request({
      method: 'POST',
      url: `/plan/scenarios/${scenarioId}/projections`,
      session,
      body: { method: 'deterministic' },
    });
    expectStatus(response, 200);
    return response.json() as OutcomeWire;
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp49-adv' });

    // --- Alice: a checking account that funds her goal, and an IRA ----------
    const linked = await linkManual(h, {
      providerConnectionId: 'wp49-alice',
      displayName: 'Alice Bank',
      accounts: [
        {
          providerAccountId: 'wp49-checking',
          name: 'Checking',
          type: 'depository',
          currency: 'USD',
        },
        {
          providerAccountId: 'wp49-ira',
          name: 'Rollover IRA',
          type: 'investment',
          currency: 'USD',
        },
      ],
      batch: {
        balances: [
          {
            providerAccountId: 'wp49-checking',
            current: money(200_000n, 'USD'),
            available: null,
            limit: null,
            asOf: new Date(Date.now() - 5 * DAY_MS),
          },
        ],
      },
    });
    checkingId = linked.accountIds[0] as string;
    iraId = linked.accountIds[1] as string;
    // The tax bucket is read from the provider subtype (`defaultTaxBucketFor`);
    // a manual link carries none, so the test states the one an IRA reports.
    await h.database.db.execute(sql`
      UPDATE accounts SET subtype = 'ira' WHERE id = ${iraId}::uuid AND user_id = ${h.userId}::uuid
    `);
    // 4,000 × $250 = $1,000,000, the whole of the plan's starting assets and
    // all of it tax-deferred — so R3's share is 100% and nothing about it
    // depends on a rounding boundary.
    const securityId = newId();
    await h.database.db.execute(sql`
      INSERT INTO securities (
        id, user_id, identity_kind, identity_key, ticker, name, type, currency,
        is_cash_equivalent, asset_class, region, sector, expense_ratio,
        classification_source, classification_depth, classification_flagged
      ) VALUES (
        ${securityId}::uuid, ${h.userId}::uuid, 'ticker', ${`ticker:VTI:${h.userId.slice(0, 8)}`},
        'VTI', 'Vanguard Total Stock Market ETF', 'etf', 'USD', false,
        'US_EQUITY', 'US', 'BROAD', '0.000300', 'LOCAL_SEED_TABLE', 0, false
      )
    `);
    await h.database.db.execute(sql`
      INSERT INTO holdings (
        id, user_id, account_id, security_id, quantity, institution_value_minor, currency,
        cost_basis_minor, cost_basis_is_user_supplied, cost_basis_source, as_of_date
      ) VALUES (
        ${newId()}::uuid, ${h.userId}::uuid, ${iraId}::uuid, ${securityId}::uuid,
        '4000.000000000000000000', 100000000, 'USD', 60000000, false, 'BROKER', ${day(-3)}::date
      )
    `);
    await h.database.db.execute(sql`
      INSERT INTO prices (
        id, user_id, security_id, price_date, source, close, currency, stale, observed_at
      ) VALUES (
        ${newId()}::uuid, ${h.userId}::uuid, ${securityId}::uuid, ${day(-3)}::date,
        'tiingo', '250.00', 'USD', false, now()
      )
    `);
    // Alice's newest net-worth day is two days ago, sealed. She has none for today.
    await writeDay(h.userId, day(-2), true);

    // --- Bob: a newer net-worth day than Alice's, and nothing else yet ------
    bobId = await h.database.createUser('Bob');
    bob = await h.issueSession({ userId: bobId, fresh: true });
    // A sealed day (a projection starts from one) and an open one for today:
    // both newer than anything Alice has.
    await writeDay(bobId, day(-1), true);
    await writeDay(bobId, day(0), false);

    // --- Alice's goal: WP 4.6's worked R6 case, over real rows --------------
    const goal = await h.request({
      method: 'POST',
      url: '/goals',
      session: h.stale,
      body: {
        kind: 'purchase',
        name: 'House deposit',
        target: moneyJson('2000000'),
        targetDate: day(380),
        priority: 1,
        fundedFromAccountIds: [checkingId],
      },
    });
    expectStatus(goal, 201);
    aliceGoalId = (goal.json() as { id: string }).id;
    expectStatus(
      await h.request({
        method: 'POST',
        url: `/goals/${aliceGoalId}/contributions`,
        session: h.stale,
        body: { cadence: 'monthly', amount: moneyJson('50000'), startsOn: day(0), source: 'USER' },
      }),
      201,
    );

    // --- Risk profiles: Alice gives an income, Bob declines ------------------
    const answers = {
      'drawdown.stated': 'hold',
      'drawdown.revealed': 'held',
      'volatility.stated': 'range_middle',
      'volatility.revealed': 'stocks_40_to_60',
      'risk_identity.stated': 'balanced',
      'risk_identity.revealed': 'split',
    };
    expectStatus(
      await h.request({
        method: 'PUT',
        url: '/risk-profile',
        session: h.stale,
        body: {
          answers,
          horizonYears: 29,
          liquidityNeed: 'medium',
          income: { taxableIncome: moneyJson('8400000'), filingStatus: 'single', taxYear: 2026 },
        },
      }),
      200,
    );
    expectStatus(
      await h.request({
        method: 'PUT',
        url: '/risk-profile',
        session: bob,
        body: { answers, horizonYears: 30, liquidityNeed: 'low' },
      }),
      200,
    );

    // --- Alice's baseline: 66, retired at 65, born 1960 (RMD age 75) --------
    const baseline = await h.request({
      method: 'POST',
      url: '/plan/scenarios',
      session: h.stale,
      body: {
        kind: 'baseline',
        name: 'Alice baseline',
        profile: {
          birthDate: `1960-${day(0).slice(5, 7)}-01`,
          retirementAge: 65,
          planEndAge: 95,
          currency: 'USD',
          glidepath: { kind: 'age_based' },
          contributionGrowth: 'flat',
          // 9% of a $1,000,000 portfolio before Social Security starts at 67:
          // above the 3.6%–5.4% band (R7), and a plan that fails more often
          // than the 80% target allows (R2, where a Monte Carlo is available).
          annualSpending: moneyJson('9000000'),
          withdrawalPolicy: 'guardrails',
          spendingFloor: 'none',
          taxDeferredRate: '0.15',
          socialSecurity: {
            monthlyPia: moneyJson('200000'),
            claimAge: { years: 67, months: 0 },
            stressAfter2034: false,
          },
          pensions: [],
          contributions: null,
        },
      },
    });
    expectStatus(baseline, 201);
    aliceBaselineId = (baseline.json() as { id: string }).id;
    const baselineOutcome = await project(h.stale, aliceBaselineId, true);
    aliceBaselineRun = baselineOutcome.run as RunWire;
    const last = [...baselineOutcome.percentiles].sort((a, b) => b.index - a.index)[0];
    aliceBaselineTerminalP50 = BigInt(last?.p50.minor ?? '0');

    // A fork, run *after* the baseline, so it is Alice's newest run of any
    // scenario — the row a dropped `scenario_id` predicate would pick.
    const fork = await h.request({
      method: 'POST',
      url: '/plan/scenarios',
      session: h.stale,
      body: { kind: 'fork', name: 'Spend less', levers: { annualSpending: moneyJson('3000000') } },
    });
    expectStatus(fork, 201);
    await project(h.stale, (fork.json() as { id: string }).id, false);

    // --- Bob's baseline and run: the newest run in the table ----------------
    const bobBaseline = await h.request({
      method: 'POST',
      url: '/plan/scenarios',
      session: bob,
      body: {
        kind: 'baseline',
        name: 'Bob baseline',
        profile: {
          birthDate: '1990-01-01',
          retirementAge: 60,
          planEndAge: 90,
          currency: 'USD',
          glidepath: { kind: 'age_based' },
          contributionGrowth: 'flat',
          annualSpending: moneyJson('4000000'),
          withdrawalPolicy: 'constant_real',
          spendingFloor: 'none',
          taxDeferredRate: '0.15',
          socialSecurity: null,
          pensions: [],
          contributions: null,
        },
      },
    });
    expectStatus(bobBaseline, 201);
    await project(bob, (bobBaseline.json() as { id: string }).id, false);
    const bobGoal = await h.request({
      method: 'POST',
      url: '/goals',
      session: bob,
      body: { kind: 'custom', name: 'Bob only', target: moneyJson('500000'), targetDate: day(400) },
    });
    expectStatus(bobGoal, 201);
  }, 240_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  it('goals.list and risk.profile come from the real readers, and no id crosses', async () => {
    for (const kind of ['builtin', 'external'] as const) {
      const built = await snapshotOf(h.userId, PLANNING_SCOPES, kind);
      const goals = built.snapshot.goals_list?.goals ?? [];
      expect(
        goals.map((goal) => goal.name),
        kind,
      ).toEqual(['House deposit']);
      const goal = goals[0];
      expect(goal?.goal_ref, kind).toMatch(/^GOAL_[0-9a-f]{12}$/u);
      expect(goal?.horizon_months).toBe(12);
      expect(goal?.progress).toBe(0.1);
      expect(goal?.pace).toEqual({
        status: 'off_track',
        required_monthly: moneyJson('150000'),
        planned_monthly: moneyJson('50000'),
      });
      expect(built.snapshot.risk_profile).toEqual({
        tolerance: expect.any(String) as string,
        horizon_years: 29,
        tax_bracket_band: '22-32',
        liquidity_need: 'medium',
      });

      // 08 §4.2: no id crosses, for any kind — not the goal's, not the funding
      // account's, not the scenario's or the run's, not the holder's.
      const text = JSON.stringify(built.snapshot);
      expect(UUID.test(text), `${kind}: ${text.match(UUID)?.[0] ?? ''}`).toBe(false);
      for (const id of [aliceGoalId, checkingId, iraId, aliceBaselineId, aliceBaselineRun.id]) {
        expect(text, kind).not.toContain(id);
      }
      expect(text).not.toContain('8400000'); // the income behind the band
      expect(text).not.toContain('Bob');
    }
  });

  it('goals.list reads only the holder’s goals and the holder’s balances', async () => {
    // Bob's newest net-worth day (today) is newer than Alice's (two days ago).
    // Alice's goal is funded $2,000 from her checking account on *her* day; a
    // read that took Bob's date would find no Alice row on it and report 0.
    const alice = await snapshotOf(h.userId, ['goals.list']);
    expect(alice.snapshot.goals_list?.goals.map((goal) => goal.progress)).toEqual([0.1]);

    const bobs = await snapshotOf(bobId, ['goals.list']);
    expect(bobs.snapshot.goals_list?.goals.map((goal) => goal.name)).toEqual(['Bob only']);
  });

  it('plan.projection is the newest baseline run — never a fork’s, never another holder’s', async () => {
    const built = await snapshotOf(h.userId, ['plan.projection']);
    const block = built.snapshot.plan_projection;
    expect(block, 'Alice has a baseline run; the block must exist').toBeDefined();
    if (block === undefined) return;

    expect(block.method).toBe(aliceBaselineRun.method);
    expect(block.paths).toBe(aliceBaselineRun.paths);
    expect(block.success_probability).toBe(aliceBaselineRun.successProbability);
    // The fork spends a third as much and ends with more; Bob's plan ends at
    // 90. Either one read in place of Alice's baseline changes these.
    const rounding = 100_000n;
    const half = rounding / 2n;
    const expectedP50 = ((aliceBaselineTerminalP50 + half) / rounding) * rounding;
    expect(BigInt(block.terminal.p50.minor) - expectedP50).toBeLessThanOrEqual(rounding);
    expect(BigInt(block.terminal.p50.minor) % rounding).toBe(0n);
    expect(block.ages.plan_end).toBe(95);
    expect(block.ages.current).toBe(66);
    expect(block.ages.retirement).toBe(65);

    // The sub-blocks, each from the source the contract names.
    expect(block.rmd).toEqual({
      start_age: 75,
      start_year: 2035,
      tax_deferred_share: '1',
    });
    expect(block.social_security?.claim_age_years).toBe(67);
    expect(Number(block.social_security?.factor_at_70)).toBeGreaterThan(
      Number(block.social_security?.claim_factor),
    );
    expect(block.guardrail?.position).toBe('above');
    expect(block.guardrail?.lower).toBe('0.036');
    expect(block.guardrail?.upper).toBe('0.054');
    // No twelve months of income history in this fixture: R1's sub-block is
    // absent — never a zero rate.
    expect(block.savings_rate).toBeUndefined();

    // Bob's own block is Bob's.
    const bobs = await snapshotOf(bobId, ['plan.projection']);
    expect(bobs.snapshot.plan_projection?.ages.plan_end).toBe(90);
  });

  it('a holder who declined income gets no risk_profile block, never an invented band', async () => {
    const bobs = await snapshotOf(bobId, ['risk.profile']);
    expect(bobs.snapshot.risk_profile).toBeUndefined();
    expect(bobs.emittedScopes).toEqual([]);
  });

  it('plan.projection is grantable through the consent route, because 0024 widened the CHECK', async () => {
    const constraint = await h.database.db.execute<{ definition: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conname = 'snapshot_grants_scope_check'
    `);
    expect(constraint.rows[0]?.definition).toContain('plan.projection');

    for (const advisorId of RETIREMENT_ADVISORS) {
      const manifest = createBuiltinRegistry()
        .scheduled()
        .find((entry) => entry.manifest.advisor_id === advisorId)?.manifest;
      expect(manifest, advisorId).toBeDefined();
      const response = await h.request({
        method: 'PUT',
        url: `/advisors/${advisorId}/grants`,
        session: h.fresh,
        body: { scopes: [...(manifest?.requires_scopes ?? [])] },
      });
      expectStatus(response, 200);
    }
    const scopes = await h.request({
      method: 'GET',
      url: '/advisors/builtin.retirement.success_probability/scopes',
      session: h.stale,
    });
    expectStatus(scopes, 200);
    const rows = (scopes.json() as { scopes: { scope: string; granted: boolean }[] }).scopes;
    expect(rows.find((row) => row.scope === 'plan.projection')?.granted).toBe(true);
  });

  it('the retirement wave runs over the real ports and proposes with resolvable evidence', async () => {
    const context = {
      userId: h.userId,
      clock: systemClock,
      correlationId: newId(),
      causationId: null,
    };
    // The route above granted them; `grantScopes` again is idempotent and
    // keeps this test independent of test order.
    const registry = createBuiltinRegistry();
    for (const advisorId of RETIREMENT_ADVISORS) {
      const entry = registry.scheduled().find((item) => item.manifest.advisor_id === advisorId);
      await grantScopes(h.database.db, context, advisorId, [
        ...(entry?.manifest.requires_scopes ?? []),
      ]);
    }

    const results = await runAdvisors(h.database.db, context, dependenciesOf(), {
      advisorIds: [...RETIREMENT_ADVISORS],
      trigger: 'schedule',
    });
    const byId = new Map(results.map((result) => [result.advisorId, result]));
    for (const result of results) expect(result.status, result.advisorId).toBe('completed');

    // R3, R4, R6 and R7 fire on this fixture over the real ports.
    for (const advisorId of [
      'builtin.retirement.rmd_window',
      'builtin.retirement.claiming_age',
      'builtin.retirement.goal_pace',
      'builtin.retirement.withdrawal_guardrail',
    ]) {
      expect(byId.get(advisorId)?.accepted, advisorId).toBe(1);
      expect(byId.get(advisorId)?.rejected, advisorId).toBe(0);
    }
    // R2 needs a Monte Carlo run. With the cached return series it fires;
    // without it the baseline is deterministic and R2 is silent by design.
    const r2 = byId.get('builtin.retirement.success_probability');
    if (monteCarloAvailable && Number(aliceBaselineRun.successProbability) < 0.8) {
      expect(r2?.accepted).toBe(1);
    } else {
      expect(r2?.accepted).toBe(0);
    }
    // R1: no income history, so no savings-rate sub-block, so nothing to say.
    expect(byId.get('builtin.retirement.savings_rate')?.accepted).toBe(0);
    // Each rule was sent only what it declared.
    expect(byId.get('builtin.retirement.goal_pace')?.emittedScopes).toEqual(['goals.list']);
    expect(byId.get('builtin.retirement.withdrawal_guardrail')?.emittedScopes).toEqual([
      'plan.projection',
    ]);

    const proposed = await listInsights(h.database.db, {
      userId: h.userId,
      advisorIds: [...RETIREMENT_ADVISORS],
      now: systemClock.now(),
    });
    expect(proposed.length).toBeGreaterThanOrEqual(4);
    for (const insight of proposed) {
      expect(insight.status).toBe('pending_review');
      expect(insight.evidence.length, insight.key).toBeGreaterThan(0);
      for (const row of insight.evidence) {
        const ref = row.sourceRef as string;
        expect(isSnapshotRef(ref), ref).toBe(true);
        expect(parsePath(ref.slice('snapshot:'.length)), ref).not.toBeNull();
        expect(row.resolvedDisplay, `${ref} resolved to nothing`).not.toBeNull();
      }
    }
    const pace = proposed.find((insight) => insight.key.startsWith('retirement.goal_pace.'));
    expect(pace?.summaryMd).toContain('House deposit');
    expect(pace?.annualizedImpact?.minor).toBe(1_200_000n);
  });
});
