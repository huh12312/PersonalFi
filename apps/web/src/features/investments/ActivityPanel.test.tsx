// SPDX-License-Identifier: MIT
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { InvestmentActivityAccount } from '../../api/generated/types.gen.ts';
import { ActivityPanel, trimDecimal, type ActivityPanelProps } from './ActivityPanel.tsx';
import { activityFixture, usd } from './fixtures.ts';

const ACCOUNTS = [
  { id: 'acct-brokerage', name: 'Northwind Brokerage' },
  { id: 'acct-401k', name: 'Plaid 401k' },
];
const NAMES = new Map(ACCOUNTS.map((account) => [account.id, account.name]));

function synced(accountId: string, name: string): InvestmentActivityAccount {
  return { accountId, name, provider: 'plaid', activitySync: 'synced', lastSyncedAt: null };
}
function pending(accountId: string, name: string): InvestmentActivityAccount {
  return { accountId, name, provider: 'plaid', activitySync: 'pending', lastSyncedAt: null };
}

function renderPanel(overrides: Partial<ActivityPanelProps> = {}) {
  const onFiltersChange = vi.fn();
  const onLoadMore = vi.fn();
  render(
    <ActivityPanel
      filters={{ from: '2025-10-14', to: '2026-10-13' }}
      onFiltersChange={onFiltersChange}
      accounts={ACCOUNTS}
      accountNameOf={(id) => NAMES.get(id) ?? id}
      items={[]}
      syncStates={[synced('acct-brokerage', 'Northwind Brokerage')]}
      total={0}
      isLoading={false}
      hasNextPage={false}
      isFetchingNextPage={false}
      onLoadMore={onLoadMore}
      {...overrides}
    />,
  );
  return { onFiltersChange, onLoadMore };
}

const FIXTURE_ITEMS = [
  activityFixture({
    id: 'a5',
    tradeDate: '2026-06-01',
    kind: 'fee',
    type: 'FEE',
    subtype: 'account fee',
    name: 'ANNUAL ACCOUNT FEE',
    security: null,
    quantity: '0.000000000000000000',
    price: null,
    amount: usd('-2000'),
    fees: usd('2000'),
  }),
  activityFixture({
    id: 'a4',
    tradeDate: '2026-05-31',
    kind: 'contribution',
    type: 'CASH',
    subtype: 'contribution',
    name: 'ACH CONTRIBUTION',
    security: null,
    quantity: '0.000000000000000000',
    price: null,
    amount: usd('100000'),
    flow: usd('100000'),
  }),
  activityFixture({
    id: 'a3',
    tradeDate: '2026-05-30',
    kind: 'dividend',
    type: 'DIVIDEND',
    subtype: 'dividend',
    name: 'DIVIDEND VTI',
    quantity: '0.000000000000000000',
    price: null,
    amount: usd('4118'),
  }),
  activityFixture({ id: 'a1' }),
];

