// SPDX-License-Identifier: MIT
/**
 * `CategoryPicker` over `GET /categories` — the UI half of gate condition D-6.
 *
 * The defect these tests exist against was not a rendering bug: the picker was
 * *correct*, and offered one option, because there was no route to ask. So the
 * assertions here are about what a user can now reach — every assignable
 * category, under its parent, selectable, emitting the real id — and about the
 * two ways that can silently regress: a heading becoming selectable (money would
 * land on a grouping), and a value the list does not contain being dropped on
 * the floor (a blur would clear a real assignment).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TEST_CATEGORIES,
  categoriesRoute,
  ensureApiClient,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { CategoryPicker } from './CategoryPicker.tsx';

function renderPicker(props: Partial<Parameters<typeof CategoryPicker>[0]> = {}) {
  const onChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CategoryPicker value={null} onChange={onChange} {...props} />
    </QueryClientProvider>,
  );
  return { onChange };
}

function select(): HTMLSelectElement {
  return screen.getByLabelText('Category') as HTMLSelectElement;
}

describe('CategoryPicker', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('groups children under their parent and never offers a heading', async () => {
    stubFetchRoutes([categoriesRoute()]);
    renderPicker();

    await screen.findByRole('option', { name: 'Restaurants' });

    // Headings become `<optgroup>` labels, which are not values. Asserted as
    // "no option carries the heading's id" rather than "the label is absent",
    // because the label is very much present — as a group.
    const values = [...select().querySelectorAll('option')].map((option) => option.value);
    expect(values).not.toContain('cat_dining');
    expect(values).not.toContain('cat_transfers');

    // Every assignable category the server sent is reachable, and the empty
    // string — "Uncategorized" — is the null option.
    const assignable = TEST_CATEGORIES.filter((category) => category.assignable);
    expect(values).toEqual(['', ...assignable.map((category) => category.id)]);
    expect(screen.getByRole('option', { name: 'Uncategorized' })).toHaveValue('');

    // Grouped parent → children, in the server's order.
    const groups = [...select().querySelectorAll('optgroup')];
    expect(groups.map((group) => group.label)).toEqual(['Dining', 'Transfers · transfer']);
    expect([...groups[0]!.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Restaurants',
      'Coffee Shops',
    ]);

    // The kind rides on the option, where a test and a Phase 2 feature can read
    // it — a `<option>` renders as plain text, so a badge would not survive.
    expect(screen.getByRole('option', { name: 'Internal Transfer' })).toHaveAttribute(
      'data-kind',
      'transfer',
    );

    // `uncategorised` is top-level and childless in the real taxonomy, so it has
    // no heading to sit under and must still be offered.
    expect(screen.getByRole('option', { name: 'Uncategorised' })).toHaveValue('cat_uncategorised');
  });

  it('emits the category id the API assigned, not a label or a key', async () => {
    stubFetchRoutes([categoriesRoute()]);
    const { onChange } = renderPicker();
    const user = userEvent.setup();

    await screen.findByRole('option', { name: 'Coffee Shops' });
    await user.selectOptions(select(), 'cat_dining_coffee');

    expect(onChange).toHaveBeenCalledWith('cat_dining_coffee');
  });

  it('clears to null when Uncategorized is chosen', async () => {
    stubFetchRoutes([categoriesRoute()]);
    const { onChange } = renderPicker({ value: 'cat_dining_coffee' });
    const user = userEvent.setup();

    await screen.findByRole('option', { name: 'Coffee Shops' });
    await user.selectOptions(select(), '');

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('keeps a value the list does not contain rather than silently clearing it', async () => {
    // An archived category, or a list that has not arrived. A `<select>` whose
    // `value` matches no option renders as the first one — "Uncategorized" — and
    // the next change event would write that back, clearing an assignment the
    // user never touched.
    stubFetchRoutes([categoriesRoute()]);
    renderPicker({ value: 'cat_archived_but_assigned' });

    await screen.findByRole('option', { name: 'Coffee Shops' });
    expect(select().value).toBe('cat_archived_but_assigned');
  });

  it('degrades to the null option when the categories request fails', async () => {
    stubFetchRoutes([
      {
        match: '/api/categories',
        handle: () => new Response('{}', { status: 503 }),
      },
    ]);
    renderPicker();

    await waitFor(() => {
      expect(select().querySelectorAll('option')).toHaveLength(1);
    });
    // Still usable and still enabled: a failed list must not make the field look
    // read-only.
    expect(select()).not.toBeDisabled();
  });
});
