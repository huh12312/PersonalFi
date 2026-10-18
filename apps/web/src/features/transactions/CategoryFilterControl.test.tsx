// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  categoriesRoute,
  ensureApiClient,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { CategoryFilterControl } from './CategoryFilterControl.tsx';

function renderControl(value: readonly string[] = []) {
  const onChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CategoryFilterControl value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return { onChange };
}

describe('CategoryFilterControl', () => {
  beforeEach(() => {
    ensureApiClient();
    stubFetchRoutes([categoriesRoute()]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows "Category" until something is selected', () => {
    renderControl();
    expect(screen.getByRole('button', { name: /category/i })).toHaveTextContent('Category');
  });

  it('checking a category calls onChange with its id and shows the label as the summary', async () => {
    const { onChange } = renderControl();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Category' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Coffee Shops' }));

    expect(onChange).toHaveBeenCalledWith(['cat_dining_coffee']);
  });

  it('shows a count once more than one category is selected', () => {
    renderControl(['cat_dining_coffee', 'cat_dining_restaurants']);
    expect(screen.getByRole('button', { name: /2 categories/i })).toBeInTheDocument();
  });

  it('"Clear categories" clears the selection', async () => {
    const { onChange } = renderControl(['cat_dining_coffee']);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Coffee Shops' }));
    await user.click(await screen.findByRole('button', { name: 'Clear categories' }));

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('the search field narrows the checklist to matching categories', async () => {
    renderControl();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Category' }));
    await user.type(await screen.findByLabelText('Search categories'), 'coffee');

    expect(screen.getByRole('checkbox', { name: 'Coffee Shops' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Restaurants')).not.toBeInTheDocument();
  });
});
