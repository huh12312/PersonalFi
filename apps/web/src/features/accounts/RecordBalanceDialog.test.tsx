// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Account } from '../../api/generated/types.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { RecordBalanceDialog } from './RecordBalanceDialog.tsx';
import { DEFAULT_OVERLAY } from './fixtures.ts';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
}));

const ACCOUNT: Account = {
  id: 'acct_1',
  connectionId: null,
  provider: 'manual',
  name: 'Cash envelope',
  officialName: null,
  type: 'depository',
  subtype: null,
  classification: 'asset',
  currency: 'USD',
  mask: null,
  closedAt: null,
  includeInNetWorth: true,
  balance: null,
  overlay: DEFAULT_OVERLAY,
};

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <RecordBalanceDialog account={ACCOUNT} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('RecordBalanceDialog', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('records a balance through the step-up ceremony, in bigint minor units', async () => {
    let recordedBody: unknown = null;
    stubFetchRoutes([
      { match: '/api/auth/step-up/options', handle: () => jsonResponse({ options: {} }) },
      {
        match: '/api/auth/step-up/verify',
        handle: () => jsonResponse({ freshUntil: new Date(Date.now() + 300_000).toISOString() }),
      },
      {
        match: '/api/accounts/acct_1/balance',
        method: 'POST',
        handle: async ({ request }) => {
          recordedBody = await request.json();
          return jsonResponse({ account: ACCOUNT, recorded: true });
        },
      },
    ]);

    const { onOpenChange } = renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/current balance/i), '142.50');
    await user.click(screen.getByRole('button', { name: 'Save balance' }));

    await waitFor(() =>
      expect(recordedBody).toEqual({ current: { minor: '14250', currency: 'USD' } }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
