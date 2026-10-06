// SPDX-License-Identifier: MIT
/**
 * WP 5.6 — `createInsightsRetirementImpactPort`, the composition-root
 * binding of `@ctx/insights`' `RetirementImpactPort` over WP 5.5's
 * `solveRetirementImpact`, against a real database.
 *
 * `packages/contexts/insights/test/brief-retirement.test.ts` proves the
 * Brief never invents or adjusts what the port answers, over a fake port.
 * This file proves the *real*, bound port's answer for one action is exactly
 * what a direct call to `solveRetirementImpact` over the same assembled plan
 * produces — the adapter's whole job is the conversion, and this is the
 * check that the conversion is faithful (`brief/ports.ts`'s own header).
 */
import { DateOnly, Money, money, systemClock } from '@core/kernel';
import {
  assembleInput,
  createProjectionInputsReader,
  getBaseline,
  listLifeEvents,
  resolveForUser,
  saveBaseline,
  sealDay,
  solveRetirementImpact,
  upsertOpenDay,
  type BaselineProfile,
  type NetWorthSnapshot,
  type RetirementImpact,
  type RetirementImpactAction,
} from '@ctx/planning';
import type { RetirementImpactAnswer } from '@ctx/insights';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInsightsRetirementImpactPort, planningRevealedPortsFor } from '../../src/domain.ts';
import { createApiHarness, NO_DATABASE, type ApiHarness } from '../helpers/api-harness.ts';

const ZONE = 'UTC';
const USD = 'USD';

/** A `net_worth_daily` day with nothing in it — the `phase4-wiring.test.ts` precedent. */
function emptySnapshot(asOfDate: string): NetWorthSnapshot {
  return {
    asOfDate,
    baseCurrency: USD,
    assetsMinor: 0n,
    liabilitiesMinor: 0n,
    netWorthMinor: 0n,
    liquidMinor: 0n,
    investableMinor: 0n,
    onBudgetMinor: 0n,
    breakdown: [],
    source: 'observed',
    stalePrice: false,
    accountsCounted: 0,
    accountsUnvalued: 0,
    unvalued: [],
  };
}

async function sealMinimalDay(
  db: ApiHarness['database']['db'],
  userId: string,
  asOfDate: string,
): Promise<void> {
  await upsertOpenDay(db, { userId, snapshot: emptySnapshot(asOfDate), clock: systemClock });
  await sealDay(db, { userId, asOfDate, clock: systemClock });
}

/** States everything itself, the `phase4-wiring.test.ts` precedent: no ledger or budget needed. */
function statedProfile(overrides: Partial<BaselineProfile> = {}): BaselineProfile {
  return {
    birthDate: DateOnly.parse('1966-09-25'),
    retirementAge: 65,
    planEndAge: 90,
    currency: USD,
    glidepath: { kind: 'age_based' },
    contributionGrowth: 'flat',
    annualSpending: money(40_000_00n, USD),
    withdrawalPolicy: 'constant_real',
    spendingFloor: 'none',
    taxDeferredRate: '0.15',
    socialSecurity: null,
    pensions: [],
    contributions: { TAXABLE: money(12_000_00n, USD) },
    ...overrides,
  };
}

/** A funded plan: 30 years old, $30k a year into a taxable pot, $24k of retirement spending. */
function fundedProfile(): BaselineProfile {
  return statedProfile({
    birthDate: DateOnly.parse('1996-09-25'),
    annualSpending: money(24_000_00n, USD),
    contributions: { TAXABLE: money(30_000_00n, USD) },
  });
}
const FUNDED_ACTION = { kind: 'extra_annual' as const, annual: money(12_000_00n, USD) };

/** Field for field: the adapter's conversion changed nothing. */
type ComputedAnswer = Extract<RetirementImpactAnswer, { readonly kind: 'computed' }>;

