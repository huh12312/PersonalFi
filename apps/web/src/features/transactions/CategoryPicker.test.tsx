// SPDX-License-Identifier: MIT
/**
 * `CategoryPicker` over `GET /categories` (gate condition D-6) and
 * `POST /categories` (WP 2.5's carry-over route, this WP's combobox).
 *
 * The defect the original suite guarded against was not a rendering bug: the
 * picker was *correct*, and offered one option, because there was no route to
 * ask. WP 2.11 replaces the native `<select>` with a Base UI combobox
 * (searchable, grouped, keyboard-accessible); these tests assert the same
 * guarantees the `<select>` version pinned — every assignable category
 * reachable and selectable, emitting the real id, a heading never selectable,
 * an unresolvable value never silently dropped — against the combobox's own
 * ARIA shape (`role="combobox"` input, `role="listbox"` popup, `role="option"`
 * items, `role="group"` per heading).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
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

async function openCombobox(user: ReturnType<typeof userEvent.setup>): Promise<HTMLInputElement> {
  const input = (await screen.findByRole('combobox', { name: 'Category' })) as HTMLInputElement;
  await user.click(input);
  await screen.findByRole('listbox');
  return input;
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
    const user = userEvent.setup();

    await openCombobox(user);

    // Headings become group labels, which are not options. Asserted as "no
    // option carries the heading's name" rather than "the label is absent" —
    // the label is very much present, as a group's accessible name.
    expect(screen.queryByRole('option', { name: 'Dining' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Transfers · transfer' })).not.toBeInTheDocument();

    // Every assignable category the server sent is reachable as an option,
    // plus the synthetic "Uncategorized" row standing in for `null`.
    const assignable = TEST_CATEGORIES.filter((category) => category.assignable);
    const optionNames = screen.getAllByRole('option').map((option) => option.textContent);
    expect(optionNames).toEqual(['Uncategorized', ...assignable.map((category) => category.label)]);

    // Grouped parent → children, in the server's order.
    const diningGroup = screen.getByRole('group', { name: 'Dining' });
    expect(
      within(diningGroup)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Restaurants', 'Coffee Shops']);
    const transfersGroup = screen.getByRole('group', { name: 'Transfers · transfer' });
    expect(
      within(transfersGroup)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Internal Transfer']);

    // `uncategorised` is top-level and childless in the real taxonomy, so it
    // sits in a headless group and must still be offered.
    expect(screen.getByRole('option', { name: 'Uncategorised' })).toBeInTheDocument();
  });

  it('emits the category id the API assigned, not a label or a key', async () => {
    stubFetchRoutes([categoriesRoute()]);
    const { onChange } = renderPicker();
    const user = userEvent.setup();

    await openCombobox(user);
    await user.click(await screen.findByRole('option', { name: 'Coffee Shops' }));

    expect(onChange).toHaveBeenCalledWith('cat_dining_coffee');
  });

  it('clears to null when Uncategorized is chosen', async () => {
    stubFetchRoutes([categoriesRoute()]);
    const { onChange } = renderPicker({ value: 'cat_dining_coffee' });
    const user = userEvent.setup();

    await openCombobox(user);
    await user.click(screen.getByRole('option', { name: 'Uncategorized' }));

    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('keeps a value the list does not contain rather than silently clearing it', async () => {
    // An archived category, or a list that has not arrived. Snapping the
    // field to "Uncategorized" would mean the next selection silently clears
    // an assignment the user never touched.
    stubFetchRoutes([categoriesRoute()]);
    renderPicker({ value: 'cat_archived_but_assigned' });

    const input = await screen.findByRole('combobox', { name: 'Category' });
    await waitFor(() => expect(input).toHaveValue('Current category'));
  });

  it('degrades to the null option when the categories request fails', async () => {
    stubFetchRoutes([
      {
        match: '/api/categories',
        handle: () => new Response('{}', { status: 503 }),
      },
    ]);
    renderPicker();
    const user = userEvent.setup();

    const input = await screen.findByRole('combobox', { name: 'Category' });
    await waitFor(() => expect(input).toHaveValue('Uncategorized'));
    // Still usable and still enabled: a failed list must not make the field
    // look read-only.
    expect(input).not.toBeDisabled();

    await user.click(input);
    await screen.findByRole('listbox');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Uncategorized' })).toBeInTheDocument();
  });
});
