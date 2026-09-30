// SPDX-License-Identifier: MIT
/**
 * `retirementEffectOf` (05-phase-5-dispatch.md §3 WP 5.6): the retirement
 * effect is only ever `RetirementImpactPort`'s answer, over a fake port — no
 * database, no engine. `apps/api/test/db/brief-retirement-port.test.ts`
 * proves the bound port reproduces a direct engine run for the same plan
 * exactly; this file proves the Brief never computes or invents a figure of
 * its own around it.
 */
import { Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import type { BriefCandidate } from '../src/brief/candidate.ts';
import {
  NO_DOLLAR_FIGURE_ANSWER,
  RETIREMENT_EFFECT_ASSUMPTION,
  type RetirementImpactAnswer,
  type RetirementImpactPort,
  type RetirementImpactRequest,
} from '../src/brief/ports.ts';
import { retirementEffectOf } from '../src/brief/retirement.ts';

const USD = 'USD';

function candidate(overrides: Partial<BriefCandidate> = {}): BriefCandidate {
  return {
    insightId: 'insight-1',
    advisorId: 'builtin.spending.fee_hunter',
    key: 'spending.fee_hunter.a',
    type: 'spending.fee_hunter',
    severity: 'notable',
    title: 'A finding',
    summaryMd: 'A summary.',
    confidence: 1,
    horizon: 'this_year',
    annualizedImpact: overrides.annualizedImpact !== undefined ? overrides.annualizedImpact : null,
    oneTimeImpact: overrides.oneTimeImpact !== undefined ? overrides.oneTimeImpact : null,
    actionKinds: ['suggest_only'],
    evidence: [
      {
        position: 0,
        kind: 'metric',
        label: 'Amount',
        value: '1',
        sourceRef: 'snapshot:cash_summary.as_of',
        resolvedDisplay: null,
        href: null,
      },
    ],
    inputDigest: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  };
}

/** A fake `RetirementImpactPort` that records every call and answers a fixed value. */
function fakePort(answer: RetirementImpactAnswer): {
  readonly port: RetirementImpactPort;
  readonly calls: RetirementImpactRequest[];
} {
  const calls: RetirementImpactRequest[] = [];
  return {
    calls,
    port: {
      async effectOf(request) {
        calls.push(request);
        return answer;
      },
    },
  };
}

const COMPUTED_ANSWER: RetirementImpactAnswer = Object.freeze({
  kind: 'computed' as const,
  engineVersion: 'engine-test-1',
  assumptionsVersion: 'sha256:' + 'b'.repeat(64),
  plannedRetirementAge: 65,
  baseline: { kind: 'earliest' as const, age: 64, engineRuns: 5 },
  withAction: { kind: 'earliest' as const, age: 63, engineRuns: 5 },
  yearsEarlier: 1,
  monthsOfSpending: {
    months: 14,
    atAge: 65,
    wealthDifference: Money.of(500_000n, USD),
    firstYearSpending: Money.of(4_000_000n, USD),
    derivation: 'test derivation',
  },
  assumption: RETIREMENT_EFFECT_ASSUMPTION,
});

describe('retirementEffectOf', () => {
  it("a retirement effect is only ever the port's answer: an item without one says not computable and shows no figure", async () => {
    const { port, calls } = fakePort(COMPUTED_ANSWER);

    // An item with a dollar figure: the effect is the port's answer,
    // verbatim -- nothing here re-derives or adjusts it.
    const withImpact = candidate({ annualizedImpact: Money.of(70_000n, USD) });
    const effect = await retirementEffectOf(port, 'user-1')(withImpact);
    expect(effect).toEqual(COMPUTED_ANSWER);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      userId: 'user-1',
      action: { kind: 'extra_annual', annual: Money.of(70_000n, USD) },
    });

    // An item claiming no figure at all: not_computable, no figure — and the
    // port is never even asked, so there is no code path that could answer
    // one for it.
    const withoutImpact = candidate({ annualizedImpact: null, oneTimeImpact: null });
    const noFigureEffect = await retirementEffectOf(port, 'user-1')(withoutImpact);
    expect(noFigureEffect).toEqual(NO_DOLLAR_FIGURE_ANSWER);
    expect(noFigureEffect.kind).toBe('not_computable');
    if (noFigureEffect.kind === 'not_computable') {
      expect(noFigureEffect.reason).toBe('no_dollar_figure');
    }
    expect('engineVersion' in noFigureEffect).toBe(false);
    expect(calls).toHaveLength(1); // still one -- the second call never reached the port
  });
});
