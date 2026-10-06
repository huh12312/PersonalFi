// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  textResponse,
} from '../../test-support/api-test-utils.ts';
import { BackupStatusLine } from './BackupStatusLine.tsx';
import {
  describeBackupStatus,
  formatBackupAge,
  isOpsBackupStatus,
  type OpsBackupStatus,
} from './backup-status.ts';

const OK: OpsBackupStatus = {
  lastAttemptStatus: 'ok',
  lastAttemptAt: '2026-10-20T08:00:00.000Z',
  lastSuccessfulBackupAt: '2026-10-20T08:00:00.000Z',
  lastSuccessfulBackupAgeSeconds: 4 * 3600 + 120,
  backupOverdue: false,
  lastDrillVerdict: 'pass',
  lastDrillAt: '2026-10-13T10:00:00.000Z',
  lastDrillAgeDays: 7,
  drillOverdue: false,
};

function renderLine() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <BackupStatusLine />
    </QueryClientProvider>,
  );
}

describe('describeBackupStatus', () => {
  it('reads "Last backup 4 h ago · restore drill passed 2026-10-13" when everything is current', () => {
    expect(describeBackupStatus(OK)).toEqual({
      tone: 'ok',
      text: 'Last backup 4 h ago · restore drill passed 2026-10-13',
      warning: null,
    });
  });

  it('warns past the backup window, past 35 days since a drill, on a failed drill, and with nothing yet', () => {
    expect(describeBackupStatus({ ...OK, backupOverdue: true }).tone).toBe('warning');
    expect(describeBackupStatus({ ...OK, drillOverdue: true, lastDrillAgeDays: 36 }).warning).toBe(
      'restore drill is overdue',
    );
    expect(describeBackupStatus({ ...OK, lastDrillVerdict: 'fail' }).warning).toBe(
      'the last restore drill failed',
    );
    const fresh = describeBackupStatus({
      ...OK,
      lastSuccessfulBackupAgeSeconds: null,
      lastSuccessfulBackupAt: null,
      backupOverdue: true,
      lastDrillVerdict: null,
      lastDrillAt: null,
      lastDrillAgeDays: null,
      drillOverdue: true,
    });
    expect(fresh.tone).toBe('warning');
    expect(fresh.text).toBe('No successful backup yet · no restore drill yet');
  });

  it('formats ages in the unit a person reads', () => {
    expect(formatBackupAge(30)).toBe('just now');
    expect(formatBackupAge(5 * 60)).toBe('5 min ago');
    expect(formatBackupAge(10 * 3600)).toBe('10 h ago');
    expect(formatBackupAge(3 * 86_400)).toBe('3 d ago');
  });

  it('only believes the real shape', () => {
    expect(isOpsBackupStatus(OK)).toBe(true);
    expect(isOpsBackupStatus('<!doctype html>')).toBe(false);
    expect(isOpsBackupStatus({})).toBe(false);
    expect(isOpsBackupStatus(null)).toBe(false);
  });
});

describe('BackupStatusLine', () => {
  beforeEach(() => {
    ensureApiClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the line from GET /ops/backup-status', async () => {
    stubFetchRoutes([
      { match: '/api/ops/backup-status', method: 'GET', handle: () => jsonResponse(OK) },
    ]);
    renderLine();
    const line = await screen.findByText('Last backup 4 h ago · restore drill passed 2026-10-13');
    expect(line).toHaveAttribute('data-tone', 'ok');
  });

  it('turns to a warning, in words, past the windows', async () => {
    stubFetchRoutes([
      {
        match: '/api/ops/backup-status',
        method: 'GET',
        handle: () => jsonResponse({ ...OK, drillOverdue: true, lastDrillAgeDays: 40 }),
      },
    ]);
    renderLine();
    const line = await screen.findByTestId('backup-status-line');
    await vi.waitFor(() => expect(line).toHaveAttribute('data-tone', 'warning'));
    expect(line).toHaveTextContent('Warning:');
    expect(line).toHaveTextContent('restore drill is overdue');
  });

  it('reads "Backup status unknown", quietly, when the route fails', async () => {
    stubFetchRoutes([
      {
        match: '/api/ops/backup-status',
        method: 'GET',
        handle: () => jsonResponse({ code: 'internal' }, 500),
      },
    ]);
    renderLine();
    const line = await screen.findByText('Backup status unknown');
    expect(line).toHaveAttribute('data-tone', 'unknown');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reads unknown, not an error, when the route is not mocked or answers with a page', async () => {
    stubFetchRoutes([
      {
        match: '/api/ops/backup-status',
        method: 'GET',
        handle: () => textResponse('<!doctype html><title>app</title>', 200, 'text/html'),
      },
    ]);
    renderLine();
    expect(await screen.findByText('Backup status unknown')).toBeInTheDocument();
  });
});
