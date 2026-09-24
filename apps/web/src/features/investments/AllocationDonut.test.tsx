// SPDX-License-Identifier: MIT
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

// The committed spreadsheet fixture, pulled into the bundle as text at
// transform time: `packages/contexts/investments/test/fixtures/allocation-expected.csv`,
// WP 3.3's independently-computed ground truth.
//
// Reading the real file rather than re-typing its numbers is the point: if
// somebody changes the fixture, this test changes with it, and if somebody
// changes the UI's rendering of a value the test goes red against a file this
// work package does not own.
//
// Vite's `?raw` rather than `node:fs`: `apps/web`'s `tsconfig.app.json` sets
// `"types": ["vite/client"]` and deliberately does not pull in `@types/node`,
// so a `readFileSync` here would not typecheck. `?raw` is `vite/client`'s own
// declared module and needs no new type.
import EXPECTED_CSV from '../../../../../packages/contexts/investments/test/fixtures/allocation-expected.csv?raw';

import { AllocationDonut } from './AllocationDonut.tsx';
import { allocationResponse } from './fixtures.ts';

interface ExpectedRow {
  readonly basis: string;
  readonly dimension: string;
  readonly key: string;
  readonly value: string;
  readonly weight: string;
}

function readExpected(): ExpectedRow[] {
  return EXPECTED_CSV.split('\n')
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('basis,'))
    .map((line) => {
      const [basis, dimension, key, value, weight] = line.split(',');
      return {
        basis: basis ?? '',
        dimension: dimension ?? '',
        key: key ?? '',
        value: value ?? '',
        weight: weight ?? '',
      };
    });
}

function asCurrency(value: string): string {
  return `$${Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

describe('AllocationDonut', () => {
  it('renders every slice of the committed spreadsheet fixture at its expected value', () => {
    const report = allocationResponse().byAssetClass;
    render(<AllocationDonut dimension="asset_class" report={report} />);

    const expected = readExpected().filter(
      (row) => row.basis === 'last_known' && row.dimension === 'asset_class',
    );
    expect(expected.length).toBeGreaterThan(0);

    for (const row of expected) {
      const slice = screen.getByTestId(`allocation-slice-${row.key}`);
      expect(within(slice).getByTestId('slice-value')).toHaveTextContent(asCurrency(row.value));
    }
  });

  it('draws one arc per slice and one texture per arc, so hue is never the only signal', () => {
    const report = allocationResponse().byAssetClass;
    const { container } = render(<AllocationDonut dimension="asset_class" report={report} />);

    const arcs = container.querySelectorAll('svg > g > path');
    expect(arcs).toHaveLength(report.slices.length);

    // Every arc is filled with a `<pattern>`, not a flat colour: the pattern
    // carries both the CVD-safe hue and a texture, which is D20's "colour
    // plus a pattern or a label" as a structural property rather than a
    // stylesheet convention.
    for (const arc of arcs) {
      expect(arc.getAttribute('fill')).toMatch(/^url\(#alloc-[A-Za-z0-9-]+-\d+\)$/);
    }
    const patterns = container.querySelectorAll('pattern');
    expect(patterns.length).toBe(8);
  });

  it('labels every slice in the legend, so the chart reads without colour at all', () => {
    const report = allocationResponse().byAssetClass;
    render(<AllocationDonut dimension="asset_class" report={report} />);

    const legend = screen.getByTestId('allocation-legend');
    expect(within(legend).getByText('US equity')).toBeInTheDocument();
    expect(within(legend).getByText('Unclassified')).toBeInTheDocument();
    // `weight` of US_EQUITY in the fixture is 0.4323001299 → 43%.
    const usEquity = within(legend).getByTestId('allocation-slice-US_EQUITY');
    expect(within(usEquity).getByTestId('slice-weight')).toHaveTextContent('43%');
  });
});
