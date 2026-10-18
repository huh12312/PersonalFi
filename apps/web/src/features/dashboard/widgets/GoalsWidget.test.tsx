// SPDX-License-Identifier: MIT
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Account, Goal } from '../../../api/generated/types.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../../test-support/api-test-utils.ts';
import { renderWidget } from '../test-utils.tsx';
import { account, goal } from './fixtures.ts';
import { goalProgress } from './goal-progress.ts';
import { GoalsWidget } from './GoalsWidget.tsx';

function serve(goals: Goal[], accounts: Account[]) {
  stubFetchRoutes([
    { match: '/api/goals', method: 'GET', handle: () => jsonResponse({ goals }) },
    { match: '/api/accounts', method: 'GET', handle: () => jsonResponse({ accounts }) },
  ]);
}

describe('goalProgress (WP 10.9: planning’s funded rule)', () => {
  it('sums the positive balances of asset funding accounts; a shared account counts for neither goal', () => {
    const progress = goalProgress(
      [
        goal({
          id: 'g1',
          name: 'Emergency fund',
          fundedFromAccountIds: ['sav', 'shared'],
          priority: 1,
        }),
        goal({ id: 'g2', name: 'Car', fundedFromAccountIds: ['shared', 'neg'], priority: 2 }),
      ],
      [account('sav', 250_000), account('shared', 999_999), account('neg', -5_000)],
    );
    expect(progress[0]).toMatchObject({ kind: 'measured', sharedAccounts: 1 });
    expect(progress[0]?.kind === 'measured' && progress[0].funded.minor).toBe(250_000n);
    expect(progress[0]?.kind === 'measured' && progress[0].ratio).toBeCloseTo(0.25);
    expect(progress[1]?.kind === 'measured' && progress[1].funded.minor).toBe(0n);
  });

  it('a liability adds nothing; no funding account, another currency and no balance are said, not measured', () => {
    const progress = goalProgress(
      [
        goal({ id: 'a', name: 'A', fundedFromAccountIds: [] }),
        goal({ id: 'b', name: 'B', fundedFromAccountIds: ['eur'] }),
        goal({ id: 'c', name: 'C', fundedFromAccountIds: ['unseen'] }),
        goal({ id: 'd', name: 'D', fundedFromAccountIds: ['card'] }),
      ],
      [
        account('eur', 10_000, {
          currency: 'EUR',
          balance: {
            current: { minor: '10000', currency: 'EUR' },
            available: null,
            limit: null,
            asOf: '2026-03-17T00:00:00Z',
            source: 'provider',
          },
        }),
        account('unseen', null),
        account('card', -50_000, { classification: 'liability', type: 'credit' }),
      ],
    );
    expect(
      progress.map((entry) => (entry.kind === 'unmeasured' ? entry.reason : 'measured')),
    ).toEqual(['no_funding_account', 'currency_mismatch', 'no_balance', 'no_balance']);
  });

  it('leaves out paused, achieved and retirement goals', () => {
    const progress = goalProgress(
      [
        goal({ id: 'p', name: 'Paused', status: 'paused' }),
        goal({ id: 'r', name: 'Retire', kind: 'retirement' }),
        goal({ id: 'x', name: 'Done', status: 'achieved' }),
      ],
      [],
    );
    expect(progress).toEqual([]);
  });
});

describe('GoalsWidget (WP 10.9)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('populated: a meter and "$X of $Y" per goal; an unmeasured goal says why instead of a 0 %', async () => {
    serve(
      [
        goal({ id: 'g1', name: 'Emergency fund', fundedFromAccountIds: ['sav'] }),
        goal({
          id: 'g2',
          name: 'Sabbatical',
          kind: 'sabbatical',
          fundedFromAccountIds: [],
          priority: 2,
        }),
      ],
      [account('sav', 250_000)],
    );
    renderWidget(<GoalsWidget />);
    const first = (await screen.findByText('Emergency fund')).closest('[data-goal-progress]')!;
    expect(first.getAttribute('data-goal-progress')).toBe('measured');
    expect(within(first as HTMLElement).getByRole('meter')).toHaveAttribute('aria-valuenow', '25');
    expect(first.textContent).toMatch(/\$2,500\.00.* of .*\$10,000\.00/u);
    const second = screen.getByText('Sabbatical').closest('[data-goal-progress]')!;
    expect(second.getAttribute('data-goal-progress')).toBe('unmeasured');
    expect(second.textContent).toContain('No account funds this goal yet');
    expect(within(second as HTMLElement).queryByRole('meter')).toBeNull();
  });

  it('empty: no active goal links to the screen that adds one', async () => {
    serve([], []);
    renderWidget(<GoalsWidget />);
    expect(await screen.findByTestId('widget-empty')).toHaveTextContent('No active goals yet.');
    expect(screen.getByRole('link', { name: 'Add a goal' })).toHaveAttribute('href', '/goals');
  });

  it('only a retirement goal: measured by the plan, said so', async () => {
    serve([goal({ id: 'r', name: 'Retire', kind: 'retirement' })], []);
    renderWidget(<GoalsWidget />);
    expect(await screen.findByTestId('widget-empty')).toHaveTextContent('measured by your plan');
  });
});
