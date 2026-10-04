// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  cancelAdvisorRunMutation,
  getAdvisorRunOptions,
  getAdvisorRunQueryKey,
  listAdvisorRunsOptions,
  listAdvisorRunsQueryKey,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Problem } from '../../api/generated/types.gen.ts';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { cancellationLevelLabel, isRunInFlight } from './kill-levels.ts';

export interface RunInspectorPanelProps {
  advisorId: string;
}

function problemOf(error: unknown): Problem | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return error as Problem;
  }
  return null;
}

function problemMessage(error: unknown, fallback: string): string {
  const problem = problemOf(error);
  if (problem === null) return fallback;
  return `${problem.title} (${problem.code})${problem.detail !== undefined ? ` — ${problem.detail}` : ''}`;
}

/**
 * The run inspector (`docs/plan/05-phase-5-dispatch.md` §3 WP 5.12): runs
 * per advisor, then one run's `input_digest`, the verified mark, emitted
 * scopes, per-step rejections, model and prompt hash, cancellation level;
 * cancel on an in-flight run.
 *
 * The "verified" mark is driven **only** by `payload.digestVerified` —
 * `GET /advisors/runs/{runId}` recomputes this server-side from the
 * retained bytes and never trusts what was stored
 * (`wp5.1-run-control.md` §8's sabotage S7, `inspectRunPayload`). It is
 * never rendered when there is no retained payload at all (shown as that,
 * honestly, not as unverified), and never rendered as verified when
 * `digestVerified` is `false` — a tampered-or-corrupted payload, named as
 * such.
 *
 * The cancel button is gated on `isRunInFlight(run.status)` from
 * `kill-levels.ts` — the one place that predicate is defined — so a
 * finished run can never be offered a cancel action here by construction,
 * not by a second copy of the same check drifting out of sync with it.
 */
