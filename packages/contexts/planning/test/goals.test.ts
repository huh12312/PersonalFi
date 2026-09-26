// SPDX-License-Identifier: MIT
/**
 * WP 4.1 exit tests for goals and contribution plans, without a database.
 *
 *   * `'a goal target is Money and a contribution escalation never becomes a
 *     float'` — a fast-check property over amounts up to 10^15 minor units and
 *     escalation rates with up to four decimal places, compared against an
 *     independent exact-rational reference written here. A float
 *     implementation of the escalation (`Number(minor) * (1 + p/100) ** n`)
 *     disagrees with the reference by at least a cent somewhere in that range,
 *     and the property finds it — the WP 4.1 evidence records that sabotage.
 *   * `'a target date in the past refuses with a domain error rather than
 *     clamping'` — including the zone case: the holder's today, not UTC's.
 */
import { DateOnly, Money, fixedClock } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  escalatedAmount,
  parseEscalationPct,
  validateContributionPlan,
  type ContributionPlan,
  type EscalationPct,
} from '../src/contributions.ts';
import { PlanningError } from '../src/errors.ts';
import { createGoal, validateNewGoal, type Goal } from '../src/goals.ts';
import type { PlanningExecutor } from '../src/store.ts';
import type { PlanningAccount } from '../src/ports.ts';

const CHECKING = '01920000-0000-7000-8000-00000000a001';
const BROKERAGE = '01920000-0000-7000-8000-00000000a002';
const NOWHERE = '01920000-0000-7000-8000-00000000a0ff';

const roster: readonly PlanningAccount[] = [
  {
    accountId: CHECKING,
    name: 'Checking',
    kind: 'cash',
    side: 'asset',
    currency: 'USD',
    flags: { onBudget: true, inNetWorth: true, isLiquid: true, isInvestable: false },
    closedAt: null,
  },
  {
    accountId: BROKERAGE,
    name: 'Brokerage',
    kind: 'investment',
    side: 'asset',
    currency: 'USD',
    flags: { onBudget: false, inNetWorth: true, isLiquid: false, isInvestable: true },
    closedAt: null,
  },
];

// ---------------------------------------------------------------------------
// The independent reference: amount × (1 + p/100)^n, exact, rounded half-even once.
// ---------------------------------------------------------------------------

function referenceEscalation(minor: bigint, pct: string, years: number): bigint {
  const [integer = '0', fraction = ''] = pct.split('.');
  const u = BigInt(`${integer}${fraction}`);
  const k = BigInt(fraction.length + 2);
  const numerator = minor * (10n ** k + u) ** BigInt(years);
  const denominator = 10n ** (k * BigInt(years));
  const quotient = numerator / denominator;
  const twice = (numerator - quotient * denominator) * 2n;
  if (twice > denominator) return quotient + 1n;
  if (twice < denominator) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/** Percentage points with 0–4 decimal places, 0 to 100 inclusive. */
const pctArbitrary = fc
  .tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 4 }), fc.nat({ max: 9999 }))
  .map(([integer, places, digits]) => {
    if (integer === 100 || places === 0) return String(integer);
    const fraction = String(digits).padStart(4, '0').slice(0, places);
    return `${String(integer)}.${fraction}`;
  });

const minorArbitrary = fc.bigInt({ min: 1n, max: 10n ** 15n });

