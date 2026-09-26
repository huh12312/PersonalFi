// SPDX-License-Identifier: MIT
/**
 * WP 4.4 — Guyton-Klinger guardrails with the floor and the 20% cap (07 §5.6).
 *
 * The cohort goldens (`test/engine/fixtures/guyton-klinger-cohorts.json`) run
 * historical years through **the engine's own `runPath` → `stepYear`** — the
 * step WP 4.5's Monte Carlo will call — with annual S&P 500 / 10-year Treasury
 * total returns (Damodaran) and CPI (BLS via the Minneapolis Fed). Each cohort
 * asserts the published claims quoted in the fixture, then pins the engine's
 * reproduced path so a later change that moves it is a red test, not a surprise.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DateOnly, Money } from '@core/kernel';
import { loadAssumptions } from '../assumptions.ts';
import { toEnginePlan, type ProjectionPlan } from './boundary.ts';
import { preparePlan, runPath, type MarketYear, type PathResult } from './deterministic.ts';
import {
  GR_CAP_BOUND,
  GR_FLOOR_BOUND,
  GR_INFLATION_SKIPPED,
  GR_PRESERVATION_CUT,
  decisionNames,
  guytonKlingerRules,
  newGuardrailState,
  startGuardrails,
  stepGuardrails,
} from './guardrails.ts';
import { projectDeterministic } from './project.ts';
import { BASE, fixtureText, usd } from '../../test/engine/support.ts';

const assumptions = loadAssumptions();

interface Pinned {
  readonly spendingRatio: readonly string[];
  readonly preservationCuts: readonly number[];
  readonly prosperityRaises: readonly number[];
  readonly capBound: readonly number[];
  readonly worstCut: string;
  readonly depletedInYear: number | null;
  readonly realWealthAfterFiveYears: string;
  readonly terminalRealWealth: string;
}

interface Cohort {
  readonly id: string;
  readonly start: number;
  readonly years: number;
  readonly equityShare: string;
  readonly initialRate: string;
  readonly published: readonly { readonly claim: string; readonly text: string }[];
  readonly reproduced: {
    readonly unmodified: Pinned;
    readonly capped: Pinned;
    readonly constantRealWealthAfterFiveYears: string;
  };
}

interface CohortFixture {
  readonly series: Readonly<
    Record<string, { readonly sp500: string; readonly tbond10: string; readonly cpi: string }>
  >;
  readonly cohorts: readonly Cohort[];
}

const fixture = JSON.parse(fixtureText('guyton-klinger-cohorts.json')) as CohortFixture;

function marketFor(year: number): MarketYear {
  const row = fixture.series[String(year)];
  if (row === undefined) throw new Error(`no historical row for ${String(year)}`);
  const inflation = Number(row.cpi) / 100;
  return {
    equityReal: (1 + Number(row.sp500) / 100) / (1 + inflation) - 1,
    bondReal: (1 + Number(row.tbond10) / 100) / (1 + inflation) - 1,
    inflation,
  };
}

/** $1M in one TAXABLE bucket, retired at 65 on day one, the cohort's static mix. */
function cohortPlan(cohort: Cohort, policy: 'unmodified' | 'capped' | 'constant'): ProjectionPlan {
  return {
    ...BASE,
    birthDate: DateOnly.parse('1961-01-01'),
    retirementAge: 65,
    planEndAge: 65 + cohort.years,
    buckets: [{ bucket: 'TAXABLE', startingBalance: usd('1000000'), annualContribution: usd('0') }],
    contributionGrowth: 'flat',
    glidepath: { kind: 'static', equityShare: cohort.equityShare },
    annualSpending: Money.multiplyByDecimal(usd('1000000'), cohort.initialRate),
    taxDeferredRate: '0',
    withdrawalPolicy:
      policy === 'constant'
        ? { kind: 'constant_real' }
        : {
            kind: 'guardrails',
            spendingFloor: null,
            cumulativeCutCap: policy === 'capped' ? '0.2' : null,
          },
  };
}

function runCohort(cohort: Cohort, policy: 'unmodified' | 'capped' | 'constant'): PathResult {
  const prepared = preparePlan(toEnginePlan(cohortPlan(cohort, policy), assumptions));
  return runPath(prepared, (t) => marketFor(cohort.start + t));
}

function totalOf(slots: readonly number[]): number {
  return slots.reduce((sum, slot) => sum + slot, 0);
}

function pinOf(cohort: Cohort, path: PathResult): Pinned {
  const first = path.records[0]?.spending ?? 1;
  const yearsWith = (name: string) =>
    path.records
      .filter((record) => decisionNames(record.decisions).includes(name))
      .map((record) => cohort.start + record.t);
  return {
    spendingRatio: path.records.map((record) => (record.spending / first).toFixed(4)),
    preservationCuts: yearsWith('preservation_cut'),
    prosperityRaises: yearsWith('prosperity_raise'),
    capBound: yearsWith('cap_bound'),
    worstCut: path.state.guard.worstCut.toFixed(4),
    depletedInYear:
      path.state.depletedAtAge < 0 ? null : cohort.start + (path.state.depletedAtAge - 65),
    realWealthAfterFiveYears: (totalOf(path.records[4]?.endWealth ?? []) / 1_000_000).toFixed(4),
    terminalRealWealth: (totalOf(path.records.at(-1)?.endWealth ?? []) / 1_000_000).toFixed(4),
  };
}

