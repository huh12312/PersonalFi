// SPDX-License-Identifier: MIT
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ProjectionRun, ProjectionStaleness } from '../../api/generated/types.gen.ts';
import { projectionResponse } from './fixtures.ts';
import { StaleRunNotice, staleWords } from './StaleRunNotice.tsx';

const RUN: ProjectionRun = {
  ...(projectionResponse().run as ProjectionRun),
  assumptionsVersion: 'a-0',
};

const ARMS: Record<ProjectionStaleness['reason'], ProjectionStaleness> = {
  assumptions_version_retired: {
    reason: 'assumptions_version_retired',
    assumptionsVersion: 'a-0',
    known: ['a-1', 'a-2'],
  },
  assumptions_changed: {
    reason: 'assumptions_changed',
    assumptionsVersion: 'a-0',
    currentVersion: 'a-1',
  },
  account_overrides_changed: {
    reason: 'account_overrides_changed',
    changes: [{ accountId: 'acct', field: 'role', from: null, to: 'savings' }],
  },
};

describe('StaleRunNotice', () => {
  it.each(Object.values(ARMS))('says so and names the version for the $reason arm', (staleness) => {
    render(<StaleRunNotice status="stale" staleness={staleness} run={RUN} />);
    const notice = screen.getByTestId('plan-run-stale');
    expect(notice).toHaveAttribute('data-staleness', staleness.reason);
    expect(notice).toHaveTextContent('out of date');
    expect(notice).toHaveTextContent('a-0');
  });

  it('names both versions when the assumptions changed, and lists the versions a retired run could move to', () => {
    expect(staleWords(ARMS.assumptions_changed, RUN).body).toContain('a-1');
    expect(staleWords(ARMS.assumptions_version_retired, RUN).body).toContain('a-1, a-2');
  });

  it('points at the account-settings notice instead of repeating its list', () => {
    const words = staleWords(ARMS.account_overrides_changed, RUN);
    expect(words.body).toContain('notice above');
    expect(words.body).not.toContain('acct');
  });

  it('says there is nothing stored when the answer is stale with no run', () => {
    render(
      <StaleRunNotice status="stale" staleness={ARMS.assumptions_version_retired} run={null} />,
    );
    expect(screen.getByTestId('plan-run-stale')).toHaveTextContent('no stored result');
  });

  it('is absent for a current run, and generic for a stale status with no reason', () => {
    const { rerender } = render(<StaleRunNotice status="computed" staleness={null} run={RUN} />);
    expect(screen.queryByTestId('plan-run-stale')).not.toBeInTheDocument();
    rerender(<StaleRunNotice status="stale" staleness={null} run={RUN} />);
    expect(screen.getByTestId('plan-run-stale')).toHaveAttribute('data-staleness', 'unspecified');
  });
});
