// SPDX-License-Identifier: MIT
/**
 * Minimal, schema-valid instances of the generated goal, contribution and risk-profile types — the
 * `features/plan/fixtures.ts` pattern. Typed by the generated client, never a parallel guess at a shape.
 */
import type {
  AnswerRiskProfileResponse,
  Goal,
  GoalContribution,
  GetRiskProfileResponse,
  RiskProfile,
} from '../../api/generated/types.gen.ts';

const usd = (minor: string) => ({ minor, currency: 'USD' });

export function goalFixture(overrides: Partial<Goal> = {}): Goal {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'emergency_fund',
    name: 'Emergency fund',
    target: usd('2500000'),
    targetDate: '2028-01-01',
    priority: 2,
    fundedFromAccountIds: [],
    status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

export function contributionFixture(overrides: Partial<GoalContribution> = {}): GoalContribution {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    goalId: '00000000-0000-4000-8000-000000000001',
    cadence: 'monthly',
    amount: usd('50000'),
    escalationPct: '0',
    startsOn: '2026-11-01',
    endsOn: null,
    source: 'USER',
    derivedAsOf: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

export function riskProfileFixture(overrides: Partial<RiskProfile> = {}): RiskProfile {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    tolerance: 'moderate_conservative',
    compositeScore: 7,
    unpenalisedScore: 9,
    consistencyPenalty: 2,
    horizonYears: 25,
    taxBracketBand: null,
    liquidityNeed: 'medium',
    answeredAt: '2026-10-05T12:00:00.000Z',
    ...overrides,
  };
}

/** Two of the instrument's six questions — enough to exercise grouping, framing and a "no evidence" option. */
export function riskInstrumentFixture(current: RiskProfile | null = null): GetRiskProfileResponse {
  return {
    instrument: 'risk-v1',
    items: [
      {
        id: 'drawdown.stated',
        disposition: 'drawdown',
        framing: 'stated',
        prompt: 'Suppose your long-term investments fell 25% over a few months. What would you do?',
        options: [
          { id: 'sell_all', label: 'Sell everything and move to cash', points: 1 },
          { id: 'hold', label: 'Hold and keep contributing as planned', points: 4 },
        ],
      },
      {
        id: 'drawdown.revealed',
        disposition: 'drawdown',
        framing: 'revealed',
        prompt: 'The last time investments you held fell sharply, what did you actually do?',
        options: [
          { id: 'sold_all', label: 'I sold all or most of it', points: 1 },
          { id: 'held', label: 'I changed nothing', points: 4 },
          { id: 'no_evidence', label: "I haven't held investments through a fall", points: null },
        ],
      },
    ],
    current,
  };
}

export function riskAnswerFixture(
  profile: RiskProfile = riskProfileFixture(),
): AnswerRiskProfileResponse {
  return {
    profile,
    derivation: {
      instrument: 'risk-v1',
      tolerance: profile.tolerance,
      compositeScore: profile.compositeScore,
      unpenalisedScore: profile.unpenalisedScore,
      consistencyPenalty: profile.consistencyPenalty,
      toleranceIfAveraged: 'moderate',
      dispositions: [
        {
          disposition: 'drawdown',
          statedOption: 'hold',
          revealedOption: 'sold_all',
          stated: 4,
          revealed: 1,
          revealedWasNoEvidence: false,
          unpenalised: 3,
          credited: 1,
          penalty: 2,
        },
      ],
      explanation: [
        'You said you would hold through a fall, but you sold the last time one happened; the score follows what you did.',
      ],
    },
  };
}
