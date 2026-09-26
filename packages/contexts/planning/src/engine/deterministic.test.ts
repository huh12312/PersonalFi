// SPDX-License-Identifier: MIT
/**
 * WP 4.4 — the deterministic projection (07 §5.2; dispatch §3 exit tests; §5
 * exit criterion "deterministic output within 1% of an independent reference
 * calculator on the shipped fixtures").
 *
 * The reference is `test/engine/fixtures/reference-projection.csv`, computed
 * by `reference-projection.py` in Python `decimal` from the closed-form
 * OpenFormula FV/PMT definitions — no loop over years and no code shared with
 * this engine. Its literal LibreOffice formula text is in the sibling `.md`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DateOnly, Money } from '@core/kernel';
import { applyOverrides, diffOverrides, loadAssumptions } from '../assumptions.ts';
import { ProjectionInputRefused, PROJECTION_BUCKETS, type ProjectionPlan } from './boundary.ts';
import {
  AGE_BASED_RULE,
  ageBasedEquity,
  glidepathFunction,
  risingEquity,
  targetDateEquity,
} from './glidepath.ts';
import { projectDeterministic } from './project.ts';
import { solveRequiredSavings } from './solve.ts';
import { BASE, fixtureText, referencePlan, referenceRows, usd } from '../../test/engine/support.ts';

const assumptions = loadAssumptions();

function minorOf(text: string): bigint {
  return usd(text).minor;
}

function jsonOf(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'bigint' ? inner.toString() : inner,
  );
}

describe('the committed reference (the §5 exit criterion)', () => {
  it('the projection matches the committed reference-calculator fixture within 1%', () => {
    const rows = referenceRows();
    expect(rows.length).toBeGreaterThanOrEqual(13);
    const results = {
      A: projectDeterministic(referencePlan('A'), assumptions),
      B: projectDeterministic(referencePlan('B'), assumptions),
    };
    const solved = solveRequiredSavings(referencePlan('C'), assumptions, {
      objective: {
        kind: 'wealth_at',
        targetDate: DateOnly.parse('2056-01-01'),
        target: usd('1000000'),
        basis: 'real',
      },
      maxMonthly: usd('10000'),
    });

    let worst = 0;
    for (const row of rows) {
      let engineMinor: bigint;
      if (row.caseId === 'C') {
        if (solved.kind !== 'required') throw new Error(`case C did not solve: ${solved.kind}`);
        engineMinor = solved.monthly.minor;
      } else {
        const result = row.caseId === 'A' ? results.A : results.B;
        const year = result.years[row.yearsFromStart - 1];
        if (year === undefined) throw new Error(`no year ${String(row.yearsFromStart)}`);
        expect(year.age).toBe(row.ageInFinalYear);
        engineMinor = year.endWealth.minor;
      }
      const referenceMinor = minorOf(row.reference);
      const difference = Math.abs(Number(engineMinor - referenceMinor)) / Number(referenceMinor);
      worst = Math.max(worst, difference);
      expect(
        difference,
        `${row.caseId} age ${String(row.ageInFinalYear)}: engine ${String(engineMinor)} vs reference ${String(referenceMinor)}`,
      ).toBeLessThan(0.01);
      // The criterion is 1%; the agreement actually achieved is to the cent, and
      // is held here so a drift inside the 1% band is still a red test.
      expect(Math.abs(Number(engineMinor - referenceMinor))).toBeLessThanOrEqual(1);
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('the reference ships with its formulas and was not produced by the engine', () => {
    const formulas = fixtureText('reference-projection.md');
    for (const column of ['A_acc', 'A_dec', 'B_acc', 'B_dec1', 'B_dec2', 'C_pmt']) {
      expect(formulas).toContain(column);
    }
    expect(formulas).toMatch(/=FV\(/);
    expect(formulas).toMatch(/=PMT\(/);
    const generator = fixtureText('reference-projection.py');
    // Its only import is the standard library's `decimal`: nothing of the engine's.
    expect(generator.match(/^(?:import|from)\s+\S+/gm)).toEqual(['from decimal']);
    expect(generator).not.toMatch(/\bfor\s+\w+\s+in\s+range\(\s*acc_years/);
  });
});

describe('07 §8.4 invariants', () => {
  it('zero returns and zero contributions leave the balance constant', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('0', '0.025', '0.05'),
        fc.array(fc.bigInt({ min: 0n, max: 10_000_000_000n }), { minLength: 4, maxLength: 4 }),
        fc.constantFrom('age_based', 'target_date', 'rising_equity', 'static') as fc.Arbitrary<
          'age_based' | 'target_date' | 'rising_equity' | 'static'
        >,
        fc.integer({ min: 36, max: 94 }),
        (level, starts, glide, retirementAge) => {
          // Nominal return = inflation ⇒ r_real = 0 exactly, whatever the level.
          const flat = applyOverrides(
            assumptions,
            diffOverrides(assumptions, {
              'capitalMarket.usEquity.expectedReturn': level,
              'capitalMarket.usAggregateBonds.expectedReturn': level,
              'capitalMarket.inflation.mean': level,
            }),
            DateOnly.parse('2026-01-01'),
          );
          const plan: ProjectionPlan = {
            ...BASE,
            retirementAge,
            buckets: PROJECTION_BUCKETS.map((bucket, index) => ({
              bucket,
              startingBalance: Money.of(starts[index] ?? 0n, 'USD'),
              annualContribution: usd('0'),
            })),
            contributionGrowth: 'wage',
            glidepath:
              glide === 'static' ? { kind: 'static', equityShare: '0.37' } : { kind: glide },
            annualSpending: usd('0'),
          };
          const result = projectDeterministic(plan, flat);
          const total = starts.reduce((sum, start) => sum + start, 0n);
          for (const year of result.years) {
            expect(year.startWealth.minor).toBe(total);
            expect(year.endWealth.minor).toBe(total);
            year.buckets.forEach((bucket, index) => {
              expect(bucket.end.minor).toBe(starts[index]);
            });
          }
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('real and nominal', () => {
  it('real and nominal never mix: a nominal display toggle changes no stored value', () => {
    const plan = referencePlan('B');
    const real = projectDeterministic(plan, assumptions, { display: 'real' });
    const nominal = projectDeterministic(plan, assumptions, { display: 'nominal' });

    // 1. The toggle is presentation: the stored (real) series is byte-identical.
    expect(jsonOf(nominal.years)).toBe(jsonOf(real.years));
    expect(nominal.terminalWealth).toEqual(real.terminalWealth);
    expect(nominal.basis).toBe('real');
    expect(real.displayedEndWealth).toEqual(real.years.map((year) => year.endWealth));
    expect(nominal.displayedEndWealth).toEqual(real.years.map((year) => year.endWealthNominal));
    expect(jsonOf(nominal.displayedEndWealth)).not.toBe(jsonOf(real.displayedEndWealth));

    // 2. An independent oracle run entirely in NOMINAL dollars — nominal returns,
    //    contributions growing at nominal wage growth, spending and Social
    //    Security inflating — then deflated, must equal the engine's real path.
    //    Mixing the two anywhere in the engine (a nominal r in the real
    //    recursion, an undeflated contribution) breaks this equality.
    const i = 0.025;
    const rn = 0.6 * 0.065 + 0.4 * 0.045;
    const wageNominal = i + 0.005;
    const tau = 0.15;
    let wealthNominal = 100000;
    for (let t = 0; t < 60; t += 1) {
      const age = 35 + t;
      const levelStart = (1 + i) ** t;
      if (age < 65) {
        // 12,000 today's dollars growing at real wage growth, paid mid-year in
        // that year's dollars, growing half a year: C·P_t·(1+i)^0.5·(1+rn)^0.5.
        const contributionToday = 12000 * ((1 + wageNominal) / (1 + i)) ** t;
        wealthNominal =
          wealthNominal * (1 + rn) +
          contributionToday * levelStart * Math.sqrt(1 + i) * Math.sqrt(1 + rn);
      } else {
        const needToday = 60000 - (age >= 67 ? 30000 : 0);
        wealthNominal = (wealthNominal - (needToday / (1 - tau)) * levelStart) * (1 + rn);
      }
      const deflated = wealthNominal / (1 + i) ** (t + 1);
      const engine = Number(real.years[t]?.endWealth.minor) / 100;
      expect(Math.abs(engine - deflated), `year ${String(t)}`).toBeLessThan(0.01);
      const engineNominal = Number(real.years[t]?.endWealthNominal.minor) / 100;
      expect(Math.abs(engineNominal - wealthNominal), `nominal year ${String(t)}`).toBeLessThan(
        0.011,
      );
    }
  });
});

describe('the recursion, per tax bucket', () => {
  const twoBuckets: ProjectionPlan = {
    ...BASE,
    retirementAge: 36,
    planEndAge: 40,
    buckets: [
      {
        bucket: 'TAXABLE',
        startingBalance: usd('10000'),
        annualContribution: usd('0'),
        glidepath: { kind: 'static', equityShare: '1' },
      },
      {
        bucket: 'TAX_DEFERRED',
        startingBalance: usd('200000'),
        annualContribution: usd('0'),
        glidepath: { kind: 'static', equityShare: '0' },
      },
    ],
    contributionGrowth: 'flat',
    glidepath: { kind: 'age_based' },
    annualSpending: usd('30000'),
  };

  it('each bucket carries its own allocation and therefore its own r', () => {
    const [first] = projectDeterministic(twoBuckets, assumptions).years;
    const returns = first?.buckets.map((bucket) => bucket.realReturn);
    expect(returns).toEqual(['0.03902439', '0.0195122']); // 1.065/1.025 − 1, 1.045/1.025 − 1
  });

  it('withdraws TAXABLE first, then grosses TAX_DEFERRED up by the blended rate', () => {
    const years = projectDeterministic(twoBuckets, assumptions).years;
    const retired = years[1];
    if (retired === undefined) throw new Error('no retirement year');
    const [taxable, deferred] = retired.buckets;
    // The TAXABLE bucket (≈ $10,390 after a year at 3.9%) is drained first…
    expect(taxable?.withdrawal).toEqual(taxable?.start);
    expect(taxable?.end.minor).toBe(0n);
    // …and the remainder comes from TAX_DEFERRED grossed up: net = gross × (1 − 0.15).
    const remainder = 3_000_000n - (taxable?.start.minor ?? 0n);
    const gross = deferred?.withdrawal.minor ?? 0n;
    expect(Number(gross) * 0.85).toBeCloseTo(Number(remainder), -1);
    // Rounded once each from their own floats, so they may differ by one cent.
    expect(Number(retired.tax.minor - (gross - remainder))).toBeLessThanOrEqual(1);
    expect(Number(retired.tax.minor - (gross - remainder))).toBeGreaterThanOrEqual(-1);
  });

  it('does not stop at failure: a depleted plan keeps running and reports the shortfall', () => {
    const plan: ProjectionPlan = {
      ...BASE,
      retirementAge: 35,
      planEndAge: 45,
      buckets: [{ bucket: 'ROTH', startingBalance: usd('100000'), annualContribution: usd('0') }],
      contributionGrowth: 'flat',
      glidepath: { kind: 'static', equityShare: '0' },
      annualSpending: usd('40000'),
      pensions: [
        { name: 'small', startAge: 35, annualBenefit: usd('10000'), cola: { kind: 'cpi' } },
      ],
    };
    const result = projectDeterministic(plan, assumptions);
    expect(result.years).toHaveLength(10);
    expect(result.success).toBe(false);
    expect(result.depletionAge).toBe(38);
    const last = result.years[9];
    // Pension still pays; the unfunded part of spending is reported, not hidden.
    expect(last?.pension).toEqual(usd('10000'));
    expect(last?.shortfall).toEqual(usd('30000'));
    expect(result.totalShortfall.minor).toBeGreaterThan(6n * 3_000_000n);
  });

  it('a pension without a COLA loses real value every year; a CPI-indexed one does not', () => {
    const plan = (cola: 'none' | 'cpi'): ProjectionPlan => ({
      ...BASE,
      retirementAge: 35,
      planEndAge: 40,
      buckets: [{ bucket: 'TAXABLE', startingBalance: usd('0'), annualContribution: usd('0') }],
      contributionGrowth: 'flat',
      glidepath: { kind: 'static', equityShare: '0' },
      annualSpending: usd('0'),
      pensions: [{ name: 'p', startAge: 35, annualBenefit: usd('20000'), cola: { kind: cola } }],
    });
    const indexed = projectDeterministic(plan('cpi'), assumptions).years.map((y) => y.pension);
    const fixed = projectDeterministic(plan('none'), assumptions).years.map((y) => y.pension);
    expect(new Set(indexed.map((m) => m.minor))).toEqual(new Set([2_000_000n]));
    expect(fixed[4]?.minor).toBe(1_811_901n); // 20,000 / 1.025^4 = 18,119.01
  });
});

describe('glidepaths (07 §5.9)', () => {
  it('evaluates each shape per period', () => {
    expect(ageBasedEquity(20)).toBe(AGE_BASED_RULE.maximumEquity);
    expect(ageBasedEquity(50)).toBeCloseTo(0.6, 12);
    expect(ageBasedEquity(95)).toBe(AGE_BASED_RULE.minimumEquity);
    expect(targetDateEquity(30, 65)).toBe(0.9);
    expect(targetDateEquity(65, 65)).toBe(0.5);
    expect(targetDateEquity(72, 65)).toBe(0.3);
    expect(targetDateEquity(90, 65)).toBe(0.3);
    expect(risingEquity(65, 65)).toBeCloseTo(0.4, 12);
    expect(risingEquity(80, 65)).toBeCloseTo(0.7, 12);
    expect(risingEquity(50, 65)).toBe(ageBasedEquity(50));
    expect(() => glidepathFunction({ kind: 'static', equityShare: 1.2 })).toThrow(RangeError);
  });
});

describe('refusals', () => {
  it('refuses rather than clamps an impossible plan', () => {
    const plan = referencePlan('A');
    const cases: readonly ProjectionPlan[] = [
      { ...plan, birthDate: DateOnly.parse('2027-01-01') },
      { ...plan, planEndAge: 30 },
      { ...plan, retirementAge: 64.5 },
      { ...plan, buckets: [...plan.buckets, ...plan.buckets] },
      { ...plan, taxDeferredRate: '1' },
      { ...plan, glidepath: { kind: 'static', equityShare: '1.5' } },
      { ...plan, annualSpending: Money.of(-1n, 'USD') },
      { ...plan, annualSpending: Money.of(100n, 'EUR') },
      {
        ...plan,
        withdrawalPolicy: { kind: 'guardrails', spendingFloor: usd('60000') },
      },
      {
        ...plan,
        socialSecurity: {
          kind: 'statement',
          monthlyPia: usd('2000'),
          claimAge: { years: 61, months: 0 },
          stressAfter2034: false,
        },
      },
    ];
    for (const bad of cases) {
      expect(() => projectDeterministic(bad, assumptions)).toThrow(ProjectionInputRefused);
    }
  });
});
