// SPDX-License-Identifier: MIT
import { Target } from 'lucide-react';
import { useState } from 'react';

import { Money } from '../../components/finance/Money.tsx';
import { Percent } from '../../components/finance/Percent.tsx';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { Label } from '../../components/ui/label.tsx';
import type { BaselineScenario } from '../../api/generated/types.gen.ts';
import {
  useAssumptionsQuery,
  useCompareQuery,
  useCreateLifeEventMutation,
  useCreatePlanScenarioMutation,
  useDeleteLifeEventMutation,
  useLifeEventsQuery,
  useOverrideAssumptionMutation,
  useProjectionQuery,
  useRequiredSavings,
  useScenariosQuery,
  useUpdateLifeEventMutation,
} from './api.ts';
import { AssumptionsPanel } from './AssumptionsPanel.tsx';
import { BaselinePlanForm } from './BaselinePlanForm.tsx';
import { FanChart } from './FanChart.tsx';
import { GoalControls } from './GoalControls.tsx';
import { LifeEventForm } from './LifeEventForm.tsx';
import { LifeEventsTimeline } from './LifeEventsTimeline.tsx';
import { ScenarioCompare } from './ScenarioCompare.tsx';
import { DEFAULT_GOAL_CURRENCY, type PlanSearch } from './search.ts';
import { GoalSliders } from './sliders/GoalSliders.tsx';

/** `$2,000` in minor units — the required-savings solver's ceiling when a goal is set but the ceiling field was somehow skipped. `GoalControls` always sets all three fields together, so this is a defensive fallback, not a real default. */
const FALLBACK_MAX_MONTHLY_MINOR = '200000';

export interface PlanScreenProps {
  readonly search: PlanSearch;
  readonly onSearchChange: (next: PlanSearch) => void;
}

/**
 * `/plan` (WP 4.10), replacing the Phase 1 `PlaceholderRoute`
 * (`docs/plan/04-phase-4-dispatch.md` §3 "WP 4.10"). Every number below is a
 * field off one of `./api.ts`'s query responses — the fan chart's bands, the
 * headline sentence's success probability and terminal median, the
 * assumptions panel's cited values, the scenario compare deltas — formatted
 * for display and never recomputed on the client
 * (`docs/CONVENTIONS.md`: "no client-side money math beyond formatting").
 */
