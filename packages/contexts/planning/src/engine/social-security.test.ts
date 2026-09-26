// SPDX-License-Identifier: MIT
/**
 * WP 4.4 — Social Security, 07 §5.8's seven steps, against SSA's own published
 * example: OACT's "Benefit Calculation Examples for Workers Retiring in 2026"
 * (`test/engine/fixtures/ssa-2026-examples.json` carries the inputs, SSA's
 * published outputs and the URLs). Bend points, factors, FRA, the reduction
 * fractions and the delayed credit all come from WP 4.2's assumptions file via
 * `socialSecurityRulesFrom` — this suite writes none of them down.
 */
import { describe, expect, it } from 'vitest';
import { DateOnly, Money } from '@core/kernel';
import { loadAssumptions } from '../assumptions.ts';
import { projectDeterministic } from './project.ts';
import { socialSecurityRulesFrom, type ProjectionPlan } from './boundary.ts';
import {
  applyColas,
  averageIndexedMonthlyEarnings,
  claimFactor,
  deriveSocialSecurity,
  fullRetirementAgeMonths,
  indexEarnings,
  monthlyBenefit,
  piaFromAime,
  type EngineSocialSecurity,
} from './social-security.ts';
import { BASE, fixtureText, usd } from '../../test/engine/support.ts';

interface SsaFixture {
  readonly caseA: {
    readonly birthYear: number;
    readonly indexYear: number;
    readonly earnings: readonly { readonly year: number; readonly earnings: string }[];
    readonly published: {
      readonly highest35Total: string;
      readonly aime: string;
      readonly piaBeforeTruncation: string;
      readonly pia: string;
      readonly claimAt62Monthly: string;
    };
  };
  readonly caseB: {
    readonly aime: string;
    readonly bendPoints2021: { readonly first: string; readonly second: string };
    readonly colas2021to2025: readonly string[];
    readonly published: { readonly pia: string; readonly monthlyAtNormalRetirementAge: string };
  };
  readonly averageWageIndex: readonly { readonly year: number; readonly index: string }[];
}

const ssa = JSON.parse(fixtureText('ssa-2026-examples.json')) as SsaFixture;
const assumptions = loadAssumptions();
const rules = socialSecurityRulesFrom(assumptions, 2026);
// Test-side parsing of the fixture's decimal strings; the engine's own path is the boundary.
const awi = new Map(ssa.averageWageIndex.map((row) => [row.year, Number(row.index)]));
const earningsA = ssa.caseA.earnings.map((row) => ({
  year: row.year,
  earnings: Number(row.earnings),
}));

describe('SSA 2026 case A (born 1964, first eligible 2026)', () => {
  it('the published 2026 bend points reproduce a known AIME to PIA case to the dollar', () => {
    // The file's bend points are SSA's 2026 figures.
    expect(rules.bendFirst).toBe(1286);
    expect(rules.bendSecond).toBe(7749);

    // Step 1: index to the AWI of the year the worker turns 60 (2024).
    const indexed = indexEarnings(earningsA, awi, ssa.caseA.indexYear);
    expect(Math.round(indexed[0] ?? 0)).toBe(65_307); // SSA's 1986 row: $16,196 × 4.0323 = $65,307
    const highest = [...indexed].sort((a, b) => b - a).slice(0, 35);
    expect(Math.round(highest.reduce((sum, year) => sum + year, 0))).toBe(
      Number(ssa.caseA.published.highest35Total),
    );

    // Step 2: AIME = highest 35 / 420, floored.
    const aime = averageIndexedMonthlyEarnings(indexed);
    expect(aime).toBe(Number(ssa.caseA.published.aime)); // $5,825

    // Step 3: .9(1286) + .32(5825 − 1286) = $2,609.88, truncated to the dime = $2,609.80.
    const untruncated = 0.9 * 1286 + 0.32 * (aime - 1286);
    expect(untruncated).toBeCloseTo(Number(ssa.caseA.published.piaBeforeTruncation), 9);
    expect(piaFromAime(aime, rules)).toBe(Number(ssa.caseA.published.pia));

    // The whole chain through the engine's own derivation, and through the Money boundary.
    const derived = deriveSocialSecurity(
      {
        kind: 'earnings',
        history: earningsA,
        averageWageIndex: awi,
        futureAnnualEarnings: 0,
        firstFutureYear: 2026,
        lastFutureYear: 0,
        claimMonths: 62 * 12,
        birthYear: 1964,
        stress: false,
      } satisfies EngineSocialSecurity,
      rules,
    );
    expect(derived.indexYear).toBe(2024);
    expect(derived.aime).toBe(5825);
    expect(derived.pia).toBe(2609.8);
    expect(derived.monthly).toBe(Number(ssa.caseA.published.claimAt62Monthly)); // $1,826
  });

  it('a Money-facing projection from the raw earnings record reports the same PIA and benefit', () => {
    const plan: ProjectionPlan = {
      ...BASE,
      birthDate: DateOnly.parse('1964-01-01'),
      retirementAge: 62,
      planEndAge: 70,
      buckets: [{ bucket: 'TAXABLE', startingBalance: usd('0'), annualContribution: usd('0') }],
      contributionGrowth: 'flat',
      glidepath: { kind: 'static', equityShare: '0' },
      annualSpending: usd('0'),
      socialSecurity: {
        kind: 'earnings',
        history: ssa.caseA.earnings.map((row) => ({ year: row.year, earnings: usd(row.earnings) })),
        averageWageIndex: ssa.averageWageIndex,
        futureAnnualEarnings: null,
        claimAge: { years: 62, months: 0 },
        stressAfter2034: false,
      },
    };
    const result = projectDeterministic(plan, assumptions);
    expect(result.socialSecurity?.aime).toEqual(usd('5825'));
    expect(result.socialSecurity?.pia).toEqual(usd('2609.80'));
    expect(result.socialSecurity?.monthlyBenefit).toEqual(usd('1826'));
    expect(result.socialSecurity?.claimFactor).toBe('0.7');
    expect(result.years[0]?.socialSecurity).toEqual(usd('21912')); // 12 × $1,826
  });
});

