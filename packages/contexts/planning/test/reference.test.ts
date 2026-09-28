// SPDX-License-Identifier: MIT
/**
 * WP 4.14 — the §5 exit criterion as a test, not a ceremony:
 *
 * > "deterministic output within 1% of an independent reference calculator
 * > on the shipped fixtures"
 *
 * Two committed references, both closed-form Python `decimal` models of 07
 * §5.2's recursions (OpenDocument OpenFormula `FV`/`PMT`), neither sharing
 * code with the TypeScript engine:
 *
 *   * WP 4.4's `test/engine/fixtures/reference-projection.{csv,md,py}` —
 *     cases A, B, C (read here through `test/engine/support.ts`'s
 *     `referencePlan`/`referenceRows`, not duplicated).
 *   * WP 4.14's own `reference/independent-cases.{csv,md,py}` — cases D (a
 *     CPI-indexed pension) and E (the solver's `nominal` basis), each
 *     exercising a code path A/B/C do not.
 *
 * `'a deliberately wrong engine constant pushes a case outside 1% and the
 * test goes red'` is the control the dispatch (§3 WP 4.14) names by name: a
 * tolerance nobody has watched fail is not a tolerance. It sabotages the
 * *assumptions* input WP 4.2 exposes for exactly this (`diffOverrides` /
 * `applyOverrides`) rather than editing engine source, so nothing here
 * leaves the tree touched after the test finishes.
 *
 * ## Why this file lives at `test/reference.test.ts`, not `test/reference/reference.test.ts`
 *
 * The dispatch (§3 WP 4.14) names the file at `test/reference/reference.test.ts`.
 * The `planning` vitest project's `include` is `src/**\/*.test.ts` and
 * `test/*.test.ts` (`vitest.config.ts`) — a single `*`, not `**`, so a spec
 * under `test/reference/` is never collected; verified empirically with
 * `vitest list --project planning` both before and after this file existed.
 * `docs/evidence/phase-4/wp4.14-quality.md` records the same finding. The
 * fixtures themselves (`independent-cases.{csv,md,py}`) are data, not specs,
 * so they stay under `test/reference/` where the dispatch and this repo's
 * `test/engine/fixtures/` precedent both put fixtures; only the runnable
 * spec moved.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DateOnly } from '@core/kernel';
import { applyOverrides, diffOverrides, loadAssumptions } from '../src/assumptions.ts';
import type { ProjectionPlan } from '../src/engine/boundary.ts';
import { projectDeterministic } from '../src/engine/project.ts';
import { solveRequiredSavings } from '../src/engine/solve.ts';
import { BASE, fixtureText, referencePlan, referenceRows, usd } from './engine/support.ts';

const REFERENCE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'reference');
const assumptions = loadAssumptions();

interface ReferenceRow {
  readonly caseId: string;
  /** The age the person is during the last projected year of the checkpoint (born 1 Jan). */
  readonly ageInFinalYear: number;
  readonly yearsFromStart: number;
  readonly measure: string;
  /** Decimal string, cents. */
  readonly reference: string;
  readonly formula: string;
}

const ROW_HEADER = 'case,age_in_final_year,years_from_start,measure,reference,formula';