export function PlanScreen({ search, onSearchChange }: PlanScreenProps) {
  const scenariosQuery = useScenariosQuery();
  const scenarios = scenariosQuery.data?.scenarios ?? [];
  const baseline = scenarios.find((s): s is BaselineScenario => s.kind === 'baseline');
  const selectedScenarioId = search.scenario ?? baseline?.id;

  const projectionQuery = useProjectionQuery(selectedScenarioId);
  const assumptionsQuery = useAssumptionsQuery();
  const lifeEventsQuery = useLifeEventsQuery();
  const compareQuery = useCompareQuery(search.compareA, search.compareB);

  const createScenario = useCreatePlanScenarioMutation();
  const createLifeEvent = useCreateLifeEventMutation();
  const updateLifeEvent = useUpdateLifeEventMutation();
  const deleteLifeEvent = useDeleteLifeEventMutation();
  const overrideAssumption = useOverrideAssumptionMutation();
  const requiredSavings = useRequiredSavings();

  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [savingOverridePath, setSavingOverridePath] = useState<string | null>(null);

  function update(patch: Partial<PlanSearch>): void {
    onSearchChange({ ...search, ...patch });
  }

  function handleGapActivate(): void {
    if (search.goalTargetMinor === undefined || search.goalDate === undefined) return;
    const currency = search.goalCurrency ?? DEFAULT_GOAL_CURRENCY;
    void requiredSavings.solve({
      objective: {
        kind: 'wealth_at',
        targetDate: search.goalDate,
        target: { minor: search.goalTargetMinor, currency },
        basis: 'nominal',
      },
      maxMonthly: { minor: search.maxMonthlyMinor ?? FALLBACK_MAX_MONTHLY_MINOR, currency },
    });
  }

  function handleMoveLifeEvent(lifeEventId: string, occursOn: string): void {
    updateLifeEvent.mutate({ path: { lifeEventId }, body: { occursOn } });
  }

  function handleDeleteLifeEvent(lifeEventId: string): void {
    setPendingDeleteId(lifeEventId);
    deleteLifeEvent.mutate(
      { path: { lifeEventId } },
      { onSettled: () => setPendingDeleteId(null) },
    );
  }

  function handleOverride(path: string, value: string): void {
    const current = Object.fromEntries(
      (assumptionsQuery.data?.overrides ?? []).map((o) => [o.path, o.value]),
    );
    setSavingOverridePath(path);
    overrideAssumption.mutate(
      { body: { overrides: { ...current, [path]: value } } },
      { onSettled: () => setSavingOverridePath(null) },
    );
  }

  if (scenariosQuery.isLoading) {
    return <Skeleton variant="block" height={320} />;
  }

  if (baseline === undefined) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <EmptyState
          icon={Target}
          headline="Start your plan"
          description="Tell us your retirement age and we'll project it against your revealed savings rate."
          className="max-w-lg"
        >
          <BaselinePlanForm
            onSubmit={(body) => createScenario.mutate({ body })}
            pending={createScenario.isPending}
            error={createScenario.isError ? 'Could not create your plan. Try again.' : null}
          />
        </EmptyState>
      </div>
    );
  }

  const projection = projectionQuery.data;
  const percentiles = projection?.percentiles ?? [];
  const lastRow = percentiles[percentiles.length - 1];
  const run = projection?.run ?? null;

  const goal =
    search.goalTargetMinor !== undefined && search.goalDate !== undefined
      ? {
          targetMinor: search.goalTargetMinor,
          currency: search.goalCurrency ?? DEFAULT_GOAL_CURRENCY,
          calendarYear: Number(search.goalDate.slice(0, 4)),
        }
      : null;

  const rangeStart =
    percentiles.length > 0 ? new Date(percentiles[0]!.calendarYear, 0, 1) : new Date();
  const rangeEnd =
    percentiles.length > 0
      ? new Date(percentiles[percentiles.length - 1]!.calendarYear, 11, 31)
      : new Date(rangeStart.getFullYear() + 30, 11, 31);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-h2 font-semibold text-text-primary">Plan</h1>
        <p className="text-body text-text-secondary" data-testid="plan-headline">
          {run !== null && lastRow !== undefined ? (
            <>
              You&apos;re on track for{' '}
              <Money value={lastRow.p50} colorBySign={false} data-testid="plan-headline-amount" />{' '}
              at age {lastRow.age} —{' '}
              <Percent
                value={Number(run.successProbability)}
                signDisplay="never"
                data-testid="plan-headline-probability"
              />{' '}
              of plans succeed.
            </>
          ) : (
            'Projecting your plan…'
          )}
        </p>
      </header>

      {scenarios.length > 1 && (
        <div className="flex items-end gap-2">
          <div>
            <Label htmlFor="plan-scenario-select">Viewing scenario</Label>
            <select
              id="plan-scenario-select"
              className="h-9 rounded-md border border-border-strong bg-bg-surface px-2 text-small text-text-primary"
              value={selectedScenarioId ?? ''}
              onChange={(e) => update({ scenario: e.target.value })}
            >
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <section aria-label="Monte Carlo fan chart" className="flex flex-col gap-4">
        {projectionQuery.isLoading ? (
          <Skeleton variant="block" height={320} />
        ) : (
          <FanChart
            percentiles={percentiles}
            currency={run?.currency ?? DEFAULT_GOAL_CURRENCY}
            goal={goal}
            onGapActivate={handleGapActivate}
          />
        )}

        <GoalControls
          value={{
            goalTargetMinor: search.goalTargetMinor,
            goalCurrency: search.goalCurrency,
            goalDate: search.goalDate,
            maxMonthlyMinor: search.maxMonthlyMinor,
          }}
          onApply={(next) => update(next)}
        />

        {requiredSavings.pending && (
          <p className="text-small text-text-muted" role="status">
            Solving…
          </p>
        )}
        {requiredSavings.error !== null && (
          <p className="text-small text-status-critical" role="alert">
            {requiredSavings.error}
          </p>
        )}
        {requiredSavings.result !== null && (
          <div
            className="rounded-md border border-border-hairline p-3"
            data-testid="required-savings-result"
            role="status"
          >
            {requiredSavings.result.kind === 'already_met' && (
              <p>You&apos;re already on track — no additional monthly saving is required.</p>
            )}
            {requiredSavings.result.kind === 'required' && (
              <p>
                Save an additional{' '}
                <Money value={requiredSavings.result.monthly} colorBySign={false} /> per month to
                reach this goal.
              </p>
            )}
            {requiredSavings.result.kind === 'unreachable' && (
              <p data-testid="required-savings-unreachable">
                This goal is <strong>unreachable</strong>:{' '}
                {requiredSavings.result.constraint.detail}
              </p>
            )}
          </div>
        )}
      </section>

      <GoalSliders scenario={baseline} />

      <section aria-label="Life events" className="flex flex-col gap-3">
        <h2 className="text-h3 font-semibold text-text-primary">Life events</h2>
        <LifeEventForm
          onSubmit={(body) => createLifeEvent.mutate({ body })}
          pending={createLifeEvent.isPending}
        />
        {lifeEventsQuery.isLoading ? (
          <Skeleton variant="block" height={120} />
        ) : (
          <LifeEventsTimeline
            lifeEvents={lifeEventsQuery.data?.lifeEvents ?? []}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onMove={handleMoveLifeEvent}
            onDelete={handleDeleteLifeEvent}
            pendingDeleteId={pendingDeleteId}
          />
        )}
      </section>

      <section aria-label="Scenario compare" className="flex flex-col gap-3">
        <h2 className="text-h3 font-semibold text-text-primary">Compare scenarios</h2>
        <ScenarioCompare
          scenarios={scenarios}
          a={search.compareA}
          b={search.compareB}
          onChangeA={(id) => update({ compareA: id })}
          onChangeB={(id) => update({ compareB: id })}
          compare={compareQuery.data}
          isLoading={compareQuery.isLoading}
        />
      </section>

      <section aria-label="Assumptions" className="flex flex-col gap-3">
        <h2 className="text-h3 font-semibold text-text-primary">Assumptions</h2>
        {assumptionsQuery.isLoading ? (
          <Skeleton variant="block" height={200} />
        ) : (
          assumptionsQuery.data !== undefined && (
            <AssumptionsPanel
              file={assumptionsQuery.data.file}
              overrides={assumptionsQuery.data.overrides}
              overridablePaths={assumptionsQuery.data.overridablePaths}
              version={assumptionsQuery.data.version}
              onOverride={handleOverride}
              savingPath={savingOverridePath}
            />
          )
        )}
      </section>
    </div>
  );
}
