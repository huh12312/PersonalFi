// SPDX-License-Identifier: MIT
/**
 * WP 11.5b — the advisory catalogue over a real database and the real app:
 * `GET /advisor/catalogue` and `POST /advisor/catalogue/{name}`, the holder's
 * real grants to the narrator, the real snapshot builder, the real parameter
 * store, the real projection service and the real investment-activity
 * classifier.
 *
 *   * **The gate is the query types' gate**: with no grant nothing is listed
 *     and a call is refused 403; a partial grant lists exactly the functions
 *     it covers; the same `narratorGrantCeiling` `insight.explain` reads.
 *   * **Read only**: a projection, a compare and the tornado store no run.
 *   * **`limits.contribution_room`** counts what the classifier calls a
 *     contribution into the asked kind of account in the asked year, and a
 *     year the store does not hold is refused, 422, never answered from 2026.
 *   * **Deterministic**: the same call twice answers byte for byte the same.
 */
import { computeNetWorth, sealDay, upsertOpenDay } from '@ctx/planning';
import { DateOnly, Money, Quantity, newId, systemClock, todayIn } from '@core/kernel';
import {
  CATALOGUE_FUNCTION_NAMES,
  NARRATOR_MANIFEST,
  checkCatalogueResult,
  grantScopes,
  registerAdvisor,
  revokeScopes,
  type CatalogueResult,
} from '@ctx/insights';
import { drizzleLotStore } from '@ctx/investments';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planningPortsFor } from '../../src/domain.ts';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const TOKEN_SECRET = 'wp115b-catalogue'; // gitleaks:allow — synthetic advisor-token secret for a test

const money = (minor: string) => ({ minor, currency: 'USD' });

