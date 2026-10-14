// SPDX-License-Identifier: MIT
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AccountPositionsPanel } from './AccountPositionsPanel.tsx';
import { ActivityPanel } from './ActivityPanel.tsx';
import { HoldingsTable } from './HoldingsTable.tsx';
import type { BasisMethodElection } from './api.ts';
import {
  accountHoldingsResponse,
  activityFixture,
  SPREADSHEET_HOLDINGS,
  unresolvedSecurity,
  usd,
} from './fixtures.ts';
import { excludedItemLabel, exclusionReasonLabel } from './labels.ts';

/**
 * WP 10.4: a position whose security nobody could identify is a named row - in the holdings table, in its
 * account's panel - and a movement in one keeps its name in Activity, each with "Could not identify this
 * security". Chris's IRA showed nothing anywhere before this: every position in it was unidentified.
 */

const NAMES = new Map([
  ['acct-taxable', 'Taxable brokerage'],
  ['acct-ira', 'Traditional IRA'],
]);
const nameOf = (id: string): string => NAMES.get(id) ?? id;

const IRA_ROW = unresolvedSecurity({ accountId: 'acct-ira' });

const ELECTION: BasisMethodElection = {
  submit: vi.fn(async () => undefined),
  pendingSecurityId: null,
  attemptedSecurityId: null,
  refusal: null,
  stepUpError: null,
};

function renderTable(holdings = SPREADSHEET_HOLDINGS, unresolved = [IRA_ROW]) {
  render(
    <HoldingsTable
      holdings={holdings}
      unresolved={unresolved}
      accountHoldings={new Map()}
      accountNameOf={nameOf}
      onOpenAccount={vi.fn()}
    />,
  );
}

describe('unresolved positions on the Holdings tab (WP 10.4)', () => {
  it('lists an unidentified position as a named row with its ticker, name, quantity and the marker', () => {
    renderTable();
    const row = screen.getByTestId(`unresolved-row-${IRA_ROW.id}`);
    const header = within(row).getByRole('rowheader');
    expect(header).toHaveTextContent('VFIFX');
    expect(header).toHaveTextContent('Vanguard Target Retirement 2050 Fund');
    expect(header).toHaveTextContent('Traditional IRA');
    expect(within(row).getByTestId('unresolved-marker')).toHaveTextContent(
      'Could not identify this security',
    );
    // Quantity, trimmed: the wire's 18-place decimal is not what a person reads.
    expect(within(row).getAllByRole('cell')[0]).toHaveTextContent(/^12\.5$/u);
  });

  it("shows the institution's value labelled as the institution's figure, and no price, basis, gain or weight", () => {
    renderTable();
    const row = screen.getByTestId(`unresolved-row-${IRA_ROW.id}`);
    const figure = within(row).getByTestId('institution-figure');
    expect(figure).toHaveTextContent('$2,140.33');
    expect(figure).toHaveTextContent("(institution's figure)");
    // Price, cost basis, unrealized and weight: a dash to the eye, "not available" to a screen reader.
    const cells = within(row).getAllByRole('cell');
    for (const index of [1, 3, 4, 5]) {
      expect(cells[index]).toHaveTextContent('—not available');
      expect(cells[index]).not.toHaveTextContent('$');
      expect(cells[index]).not.toHaveTextContent('0.00');
    }
  });

  it('says plainly when the institution reported no value', () => {
    renderTable(SPREADSHEET_HOLDINGS, [unresolvedSecurity({ institutionValue: null })]);
    expect(screen.getByTestId('institution-figure')).toHaveTextContent(
      'the institution reported no value',
    );
  });

  it('gives the reasons in plain words, behind a disclosure', async () => {
    renderTable();
    const user = userEvent.setup();
    const row = screen.getByTestId(`unresolved-row-${IRA_ROW.id}`);
    const summary = within(row).getByText('Why it could not be identified');
    await user.click(summary);
    expect(within(row).getByText(/A ticker alone can name more than one security/u)).toBeVisible();
  });

  it('an account whose every position is unidentified shows them, not "No holdings yet"', () => {
    renderTable([], [IRA_ROW]);
    expect(screen.queryByText('No holdings yet')).not.toBeInTheDocument();
    expect(screen.getByTestId(`unresolved-row-${IRA_ROW.id}`)).toHaveTextContent('VFIFX');
  });

  it('with nothing unidentified, adds no rows', () => {
    renderTable(SPREADSHEET_HOLDINGS, []);
    expect(screen.queryByTestId('unresolved-marker')).not.toBeInTheDocument();
  });
});

