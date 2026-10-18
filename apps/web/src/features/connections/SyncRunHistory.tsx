// SPDX-License-Identifier: MIT
import { Badge } from '../../components/ui/badge.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { formatDateOnly } from '../../lib/date.ts';
import { describeErrorKind } from './connection-health.ts';
import { useSyncRunsQuery } from './useConnections.ts';
import type { SyncRun } from '../../api/generated/types.gen.ts';

const STATUS_VARIANT: Record<SyncRun['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  running: 'neutral',
  success: 'success',
  partial: 'warning',
  failed: 'danger',
};

/** `GET /connections/{id}/sync-runs` — every attempt, including ones that failed before page one (wp1.5-api.md §1). */
export function SyncRunHistory({ connectionId }: { connectionId: string }) {
  const runsQuery = useSyncRunsQuery(connectionId);

  if (runsQuery.isLoading) {
    return (
      <div className="mt-3 flex flex-col gap-1.5 border-t border-border-hairline pt-3">
        <Skeleton height={14} />
        <Skeleton height={14} width="70%" />
      </div>
    );
  }

  const runs = runsQuery.data?.runs ?? [];

  if (runs.length === 0) {
    return (
      <p className="mt-3 border-t border-border-hairline pt-3 text-small text-text-muted">
        No syncs yet.
      </p>
    );
  }

  return (
    <ul className="mt-3 flex flex-col gap-1.5 border-t border-border-hairline pt-3">
      {runs.map((run) => (
        <li key={run.id} className="flex items-center justify-between text-small">
          <span className="text-text-secondary">
            {formatDateOnly(run.startedAt.slice(0, 10))} · {run.trigger} · {run.operation}
            {run.errorKind !== null && ` · ${describeErrorKind(run.errorKind)}`}
          </span>
          <Badge variant={STATUS_VARIANT[run.status]}>{run.status}</Badge>
        </li>
      ))}
    </ul>
  );
}