describe.skipIf(NO_DATABASE)('WP 11.5b: the advisory catalogue, over a real database', () => {
  let h: ApiHarness;
  let iraId = '';
  const ctx = () => ({ userId: h.userId, clock: systemClock, correlationId: newId() });

  async function list(): Promise<string[]> {
    const response = await h.request({
      method: 'GET',
      url: '/advisor/catalogue',
      session: h.stale,
    });
    expectStatus(response, 200);
    return (response.json() as { functions: { name: string }[] }).functions.map(
      (entry) => entry.name,
    );
  }

  async function call(name: string, body: unknown = {}) {
    return h.request({ method: 'POST', url: `/advisor/catalogue/${name}`, session: h.stale, body });
  }

  async function ok(name: string, body: unknown = {}): Promise<CatalogueResult> {
    const response = await call(name, body);
    expectStatus(response, 200);
    const result = response.json() as CatalogueResult;
    expect(checkCatalogueResult(result), name).toEqual([]);
    return result;
  }

  async function movement(input: {
    readonly type: 'CASH' | 'BUY' | 'TRANSFER_IN';
    readonly subtype: string;
    readonly amountMinor: bigint;
    readonly tradeDate: string;
  }) {
    await drizzleLotStore(h.database.db, systemClock).upsertInvestmentTransaction(h.userId, {
      id: newId(),
      accountId: iraId,
      securityId: null,
      provider: 'manual',
      providerTransactionId: `wp115b-${newId()}`,
      type: input.type,
      subtype: input.subtype,
      name: `${input.type} ${input.subtype}`,
      quantity: Quantity.of('0'),
      price: null,
      amount: Money.of(input.amountMinor, 'USD'),
      fees: Money.zero('USD'),
      tradeDate: DateOnly.parse(input.tradeDate),
      settleDate: null,
      source: 'USER',
      fingerprint: null,
    });
  }

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp115b_catalogue',
      extraSecrets: { advisor_token_secret: TOKEN_SECRET },
    });
    await registerAdvisor(h.database.db, ctx(), { manifest: NARRATOR_MANIFEST, enabled: false });
    const linked = await linkManual(h, {
      providerConnectionId: 'wp115b-manual',
      displayName: 'Catalogue Brokerage',
      accounts: [
        { providerAccountId: 'ira', name: 'My Roth', type: 'investment', currency: 'USD' },
        { providerAccountId: 'chk', name: 'Checking', type: 'depository', currency: 'USD' },
      ],
    });
    iraId = linked.accountIds[0] ?? '';
    // fixture: the provider subtype written by SQL because the manual connector stages no subtype and a linked Plaid IRA carries exactly this word (Plaid's investment subtype vocabulary).
    await h.database.db.execute(sql`
      UPDATE accounts SET subtype = 'roth ira' WHERE id = ${iraId}::uuid AND user_id = ${h.userId}::uuid
    `);
    await movement({
      type: 'CASH',
      subtype: 'contribution',
      amountMinor: 200_000n,
      tradeDate: '2026-02-10',
    });
    await movement({
      type: 'CASH',
      subtype: 'deposit',
      amountMinor: 150_000n,
      tradeDate: '2026-06-03',
    });
    // Not new money against the limit: a rollover in, and a contribution in another year.
    await movement({
      type: 'TRANSFER_IN',
      subtype: 'rollover',
      amountMinor: 900_000n,
      tradeDate: '2026-04-01',
    });
    await movement({
      type: 'CASH',
      subtype: 'contribution',
      amountMinor: 700_000n,
      tradeDate: '2025-12-30',
    });
  }, 180_000);

  afterAll(async () => {
    await h.close();
  });

  it('answers 401 without a session', async () => {
    expect((await h.request({ method: 'GET', url: '/advisor/catalogue' })).statusCode).toBe(401);
  });

  it('with no grant to the narrator, lists nothing and refuses every call 403', async () => {
    expect(await list()).toEqual([]);
    const refused = await call('cash.emergency_fund');
    expectStatus(refused, 403);
    expect(problemOf(refused)['code']).toBe('catalogue.scope_not_granted');
  });

  it('a partial grant lists exactly what it covers; an ungranted function is invisible and refused', async () => {
    await grantScopes(h.database.db, ctx(), NARRATOR_MANIFEST.advisor_id, ['cash.summary']);
    // `any` functions read whatever part is granted; every `all` function needs more than cash.summary.
    expect(await list()).toEqual(['situation.snapshot', 'insights.current', 'insights.explain']);
    const refused = await call('cash.emergency_fund');
    expectStatus(refused, 403);
    expect(problemOf(refused)['detail']).toContain('cashflow.monthly');

    const snapshot = await ok('situation.snapshot');
    expect(snapshot.scopes).toEqual(['cash.summary']);
    expect(Object.keys(snapshot.inputs).sort()).toEqual(['args', 'cash_summary']);
  });

  it('the whole narrator grant lists all nineteen functions — and never transactions.raw', async () => {
    await grantScopes(h.database.db, ctx(), NARRATOR_MANIFEST.advisor_id, [
      ...NARRATOR_MANIFEST.requires_scopes,
    ]);
    expect(await list()).toEqual([...CATALOGUE_FUNCTION_NAMES]);
    const snapshot = await ok('situation.snapshot');
    expect(snapshot.scopes).not.toContain('transactions.raw');
    expect(snapshot.inputs).not.toHaveProperty('transactions_raw');
  });

  it('refuses an unknown function 404 and invalid arguments 400', async () => {
    expectStatus(await call('cash.nothing'), 404);
    const invalid = await call('retirement.claiming', { ages: [40] });
    expectStatus(invalid, 400);
    expect(problemOf(invalid)['code']).toBe('catalogue.invalid_arguments');
  });

  it('limits.contribution_room: the store’s 2026 IRA limit, the classifier’s contributions, the days left', async () => {
    const result = await ok('limits.contribution_room', { year: 2026, account_kind: 'ira' });
    const r = result.result as Record<string, { money?: { minor: string }; decimal?: string }>;
    expect(r['limit']?.money?.minor).toBe('750000');
    expect(r['contributed']?.money?.minor).toBe('350000');
    expect(r['remaining']?.money?.minor).toBe('400000');
    const today = todayIn(systemClock, 'UTC');
    const expected =
      DateOnly.year(today) > 2026 ? 0 : DateOnly.differenceInDays(today, DateOnly.of(2026, 12, 31));
    expect(r['days_left']?.decimal).toBe(String(expected));
    expect((result.inputs['contributions'] as { excluded: unknown }).excluded).toEqual([
      { reason: 'transfer_or_rollover', count: 1 },
    ]);
  });

  it('limits.contribution_room: a year the store does not hold is refused 422, never answered from 2026', async () => {
    const refused = await call('limits.contribution_room', { year: 2027, account_kind: 'ira' });
    expectStatus(refused, 422);
    expect(problemOf(refused)['code']).toBe('catalogue.year_unavailable');
  });

  it('plan functions with no baseline say so; with one, project, compare and the tornado store nothing', async () => {
    expect((await ok('plan.project')).not_available?.code).toBe('no_baseline');

    const sealed = DateOnly.addDays(todayIn(systemClock, 'UTC'), -2);
    const ports = planningPortsFor(h.database.db, {
      userId: h.userId,
      timeZone: 'UTC',
      clock: systemClock,
    });
    const snapshot = await computeNetWorth(ports, {
      userId: h.userId,
      asOfDate: sealed,
      baseCurrency: 'USD',
    });
    await upsertOpenDay(h.database.db, { userId: h.userId, snapshot, clock: systemClock });
    await sealDay(h.database.db, { userId: h.userId, asOfDate: sealed, clock: systemClock });
    const created = await h.request({
      method: 'POST',
      url: '/plan/scenarios',
      session: h.stale,
      body: {
        kind: 'baseline',
        name: 'Baseline',
        profile: {
          birthDate: '1980-01-01',
          retirementAge: 65,
          planEndAge: 95,
          currency: 'USD',
          glidepath: { kind: 'age_based' },
          contributionGrowth: 'flat',
          annualSpending: money('4000000'),
          withdrawalPolicy: 'constant_real',
          spendingFloor: 'none',
          taxDeferredRate: '0.15',
          socialSecurity: {
            monthlyPia: money('250000'),
            claimAge: { years: 67, months: 0 },
            stressAfter2034: false,
          },
          pensions: [],
          contributions: { TAXABLE: money('600000') },
        },
      },
    });
    expectStatus(created, 201);
    const baselineId = (created.json() as { id: string }).id;
    const fork = await h.request({
      method: 'POST',
      url: '/plan/scenarios',
      session: h.stale,
      body: { kind: 'fork', name: 'Later', levers: { retireAge: 67 } },
    });
    expectStatus(fork, 201);
    const forkId = (fork.json() as { id: string }).id;

    const runs = async () =>
      Number(
        (
          await h.database.db.execute<{ n: string }>(
            sql`SELECT count(*)::text AS n FROM projection_runs WHERE user_id = ${h.userId}::uuid`,
          )
        ).rows[0]?.n ?? '-1',
      );
    expect(await runs()).toBe(0);
    const projected = await ok('plan.project', { scenario: 'baseline' });
    expect(projected.status).toBe('ok');
    // Monte Carlo when this process has the returns cache, deterministic otherwise: the result says which.
    const method = (projected.inputs['projection'] as { method: string; paths: number }).method;
    expect(['monte_carlo', 'deterministic']).toContain(method);
    const compared = await ok('plan.compare', { a: baselineId, b: forkId });
    expect(
      (compared.result as { retirement_delta_months: { decimal: string } }).retirement_delta_months
        .decimal,
    ).toBe('24');
    const levers = await ok('plan.levers');
    expect((levers.result as { levers: unknown[] }).levers).toHaveLength(8);
    // The tornado runs at the compare's path count, on the method the projection used.
    expect((levers.inputs['tornado'] as { method: string; paths: number }).method).toBe(method);
    expect((levers.inputs['tornado'] as { paths: number }).paths).toBe(
      method === 'monte_carlo' ? 10_000 : 1,
    );
    expect(await runs()).toBe(0);

    // Deterministic: the same call twice, the same answer.
    expect(await ok('plan.levers')).toEqual(levers);
    expect(await ok('plan.project', { scenario: 'baseline' })).toEqual(projected);

    const unknown = await call('plan.project', { scenario: newId() });
    expectStatus(unknown, 404);
    expect(problemOf(unknown)['code']).toBe('catalogue.scenario_unknown');
  });

  it('every function answers a traced result (or a named not_available) for this holder', async () => {
    const args: Record<string, unknown> = {
      'debt.payoff_plan': { order: 'avalanche', extra_monthly: money('10000') },
      'plan.compare': { a: 'baseline', b: 'baseline' },
      'retirement.claiming': { ages: [62, 70] },
      'limits.contribution_room': { year: 2026, account_kind: 'workplace_deferral' },
    };
    for (const name of CATALOGUE_FUNCTION_NAMES) {
      if (name === 'goal.required_savings' || name === 'insights.explain') continue;
      const result = await ok(name, args[name] ?? {});
      if (result.status === 'not_available')
        expect(result.not_available?.reason.length, name).toBeGreaterThan(0);
      expect(await ok(name, args[name] ?? {}), `${name} twice`).toEqual(result);
    }
  });

  it('goal.required_savings: named by the snapshot’s goal_ref, solved over the baseline, the id never returned', async () => {
    const created = await h.request({
      method: 'POST',
      url: '/goals',
      session: h.stale,
      body: {
        kind: 'purchase',
        name: 'House deposit',
        target: money('6000000'),
        targetDate: DateOnly.addDays(todayIn(systemClock, 'UTC'), 1_100),
        priority: 1,
      },
    });
    expectStatus(created, 201);
    const goalId = (created.json() as { id: string }).id;
    const snapshot = await ok('situation.snapshot');
    const goals = (snapshot.inputs['goals_list'] as { goals: { goal_ref: string; name: string }[] })
      .goals;
    const goalRef = goals.find((goal) => goal.name === 'House deposit')?.goal_ref ?? '';
    expect(goalRef).toMatch(/^GOAL_[0-9a-f]{12}$/u);
    const solved = await ok('goal.required_savings', { goal_ref: goalRef });
    expect(solved.status).toBe('ok');
    expect(['already_met', 'required', 'unreachable']).toContain(
      (solved.result as { kind: string }).kind,
    );
    expect(JSON.stringify(solved)).not.toContain(goalId);
    expect(await ok('goal.required_savings', { goal_ref: goalRef })).toEqual(solved);
    const unknown = await call('goal.required_savings', { goal_ref: 'GOAL_000000000000' });
    expectStatus(unknown, 404);
  });

  it('insights.explain: an insight that is not the holder’s is 404; nothing asks a model', async () => {
    const unknown = await call('insights.explain', { insight_id: newId() });
    expectStatus(unknown, 404);
    expect(problemOf(unknown)['code']).toBe('catalogue.insight_unknown');
  });

  it('revoking the grant hides the functions again', async () => {
    await revokeScopes(h.database.db, ctx(), NARRATOR_MANIFEST.advisor_id, [
      ...NARRATOR_MANIFEST.requires_scopes,
    ]);
    expect(await list()).toEqual([]);
    expectStatus(await call('plan.levers'), 403);
  });
});
