// SPDX-License-Identifier: MIT
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AssumptionsPanel } from './AssumptionsPanel.tsx';
import { assumptionsFileFixture, assumptionsResponse } from './fixtures.ts';

/**
 * `docs/plan/04-phase-4-dispatch.md` §3 "WP 4.10": "every number with its
 * `source` and `as_of` visible without a click — the §5 exit criterion is
 * *'visible, editable, cited'*, and a disclosure that hides the citation
 * behind a chevron satisfies two of three." These tests assert the citation
 * text is in the accessible tree on first render, with no `<details>`,
 * `aria-expanded="false"` disclosure, or click anywhere in the ancestor
 * chain of a cited value.
 */
describe('AssumptionsPanel', () => {
  it("shows every cited number's source and as-of date without any click", () => {
    const { file, overrides, overridablePaths, version } = assumptionsResponse();
    render(
      <AssumptionsPanel
        file={file}
        overrides={overrides}
        overridablePaths={overridablePaths}
        version={version}
        onOverride={vi.fn()}
      />,
    );

    // US equity expected return's citation, from `assumptionsFileFixture()`.
    expect(screen.getByText(/Source: 07 Appendix A §5\.5/)).toBeVisible();
    expect(screen.getByText(/As of 2026-01-01/)).toBeVisible();
    // Social Security wage base's citation.
    expect(screen.getByText(/Source: SSA 2026 COLA notice/)).toBeVisible();

    // No collapsed/disclosure element anywhere in the panel — a `<details>`
    // or an `aria-expanded="false"` control would be exactly the "hides the
    // citation behind a chevron" failure the dispatch calls out.
    expect(document.querySelectorAll('details')).toHaveLength(0);
    expect(screen.queryAllByRole('button', { expanded: false })).toHaveLength(0);
  });

  it('has no citation hidden inside a closed disclosure even before any interaction', () => {
    const { file, overrides, overridablePaths, version } = assumptionsResponse();
    const { container } = render(
      <AssumptionsPanel
        file={file}
        overrides={overrides}
        overridablePaths={overridablePaths}
        version={version}
        onOverride={vi.fn()}
      />,
    );
    // Every `dt`/`dd` pair the component renders is a sibling in the flat
    // flow, not a child of a collapsed container — `offsetParent`-style
    // visibility isn't available in happy-dom, so this asserts structurally:
    // no ancestor of any `dd` carries `hidden` or `aria-hidden="true"`, and
    // — WP 5.14's fix for wp4.10 §9 item 3 — no ancestor is a `<details>`
    // without an `open` attribute. A closed `<details>` hides its content
    // through the browser's own default stylesheet, never through either
    // attribute this test used to check alone, so a citation sabotaged into
    // one read green here even though `toBeVisible()` in the test above
    // (which jest-dom gives `<details>`-specific semantics) correctly went
    // red — reproduced red first against that exact sabotage, confirming the
    // gap, before this ancestor-walk grew the third check.
    const citationNodes = within(container).getAllByText(/^Source: /);
    for (const node of citationNodes) {
      let el: HTMLElement | null = node;
      while (el !== null) {
        expect(el.hasAttribute('hidden')).toBe(false);
        expect(el.getAttribute('aria-hidden')).not.toBe('true');
        expect(
          el.tagName === 'DETAILS' && !el.hasAttribute('open'),
          'a closed <details> hides its content with no hidden/aria-hidden attribute anywhere ' +
            'in this chain — the exact shape this check must catch on its own',
        ).toBe(false);
        el = el.parentElement;
      }
    }
  });

  it('shows an "overridden — default X" badge and lets an overridable value be edited', async () => {
    const user = userEvent.setup();
    const onOverride = vi.fn();
    const file = assumptionsFileFixture();
    render(
      <AssumptionsPanel
        file={file}
        overrides={[
          { path: 'capitalMarket.usEquity.expectedReturn', value: '0.07', default: '0.065' },
        ]}
        overridablePaths={['capitalMarket.usEquity.expectedReturn']}
        version="assumptions-1"
        onOverride={onOverride}
      />,
    );

    expect(
      screen.getByTestId('assumption-overridden-capitalMarket.usEquity.expectedReturn'),
    ).toHaveTextContent('overridden — default 0.065');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByLabelText(/Override Capital market/);
    await user.clear(input);
    await user.type(input, '0.08');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onOverride).toHaveBeenCalledWith('capitalMarket.usEquity.expectedReturn', '0.08');
  });

  it('renders no edit control at all for a non-overridable (tax-law) figure', () => {
    const { file, overrides, version } = assumptionsResponse();
    render(
      <AssumptionsPanel
        file={file}
        overrides={overrides}
        overridablePaths={[]}
        version={version}
        onOverride={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});
