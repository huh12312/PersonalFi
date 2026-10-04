// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { AdvisorManagementScreen } from './AdvisorManagementScreen.tsx';

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AdvisorManagementScreen />
    </QueryClientProvider>,
  );
}

function advisor(overrides: Record<string, unknown> = {}) {
  return {
    advisorId: 'builtin.cash.low_balance',
    displayName: 'Low balance warning',
    kind: 'builtin',
    version: '1.0.0',
    enabled: true,
    quarantinedAt: null,
    quarantineReason: null,
    consecutiveFailures: 0,
    lastRunAt: '2026-06-01T00:00:00.000Z',
    grantedScopes: ['cash.summary'],
    lastRunStatus: 'completed',
    lastRunRejected: 0,
    ...overrides,
  };
}

function scopesRoute(advisorId: string) {
  return {
    match: `/api/advisors/${advisorId}/scopes`,
    method: 'GET',
    handle: () => jsonResponse({ advisorId, kind: 'builtin', scopes: [] }),
  };
}

function previewRoute(advisorId: string) {
  return {
    match: `/api/advisors/${advisorId}/payload-preview`,
    method: 'GET',
    handle: () =>
      jsonResponse({
        advisorId,
        kind: 'builtin',
        queryShape: 'sha256:shape',
        scopes: [],
        promptTemplateHash: null,
        request: {
          contract_version: 1,
          request_id: 'req_1',
          advisor_id: advisorId,
          advisor_version: '1.0.0',
          kind: 'builtin',
          generated_at: '2026-06-01T00:00:00.000Z',
          base_currency: 'USD',
          time_zone: 'UTC',
          today: '2026-06-01',
          granted_scopes: [],
          input_digest: 'sha256:digest',
          limits: {
            max_insights: 5,
            max_response_bytes: 65536,
            deadline: '2026-06-01T00:03:00.000Z',
          },
          snapshot: {},
        },
        prompt: null,
        approvalRequired: false,
        approved: false,
      }),
  };
}

function runsRoute(advisorId: string) {
  return {
    match: `/api/advisors/${advisorId}/runs`,
    method: 'GET',
    handle: () => jsonResponse({ runs: [] }),
  };
}

describe('AdvisorManagementScreen', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the kind switch is shown only when a local_model advisor is registered', async () => {
    stubFetchRoutes([
      {
        match: '/api/advisors',
        method: 'GET',
        handle: () => jsonResponse({ advisors: [advisor()] }),
      },
    ]);

    renderScreen();

    await screen.findByText('Low balance warning');
    expect(screen.queryByTestId('kind-switch')).not.toBeInTheDocument();
  });

  it('shows the kind switch when a local_model advisor exists, and every kill level in words on expand', async () => {
    const narrator = advisor({
      advisorId: 'local.narrator',
      displayName: 'Local narrator',
      kind: 'local_model',
      lastRunStatus: null,
    });
    stubFetchRoutes([
      {
        match: '/api/advisors',
        method: 'GET',
        handle: () => jsonResponse({ advisors: [narrator] }),
      },
      scopesRoute('local.narrator'),
      previewRoute('local.narrator'),
      runsRoute('local.narrator'),
    ]);

    renderScreen();
    const user = userEvent.setup();

    await screen.findByText('Local narrator');
    expect(screen.getByTestId('kind-switch')).toBeInTheDocument();
    expect(screen.getByTestId('module-level-note')).toHaveTextContent('Level 1');

    await user.click(screen.getByRole('button', { name: 'Show detail' }));

    const region = await screen.findByRole('region', { name: 'Local narrator detail' });
    expect(region).toHaveTextContent('Level 2 — Kind: the advisors.kind.local_model flag');
    expect(region).toHaveTextContent('Level 3 — Advisor: enabled');
    expect(region).toHaveTextContent('Level 4 — Run: no run has started yet');
  });

  it('lists the catalogue gaps', async () => {
    stubFetchRoutes([
      { match: '/api/advisors', method: 'GET', handle: () => jsonResponse({ advisors: [] }) },
    ]);

    renderScreen();

    expect(await screen.findByText('Not yet available')).toBeInTheDocument();
  });
});
