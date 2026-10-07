// SPDX-License-Identifier: MIT
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ProjectionProblem } from './ProjectionProblem.tsx';
import { PROBLEM_WORDS } from './problem-words.ts';

describe('ProjectionProblem', () => {
  it('renders the sentence for a code, with the server detail, code and reference beneath it', () => {
    render(
      <ProjectionProblem
        error={{
          code: 'planning.projection_no_balances',
          status: 409,
          detail: 'no sealed net-worth day exists yet',
          correlationId: 'corr-9',
        }}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-problem-words', 'table');
    expect(alert).toHaveTextContent(PROBLEM_WORDS['planning.projection_no_balances']!.headline);
    expect(alert).toHaveTextContent('no sealed net-worth day exists yet');
    expect(alert).toHaveTextContent('planning.projection_no_balances');
    expect(alert).toHaveTextContent('corr-9');
    // A refusal is not a thing a retry can change.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('says it is the fallback for a code the table does not have', () => {
    render(<ProjectionProblem error={{ code: 'planning.brand_new', status: 409 }} />);
    expect(screen.getByRole('alert')).toHaveAttribute('data-problem-words', 'fallback');
  });

  it('offers a retry for a server fault, and calls it', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <ProjectionProblem
        error={{ code: 'planning.montecarlo_timeout', status: 503 }}
        onRetry={onRetry}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('never renders the spinner sentence', () => {
    render(<ProjectionProblem error={new TypeError('Failed to fetch')} />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('Projecting your plan');
  });
});
