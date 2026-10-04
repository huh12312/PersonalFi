// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  listAdvisorsOptions,
  listAdvisorsQueryKey,
  setAdvisorEnabledMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { Sdk } from '../../api/generated/sdk.gen.ts';
import type { AdvisorHealth } from '../../api/generated/types.gen.ts';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Switch } from '../../components/ui/switch.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { useStepUpRetry } from '../../lib/step-up.ts';
import { CATALOGUE_GAPS } from '../insights/catalogue-gaps.ts';
import {
  advisorLevelWords,
  kindLevelWords,
  MODULE_LEVEL_WORDS,
  runLevelWords,
} from './kill-levels.ts';
import { KindSwitch } from './KindSwitch.tsx';
import { PayloadPreviewPanel } from './PayloadPreviewPanel.tsx';
import { RunInspectorPanel } from './RunInspectorPanel.tsx';
import { ScopeGrantsPanel } from './ScopeGrantsPanel.tsx';

/**
 * `/settings/advisors` (`docs/plan/05-phase-5-dispatch.md` §3 WP 5.12).
 * Moved from the Insights screen's own "Advisors" tab
 * (`features/insights/AdvisorsSettings.tsx`, deleted by this move — its
 * enable/disable switch and "Run now" trigger live on here unchanged) and
 * grown: every advisor's kind and all four kill-ladder levels in words, the
 * kind switch (level 2), scope grants with yields/drops before the
 * step-up (level 3's consent surface, C-12/G4-17/G4-22 —
 * `docs/evidence/phase-4/gate-security-review.md` §3.13), the run inspector
 * and the payload preview with its approval (level 4's screen and the
 * preview gate), and cancel on an in-flight run.
 *
 * **Needs the orchestrator.** Levels 1 (`ADVISORS_ENABLED` /
 * `module.insights`) and 2 (`advisors.kind.local_model`) have no `GET`
 * route that reports their current boolean value to this browser —
 * `kill-levels.ts`'s own doc comment names this, and every word this
 * screen prints about those two levels is a description of the mechanism,
 * never a read of a value nobody can fetch. `KindSwitch` is two write-only
 * buttons rather than a `Switch` for exactly that reason. The fix is a
 * route (`GET /advisors/kinds/{kind}/enabled` and a module-level
 * equivalent), not a UI change, and it is outside this work package's
 * `apps/web`-only ownership.
 */
export function AdvisorManagementScreen() {
  const advisorsQuery = useQuery(listAdvisorsOptions());
  const queryClient = useQueryClient();
  const stepUp = useStepUpRetry();
  const setEnabled = useMutation(setAdvisorEnabledMutation());
  const [isRunning, setIsRunning] = useState(false);
  const [runResultByAdvisor, setRunResultByAdvisor] = useState<Record<string, string>>({});
  const [openAdvisorId, setOpenAdvisorId] = useState<string | null>(null);

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

  const advisors: readonly AdvisorHealth[] = advisorsQuery.data?.advisors ?? [];
  const hasLocalModelAdvisor = advisors.some((advisor) => advisor.kind === 'local_model');

  return (
    <div className="flex flex-col gap-6" data-testid="advisor-management-screen">
      <div>
        <h1 className="text-h2 text-text-primary">Advisor management</h1>
        <p className="mt-1 text-small text-text-muted">
          Every advisor, its kind, and the four-level kill ladder that can stop it — module, kind,
          advisor, and a run in flight.
        </p>
      </div>

      <section
        className="rounded-md border border-border-hairline bg-bg-subtle p-3 text-caption text-text-secondary"
        data-testid="module-level-note"
      >
        {MODULE_LEVEL_WORDS}
      </section>

      {hasLocalModelAdvisor && <KindSwitch kind="local_model" />}

      {stepUp.error !== null && <p className="text-small text-status-critical">{stepUp.error}</p>}

      <section>
        <h2 className="text-h3 text-text-primary">Advisors</h2>
        {advisors.length === 0 ? (
          <p className="mt-2 text-small text-text-muted">No advisors are registered.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {advisors.map((advisor) => {
              const isOpen = openAdvisorId === advisor.advisorId;
              const latestRun =
                advisor.lastRunStatus === null ? null : { status: advisor.lastRunStatus };
              const panelId = `advisor-detail-${advisor.advisorId}`;
              return (
                <li
                  key={advisor.advisorId}
                  className="rounded-md border border-border-hairline bg-bg-surface p-3"
                  data-testid="advisor-row"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-body font-medium text-text-primary">
                        {advisor.displayName}
                      </p>
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
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-expanded={isOpen}
                        aria-controls={panelId}
                        onClick={() => setOpenAdvisorId(isOpen ? null : advisor.advisorId)}
                      >
                        {isOpen ? 'Hide detail' : 'Show detail'}
                      </Button>
                    </div>
                  </div>

                  {isOpen && (
                    <div
                      id={panelId}
                      role="region"
                      aria-label={`${advisor.displayName} detail`}
                      className="mt-4 flex flex-col gap-4 border-t border-border-hairline pt-4"
                    >
                      <dl className="flex flex-col gap-1 text-caption text-text-secondary">
                        <dt className="font-semibold text-text-muted">Kind</dt>
                        <dd>{kindLevelWords(advisor.kind)}</dd>
                        <dt className="mt-2 font-semibold text-text-muted">Advisor</dt>
                        <dd>{advisorLevelWords(advisor)}</dd>
                        <dt className="mt-2 font-semibold text-text-muted">Run</dt>
                        <dd>{runLevelWords(latestRun)}</dd>
                      </dl>

                      <div>
                        <h3 className="text-small font-semibold text-text-primary">Scope grants</h3>
                        <ScopeGrantsPanel advisorId={advisor.advisorId} />
                      </div>

                      <div>
                        <h3 className="text-small font-semibold text-text-primary">
                          Payload preview
                        </h3>
                        <PayloadPreviewPanel advisorId={advisor.advisorId} />
                      </div>

                      <div>
                        <h3 className="text-small font-semibold text-text-primary">
                          Run inspector
                        </h3>
                        <RunInspectorPanel advisorId={advisor.advisorId} />
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
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
