// SPDX-License-Identifier: MIT
/**
 * Shared plan builders for WP 4.4's engine suites. Not a test file itself.
 *
 * The three reference plans are the ones `fixtures/reference-projection.py`
 * computes in closed form. Their parameters are written twice — here as Money
 * and decimal strings, there as Python `Decimal`s — on purpose: the reference
 * must not import the engine's plan to compute its answer.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateOnly, Money } from '@core/kernel';
import type { ProjectionPlan } from '../../src/engine/boundary.ts';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** Whole or decimal dollars, as a string, to USD Money — exact, no float. */
export function usd(dollars: string): Money {
  return Money.parseAmount(dollars, 'USD');
}

/** Born 1 Jan 1991, projected from 1 Jan 2026: age 35, retire at 65, plan to 95. */
export const BASE: Omit<
  ProjectionPlan,
  'buckets' | 'contributionGrowth' | 'glidepath' | 'annualSpending'
> = Object.freeze({
  currency: 'USD',
  asOf: DateOnly.parse('2026-01-01'),
  birthDate: DateOnly.parse('1991-01-01'),
  retirementAge: 65,
  planEndAge: 95,
  withdrawalPolicy: { kind: 'constant_real' as const },
  taxDeferredRate: '0.15',
  socialSecurity: null,
  pensions: [],
  otherIncome: [],
});

/** The committed reference cases (see `fixtures/reference-projection.md`). */
export function referencePlan(which: 'A' | 'B' | 'C'): ProjectionPlan {
  switch (which) {
    case 'A':
      return {
        ...BASE,
        buckets: [
          { bucket: 'TAXABLE', startingBalance: usd('50000'), annualContribution: usd('15000') },
        ],
        contributionGrowth: 'flat',
        glidepath: { kind: 'static', equityShare: '1' },
        annualSpending: usd('50000'),
      };
    case 'B':
      return {
        ...BASE,
        buckets: [
          {
            bucket: 'TAX_DEFERRED',
            startingBalance: usd('100000'),
            annualContribution: usd('12000'),
          },
        ],
        contributionGrowth: 'wage',
        glidepath: { kind: 'static', equityShare: '0.6' },
        annualSpending: usd('60000'),
        socialSecurity: {
          kind: 'statement',
          monthlyPia: usd('2500'),
          claimAge: { years: 67, months: 0 },
          stressAfter2034: false,
        },
      };
    case 'C':
      return {
        ...BASE,
        buckets: [
          { bucket: 'TAXABLE', startingBalance: usd('25000'), annualContribution: usd('0') },
        ],
        contributionGrowth: 'flat',
        glidepath: { kind: 'static', equityShare: '0.8' },
        annualSpending: usd('0'),
      };
  }
}

export interface ReferenceRow {
  readonly caseId: string;
  /** The age the person is during the last projected year of the checkpoint (born 1 Jan). */
  readonly ageInFinalYear: number;
  readonly yearsFromStart: number;
  readonly measure: string;
  /** Decimal string, cents. */
  readonly reference: string;
  readonly formula: string;
}

export function referenceRows(): readonly ReferenceRow[] {
  const [header, ...lines] = fixtureText('reference-projection.csv').trim().split('\n');
  if (header !== 'case,age_in_final_year,years_from_start,measure,reference,formula') {
    throw new Error(`reference-projection.csv header changed: ${String(header)}`);
  }
  return lines.map((line) => {
    const [caseId = '', age = '', years = '', measure = '', reference = '', formula = ''] =
      line.split(',');
    return {
      caseId,
      ageInFinalYear: Number.parseInt(age, 10),
      yearsFromStart: Number.parseInt(years, 10),
      measure,
      reference,
      formula,
    };
  });
}