describe('claiming age', () => {
  it('claiming at 62 and at 70 straddle FRA by exactly the published adjustment', () => {
    const fra = fullRetirementAgeMonths(1964, rules);
    expect(fra).toBe(67 * 12);
    // SSA: born 1960 or later, 62 is 60 months early — 36 × 5/9% + 24 × 5/12% = 30% off.
    expect(claimFactor(62 * 12, fra, rules)).toBeCloseTo(0.7, 12);
    // 36 months early is exactly 20% off; the boundary between the two rates.
    expect(claimFactor(64 * 12, fra, rules)).toBeCloseTo(0.8, 12);
    expect(claimFactor(fra, fra, rules)).toBe(1);
    // 8%/yr for 3 years of delay = 124% at 70, and not a month more after 70.
    expect(claimFactor(70 * 12, fra, rules)).toBeCloseTo(1.24, 12);
    expect(claimFactor(72 * 12, fra, rules)).toBeCloseTo(1.24, 12);
    // Month-granular: 67y6m is 6 months of 2/3%.
    expect(claimFactor(67 * 12 + 6, fra, rules)).toBeCloseTo(1.04, 12);

    const pia = Number(ssa.caseA.published.pia);
    expect(monthlyBenefit(pia, claimFactor(62 * 12, fra, rules))).toBe(1826); // SSA: $1,826.00
    expect(monthlyBenefit(pia, claimFactor(fra, fra, rules))).toBe(2609);
    expect(monthlyBenefit(pia, claimFactor(70 * 12, fra, rules))).toBe(3236); // floor(2609.80 × 1.24)
    expect(() => claimFactor(61 * 12 + 11, fra, rules)).toThrow(RangeError);
  });

  it('a birth year the assumptions file does not encode is refused, not guessed', () => {
    expect(() => fullRetirementAgeMonths(1959, rules)).toThrow(/no full retirement age/);
  });
});

describe('SSA 2026 case B (born 1959, first eligible 2021) — step 6, COLAs', () => {
  it('truncates to the dime after the formula and after every COLA, as SSA publishes', () => {
    // Case B is locked into its eligibility year's (2021) bend points, which SSA
    // publishes in its bend-point table; the 2026 file does not carry 2021.
    const rules2021 = {
      ...rules,
      bendFirst: Number(ssa.caseB.bendPoints2021.first),
      bendSecond: Number(ssa.caseB.bendPoints2021.second),
    };
    const pia2021 = piaFromAime(Number(ssa.caseB.aime), rules2021);
    expect(pia2021).toBe(3317.4); // $3,317.47 truncated
    const pia = applyColas(pia2021, ssa.caseB.colas2021to2025.map(Number));
    expect(pia).toBe(Number(ssa.caseB.published.pia)); // $4,152.40
    expect(monthlyBenefit(pia, 1)).toBe(Number(ssa.caseB.published.monthlyAtNormalRetirementAge));
  });
});

describe('the "75% benefit after 2034" stress toggle (07 §5.8)', () => {
  it('pays the file’s payable ratio from its calendar year, and nothing changes before it', () => {
    const plan = (stress: boolean): ProjectionPlan => ({
      ...BASE,
      birthDate: DateOnly.parse('1964-01-01'),
      retirementAge: 62,
      planEndAge: 75,
      buckets: [{ bucket: 'TAXABLE', startingBalance: usd('0'), annualContribution: usd('0') }],
      contributionGrowth: 'flat',
      glidepath: { kind: 'static', equityShare: '0' },
      annualSpending: usd('0'),
      socialSecurity: {
        kind: 'statement',
        monthlyPia: usd('2000'),
        claimAge: { years: 67, months: 0 },
        stressAfter2034: stress,
      },
    });
    const normal = projectDeterministic(plan(false), assumptions).years;
    const stressed = projectDeterministic(plan(true), assumptions).years;
    for (const [index, year] of stressed.entries()) {
      const base = normal[index]?.socialSecurity ?? Money.of(0n, 'USD');
      if (year.calendarYear < 2034) expect(year.socialSecurity).toEqual(base);
      else expect(year.socialSecurity.minor).toBe((base.minor * 3n) / 4n);
    }
    // Claimed at 67 (2031): three full years before the cliff.
    expect(stressed.find((y) => y.calendarYear === 2031)?.socialSecurity).toEqual(usd('24000'));
    expect(stressed.find((y) => y.calendarYear === 2034)?.socialSecurity).toEqual(usd('18000'));
  });
});