function cohort(id: string): Cohort {
  const found = fixture.cohorts.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no cohort ${id}`);
  return found;
}

describe('historical cohorts', () => {
  it('the 1973 and 2000 Guyton-Klinger cohort paths reproduce their published shape', () => {
    const c1973 = cohort('1973');
    const c2000 = cohort('2000');
    const c1966 = cohort('1966-kitces');
    const run = (c: Cohort) => ({
      unmodified: pinOf(c, runCohort(c, 'unmodified')),
      capped: pinOf(c, runCohort(c, 'capped')),
      constant: runCohort(c, 'constant'),
    });
    const r1973 = run(c1973);
    const r2000 = run(c2000);
    const r1966 = run(c1966);

    // --- 1973 (Guyton & Klinger 2006, p. 2) -----------------------------------
    // "Guyton calculated the maximum initial withdrawal rate for this period to be
    // 5.8 percent for a portfolio containing 50 percent equities": sustainable.
    expect(r1973.unmodified.depletedInYear).toBeNull();
    // "a severe market decline in the initial retirement years combined with
    // inflation in the first decade": every cut is in that decade, and the
    // raises wait for the 1980s bull market.
    expect(r1973.unmodified.preservationCuts.length).toBeGreaterThanOrEqual(2);
    expect(r1973.unmodified.preservationCuts.every((year) => year <= 1982)).toBe(true);
    expect(Math.min(...r1973.unmodified.prosperityRaises)).toBeGreaterThanOrEqual(1983);
    // "a 1973 retiree [was] in a more financially uncertain position after five
    // years of retirement at the end of 1977 than a 2000 retiree found after 2004".
    const fiveYears = (path: PathResult) => totalOf(path.records[4]?.endWealth ?? []);
    expect(fiveYears(r1973.constant)).toBeLessThan(fiveYears(r2000.constant));
    expect(Number(r1973.unmodified.spendingRatio[5])).toBeLessThan(
      Number(r2000.unmodified.spendingRatio[5]),
    );

    // --- 2000 (Kitces 2024: "hit its lower guardrail 3 times, ultimately
    // bottoming out at 36% below the planned spending level") ------------------
    expect(r2000.unmodified.preservationCuts).toHaveLength(3);
    expect(r2000.unmodified.preservationCuts[0]).toBe(2003); // after 2000–2002
    expect(r2000.unmodified.preservationCuts.at(-1)).toBe(2009); // after 2008
    expect(Math.abs(Number(r2000.unmodified.worstCut) - 0.36)).toBeLessThanOrEqual(0.05);

    // --- 1965/66 stagflation (Kitces 2024 / 07 §5.6: "~54%") -------------------
    expect(Math.abs(Number(r1966.unmodified.worstCut) - 0.54)).toBeLessThanOrEqual(0.05);

    // --- 07 §5.6's answer: with the cap, no cohort cuts more than 20% ---------
    for (const result of [r1973, r2000, r1966]) {
      expect(Number(result.unmodified.worstCut)).toBeGreaterThan(0.2);
      expect(result.capped.worstCut).toBe('0.2000');
      expect(result.capped.capBound.length).toBeGreaterThan(0);
    }
    // …and the cap's price, stated rather than hidden: 1973 at 5.8% now depletes.
    expect(r1973.capped.depletedInYear).toBe(1994);

    // --- The pins: the engine's reproduced paths, for drift -------------------
    for (const [c, r] of [
      [c1973, r1973],
      [c2000, r2000],
      [c1966, r1966],
    ] as const) {
      expect(r.unmodified, `${c.id} unmodified drifted`).toEqual(c.reproduced.unmodified);
      expect(r.capped, `${c.id} capped drifted`).toEqual(c.reproduced.capped);
      expect((fiveYears(r.constant) / 1_000_000).toFixed(4)).toBe(
        c.reproduced.constantRealWealthAfterFiveYears,
      );
    }
  });
});

describe('the floor and the cap', () => {
  it('cumulative real cuts never exceed 20% and never breach the spending floor', () => {
    const marketYear = fc.record({
      equityReal: fc.double({ min: -0.6, max: 0.6, noNaN: true }),
      bondReal: fc.double({ min: -0.25, max: 0.3, noNaN: true }),
      inflation: fc.double({ min: -0.03, max: 0.15, noNaN: true }),
    });
    fc.assert(
      fc.property(
        fc.array(marketYear, { minLength: 30, maxLength: 30 }),
        fc.integer({ min: 2_000, max: 12_000 }), // initial spending, basis points of $1M ×100
        fc.integer({ min: 0, max: 100 }), // floor as a percent of spending
        fc.integer({ min: 0, max: 100 }), // equity percent
        fc.integer({ min: 0, max: 3_000_000 }), // pension, cents per year
        (markets, spendBp, floorPct, equityPct, pensionCents) => {
          const spendingCents = BigInt(spendBp) * 1_000n;
          const floorCents = (spendingCents * BigInt(floorPct)) / 100n;
          const plan: ProjectionPlan = {
            ...BASE,
            retirementAge: 35,
            planEndAge: 65,
            buckets: [
              { bucket: 'TAXABLE', startingBalance: usd('1000000'), annualContribution: usd('0') },
            ],
            contributionGrowth: 'flat',
            glidepath: { kind: 'static', equityShare: (equityPct / 100).toString() },
            annualSpending: Money.of(spendingCents, 'USD'),
            withdrawalPolicy: {
              kind: 'guardrails',
              spendingFloor: Money.of(floorCents, 'USD'),
            },
            pensions: [
              {
                name: 'p',
                startAge: 35,
                annualBenefit: Money.of(BigInt(pensionCents), 'USD'),
                cola: { kind: 'none' },
              },
            ],
          };
          const prepared = preparePlan(toEnginePlan(plan, assumptions));
          const path = runPath(prepared, (t) => markets[t] ?? markets[0]!);
          const initial = path.state.guard.initialSpending;
          const floor = Number(floorCents) / 100;
          const bound = Math.max(floor, 0.8 * initial);
          for (const record of path.records) {
            expect(record.spending).toBeGreaterThanOrEqual(bound - 1e-9 * initial);
            expect(1 - record.spending / initial).toBeLessThanOrEqual(0.2 + 1e-12);
            expect(record.spending).toBeGreaterThanOrEqual(floor - 1e-9);
          }
          expect(path.state.guard.worstCut).toBeLessThanOrEqual(0.2 + 1e-12);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('with the cap removed the same property fails — the bound is doing the work', () => {
    const rules = guytonKlingerRules(0, { cumulativeCutCap: null });
    const state = newGuardrailState();
    startGuardrails(state, rules, 50_000, 1_000_000, 0);
    // A crash: the portfolio halves, then halves again.
    for (const portfolio of [500_000, 400_000, 300_000, 250_000, 200_000]) {
      stepGuardrails(state, rules, portfolio, 0, -0.3, 0.03, 25);
    }
    expect(state.worstCut).toBeGreaterThan(0.2);
  });

  it('names which bound bound: the cap above the floor, the floor above the cap', () => {
    const capFirst = guytonKlingerRules(10_000);
    const floorFirst = guytonKlingerRules(45_000);
    for (const [rules, bit] of [
      [capFirst, GR_CAP_BOUND],
      [floorFirst, GR_FLOOR_BOUND],
    ] as const) {
      const state = newGuardrailState();
      startGuardrails(state, rules, 50_000, 1_000_000, 0);
      let seen = 0;
      for (const portfolio of [500_000, 400_000, 300_000, 250_000]) {
        seen |= stepGuardrails(state, rules, portfolio, 0, -0.3, 0.03, 25);
      }
      expect(seen & bit).toBe(bit);
      expect(state.spending).toBe(Math.max(rules.floor, 40_000));
    }
  });
});

describe('the rules', () => {
  it('the capital-preservation cut is off in the final 15 years; the COLA skip still applies', () => {
    const rules = guytonKlingerRules(0, { cumulativeCutCap: null });
    const late = newGuardrailState();
    startGuardrails(late, rules, 50_000, 1_000_000, 0);
    const bits = stepGuardrails(late, rules, 500_000, 0, -0.2, 0.03, 15);
    expect(bits & GR_PRESERVATION_CUT).toBe(0);
    expect(bits & GR_INFLATION_SKIPPED).toBe(GR_INFLATION_SKIPPED);
    expect(late.spending).toBeCloseTo(50_000 / 1.03, 6);

    const early = newGuardrailState();
    startGuardrails(early, rules, 50_000, 1_000_000, 0);
    const earlyBits = stepGuardrails(early, rules, 500_000, 0, -0.2, 0.03, 16);
    expect(earlyBits & GR_PRESERVATION_CUT).toBe(GR_PRESERVATION_CUT);
    expect(early.spending).toBeCloseTo((50_000 / 1.03) * 0.9, 6);
  });

  it('a projection reports its worst spending cut beside its success', () => {
    const c = cohort('2000');
    const result = projectDeterministic(cohortPlan(c, 'capped'), assumptions);
    // Even on expected returns, 5.8% from a 50/50 mix (r_real ≈ 2.9%) drifts past
    // the upper rail: two 10% cuts compound to 19%, just inside the 20% cap.
    expect(result.worstSpendingCut).toBe('0.19');
    expect(result.success).toBe(true);
    const cuts = result.years.filter((year) => year.guardrail.includes('preservation_cut'));
    expect(cuts).toHaveLength(2);
    // …and the field is a decimal string, never a float, on the Money side.
    expect(typeof result.worstSpendingCut).toBe('string');
  });
});