function expectFigureEqual(answer: ComputedAnswer, direct: RetirementImpact): void {
  expect(answer.engineVersion).toBe(direct.engineVersion);
  expect(answer.assumptionsVersion).toBe(direct.assumptionsVersion);
  expect(answer.plannedRetirementAge).toBe(direct.plannedRetirementAge);
  expect(answer.yearsEarlier).toBe(direct.yearsEarlier);

  expect(answer.baseline.kind).toBe(direct.baseline.kind);
  if (answer.baseline.kind === 'earliest' && direct.baseline.kind === 'earliest') {
    expect(answer.baseline.age).toBe(direct.baseline.age);
  }
  expect(answer.withAction.kind).toBe(direct.withAction.kind);
  if (answer.withAction.kind === 'earliest' && direct.withAction.kind === 'earliest') {
    expect(answer.withAction.age).toBe(direct.withAction.age);
  }

  expect(answer.monthsOfSpending.months).toBe(direct.monthsOfSpending.months);
  if (answer.monthsOfSpending.months !== null && direct.monthsOfSpending.months !== null) {
    expect(answer.monthsOfSpending.atAge).toBe(direct.monthsOfSpending.atAge);
    expect(
      Money.equals(
        answer.monthsOfSpending.wealthDifference,
        direct.monthsOfSpending.wealthDifference,
      ),
    ).toBe(true);
    expect(
      Money.equals(
        answer.monthsOfSpending.firstYearSpending,
        direct.monthsOfSpending.firstYearSpending,
      ),
    ).toBe(true);
    expect(answer.monthsOfSpending.derivation).toBe(direct.monthsOfSpending.derivation);
  }
}

describe.skipIf(NO_DATABASE)("WP 5.6's RetirementImpactPort reproduces a direct engine run", () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp56retirementport' });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  /**
   * Seals a day, saves `profile` as the baseline and returns the bound port's
   * answer for `action` and the direct engine run over the same assembly.
   */
  async function portAndDirect(
    name: string,
    profile: BaselineProfile,
    action: RetirementImpactAction,
  ): Promise<{ answer: ComputedAnswer; direct: RetirementImpact }> {
    const userId = await h.database.createUser(name);
    const asOfDate = '2026-09-25';
    await sealMinimalDay(h.database.db, userId, asOfDate);
    await saveBaseline(h.database.db, { userId, name, profile, clock: systemClock });

    // The bound port, exactly as `apps/api/src/domain.ts` constructs it.
    const port = createInsightsRetirementImpactPort(h.database.db, { timeZone: ZONE });
    const answer = await port.effectOf({ userId, action });
    expect(answer.kind, answer.kind === 'not_computable' ? answer.reason : '').toBe('computed');
    if (answer.kind !== 'computed') throw new Error('unreachable');

    // The direct engine run: the same assembly the adapter performs,
    // called here without going through the port at all.
    const baseline = await getBaseline(h.database.db, userId);
    if (baseline === null) throw new Error('baseline was just saved');
    const resolved = await resolveForUser(h.database.db, { userId, timeZone: ZONE });
    const derived = await createProjectionInputsReader(
      h.database.db,
      planningRevealedPortsFor(h.database.db, { userId, timeZone: ZONE, clock: systemClock }),
    ).derivedInputs({ userId, asOf: null, allowOpenDay: false });
    const lifeEvents = await listLifeEvents(h.database.db, userId);
    const assembled = assembleInput({
      scenario: baseline,
      baseline,
      derived,
      lifeEvents,
      method: 'deterministic',
      paths: 1,
    });
    return { answer, direct: solveRetirementImpact(assembled.plan, resolved, action) };
  }

  it('the bound port reproduces a direct engine run for the same plan exactly (the original WP 5.6 plan, an empty sealed day — its yearsEarlier is null, so it cannot pin that field; see the funded test below)', async () => {
    const { answer, direct } = await portAndDirect(
      'WP 5.6 retirement-port holder',
      statedProfile(),
      { kind: 'extra_annual', annual: money(6_000_00n, USD) },
    );
    expectFigureEqual(answer, direct);
  });

  it("C5-7 (G5-19): on a FUNDED plan the Brief figure — a non-null yearsEarlier and months of spending — is the engine's, exactly", async () => {
    const { answer, direct } = await portAndDirect(
      'WP 9.3 funded retirement-port holder',
      fundedProfile(),
      FUNDED_ACTION,
    );

    // The precondition the old test lacked: this comparison is not null = null.
    expect(direct.baseline.kind).toBe('earliest');
    expect(direct.withAction.kind).toBe('earliest');
    expect(direct.yearsEarlier).not.toBeNull();
    expect(direct.monthsOfSpending.months).not.toBeNull();
    expect(answer.yearsEarlier).toBe(direct.yearsEarlier);
    expect(answer.monthsOfSpending.months).toBe(direct.monthsOfSpending.months);
    expectFigureEqual(answer, direct);
  });
});
