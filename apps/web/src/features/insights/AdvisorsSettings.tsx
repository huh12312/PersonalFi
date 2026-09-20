// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  listAdvisorsOptions,
  listAdvisorsQueryKey,
  setAdvisorEnabledMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { Sdk } from '../../api/generated/sdk.gen.ts';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Switch } from '../../components/ui/switch.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { CATALOGUE_GAPS } from './catalogue-gaps.ts';

/**
 * Kill switch 2 (enable/disable) and the manual run trigger
 * (`POST /advisors/run`), both `requireFreshSession`-gated
 * (docs/evidence/phase-2/wp2.r-routes.md §1: "changes what the system does
 * on a schedule with no further click from the user"). Every mutation here
 * goes through `useStepUpRetry`, the same passkey step-up ceremony
 * `useExportTransactions.ts` and the connections screen already use.
 */
export function AdvisorsSettings() {
  const advisorsQuery = useQuery(listAdvisorsOptions());
  const queryClient = useQueryClient();
  const stepUp = useStepUpRetry();
  const setEnabled = useMutation(setAdvisorEnabledMutation());
  const [isRunning, setIsRunning] = useState(false);
  const [runResultByAdvisor, setRunResultByAdvisor] = useState<Record<string, string>>({});

  function invalidate(): void {
    void queryClient.invalidateQueries({ queryKey: listAdvisorsQueryKey() });
  }

  async function handleToggle(advisorId: string, enabled: boolean): Promise<void> {
    await stepUp.run(() => setEnabled.mutateAsync({ path: { advisorId }, body: { enabled } }));
    invalidate();
  }

  async function handleRun(advisorId: string): Promise<void> {
    setIsRunning(true);
    try {
      const { data } = await stepUp.run(() =>
        Sdk.__registry.get().runAdvisors({ body: { advisorId }, throwOnError: true }),
      );
      const result = data.results[0];
      setRunResultByAdvisor((prev) => ({
        ...prev,
        [advisorId]:
          result === undefined
            ? 'No result returned'
            : result.status === 'completed'
              ? `${String(result.inserted)} new, ${String(result.rejected)} rejected`
              : (result.refusal ?? result.status),
      }));
      invalidate();
    } finally {
      setIsRunning(false);
    }
  }

  if (advisorsQuery.isLoading) return <SkeletonText lines={4} />;

  const advisors = advisorsQuery.data?.advisors ?? [];

  return (
    <div className="flex flex-col gap-6">
      {stepUp.error !== null && <p className="text-small text-status-critical">{stepUp.error}</p>}

      <section>
        <h2 className="text-h3 text-text-primary">Advisors</h2>
        {advisors.length === 0 ? (
          <p className="mt-2 text-small text-text-muted">No advisors are registered.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {advisors.map((advisor) => (
              <li
                key={advisor.advisorId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border-hairline bg-bg-surface p-3"
              >
                <div className="min-w-0">
                  <p className="text-body font-medium text-text-primary">{advisor.displayName}</p>
                  <p className="text-caption text-text-muted">
                    {advisor.advisorId} · v{advisor.version} · {advisor.kind}
                  </p>
                  {advisor.quarantinedAt !== null && (
                    <p className="mt-1 text-caption text-status-critical">
                      Quarantined: {advisor.quarantineReason ?? 'unknown reason'}
                    </p>
                  )}
                  {runResultByAdvisor[advisor.advisorId] !== undefined && (
                    <p className="mt-1 text-caption text-text-secondary">
                      Last manual run: {runResultByAdvisor[advisor.advisorId]}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {advisor.lastRunStatus !== null && (
                    <Badge variant="neutral">{advisor.lastRunStatus}</Badge>
                  )}
                  <Button
                    variant="ghost"
                    onClick={() => void handleRun(advisor.advisorId)}
                    disabled={stepUp.busy || isRunning}
                  >
                    Run now
                  </Button>
                  <Switch
                    checked={advisor.enabled}
                    onCheckedChange={(checked: boolean) =>
                      void handleToggle(advisor.advisorId, checked)
                    }
                    disabled={stepUp.busy || setEnabled.isPending}
                    aria-label={`Enable ${advisor.displayName}`}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-h3 text-text-primary">Not yet available</h2>
        <p className="mt-1 text-small text-text-muted">
          These built-in checks are designed but need data PersonalFi does not have yet.
        </p>
        <ul className="mt-3 flex flex-col gap-1.5">
          {CATALOGUE_GAPS.map((gap) => (
            <li key={gap.id} className="text-small text-text-secondary">
              <span className="font-mono text-caption text-text-muted">{gap.id}</span>
              {' — '}not yet available: needs {gap.needs}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
