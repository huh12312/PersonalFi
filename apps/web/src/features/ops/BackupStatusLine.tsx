// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';

import { client } from '../../api/generated/client.gen.ts';
import {
  describeBackupStatus,
  isOpsBackupStatus,
  STATUS_UNKNOWN,
  type BackupLine,
  type OpsBackupStatus,
} from './backup-status.ts';

/** `GET /ops/backup-status`, session-guarded and install-wide (apps/api/src/routes/ops.ts). */
export function useBackupStatusQuery() {
  return useQuery({
    queryKey: ['ops', 'backup-status'],
    queryFn: async ({ signal }): Promise<OpsBackupStatus> => {
      const result = await client.get<{ 200: OpsBackupStatus }, unknown, true>({
        url: '/ops/backup-status',
        signal,
        throwOnError: true,
      });
      if (!isOpsBackupStatus(result.data)) throw new Error('unexpected /ops/backup-status shape');
      return result.data;
    },
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * One quiet line on the dashboard: "Last backup 4 h ago · restore drill passed
 * 2026-10-13". Past the backup staleness window, or 35 days since a drill (or a
 * failed drill), it adds a warning in words beside an icon. When the route
 * fails -- or is not mocked, or returns something that is not the shape -- it
 * reads "Backup status unknown" in the muted style: never an error screen,
 * never a blocked dashboard, and never a green line it did not earn.
 */
export function BackupStatusLine() {
  const query = useBackupStatusQuery();
  const line: BackupLine = query.isLoading
    ? { tone: 'unknown', text: 'Checking backups…', warning: null }
    : query.isError || query.data === undefined
      ? STATUS_UNKNOWN
      : describeBackupStatus(query.data);

  if (line.tone === 'warning') {
    return (
      <p
        data-testid="backup-status-line"
        data-tone="warning"
        className="flex flex-wrap items-center gap-x-2 text-small text-status-warning-text"
      >
        <AlertTriangle size={14} aria-hidden="true" />
        <span className="font-medium">Warning:</span>
        <span>{line.warning}</span>
        <span className="text-text-secondary">· {line.text}</span>
      </p>
    );
  }

  return (
    <p
      data-testid="backup-status-line"
      data-tone={line.tone}
      className="text-small text-text-secondary"
    >
      {line.text}
    </p>
  );
}
