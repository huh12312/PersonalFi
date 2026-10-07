// SPDX-License-Identifier: MIT
import { Percent } from '../../components/finance/Percent.tsx';
import { StatTile } from '../../components/finance/StatTile.tsx';
import type {
  BaselineScenario,
  ComparePlanScenariosResponse,
  ForkScenario,
  ProjectionRun,
} from '../../api/generated/types.gen.ts';
import {
  describeEngine,
  isProbabilistic,
  SINGLE_PATH_OUTCOME_WORDS,
  singlePathOutcome,
} from './engine.ts';
import { ProjectionProblem } from './ProjectionProblem.tsx';

export interface ScenarioCompareProps {
  readonly scenarios: readonly (BaselineScenario | ForkScenario)[];
  readonly a: string | undefined;
  readonly b: string | undefined;
  readonly onChangeA: (id: string | undefined) => void;
  readonly onChangeB: (id: string | undefined) => void;
  readonly compare: ComparePlanScenariosResponse | undefined;
  readonly isLoading: boolean;
  /** The compare request's failure, if it failed — worded, never silent. */
  readonly error?: unknown;
  readonly isError?: boolean;
  readonly onRetry?: () => void;
}

/**
 * One scenario's card. A Monte Carlo run shows its share of simulated paths; a
 * deterministic run shows its outcome in words and no percentage, because one
 * path has no probability (WP 9.7, G4-13).
 */
function RunFigure({ run }: { readonly run: ProjectionRun | null }) {
  if (run === null) return <StatTile label="Outcome" value="—" />;
  if (isProbabilistic(run)) {
    return (
      <StatTile
        label="Success probability"
        value={<Percent value={ratioToNumber(run.successProbability)} signDisplay="never" />}
      />
    );
  }
  return (
    <StatTile
      label="Outcome on one path"
      value={
        <span className="text-h3">
          The plan {SINGLE_PATH_OUTCOME_WORDS[singlePathOutcome(run)]}
        </span>
      }
    />
  );
}

/** A decimal-string ratio (e.g. `"0.0412"`) → number, for `<Percent>`. Never used for arithmetic — display only. */
function ratioToNumber(decimal: string): number {
  return Number(decimal);
}

function nameOf(
  scenarios: readonly (BaselineScenario | ForkScenario)[],
  id: string | undefined,
): string {
  return scenarios.find((s) => s.id === id)?.name ?? '—';
}

/**
 * Two scenarios side by side with the delta in success probability and
 * retirement date (`docs/plan/04-phase-4-dispatch.md` §3: "Scenario compare
 * side by side with the delta in success probability and in retirement
 * date"), from `GET /plan/compare?a=&b=` alone — every figure below is one
 * of that response's own fields.
 */
export function ScenarioCompare({
  scenarios,
  a,
  b,
  onChangeA,
  onChangeB,
  compare,
  isLoading,
  error,
  isError = false,
  onRetry,
}: ScenarioCompareProps) {
  const selectClass =
    'h-9 rounded-md border border-border-strong bg-bg-surface px-2 text-small text-text-primary';

  return (
    <div className="flex flex-col gap-4" data-testid="scenario-compare">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="compare-scenario-a" className="text-small text-text-secondary">
            Scenario A
          </label>
          <select
            id="compare-scenario-a"
            className={selectClass}
            value={a ?? ''}
            onChange={(e) => onChangeA(e.target.value === '' ? undefined : e.target.value)}
          >
            <option value="">Choose a scenario…</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="compare-scenario-b" className="text-small text-text-secondary">
            Scenario B
          </label>
          <select
            id="compare-scenario-b"
            className={selectClass}
            value={b ?? ''}
            onChange={(e) => onChangeB(e.target.value === '' ? undefined : e.target.value)}
          >
            <option value="">Choose a scenario…</option>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {a !== undefined && b !== undefined && a === b && (
        <p className="text-small text-text-muted">Choose two different scenarios to compare.</p>
      )}

      {isLoading && <p className="text-small text-text-muted">Comparing…</p>}

      {isError && (
        <ProjectionProblem error={error} {...(onRetry === undefined ? {} : { onRetry })} />
      )}

      {compare !== undefined && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-md border border-border-hairline p-4" data-testid="compare-a">
            <h3 className="mb-2 text-small font-semibold text-text-primary">
              {nameOf(scenarios, a)}
            </h3>
            <RunFigure run={compare.a.run} />
            <p className="mt-1 text-caption text-text-muted">
              Retirement date: {compare.retirementDate.a}
            </p>
          </div>
          <div className="rounded-md border border-border-hairline p-4" data-testid="compare-b">
            <h3 className="mb-2 text-small font-semibold text-text-primary">
              {nameOf(scenarios, b)}
            </h3>
            <RunFigure run={compare.b.run} />
            <p className="mt-1 text-caption text-text-muted">
              Retirement date: {compare.retirementDate.b}
            </p>
          </div>
          <div className="sm:col-span-2 rounded-md bg-bg-subtle p-4" data-testid="compare-delta">
            {compare.a.run !== null &&
            compare.b.run !== null &&
            isProbabilistic(compare.a.run) &&
            isProbabilistic(compare.b.run) ? (
              <p className="text-small text-text-primary">
                Δ success probability:{' '}
                <Percent
                  value={ratioToNumber(compare.successProbabilityDelta)}
                  signDisplay="exceptZero"
                  colorBySign
                />
              </p>
            ) : (
              <p className="text-small text-text-primary">
                {describeEngine(compare.a.run?.method).phrasing === 'single_path' ||
                describeEngine(compare.b.run?.method).phrasing === 'single_path'
                  ? 'These are single paths, not simulations, so there is no share to compare. Read the outcome on each card.'
                  : 'No stored run to compare.'}
              </p>
            )}
            <p className="text-small text-text-primary">
              Δ retirement date: {Math.abs(compare.retirementDeltaMonths)} month
              {Math.abs(compare.retirementDeltaMonths) === 1 ? '' : 's'}{' '}
              {compare.retirementDeltaMonths === 0
                ? ''
                : compare.retirementDeltaMonths > 0
                  ? 'later'
                  : 'earlier'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
