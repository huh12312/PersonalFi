// SPDX-License-Identifier: MIT
/**
 * The advisory catalogue's definitions and its result check (WP 11.5b), with
 * no database: every function is run in a fake, already-gated context over a
 * fixed snapshot and fake ports, through `evaluateCatalogueFunction` — the
 * same parse → run → envelope → check path `callCatalogueByName` takes after
 * its gate. The gate itself (the holder's real grants, the listing, the 403)
 * is proven over a real database in `apps/api/test/db/wp115b-advisor-catalogue.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { lintAdviceCopy } from '../src/advisors/copy-lint.ts';
import { NARRATOR_SCOPES } from '../src/advisors/local/manifest.ts';
import {
  CATALOGUE,
  CATALOGUE_FUNCTION_NAMES,
  evaluateCatalogueFunction,
  grantedScopesFor,
} from '../src/catalogue/catalogue.ts';
import {
  CatalogueResultRejected,
  checkCatalogueResult,
  decimalised,
  type CatalogueResult,
} from '../src/catalogue/figures.ts';
import { CatalogueRefusal } from '../src/catalogue/ports.ts';
import type { AdvisorScope } from '../src/contract/scopes.ts';
import {
  GOAL_ID,
  NO_DATABASE,
  call,
  contextFor,
  fixtureSnapshot,
  money,
} from './fixtures/catalogue-context.ts';

type Figure = { money?: { minor: string }; decimal?: string; date?: string; source_refs: string[] };
const result = (outcome: CatalogueResult) => outcome.result as Record<string, unknown>;

describe('the catalogue’s definitions', () => {
  it('names nineteen functions, each under its own name', () => {
    expect(CATALOGUE_FUNCTION_NAMES).toHaveLength(19);
    for (const name of CATALOGUE_FUNCTION_NAMES) expect(CATALOGUE[name].name).toBe(name);
  });

  it('declares scopes inside the narrator’s bound, never transactions.raw', () => {
    for (const name of CATALOGUE_FUNCTION_NAMES) {
      const { scopes } = CATALOGUE[name];
      expect(scopes.length, name).toBeGreaterThan(0);
      expect(scopes, name).not.toContain('transactions.raw');
      for (const scope of scopes) expect(NARRATOR_SCOPES, `${name}: ${scope}`).toContain(scope);
    }
  });

  it('every summary and description passes the advice copy-linter', () => {
    for (const name of CATALOGUE_FUNCTION_NAMES) {
      const definition = CATALOGUE[name];
      expect(lintAdviceCopy(definition.summary, 'summary_md'), name).toEqual([]);
      expect(lintAdviceCopy(definition.description, 'summary_md'), name).toEqual([]);
    }
  });

  it('gates `all` on every scope and `any` on one', () => {
    const all = {
      scopes: ['cash.summary', 'cashflow.monthly'] as AdvisorScope[],
      scopeRule: 'all' as const,
    };
    expect(grantedScopesFor(all, ['cash.summary'])).toBeNull();
    expect(grantedScopesFor(all, ['cash.summary', 'cashflow.monthly', 'goals.list'])).toEqual([
      'cash.summary',
      'cashflow.monthly',
    ]);
    const any = {
      scopes: ['cash.summary', 'goals.list'] as AdvisorScope[],
      scopeRule: 'any' as const,
    };
    expect(grantedScopesFor(any, [])).toBeNull();
    expect(grantedScopesFor(any, ['goals.list', 'plan.projection'])).toEqual(['goals.list']);
  });
});

describe('every function, over a fixed snapshot', () => {
  it.each(NO_DATABASE)(
    '%s returns a result whose figures all trace to its inputs',
    async (name) => {
      const outcome = await call(name);
      expect(outcome.catalogue_version).toBe('catalogue/1');
      expect(checkCatalogueResult(outcome)).toEqual([]);
      expect(JSON.stringify(outcome)).not.toMatch(/\d\.\d+[,}\]]/u); // no bare float in the JSON
    },
  );

  it.each(NO_DATABASE)('%s is deterministic: two calls, the same result', async (name) => {
    expect(await call(name)).toEqual(await call(name));
  });

  it('cash.emergency_fund: $3,100 a month, 4.84 months, $5,700 above three months, $200.64 a year', async () => {
    const r = result(await call('cash.emergency_fund'));
    expect((r['monthly_spending'] as Figure).money?.minor).toBe('310000');
    expect((r['months_covered'] as Figure).decimal).toBe('4.84');
    expect((r['target_amount'] as Figure).money?.minor).toBe('930000');
    expect((r['excess'] as Figure).money?.minor).toBe('570000');
    expect((r['shortfall'] as Figure).money?.minor).toBe('0');
    expect((r['yield_spread'] as Figure).decimal).toBe('0.0352');
    expect((r['annual_spread_on_excess'] as Figure).money?.minor).toBe('20064');
    expect((r['monthly_spending'] as Figure).source_refs).toEqual([
      'snapshot:cashflow_monthly.months[0].expense',
      'snapshot:cashflow_monthly.months[1].expense',
      'snapshot:cashflow_monthly.months[2].expense',
    ]);
  });

  it('debt.payoff_plan: reference case C over the snapshot, the no-rate debt named', async () => {
    const outcome = await call('debt.payoff_plan');
    const r = result(outcome);
    const plans = r['plans'] as { order: string; total_interest: Figure; months: Figure }[];
    expect(
      plans.map((plan) => [plan.order, plan.months.decimal, plan.total_interest.money?.minor]),
    ).toEqual([
      ['avalanche', '5', '1803'],
      ['snowball', '5', '1992'],
    ]);
    expect(r['excluded']).toEqual([{ liability_ref: 'LIABILITY_c', reason: 'no_apr' }]);
    const [difference] = r['differences'] as { other: string; interest: Figure }[];
    expect(difference?.other).toBe('snowball');
    expect(difference?.interest.money?.minor).toBe('-189');
    // A rate crosses as the decimal string the inputs carry, never the snapshot's float.
    expect(
      (outcome.inputs['liabilities_terms'] as { liabilities: { apr: unknown }[] }).liabilities[0]
        ?.apr,
    ).toBe('0.24');
  });

  it('debt.payoff_plan: a custom order runs beside the other two', async () => {
    const r = result(
      await call('debt.payoff_plan', {
        order: 'custom',
        extra_monthly: money('6000'),
        custom_order: ['LIABILITY_b'],
      }),
    );
    expect(
      (r['plans'] as { order: string; sequence: string[] }[]).map((plan) => plan.order),
    ).toEqual(['avalanche', 'snowball', 'custom']);
    await expect(
      call('debt.payoff_plan', {
        order: 'custom',
        extra_monthly: money('6000'),
        custom_order: ['NOPE'],
      }),
    ).rejects.toBeInstanceOf(CatalogueRefusal);
  });

  it('limits.contribution_room: the 2026 IRA limit, $3,500 in, $4,000 left, 64 days', async () => {
    const outcome = await call('limits.contribution_room');
    const r = result(outcome);
    expect((r['limit'] as Figure).money?.minor).toBe('750000');
    expect((r['contributed'] as Figure).money?.minor).toBe('350000');
    expect((r['remaining'] as Figure).money?.minor).toBe('400000');
    expect((r['days_left'] as Figure).decimal).toBe('64');
    expect((r['limit'] as Figure).source_refs).toEqual(['snapshot:parameters[0].value']);
    expect((outcome.inputs['parameters'] as { key: string }[])[0]?.key).toBe(
      'tax.us.2026.retirement.ira_contribution', // gitleaks:allow — a parameter key, not a secret
    );
  });

  it('limits.contribution_room: a year the store does not hold is refused, never answered from 2026', async () => {
    const refused = call('limits.contribution_room', { year: 2027, account_kind: 'ira' });
    await expect(refused).rejects.toBeInstanceOf(CatalogueRefusal);
    await expect(refused).rejects.toMatchObject({
      code: 'catalogue.year_unavailable',
      status: 422,
    });
  });

  it('plan.project: money rounded to the scope’s $1,000, the run identity in the inputs', async () => {
    const outcome = await call('plan.project');
    const [year] = result(outcome)['median_path'] as { p5: Figure; p50: Figure; p95: Figure }[];
    expect(year?.p5.money?.minor).toBe('12300000');
    // 234.5 thousands is a tie: half-even keeps the even 234.
    expect(year?.p50.money?.minor).toBe('23400000');
    expect(year?.p95.money?.minor).toBe('34500000');
    expect((outcome.inputs['projection'] as { seed: string }).seed).toBe('42');
  });

  it('goal.required_savings: resolves the goal by its ref; the id never appears', async () => {
    const outcome = await call('goal.required_savings');
    expect((result(outcome)['monthly'] as Figure).money?.minor).toBe('131200');
    expect(JSON.stringify(outcome)).not.toContain(GOAL_ID);
    await expect(
      call('goal.required_savings', { goal_ref: 'GOAL_000000000000' }),
    ).rejects.toMatchObject({
      code: 'catalogue.goal_unknown',
    });
  });

  it('investing.drift: 10 points over on equities, $20,000 to target', async () => {
    const classes = result(await call('investing.drift'))['classes'] as {
      asset_class: string;
      drift: Figure;
      amount_to_target: Figure;
      outside_band: boolean;
    }[];
    expect(classes[0]).toMatchObject({ asset_class: 'us_equity', outside_band: true });
    expect(classes[0]?.drift.decimal).toBe('0.1');
    expect(classes[0]?.amount_to_target.money?.minor).toBe('-2000000');
  });

  it('recurring.waste: U2’s price rise with its annual cost and the refs it rests on', async () => {
    const findings = result(await call('recurring.waste'))['findings'] as {
      rule_id: string;
      annual_impact: Figure | null;
    }[];
    const u2 = findings.find((finding) => finding.rule_id === 'U2');
    expect(u2?.annual_impact?.money?.minor).toBe('3600');
    expect(u2?.annual_impact?.source_refs.length).toBeGreaterThan(0);
  });

  it('investing.tax_location: not available, with the reason, and no figure', async () => {
    const outcome = await call('investing.tax_location');
    expect(outcome.status).toBe('not_available');
    expect(outcome.result).toBeNull();
    expect(outcome.not_available?.code).toBe('engine_not_built');
  });

  it('refuses invalid arguments', async () => {
    await expect(call('retirement.claiming', { ages: [55] })).rejects.toMatchObject({
      code: 'catalogue.invalid_arguments',
      status: 400,
    });
    await expect(call('cash.emergency_fund', { target_months: 3, extra: 1 })).rejects.toMatchObject(
      {
        code: 'catalogue.invalid_arguments',
      },
    );
  });
});

describe('the result check', () => {
  const base = { inputs: { args: { x: '1' }, a: { b: money('100') } } };

  it('accepts a figure whose refs resolve into the inputs', () => {
    expect(
      checkCatalogueResult({
        ...base,
        result: { f: { money: money('100'), source_refs: ['snapshot:a.b'] } },
      }),
    ).toEqual([]);
  });

  it('refuses a figure with no source_ref', () => {
    expect(
      checkCatalogueResult({ ...base, result: { f: { money: money('100'), source_refs: [] } } }),
    ).toEqual([{ kind: 'figure_without_source_ref', path: 'result.result.f' }]);
  });

  it('refuses a ref that does not resolve into the inputs', () => {
    expect(
      checkCatalogueResult({
        ...base,
        result: { f: { decimal: '1', unit: 'count', source_refs: ['snapshot:a.nowhere'] } },
      }),
    ).toEqual([
      { kind: 'unresolved_source_ref', path: 'result.result.f', ref: 'snapshot:a.nowhere' },
    ]);
  });

  it('refuses money and decimals outside a figure', () => {
    expect(
      checkCatalogueResult({ ...base, result: { m: money('5'), d: '0.25' } }).map((p) => p.kind),
    ).toEqual(['bare_money', 'bare_decimal']);
  });

  it('refuses a float anywhere, inputs included', () => {
    expect(
      checkCatalogueResult({ inputs: { a: 0.25 }, result: { n: 3, f: 0.5 } }).map((p) => p.path),
    ).toEqual(['result.inputs.a', 'result.result.f']);
  });

  it('a function whose result does not trace is never returned', async () => {
    const snapshot = fixtureSnapshot();
    // A function that read a float the inputs could not carry is rejected, not returned.
    expect(decimalised({ apr: 0.2399, n: 3 })).toEqual({ apr: '0.2399', n: 3 });
    const context = contextFor(snapshot);
    await expect(
      evaluateCatalogueFunction(
        'investing.allocation',
        {
          ...context,
          async snapshot() {
            const broken = fixtureSnapshot();
            // A block whose value is not money-shaped where a figure expects money.
            (broken.holdings_aggregate as { investable_total: unknown }).investable_total = 12.5;
            return broken;
          },
        },
        {},
        ['holdings.aggregate'],
      ),
    ).rejects.toBeInstanceOf(CatalogueResultRejected);
  });
});