describe('goals and contribution plans', () => {
  it('a goal target is Money and a contribution escalation never becomes a float', () => {
    // The types, first: nothing on either shape is a `number` amount or rate.
    expectTypeOf<Goal['target']>().toEqualTypeOf<Money>();
    expectTypeOf<Goal['target']['minor']>().toEqualTypeOf<bigint>();
    expectTypeOf<ContributionPlan['amount']>().toEqualTypeOf<Money>();
    expectTypeOf<ContributionPlan['escalationPct']>().toEqualTypeOf<EscalationPct>();
    expectTypeOf<EscalationPct>().toMatchTypeOf<string>();
    expectTypeOf<ContributionPlan['escalationPct']>().not.toMatchTypeOf<number>();

    fc.assert(
      fc.property(
        minorArbitrary,
        pctArbitrary,
        fc.integer({ min: 0, max: 40 }),
        (minor, pctText, years) => {
          // A goal target survives validation as the identical bigint.
          const target = Money.of(minor, 'USD');
          const goal = validateNewGoal(
            {
              kind: 'purchase',
              name: 'House deposit',
              target,
              targetDate: '2030-01-01',
              fundedFromAccountIds: [CHECKING],
            },
            { today: DateOnly.parse('2026-09-26'), accounts: roster },
          );
          expect(typeof goal.target.minor).toBe('bigint');
          expect(goal.target.minor).toBe(minor);
          expect(Money.toJSON(goal.target)).toEqual({ minor: minor.toString(), currency: 'USD' });

          // The rate is a string in and a string out, canonical, and what
          // NUMERIC(7,4) reads back ('3.2500') is the same value.
          const pct = parseEscalationPct(pctText);
          expect(typeof pct).toBe('string');
          const padded = pct.includes('.')
            ? `${pct}${'0'.repeat(4 - (pct.split('.')[1]?.length ?? 0))}`
            : `${pct}.0000`;
          expect(parseEscalationPct(padded)).toBe(pct);

          // The plan carries it untouched.
          const plan = validateContributionPlan(
            {
              cadence: 'monthly',
              amount: target,
              escalationPct: pctText,
              startsOn: '2026-10-01',
              source: 'USER',
            },
            goal,
          );
          expect(plan.escalationPct).toBe(pct);
          expect(plan.amount.minor).toBe(minor);

          // And the one place rate meets amount is exact until a single rounding.
          const escalated = escalatedAmount(plan.amount, plan.escalationPct, years);
          expect(typeof escalated.minor).toBe('bigint');
          expect(escalated.currency).toBe('USD');
          expect(escalated.minor).toBe(referenceEscalation(minor, pct, years));
        },
      ),
      { numRuns: 1000 },
    );

    // A number is refused at the door, never converted — including one that
    // looks harmless.
    for (const value of [3, 3.25, 0, Number.NaN]) {
      expect(() => parseEscalationPct(value)).toThrow(PlanningError);
    }
    expect(() =>
      validateContributionPlan(
        {
          cadence: 'monthly',
          amount: Money.of(50_000n, 'USD'),
          escalationPct: 3,
          startsOn: '2026-10-01',
          source: 'USER',
        },
        { target: Money.of(1n, 'USD') },
      ),
    ).toThrow(expect.objectContaining({ code: 'planning.contribution_escalation_invalid' }));

    // A worked case a float gets wrong: $9,007,199,254,740.99 at 3.1% for 30 years.
    const large = Money.of(900_719_925_474_099n, 'USD');
    const exact = escalatedAmount(large, parseEscalationPct('3.1'), 30);
    expect(exact.minor).toBe(referenceEscalation(large.minor, '3.1', 30));
    const float = BigInt(Math.round(Number(large.minor) * 1.031 ** 30));
    expect(float).not.toBe(exact.minor);
  });

  it('a target date in the past refuses with a domain error rather than clamping', async () => {
    // 03:00 UTC on the 26th is still the evening of the 25th in Los Angeles.
    const clock = fixedClock(new Date('2026-09-26T03:00:00Z'));
    const context = {
      userId: '01920000-0000-7000-8000-000000000001',
      clock,
      timeZone: 'America/Los_Angeles',
      correlationId: '01920000-0000-7000-8000-0000000000c8',
    };
    // The refusal happens before any write: an executor that is touched fails the test.
    const untouchable = new Proxy(
      {},
      {
        get: (_target, property) => {
          throw new Error(`the executor was touched (${String(property)}) before the refusal`);
        },
      },
    ) as PlanningExecutor;
    const ports = { accounts: { accounts: () => Promise.resolve(roster) } };
    const input = {
      kind: 'purchase' as const,
      name: 'Car',
      target: Money.of(2_500_000n, 'USD'),
      fundedFromAccountIds: [CHECKING],
    };

    const refusal = await createGoal(untouchable, ports, context, {
      ...input,
      targetDate: '2026-09-24',
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PlanningError);
    expect(refusal).toMatchObject({
      code: 'planning.goal_target_date_in_past',
      status: 422,
      family: 'domain',
    });
    expect((refusal as Error).message).toContain('2026-09-24');
    expect((refusal as Error).message).toContain('2026-09-25');

    // Today *in the holder's zone* passes validation and reaches the write —
    // the untouchable executor is what stops it, not a refusal — even though
    // 2026-09-25 is already yesterday in UTC.
    await expect(
      createGoal(untouchable, ports, context, { ...input, targetDate: '2026-09-25' }),
    ).rejects.toThrow(/the executor was touched/);

    // Not clamped: there is no path that returns a goal re-dated to today.
    const today = DateOnly.parse('2026-09-25');
    expect(() =>
      validateNewGoal({ ...input, targetDate: '2026-09-24' }, { today, accounts: roster }),
    ).toThrow(expect.objectContaining({ code: 'planning.goal_target_date_in_past' }));

    // Today in the holder's zone is allowed, even though it is already
    // yesterday in UTC; tomorrow obviously is.
    expect(
      validateNewGoal({ ...input, targetDate: '2026-09-25' }, { today, accounts: roster })
        .targetDate,
    ).toBe('2026-09-25');

    // The other refusal the dispatch names: a funding account that does not
    // exist is refused by name, not dropped from the list.
    const missing = (() => {
      try {
        validateNewGoal(
          { ...input, targetDate: '2027-01-01', fundedFromAccountIds: [CHECKING, NOWHERE] },
          { today, accounts: roster },
        );
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(missing).toMatchObject({
      code: 'planning.goal_funding_account_not_found',
      status: 422,
      family: 'domain',
    });
    expect((missing as Error).message).toContain(NOWHERE);

    // A closed funding account is a state conflict (409), and a non-positive
    // target is refused, never floored to a cent.
    const closedRoster = roster.map((account) =>
      account.accountId === BROKERAGE
        ? { ...account, closedAt: new Date('2026-06-30T00:00:00Z') }
        : account,
    );
    expect(() =>
      validateNewGoal(
        { ...input, targetDate: '2027-01-01', fundedFromAccountIds: [BROKERAGE] },
        { today, accounts: closedRoster },
      ),
    ).toThrow(expect.objectContaining({ code: 'planning.goal_funding_account_closed' }));
    expect(() =>
      validateNewGoal(
        { ...input, targetDate: '2027-01-01', target: Money.of(0n, 'USD') },
        { today, accounts: roster },
      ),
    ).toThrow(expect.objectContaining({ code: 'planning.goal_target_not_positive' }));
  });
});