describe("an account's panel (WP 10.4)", () => {
  it("lists that account's unidentified positions as cards with the marker and the institution's figure", () => {
    render(
      <AccountPositionsPanel
        accountName="Traditional IRA"
        data={accountHoldingsResponse({
          accountId: 'acct-ira',
          positions: [],
          unresolved: [IRA_ROW],
        })}
        isLoading={false}
        securityTypeOf={() => undefined}
        election={ELECTION}
        onBack={vi.fn()}
      />,
    );
    expect(screen.queryByText('No positions in this account')).not.toBeInTheDocument();
    const card = screen.getByTestId(`unresolved-position-${IRA_ROW.id}`);
    expect(within(card).getByRole('heading', { level: 3 })).toHaveTextContent('VFIFX');
    expect(card).toHaveTextContent('Could not identify this security');
    expect(card).toHaveTextContent('12.5 units');
    const figure = within(card).getByTestId('institution-figure');
    expect(figure).toHaveTextContent('$2,140.33');
    expect(figure).toHaveTextContent("(institution's figure)");
    expect(screen.getByText(/\+ 1 not identified/u)).toBeInTheDocument();
  });
});

describe('Activity keeps the movements of an unidentified security (WP 10.4)', () => {
  it('lists the movement under the provider name and ticker, with the marker; an identified one has none', () => {
    render(
      <ActivityPanel
        filters={{ from: '2025-10-14', to: '2026-10-13' }}
        onFiltersChange={vi.fn()}
        accounts={[{ id: 'acct-ira', name: 'Traditional IRA' }]}
        accountNameOf={nameOf}
        items={[
          activityFixture({
            id: 'u1',
            accountId: 'acct-ira',
            kind: 'contribution',
            type: 'BUY',
            subtype: 'contribution',
            name: 'PAYROLL CONTRIBUTION VFIFX',
            security: null,
            unresolvedSecurity: { name: 'Vanguard Target Retirement 2050 Fund', symbol: 'VFIFX' },
            quantity: '2.000000000000000000',
            price: '171.2200000000',
            amount: usd('-34244'),
            flow: usd('34244'),
          }),
          activityFixture({ id: 'v1' }),
        ]}
        syncStates={[]}
        total={2}
        isLoading={false}
        hasNextPage={false}
        isFetchingNextPage={false}
        onLoadMore={vi.fn()}
      />,
    );
    const [unresolvedRow, identifiedRow] = screen.getAllByTestId('activity-row');
    expect(unresolvedRow).toHaveTextContent('VFIFX');
    expect(unresolvedRow).toHaveTextContent('Vanguard Target Retirement 2050 Fund');
    expect(within(unresolvedRow as HTMLElement).getByTestId('unresolved-marker')).toHaveTextContent(
      'Could not identify this security',
    );
    expect(
      within(identifiedRow as HTMLElement).queryByTestId('unresolved-marker'),
    ).not.toBeInTheDocument();
  });
});

describe('excluded reasons in words (WP 10.4)', () => {
  it('names security_unresolved, and never shows a row id for an unnamed one', () => {
    expect(exclusionReasonLabel('security_unresolved')).toBe(
      'the security could not be identified',
    );
    expect(
      excludedItemLabel({ holdingId: 'row-1', symbol: 'VFIFX', reason: 'security_unresolved' }),
    ).toBe('VFIFX');
    expect(
      excludedItemLabel({ holdingId: 'row-1', symbol: null, reason: 'security_unresolved' }),
    ).toBe('An unnamed position');
  });
});
