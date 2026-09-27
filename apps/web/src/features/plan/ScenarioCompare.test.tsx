// SPDX-License-Identifier: MIT
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ScenarioCompare } from './ScenarioCompare.tsx';
import { baselineScenario, compareResponse, forkScenario } from './fixtures.ts';

describe('ScenarioCompare', () => {
  it('renders two scenarios side by side with the success-probability delta and the retirement-date delta', () => {
    const scenarios = [baselineScenario(), forkScenario()];
    render(
      <ScenarioCompare
        scenarios={scenarios}
        a="scenario-baseline"
        b="scenario-fork-retire-early"
        onChangeA={vi.fn()}
        onChangeB={vi.fn()}
        compare={compareResponse()}
        isLoading={false}
      />,
    );

    expect(within(screen.getByTestId('compare-a')).getByText('Baseline')).toBeInTheDocument();
    expect(within(screen.getByTestId('compare-b')).getByText('Retire at 62')).toBeInTheDocument();

    // `successProbability` 0.82 vs 0.74 → StatTile in each column.
    expect(within(screen.getByTestId('compare-a')).getByText('82%')).toBeInTheDocument();
    expect(within(screen.getByTestId('compare-b')).getByText('74%')).toBeInTheDocument();

    const delta = screen.getByTestId('compare-delta');
    expect(within(delta).getByText(/Δ success probability/)).toBeInTheDocument();
    expect(within(delta).getByText(/-8%|−8%/)).toBeInTheDocument();
    expect(within(delta).getByText(/Δ retirement date/)).toBeInTheDocument();
    expect(within(delta).getByText(/36 months earlier/)).toBeInTheDocument();
  });

  it('lets the reader change either scenario dropdown, deferring to the caller', async () => {
    const user = userEvent.setup();
    const onChangeA = vi.fn();
    render(
      <ScenarioCompare
        scenarios={[baselineScenario(), forkScenario()]}
        a={undefined}
        b={undefined}
        onChangeA={onChangeA}
        onChangeB={vi.fn()}
        compare={undefined}
        isLoading={false}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Scenario A'), 'scenario-baseline');
    expect(onChangeA).toHaveBeenCalledWith('scenario-baseline');
  });

  it('warns rather than compares when the same scenario is chosen twice', () => {
    render(
      <ScenarioCompare
        scenarios={[baselineScenario(), forkScenario()]}
        a="scenario-baseline"
        b="scenario-baseline"
        onChangeA={vi.fn()}
        onChangeB={vi.fn()}
        compare={undefined}
        isLoading={false}
      />,
    );
    expect(screen.getByText('Choose two different scenarios to compare.')).toBeInTheDocument();
  });
});
