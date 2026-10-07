// SPDX-License-Identifier: MIT
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ChartDataTable } from './ChartDataTable.tsx';

describe('ChartDataTable (09 §5.6)', () => {
  it('is closed until asked, then holds every row with real headers', async () => {
    render(
      <ChartDataTable
        caption="Net worth over time"
        columns={['Date', 'Value']}
        rows={[
          ['Sep 1', '$1,000.00'],
          ['Sep 2', '$1,250.00'],
        ]}
      />,
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /View as table/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await userEvent.setup().click(toggle);
    const table = screen.getByRole('table', { name: 'Net worth over time' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Date', 'Value']);
    const second = within(table).getByRole('row', { name: /Sep 2/ });
    expect(within(second).getByRole('rowheader')).toHaveTextContent('Sep 2');
    expect(within(second).getByRole('cell')).toHaveTextContent('$1,250.00');
  });
});