export function RunInspectorPanel({ advisorId }: RunInspectorPanelProps) {
  const runsQuery = useQuery(listAdvisorRunsOptions({ path: { advisorId } }));
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const stepUp = useStepUpRetry();
  const cancelMutation = useMutation(cancelAdvisorRunMutation());
  const [cancelError, setCancelError] = useState<string | null>(null);

  const runs = runsQuery.data?.runs ?? [];
  const activeRunId = selectedRunId ?? runs[0]?.id ?? null;

  const runQuery = useQuery({
    ...getAdvisorRunOptions({ path: { runId: activeRunId ?? '' } }),
    enabled: activeRunId !== null,
  });

  async function handleCancel(runId: string): Promise<void> {
    setCancelError(null);
    try {
      await stepUp.run(() => cancelMutation.mutateAsync({ path: { runId } }));
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: listAdvisorRunsQueryKey({ path: { advisorId } }),
        }),
        queryClient.invalidateQueries({ queryKey: getAdvisorRunQueryKey({ path: { runId } }) }),
      ]);
    } catch (cause) {
      setCancelError(problemMessage(cause, 'The run could not be cancelled.'));
    }
  }

  if (runsQuery.isLoading) return <SkeletonText lines={4} />;

  if (runsQuery.isError) {
    return (
      <p className="text-small text-status-critical">
        {problemMessage(runsQuery.error, 'Runs could not be loaded.')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="run-inspector-panel">
      {runs.length === 0 ? (
        <p className="text-small text-text-muted">No runs recorded yet for this advisor.</p>
      ) : (
        <ul className="flex flex-col gap-1.5" aria-label="Runs">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => setSelectedRunId(run.id)}
                aria-pressed={run.id === activeRunId}
                data-testid="run-row"
                className={`w-full rounded-md border p-2 text-left text-small ${
                  run.id === activeRunId
                    ? 'border-accent-text bg-accent-wash'
                    : 'border-border-hairline bg-bg-surface'
                }`}
              >
                <span className="font-mono text-caption">{run.id}</span> · {run.status}
                {run.cancelReason !== null && <> · {run.cancelReason}</>}
                {' · '}
                {new Date(run.startedAt).toLocaleString()}
              </button>
            </li>
          ))}
        </ul>
      )}

      {activeRunId !== null && (
        <div
          className="rounded-md border border-border-hairline bg-bg-surface p-3"
          data-testid="run-detail"
        >
          {runQuery.isLoading && <SkeletonText lines={4} />}
          {runQuery.isError && (
            <p className="text-small text-status-critical">
              {problemMessage(runQuery.error, 'Run detail could not be loaded.')}
            </p>
          )}
          {runQuery.data !== undefined &&
            (() => {
              const { run, rejections, payload } = runQuery.data;
              const cancellationLevel = cancellationLevelLabel(run.cancelReason);
              return (
                <div className="flex flex-col gap-3">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-caption text-text-muted">
                    <dt>Status</dt>
                    <dd className="text-text-secondary">{run.status}</dd>
                    <dt>Input digest</dt>
                    <dd
                      className="break-all font-mono text-text-secondary"
                      data-testid="input-digest"
                    >
                      {run.inputDigest ?? 'none recorded'}
                    </dd>
                    <dt>Emitted scopes</dt>
                    <dd className="text-text-secondary">
                      {run.emittedScopes.length === 0 ? 'none' : run.emittedScopes.join(', ')}
                    </dd>
                    <dt>Model</dt>
                    <dd className="text-text-secondary">
                      {run.llmModel ?? 'n/a (not a local-model run)'}
                    </dd>
                    <dt>Prompt hash</dt>
                    <dd className="break-all font-mono text-text-secondary">
                      {run.llmPromptHash ?? 'n/a'}
                    </dd>
                    {cancellationLevel !== null && (
                      <>
                        <dt>Cancelled at</dt>
                        <dd className="text-text-secondary" data-testid="cancellation-level">
                          {cancellationLevel}
                        </dd>
                      </>
                    )}
                  </dl>

                  <div>
                    <p className="mb-1 text-caption font-semibold uppercase tracking-wide text-text-muted">
                      Retained payload
                    </p>
                    {payload === null ? (
                      <p className="text-small text-text-muted" data-testid="no-payload-notice">
                        No payload retained for this run (nothing retained for this kind, or its
                        30-day retention window has passed).
                      </p>
                    ) : payload.digestVerified ? (
                      <Badge variant="good" data-testid="verified-mark">
                        Verified — the retained bytes re-digest to this run&apos;s input_digest
                      </Badge>
                    ) : (
                      <Badge variant="critical" data-testid="verified-mark">
                        Not verified — the retained bytes do not match this run&apos;s input_digest
                      </Badge>
                    )}
                  </div>

                  <div>
                    <p className="mb-1 text-caption font-semibold uppercase tracking-wide text-text-muted">
                      Per-step rejections ({rejections.length})
                    </p>
                    {rejections.length === 0 ? (
                      <p className="text-small text-text-muted">None recorded.</p>
                    ) : (
                      <pre
                        className="overflow-x-auto whitespace-pre-wrap text-caption text-text-secondary"
                        data-testid="rejections"
                      >
                        {JSON.stringify(rejections, null, 2)}
                      </pre>
                    )}
                  </div>

                  {isRunInFlight(run.status) && (
                    <div>
                      <Button
                        variant="destructive"
                        onClick={() => void handleCancel(run.id)}
                        disabled={stepUp.busy || cancelMutation.isPending}
                        data-testid="cancel-run-button"
                      >
                        {stepUp.busy || cancelMutation.isPending
                          ? 'Cancelling…'
                          : 'Cancel this run'}
                      </Button>
                    </div>
                  )}
                  {cancelError !== null && (
                    <p className="text-small text-status-critical">{cancelError}</p>
                  )}
                  {stepUp.error !== null && (
                    <p className="text-small text-status-critical">{stepUp.error}</p>
                  )}
                </div>
              );
            })()}
        </div>
      )}
    </div>
  );
}
