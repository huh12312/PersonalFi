// SPDX-License-Identifier: MIT
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PerformancePanel } from './PerformancePanel.tsx';
import { byManagementResponse, performanceResponse, summaryFixture, usd } from './fixtures.ts';

const ACCOUNTS = [
  { id: 'acct-ira', name: 'Advised IRA' },
  { id: 'acct-brokerage', name: 'My Brokerage' },
];

/** A dollar figure, as `Money` renders one. */
const DOLLAR = /\$\d/u;
const PERCENT = /\d%/u;

describe('PerformancePanel (WP 10.3)', () => {
  it('the health snapshot holds the dollars and no rate; the TWR beside it holds no dollar figure', () => {
    render(<PerformancePanel data={performanceResponse()} isLoading={false} />);
    const dollars = screen.getByTestId('health-dollars');
    expect(dollars).toHaveTextContent('Net contributions');
    expect(dollars).toHaveTextContent('+$18,000.00');
    expect(dollars).toHaveTextContent('Dividends and interest');
    expect(dollars).toHaveTextContent('$3,124.55');
    expect(dollars).toHaveTextContent('Fees paid');
    expect(dollars).toHaveTextContent('Gain over the period');
    expect(dollars.textContent).not.toMatch(PERCENT);

    const twr = screen.getByTestId('health-twr');
    expect(twr).toHaveTextContent('Time-weighted return');
    expect(twr.textContent).toMatch(PERCENT);
    expect(twr.textContent).not.toMatch(DOLLAR);
  });

  it('states the annualization status: withheld under a year', () => {
    const data = performanceResponse();
    render(
      <PerformancePanel
        data={{
          ...data,
          timeWeighted: {
            ...data.timeWeighted,
            annualized: null,
            annualizationWithheld: 'period_under_one_year',
          },
        }}
        isLoading={false}
      />,
    );
    expect(screen.getByTestId('health-twr-annualized')).toHaveTextContent(
      'Not annualized: period_under_one_year',
    );
  });

  it('names what it left out, rather than counting it as zero', () => {
    render(
      <PerformancePanel
        data={performanceResponse({
          summary: summaryFixture({
            complete: false,
            exclusions: {
              unpricedSecurities: [{ securityId: 's1', symbol: 'ODDCO', name: 'Odd Co' }],
              foreignCurrencyMovements: ['m1'],
              unvaluedTransfers: ['m2'],
              unclassifiedMovements: ['m3', 'm4'],
            },
          }),
        })}
        isLoading={false}
      />,
    );
    const exclusions = screen.getByTestId('health-exclusions');
    expect(exclusions).toHaveTextContent('Left out, no price: ODDCO.');
    expect(exclusions).toHaveTextContent('1 movement(s) in another currency');
    expect(exclusions).toHaveTextContent('1 transfer(s) could not be valued');
    expect(exclusions).toHaveTextContent('2 cash movement(s) could not be classified');
  });

  it('by management: TWRs side by side in one table, MWRs and dollars in two others — no row carries a rate and a dollar', () => {
    render(
      <PerformancePanel
        data={performanceResponse()}
        isLoading={false}
        scope="management"
        onScopeChange={vi.fn()}
        accounts={ACCOUNTS}
        byManagement={byManagementResponse()}
      />,
    );
    const twrRows = within(screen.getByTestId('management-twr-table')).getAllByRole('row').slice(1);
    expect(twrRows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'Advisor',
      'Robo-advisor',
      'Self-directed',
    ]);
    for (const row of twrRows) {
      expect(row.textContent).toMatch(PERCENT);
      expect(row.textContent, 'a TWR row carries no dollar figure').not.toMatch(DOLLAR);
    }
    expect(twrRows[2]).toHaveTextContent('+14%');

    const mwrRows = within(screen.getByTestId('management-mwr-table')).getAllByRole('row').slice(1);
    for (const row of mwrRows) expect(row.textContent).not.toMatch(DOLLAR);

    const dollarRows = within(screen.getByTestId('management-dollars-table'))
      .getAllByRole('row')
      .slice(1);
    expect(dollarRows).toHaveLength(3);
    for (const row of dollarRows) {
      expect(row.textContent).toMatch(DOLLAR);
      expect(row.textContent, 'a dollar row carries no rate').not.toMatch(PERCENT);
    }
    // The single-scope blocks are not shown in the comparison.
    expect(screen.queryByTestId('performance-rates')).not.toBeInTheDocument();
  });

  it('the scope selector offers the whole portfolio, by management, and one account', async () => {
    const user = userEvent.setup();
    const onScopeChange = vi.fn();
    render(
      <PerformancePanel
        data={performanceResponse()}
        isLoading={false}
        onScopeChange={onScopeChange}
        accounts={ACCOUNTS}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Whole portfolio' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'By management' }));
    expect(onScopeChange).toHaveBeenLastCalledWith('management', undefined);
    await user.click(screen.getByRole('radio', { name: 'One account' }));
    expect(onScopeChange).toHaveBeenLastCalledWith('account', 'acct-ira');
  });

  it('one account: the account picker names it, and the snapshot is labelled with it', async () => {
    const user = userEvent.setup();
    const onScopeChange = vi.fn();
    render(
      <PerformancePanel
        data={performanceResponse({ summary: summaryFixture({ closingValue: usd('100') }) })}
        isLoading={false}
        scope="account"
        scopeAccount="acct-brokerage"
        onScopeChange={onScopeChange}
        accounts={ACCOUNTS}
      />,
    );
    expect(screen.getByTestId('health-dollars')).toHaveTextContent(
      'Health snapshot · My Brokerage',
    );
    await user.selectOptions(screen.getByLabelText('Account'), 'acct-ira');
    expect(onScopeChange).toHaveBeenLastCalledWith('account', 'acct-ira');
    expect(screen.getByTestId('performance-rates')).toBeInTheDocument();
  });
});