function parseRows(csv: string): readonly ReferenceRow[] {
  const [header, ...lines] = csv.trim().split('\n');
  if (header !== ROW_HEADER) {
    throw new Error(`reference CSV header changed: ${String(header)}`);
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

/** WP 4.14's own two cases (`reference/independent-cases.md`). Not committed by WP 4.4. */
function independentRows(): readonly ReferenceRow[] {
  return parseRows(readFileSync(join(REFERENCE_DIR, 'independent-cases.csv'), 'utf8'));
}

/** Case D — a CPI-indexed pension offsetting spending (`reference/independent-cases.md`). */
function planD(): ProjectionPlan {
  return {
    ...BASE,
    buckets: [
      { bucket: 'TAX_DEFERRED', startingBalance: usd('90000'), annualContribution: usd('11000') },
    ],
    contributionGrowth: 'flat',
    glidepath: { kind: 'static', equityShare: '0.5' },
    annualSpending: usd('40000'),
    pensions: [
      {
        name: 'Case D pension',
        startAge: 65,
        annualBenefit: usd('35000'),
        cola: { kind: 'cpi' },
      },
    ],
  };
}

/** Case E — the solver's `nominal` target basis (`reference/independent-cases.md`). */
function planE(): ProjectionPlan {
  return {
    ...BASE,
    buckets: [{ bucket: 'TAXABLE', startingBalance: usd('40000'), annualContribution: usd('0') }],
    contributionGrowth: 'flat',
    glidepath: { kind: 'static', equityShare: '0.9' },
    annualSpending: usd('0'),
  };
}

/** Every engine-vs-reference difference as a fraction of the reference. */
function differenceOf(engineMinor: bigint, referenceMinor: bigint): number {
  return Math.abs(Number(engineMinor - referenceMinor)) / Number(referenceMinor);
}

function minorOf(decimal: string): bigint {
  return usd(decimal).minor;
}

describe('the committed references (the §5 exit criterion)', () => {
  it('every committed reference case matches within 1%', () => {
    const wp44Rows = referenceRows();
    const wp414Rows = independentRows();
    expect(wp44Rows.length).toBeGreaterThanOrEqual(13);
    expect(wp414Rows.length).toBeGreaterThanOrEqual(2);

    const results = {
      A: projectDeterministic(referencePlan('A'), assumptions),
      B: projectDeterministic(referencePlan('B'), assumptions),
      D: projectDeterministic(planD(), assumptions),
    };
    const solvedC = solveRequiredSavings(referencePlan('C'), assumptions, {
      objective: {
        kind: 'wealth_at',
        targetDate: DateOnly.parse('2056-01-01'),
        target: usd('1000000'),
        basis: 'real',
      },
      maxMonthly: usd('10000'),
    });
    const solvedE = solveRequiredSavings(planE(), assumptions, {
      objective: {
        kind: 'wealth_at',
        targetDate: DateOnly.parse('2056-01-01'),
        target: usd('2000000'),
        basis: 'nominal',
      },
      maxMonthly: usd('10000'),
    });

    let worst = 0;
    for (const row of [...wp44Rows, ...wp414Rows]) {
      let engineMinor: bigint;
      if (row.caseId === 'C' || row.caseId === 'E') {
        const solved = row.caseId === 'C' ? solvedC : solvedE;
        if (solved.kind !== 'required') {
          throw new Error(`case ${row.caseId} did not solve: ${solved.kind}`);
        }
        engineMinor = solved.monthly.minor;
      } else {
        const result = row.caseId === 'A' ? results.A : row.caseId === 'B' ? results.B : results.D;
        const year = result.years[row.yearsFromStart - 1];
        if (year === undefined) {
          throw new Error(`case ${row.caseId}: no year ${String(row.yearsFromStart)}`);
        }
        expect(year.age).toBe(row.ageInFinalYear);
        engineMinor = year.endWealth.minor;
      }
      const referenceMinor = minorOf(row.reference);
      const difference = differenceOf(engineMinor, referenceMinor);
      worst = Math.max(worst, difference);
      expect(
        difference,
        `${row.caseId} age ${String(row.ageInFinalYear)}: engine ${String(engineMinor)} vs reference ${String(referenceMinor)}`,
      ).toBeLessThan(0.01);
    }
    expect(worst).toBeLessThan(0.01);
    console.error('PROBE worst', worst);
  });

  it('a deliberately wrong engine constant pushes a case outside 1% and the test goes red', () => {
    // Sabotage the assumptions file's US equity expected return — case A is
    // 100% equity, so this is the single most leveraged constant it has —
    // through the same override path WP 4.2 exposes to a real user, never by
    // editing engine source. The tree is untouched: `sabotaged` is a value,
    // never written back to `loadAssumptions()`'s cache.
    const row = referenceRows().find(
      (candidate) => candidate.caseId === 'A' && candidate.yearsFromStart === 30,
    );
    if (row === undefined) throw new Error('reference-projection.csv no longer has the A/30 row');

    const clean = projectDeterministic(referencePlan('A'), assumptions);
    const cleanDifference = differenceOf(
      clean.years[row.yearsFromStart - 1]?.endWealth.minor ?? 0n,
      minorOf(row.reference),
    );
    expect(cleanDifference).toBeLessThan(0.01); // the control's baseline is itself green.

    const deltas = diffOverrides(assumptions, { 'capitalMarket.usEquity.expectedReturn': '0.30' });
    const sabotaged = applyOverrides(assumptions, deltas, DateOnly.parse('2026-01-01'));
    const dirty = projectDeterministic(referencePlan('A'), sabotaged);
    const dirtyDifference = differenceOf(
      dirty.years[row.yearsFromStart - 1]?.endWealth.minor ?? 0n,
      minorOf(row.reference),
    );
    console.error('PROBE clean', cleanDifference, 'dirty', dirtyDifference);
    expect(
      dirtyDifference,
      'a 0.065 -> 0.30 equity-return sabotage produced no measurable drift from the reference — the tolerance is not doing anything',
    ).toBeGreaterThan(0.01);
  });

  it('both references ship with their formulas and were not produced by the engine', () => {
    const wp44 = fixtureText('reference-projection.md');
    for (const column of ['A_acc', 'A_dec', 'B_acc', 'B_dec1', 'B_dec2', 'C_pmt']) {
      expect(wp44).toContain(column);
    }
    expect(wp44).toMatch(/=FV\(/);
    expect(wp44).toMatch(/=PMT\(/);

    const wp414 = readFileSync(join(REFERENCE_DIR, 'independent-cases.md'), 'utf8');
    for (const column of ['D_acc', 'D_dec', 'E_pmt']) {
      expect(wp414).toContain(column);
    }
    expect(wp414).toMatch(/=FV\(/);
    expect(wp414).toMatch(/=PMT\(/);
    // Neither reference imports the engine, or the other reference's script
    // (a mention in a doc comment, explaining independence, is not an import).
    const script = readFileSync(join(REFERENCE_DIR, 'independent-cases.py'), 'utf8');
    expect(script).not.toMatch(/from\s+deterministic|import\s+deterministic/);
    expect(script).not.toMatch(/^\s*(?:from|import)\s+.*reference[-_]projection/m);
  });
});