describe('ActivityPanel (WP 10.3)', () => {
  it('lists each movement with its type, security, quantity, price, signed amount and source', () => {
    renderPanel({ items: FIXTURE_ITEMS, total: 4 });

    const rows = screen.getAllByTestId('activity-row');
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual([
      'fee',
      'contribution',
      'dividend',
      'buy',
    ]);
    const buy = rows[3] as HTMLElement;
    expect(within(buy).getByText('Buy')).toBeInTheDocument();
    expect(within(buy).getByText('VTI')).toBeInTheDocument();
    expect(within(buy).getByText('5')).toBeInTheDocument();
    expect(within(buy).getByText('268.4')).toBeInTheDocument();
    expect(within(buy).getByText('Broker')).toBeInTheDocument();
    const contribution = rows[1] as HTMLElement;
    expect(within(contribution).getByText('Contribution / transfer in')).toBeInTheDocument();
    // No security: the provider's own description stands in.
    expect(within(contribution).getByText('ACH CONTRIBUTION')).toBeInTheDocument();
    expect(contribution).toHaveTextContent('+$1,000.00');
    // The fee's provider word is shown beside the type, as evidence.
    expect(within(rows[0] as HTMLElement).getByText('account fee')).toBeInTheDocument();
    expect(screen.getByTestId('activity-count')).toHaveTextContent('Showing 4 of 4');
  });

  it('a 401(k) contribution that arrives as a buy shows the money that came in, not the cash the buy spent', () => {
    renderPanel({
      items: [
        activityFixture({
          kind: 'contribution',
          type: 'BUY',
          subtype: 'contribution',
          amount: usd('-46865'),
          flow: usd('46865'),
        }),
      ],
      total: 1,
    });
    expect(screen.getByTestId('activity-row')).toHaveTextContent('+$468.65');
  });

  it('sets tabular figures on every numeric column', () => {
    renderPanel({ items: FIXTURE_ITEMS, total: 4 });
    for (const row of screen.getAllByTestId('activity-row')) {
      const cells = row.querySelectorAll('td');
      // Quantity, price, amount: columns 5–7.
      for (const index of [4, 5, 6]) {
        expect(cells[index]?.className, `column ${String(index + 1)}`).toMatch(/\btabular-nums\b/u);
      }
      // The date is a <time>, which carries the class itself (DateOnlyText).
      expect(cells[0]?.querySelector('time')?.className).toMatch(/\btabular-nums\b/u);
    }
  });

  it('an account whose activity has never synced says a sync is pending — not "no activity"', () => {
    renderPanel({ syncStates: [pending('acct-401k', 'Plaid 401k')] });
    expect(screen.getByRole('heading', { name: 'Investment activity has not synced yet' }));
    expect(screen.getByText(/sync is pending for Plaid 401k/u)).toBeInTheDocument();
    expect(screen.queryByText('No investment activity in this period')).not.toBeInTheDocument();
  });

  it('an empty period with every account synced says "No investment activity in this period"', () => {
    renderPanel();
    expect(
      screen.getByRole('heading', { name: 'No investment activity in this period' }),
    ).toBeInTheDocument();
  });

  it('with one account pending and one synced, names the pending one beside the list', () => {
    renderPanel({
      items: FIXTURE_ITEMS,
      syncStates: [
        synced('acct-brokerage', 'Northwind Brokerage'),
        pending('acct-401k', 'Plaid 401k'),
      ],
    });
    expect(screen.getByTestId('activity-pending')).toHaveTextContent(
      'Investment activity for Plaid 401k has not synced yet',
    );
  });

  it('filters by account and by type through labelled controls', async () => {
    const user = userEvent.setup();
    const { onFiltersChange } = renderPanel();
    await user.selectOptions(screen.getByLabelText('Account'), 'acct-401k');
    expect(onFiltersChange).toHaveBeenLastCalledWith({ account: 'acct-401k' });
    await user.selectOptions(screen.getByLabelText('Type'), 'dividend');
    expect(onFiltersChange).toHaveBeenLastCalledWith({ kind: 'dividend' });
    await user.selectOptions(screen.getByLabelText('Type'), '');
    expect(onFiltersChange).toHaveBeenLastCalledWith({ kind: undefined });
    expect(screen.getByLabelText('From')).toHaveValue('2025-10-14');
    expect(screen.getByLabelText('To')).toHaveValue('2026-10-13');
  });

  it('offers "Load more" only when there is a next page', async () => {
    const user = userEvent.setup();
    const { onLoadMore } = renderPanel({ items: FIXTURE_ITEMS, total: 9, hasNextPage: true });
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('trims NUMERIC padding without rounding', () => {
    expect(trimDecimal('5.000000000000000000')).toBe('5');
    expect(trimDecimal('268.4000000000')).toBe('268.4');
    expect(trimDecimal('-2.000000000000000000')).toBe('-2');
    expect(trimDecimal('0.000000000000000001')).toBe('0.000000000000000001');
    expect(trimDecimal('12')).toBe('12');
  });
});
