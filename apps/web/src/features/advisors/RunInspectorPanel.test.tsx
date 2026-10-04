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
import { RunInspectorPanel } from './RunInspectorPanel.tsx';

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RunInspectorPanel advisorId="local.narrator" />
    </QueryClientProvider>,
  );
}

function runSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run_1',
    advisorId: 'local.narrator',
    advisorVersion: '1.0.0',
    trigger: 'manual',
    status: 'completed',
    refusal: null,
    inputDigest: 'sha256:digest1',
    grantedScopes: ['cash.summary'],
    emittedScopes: ['cash.summary'],
    proposedCount: 2,
    acceptedCount: 1,
    rejectedCount: 1,
    errorCode: null,
    durationMs: 1200,
    startedAt: '2026-06-01T00:00:00.000Z',
    finishedAt: '2026-06-01T00:01:00.000Z',
    cancelRequestedAt: null,
    cancelReason: null,
    llmModel: 'qwen2.5:7b-instruct-q4_K_M',
    llmPromptHash: 'sha256:prompt1',
    ...overrides,
  };
}

describe('RunInspectorPanel', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the input digest and marks a verified payload only when digestVerified is true', async () => {
    const run = runSummary();
    stubFetchRoutes([
      {
        match: '/api/advisors/local.narrator/runs',
        method: 'GET',
        handle: () => jsonResponse({ runs: [run] }),
      },
      {
        match: '/api/advisors/runs/run_1',
        method: 'GET',
        handle: () =>
          jsonResponse({
            run,
            rejections: [],
            payload: {
              queryShape: 'sha256:shape1',
              recordedDigest: 'sha256:digest1',
              recomputedDigest: 'sha256:digest1',
              digestVerified: true,
              payload: { messages: [] },
              expiresAt: '2026-07-01T00:00:00.000Z',
            },
          }),
      },
    ]);

    renderPanel();

    expect(await screen.findByTestId('input-digest')).toHaveTextContent('sha256:digest1');
    const mark = await screen.findByTestId('verified-mark');
    expect(mark).toHaveTextContent('Verified');
  });

  it('never shows a verified mark when digestVerified is false — a tampered payload is named, not hidden', async () => {
    const run = runSummary();
    stubFetchRoutes([
      {
        match: '/api/advisors/local.narrator/runs',
        method: 'GET',
        handle: () => jsonResponse({ runs: [run] }),
      },
      {
        match: '/api/advisors/runs/run_1',
        method: 'GET',
        handle: () =>
          jsonResponse({
            run,
            rejections: [],
            payload: {
              queryShape: 'sha256:shape1',
              recordedDigest: 'sha256:digest1',
              recomputedDigest: 'sha256:other',
              digestVerified: false,
              payload: { messages: [] },
              expiresAt: '2026-07-01T00:00:00.000Z',
            },
          }),
      },
    ]);

    renderPanel();

    const mark = await screen.findByTestId('verified-mark');
    expect(mark).toHaveTextContent('Not verified');
    expect(mark).not.toHaveTextContent('Verified —');
  });

  it('a run with no retained payload says so honestly — never a verified mark with nothing behind it', async () => {
    const run = runSummary();
    stubFetchRoutes([
      {
        match: '/api/advisors/local.narrator/runs',
        method: 'GET',
        handle: () => jsonResponse({ runs: [run] }),
      },
      {
        match: '/api/advisors/runs/run_1',
        method: 'GET',
        handle: () => jsonResponse({ run, rejections: [], payload: null }),
      },
    ]);

    renderPanel();

    expect(await screen.findByTestId('no-payload-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('verified-mark')).not.toBeInTheDocument();
  });

  it('cancel is offered on an in-flight run and calls POST /advisors/runs/{runId}/cancel', async () => {
    const run = runSummary({ status: 'started', finishedAt: null });
    let cancelled = false;
    stubFetchRoutes([
      {
        match: '/api/advisors/local.narrator/runs',
        method: 'GET',
        handle: () => jsonResponse({ runs: [run] }),
      },
      {
        match: '/api/advisors/runs/run_1',
        method: 'GET',
        handle: () => jsonResponse({ run, rejections: [], payload: null }),
      },
      {
        match: '/api/advisors/runs/run_1/cancel',
        method: 'POST',
        handle: () => {
          cancelled = true;
          return jsonResponse({ runId: 'run_1', outcome: 'requested' });
        },
      },
    ]);

    renderPanel();
    const user = userEvent.setup();

    const cancelButton = await screen.findByTestId('cancel-run-button');
    await user.click(cancelButton);

    expect(cancelled).toBe(true);
  });

  it('cancel is never offered on a run that already finished', async () => {
    const run = runSummary({ status: 'completed' });
    stubFetchRoutes([
      {
        match: '/api/advisors/local.narrator/runs',
        method: 'GET',
        handle: () => jsonResponse({ runs: [run] }),
      },
      {
        match: '/api/advisors/runs/run_1',
        method: 'GET',
        handle: () => jsonResponse({ run, rejections: [], payload: null }),
      },
    ]);

    renderPanel();

    // Waits for the loaded detail content itself (the `data-testid="run-
    // detail"` wrapper renders unconditionally the instant a run is
    // selected, before its query resolves — a skeleton first, this once
    // the fetch completes), not merely the wrapper, so this assertion can't
    // pass by accident on a still-loading panel.
    await screen.findByText(
      'No payload retained for this run (nothing retained for this kind, or its 30-day retention window has passed).',
    );
    expect(screen.queryByTestId('cancel-run-button')).not.toBeInTheDocument();
  });

  it('a cancelled run names the broadest level that applied', async () => {
    const run = runSummary({ status: 'cancelled', cancelReason: 'kind_disabled' });
    stubFetchRoutes([
      {
        match: '/api/advisors/local.narrator/runs',
        method: 'GET',
        handle: () => jsonResponse({ runs: [run] }),
      },
      {
        match: '/api/advisors/runs/run_1',
        method: 'GET',
        handle: () => jsonResponse({ run, rejections: [], payload: null }),
      },
    ]);

    renderPanel();

    expect(await screen.findByTestId('cancellation-level')).toHaveTextContent('Level 2 (kind)');
  });

  it('renders per-step rejections when the run has any', async () => {
    const run = runSummary();
    stubFetchRoutes([
      {
        match: '/api/advisors/local.narrator/runs',
        method: 'GET',
        handle: () => jsonResponse({ runs: [run] }),
      },
      {
        match: '/api/advisors/runs/run_1',
        method: 'GET',
        handle: () =>
          jsonResponse({
            run,
            rejections: [{ step: 'numerals', code: 'figure_not_traceable', findingKey: 'f_1' }],
            payload: null,
          }),
      },
    ]);

    renderPanel();

    const rejections = await screen.findByTestId('rejections');
    expect(rejections).toHaveTextContent('figure_not_traceable');
  });
});
