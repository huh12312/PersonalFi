// SPDX-License-Identifier: MIT
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { projectionResponse } from './fixtures.ts';
import { PlanHeadline } from './PlanHeadline.tsx';
import type { ProjectionRun, RunPlanProjectionResponse } from '../../api/generated/types.gen.ts';

function deterministic(overrides: Partial<ProjectionRun> = {}): RunPlanProjectionResponse {
  const base = projectionResponse();
  return {
    ...base,
    run: {
      ...(base.run as ProjectionRun),
      method: 'deterministic',
      paths: 1,
      successProbability: '1',
      ...overrides,
    },
  };
}

describe('PlanHeadline', () => {
  it('says "Projecting your plan…" only while the projection is on its way', () => {
    render(<PlanHeadline loading failed={false} projection={undefined} />);
    expect(screen.getByTestId('plan-headline')).toHaveTextContent('Projecting your plan…');
  });

  it('never says it for an error, which gets its own sentence', () => {
    render(<PlanHeadline loading={false} failed projection={undefined} />);
    const headline = screen.getByTestId('plan-headline');
    expect(headline).not.toHaveTextContent('Projecting your plan');
    expect(headline).toHaveTextContent('could not be projected');
  });

  it('quotes a Monte Carlo run as a share of simulated paths', () => {
    render(<PlanHeadline loading={false} failed={false} projection={projectionResponse()} />);
    expect(screen.getByTestId('plan-headline-probability')).toHaveTextContent('82%');
    expect(screen.getByTestId('plan-headline')).toHaveTextContent(/of simulated paths succeed/);
  });

  it('never phrases a deterministic run as a probability', () => {
    render(<PlanHeadline loading={false} failed={false} projection={deterministic()} />);
    const headline = screen.getByTestId('plan-headline');
    expect(headline).toHaveTextContent('lasts to the end of the plan');
    expect(headline.textContent).not.toMatch(
      /%|percent|probab|chance|likel|of (simulated )?(plans|paths)/i,
    );
    expect(screen.queryByTestId('plan-headline-probability')).not.toBeInTheDocument();
  });

  it('says a one-path run that fails runs out of money, still without a figure', () => {
    render(
      <PlanHeadline
        loading={false}
        failed={false}
        projection={deterministic({ successProbability: '0' })}
      />,
    );
    expect(screen.getByTestId('plan-headline-outcome')).toHaveTextContent(
      'runs out of money before the plan ends',
    );
  });

  it('labels a stale run before saying anything about it', () => {
    render(
      <PlanHeadline
        loading={false}
        failed={false}
        projection={{
          ...projectionResponse(),
          status: 'stale',
          staleness: {
            reason: 'assumptions_changed',
            assumptionsVersion: 'a-0',
            currentVersion: 'a-1',
          },
        }}
      />,
    );
    expect(screen.getByTestId('plan-headline').textContent?.startsWith('Out of date')).toBe(true);
  });

  it('says there is nothing stored when a stale answer carries no run', () => {
    render(
      <PlanHeadline
        loading={false}
        failed={false}
        projection={{
          status: 'stale',
          run: null,
          percentiles: [],
          staleness: {
            reason: 'assumptions_version_retired',
            assumptionsVersion: 'a-0',
            known: ['a-1'],
          },
        }}
      />,
    );
    expect(screen.getByTestId('plan-headline')).toHaveTextContent('no stored projection');
  });
});
