// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import {
  describeEngine,
  describeRunSource,
  ENGINES,
  isProbabilistic,
  SINGLE_PATH_OUTCOME_WORDS,
  singlePathOutcome,
} from './engine.ts';
import { projectionResponse } from './fixtures.ts';
import type { ProjectionRun } from '../../api/generated/types.gen.ts';

const run = (overrides: Partial<ProjectionRun>): ProjectionRun => ({
  ...(projectionResponse().run as ProjectionRun),
  ...overrides,
});

describe('engine descriptions', () => {
  it('phrases Monte Carlo as a probability and a deterministic path as a single path', () => {
    expect(ENGINES.monte_carlo.phrasing).toBe('probability');
    expect(ENGINES.deterministic.phrasing).toBe('single_path');
    expect(isProbabilistic(run({ method: 'monte_carlo' }))).toBe(true);
    expect(isProbabilistic(run({ method: 'deterministic' }))).toBe(false);
  });

  it('never phrases a method it does not know as a probability', () => {
    const unknown = describeEngine('historical_cycles');
    expect(unknown.phrasing).toBe('single_path');
    expect(unknown.name).toMatch(/does not recognise/);
    expect(describeEngine(undefined).heading).toBe('Projection');
  });

  it('reads a one-path run as lasting or running out, and refuses to classify anything else', () => {
    expect(singlePathOutcome({ successProbability: '1' })).toBe('lasts');
    expect(singlePathOutcome({ successProbability: '0' })).toBe('runs_out');
    expect(singlePathOutcome({ successProbability: '0.5' })).toBe('unclassified');
    for (const words of Object.values(SINGLE_PATH_OUTCOME_WORDS)) {
      expect(words).not.toMatch(/%|percent|probab|chance|likel/i);
    }
  });

  it('names the engine, the size, the versions and the sealed day on one line', () => {
    expect(describeRunSource(run({ method: 'monte_carlo', paths: 10_000 }))).toBe(
      'Monte Carlo simulation, 10,000 simulated paths. Assumptions version assumptions-1, engine engine-1. Starting balances from 2026-09-23 (a sealed day).',
    );
    const single = describeRunSource(
      run({ method: 'deterministic', paths: 1, balancesSealed: false }),
    );
    expect(single).toContain('a single path');
    expect(single).toContain('an open day, not sealed');
    expect(single).not.toMatch(/%|percent|probab|chance|likel/i);
  });
});
