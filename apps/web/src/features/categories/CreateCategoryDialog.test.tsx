// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Category } from '../../api/generated/types.gen.ts';
import {
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { CreateCategoryDialog } from './CreateCategoryDialog.tsx';

const GROCERIES: Category = {
  id: '01930000-0000-7000-8000-000000000001',
  key: 'groceries.supermarkets',
  parentId: null,
  label: 'Supermarkets',
  description: '',
  kind: 'expense',
  icon: 'shopping-basket',
  hue: 'teal',
  variability: null,
  emoji: null,
  sort: 0,
  isSystem: true,
  archivedAt: null,
  assignable: true,
};

function setup(category: Category = GROCERIES) {
  const bodies: unknown[] = [];
  stubFetchRoutes([
    categoriesRoute(),
    {
      method: 'GET',
      match: '/api/categories/variability-suggestions',
      handle: () => jsonResponse({ suggestions: [] }),
    },
    {
      method: 'PATCH',
      match: /^\/api\/categories\/[^/]+$/u,
      handle: async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return jsonResponse({ category: { ...category, ...body } });
      },
    },
  ]);
  const onOpenChange = vi.fn();
  const onSaved = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CreateCategoryDialog
        open
        onOpenChange={onOpenChange}
        initialLabel=""
        headings={[]}
        category={category}
        onSaved={onSaved}
      />
    </QueryClientProvider>,
  );
  return { bodies, onOpenChange, onSaved };
}

beforeEach(() => ensureApiClient());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the category editor (WP 10.14)', () => {
  it('names every swatch by its hue, marks the current one, and saves a new hue alone', async () => {
    const user = userEvent.setup();
    const { bodies, onSaved } = setup();
    const swatches = screen.getByRole('radiogroup', { name: 'Colour' });
    const teal = screen.getByRole('radio', { name: 'Teal' });
    expect(teal).toHaveAttribute('aria-checked', 'true');
    expect(swatches.querySelectorAll('[role="radio"]')).toHaveLength(13);
    // One Tab stop: the checked swatch; the arrows move and select.
    await user.click(teal);
    expect(teal).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    const green = screen.getByRole('radio', { name: 'Green' });
    expect(green).toHaveAttribute('aria-checked', 'true');
    expect(green).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // The displayed default (🛒) was never chosen, so it is never written.
    expect(bodies).toEqual([{ hue: 'green' }]);
  });

  it('refuses a typed value that is not one emoji, and saves one that is', async () => {
    const user = userEvent.setup();
    const { bodies } = setup();
    const field = screen.getByLabelText('Or type one emoji');
    await user.type(field, 'ab');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter exactly one emoji');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await user.clear(field);
    await user.type(field, '🥑');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(bodies).toEqual([{ emoji: '🥑' }]));
  });

  it('picks from the grid, and "Use default" clears a stored emoji to null', async () => {
    const user = userEvent.setup();
    const { bodies } = setup({ ...GROCERIES, emoji: '🥑' });
    const grid = screen.getByRole('radiogroup', { name: 'Icon' });
    expect(grid.querySelector('[aria-checked="true"]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Use default' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(bodies).toEqual([{ emoji: null }]));
  });

  it('sends the variability through the budget screen’s own control, as a form value', async () => {
    const user = userEvent.setup();
    const { bodies } = setup();
    await user.click(screen.getByRole('button', { name: 'Flexible' }));
    expect(screen.getByRole('button', { name: 'Flexible' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(bodies).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(bodies).toEqual([{ variability: 'flexible' }]));
  });

  it('closes without a request when nothing changed', async () => {
    const user = userEvent.setup();
    const { bodies, onOpenChange } = setup();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(bodies).toEqual([]);
  });
});
