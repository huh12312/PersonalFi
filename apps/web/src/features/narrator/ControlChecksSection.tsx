// SPDX-License-Identifier: MIT
import { CircleCheck, CircleMinus, CircleX, Clock, Info, Loader2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';

import { ScrollRegion } from '../../components/patterns/ScrollRegion.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Badge, type BadgeProps } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../lib/cn.ts';
import { useStepUpRetry } from '../../lib/step-up.ts';
import {
  isRunning,
  useControlChecksQuery,
  useRefreshControlChecks,
  useRunControlChecksMutation,
} from './control-checks-api.ts';
import {
  checkStatusWord,
  doneWords,
  formatCheckDuration,
  formatRunTime,
  nextAllowedWords,
  progressWords,
  providerModelWords,
  runResultWords,
  type ControlCheckRow,
  type ControlCheckRun,
  type ControlCheckRuns,
} from './control-checks-words.ts';
import { problemCode, problemDetail } from './narrator-api.ts';

/**
 * Settings › Language model › **Control checks** (WP 10.16). Chris's request: "a 'Run control checks' button on the
 * Language model screen would exercise every control against your live instance with your own session ... Each
 * check writes a dated evidence row like the restore drills do, and the dashboard's backup line would show when the
 * controls were last proven."
 *
 * What a run costs is said before the button, verbatim from the api. The button asks for the passkey (the step-up,
 * the same `useStepUpRetry` as "Use this provider"); while a run goes the list is read every second and the thirteen
 * checks tick over in a table, with a polite live region saying how many are done. Once a run is the api's newest,
 * the button is unavailable until `nextAllowedAt` and says so in words. The button is never `disabled` (it is
 * `aria-disabled`), so focus stays on it while a run starts and goes (2.4.3).
 */
export function ControlChecksSection() {
  const query = useControlChecksQuery();

  return (
    <section
      aria-labelledby="control-checks-heading"
      className="flex flex-col gap-3 rounded-md border border-border-hairline p-4"
      data-testid="control-checks"
    >
      <div className="flex flex-col gap-1">
        <h3 id="control-checks-heading" className="font-medium text-text-primary">
          Control checks
        </h3>
        <p className="text-small text-text-muted">
          Exercise every control on the language model against this install, with your own session:
          the approval gate, the kill switches, the validators, the egress allow-list and the rest.
          Each run is kept as a dated record, and the dashboard says when the controls were last
          proven.
        </p>
      </div>
      {query.isLoading ? (
        <SkeletonText lines={3} />
      ) : query.data === undefined ? (
        <p className="text-small text-text-secondary">
          The control checks cannot be read right now. Try again in a moment.
        </p>
      ) : (
        <ControlChecksBody data={query.data} />
      )}
    </section>
  );
}

function ControlChecksBody({ data }: { data: ControlCheckRuns }) {
  const mutation = useRunControlChecksMutation();
  const stepUp = useStepUpRetry();
  const refresh = useRefreshControlChecks();
  const [proveSwitch, setProveSwitch] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A run started from this screen: once it settles, the live region says how it ended.
  const [watched, setWatched] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const whyId = useId();
  const switchId = useId();

  const newest = data.runs[0];
  const running = isRunning(data);
  const starting = mutation.isPending || stepUp.busy;
  const wait = nextAllowedWords(data.nextAllowedAt, now);
  const unavailable = running || starting || wait !== null;

  // When the wait is over, read the list again (the api then says `nextAllowedAt: null`) and redraw.
  useEffect(() => {
    if (data.nextAllowedAt === null) return undefined;
    const left = new Date(data.nextAllowedAt).getTime() - Date.now();
    const timer = window.setTimeout(
      () => {
        setNow(new Date());
        void refresh();
      },
      Math.max(0, left) + 250,
    );
    return () => window.clearTimeout(timer);
  }, [data.nextAllowedAt, refresh]);

  async function handleRun(): Promise<void> {
    if (unavailable) return;
    setFailure(null);
    setNotice(null);
    try {
      const run = await stepUp.run(() =>
        mutation.mutateAsync({ body: proveSwitch ? { proveSwitch: true } : {} }),
      );
      setWatched(run.id);
      setNow(new Date());
    } catch (cause) {
      if (problemCode(cause) === 'narrator.control_checks_too_soon') {
        setNotice(
          problemDetail(
            cause,
            'The controls were checked less than 10 minutes ago. Try again later.',
          ),
        );
        void refresh();
      } else {
        setFailure(problemDetail(cause, 'The control checks could not start. Nothing was run.'));
      }
    } finally {
      mutation.reset();
    }
  }

  const shownFailure = stepUp.error ?? failure;
  const live =
    notice ??
    (running && newest !== undefined
      ? `Running control checks… ${progressWords(newest)}`
      : starting
        ? 'Starting the control checks…'
        : watched !== null && newest?.id === watched
          ? `Control checks finished. Result: ${runResultWords(newest)}.`
          : '');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <p className="text-small text-text-primary" data-testid="control-checks-cost">
          {data.cost.message}
        </p>
        <div className="flex items-start gap-2">
          <input
            id={switchId}
            type="checkbox"
            className="mt-1"
            checked={proveSwitch}
            disabled={unavailable}
            onChange={(event) => setProveSwitch(event.target.checked)}
          />
          <label htmlFor={switchId} className="text-small text-text-primary">
            Also prove kill switch 1 (turns the module off inside a transaction that is rolled back)
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={unavailable ? 'secondary' : 'primary'}
            aria-disabled={unavailable}
            aria-describedby={wait === null ? undefined : whyId}
            className={cn(unavailable && 'cursor-not-allowed')}
            onClick={() => void handleRun()}
            data-testid="control-checks-run"
          >
            {(running || starting) && (
              <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />
            )}
            {running || starting ? 'Running control checks…' : 'Run control checks'}
          </Button>
          <span className="text-caption text-text-muted">
            Running the checks asks for your passkey.
          </span>
        </div>
        {wait !== null && !running && (
          <p
            id={whyId}
            className="text-small text-text-secondary"
            data-testid="control-checks-wait"
          >
            {wait}
          </p>
        )}
        {shownFailure !== null && (
          <p className="text-small text-status-danger-text" role="alert">
            {shownFailure}
          </p>
        )}
        <p
          role="status"
          aria-live="polite"
          className="text-small font-medium text-text-primary empty:hidden"
          data-testid="control-checks-progress"
        >
          {live}
        </p>
      </div>

      {newest === undefined ? (
        <p className="text-small text-text-secondary" data-testid="control-checks-never">
          The controls have not been checked on this install yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {newest.state !== 'running' && (
            <p className="text-small text-text-primary" data-testid="control-checks-summary">
              {doneWords(newest)}
            </p>
          )}
          <ControlCheckTable run={newest} testId="control-checks-table" />
        </div>
      )}

      {data.runs.length > 0 && <ControlCheckHistory runs={data.runs} />}
    </div>
  );
}

const STATUS_BADGE: Record<
  ControlCheckRow['status'],
  { variant: NonNullable<BadgeProps['variant']>; icon: ReactNode }
> = {
  pass: { variant: 'success', icon: <CircleCheck size={12} aria-hidden="true" /> },
  fail: { variant: 'danger', icon: <CircleX size={12} aria-hidden="true" /> },
  skipped: { variant: 'neutral', icon: <CircleMinus size={12} aria-hidden="true" /> },
  reported: { variant: 'info', icon: <Info size={12} aria-hidden="true" /> },
  pending: { variant: 'neutral', icon: <Clock size={12} aria-hidden="true" /> },
  running: {
    variant: 'accent',
    icon: <Loader2 size={12} className="motion-safe:animate-spin" aria-hidden="true" />,
  },
};

/** The result of one check: the word is the result; the badge's colour and glyph only repeat it. */
function CheckResult({ row }: { row: ControlCheckRow }) {
  const badge = STATUS_BADGE[row.status];
  return (
    <Badge variant={badge.variant} icon={badge.icon} data-status={row.status}>
      {checkStatusWord(row)}
    </Badge>
  );
}

function CheckFacts({ row }: { row: ControlCheckRow }) {
  if (row.status === 'pending') return <span className="text-text-muted">Waiting to run.</span>;
  if (row.status === 'running' && row.facts.length === 0) {
    return <span className="text-text-muted">Running now.</span>;
  }
  if (row.reason === null && row.facts.length === 0) {
    return <span className="text-text-muted">No facts recorded.</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      {row.reason !== null && (
        <p className="text-text-primary" data-testid="control-check-reason">
          {row.reason}
        </p>
      )}
      {row.facts.length > 0 && (
        <ul
          className="list-disc pl-4 text-text-secondary"
          aria-label={`What was observed: ${row.name}`}
        >
          {row.facts.map((fact, index) => (
            // Facts are sentences; two can repeat, so the index keeps the key unique.
            <li key={`${String(index)}:${fact}`}>{fact}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One run's thirteen checks as a real table: a caption, column headers and a row header per check. */
function CheckDuration({ ms }: { ms: number | null }) {
  if (ms === null) {
    return (
      <>
        <span aria-hidden="true">—</span>
        <span className="sr-only">Not timed</span>
      </>
    );
  }
  return <>{formatCheckDuration(ms)}</>;
}

/**
 * One run's thirteen checks as a real table: a caption, column headers and a row header per check (the name, with what
 * a pass proves as secondary text). From `sm` up it has four columns (Check, Result, Facts, Duration); narrower, the
 * Facts and Duration columns are not displayed and the same words sit under the result instead, so a phone reads
 * every fact without scrolling sideways. Only one of the two is ever displayed, so a screen reader meets each once.
 */
export function ControlCheckTable({ run, testId }: { run: ControlCheckRun; testId: string }) {
  const where = providerModelWords(run.provider, run.model);
  return (
    <ScrollRegion label={`Control checks of ${formatRunTime(run.startedAt)}`}>
      <table className="w-full text-small sm:min-w-[36rem]" data-testid={testId} data-run={run.id}>
        <caption className="pb-2 text-left text-small text-text-secondary">
          Control checks of {formatRunTime(run.startedAt)}, with {where}: {runResultWords(run)}.
        </caption>
        <thead>
          <tr className="border-b border-border-hairline text-left text-text-secondary">
            <th scope="col" className="w-1/2 py-2 pr-3 font-medium sm:w-[30%]">
              Check
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Result
            </th>
            <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">
              Facts
            </th>
            <th scope="col" className="hidden py-2 text-right font-medium sm:table-cell">
              Duration
            </th>
          </tr>
        </thead>
        <tbody>
          {run.results.map((row) => (
            <tr
              key={row.id}
              className="border-b border-border-hairline align-top last:border-0"
              data-testid={`control-check-${row.id}`}
              data-status={row.status}
            >
              <th scope="row" className="py-2 pr-3 text-left font-normal">
                <span className="block font-medium text-text-primary">{row.name}</span>
                <span className="block text-caption text-text-muted">{row.proves}</span>
              </th>
              <td className="py-2 pr-3" data-testid="control-check-result-cell">
                <span data-testid="control-check-result" className="whitespace-nowrap">
                  <CheckResult row={row} />
                </span>
                <div
                  className="mt-2 flex flex-col gap-1 sm:hidden"
                  data-testid="control-check-narrow"
                >
                  <CheckFacts row={row} />
                  {row.durationMs !== null && (
                    <span className="text-caption text-text-muted">
                      Took {formatCheckDuration(row.durationMs)}
                    </span>
                  )}
                </div>
              </td>
              <td className="hidden py-2 pr-3 sm:table-cell" data-testid="control-check-facts">
                <CheckFacts row={row} />
              </td>
              <td
                className="hidden py-2 text-right whitespace-nowrap tabular-nums sm:table-cell"
                data-testid="control-check-duration"
              >
                <CheckDuration ms={row.durationMs} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}

/**
 * Every run the api keeps (the last 20), newest first. Each is a native disclosure: its summary says when, with
 * which provider and model, and the result in words; opening it shows that run's table. Native `<details>` is
 * keyboard operable (Tab to the summary, Enter or Space) with nothing to re-implement.
 */
function ControlCheckHistory({ runs }: { runs: readonly ControlCheckRun[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  return (
    <section aria-labelledby="control-checks-history-heading" className="flex flex-col gap-2">
      <h4 id="control-checks-history-heading" className="text-small font-medium text-text-primary">
        Past runs
      </h4>
      <ul className="flex flex-col gap-1" data-testid="control-checks-history">
        {runs.map((run, index) => (
          <li key={run.id} data-run={run.id}>
            <details
              className="rounded-md border border-border-hairline"
              onToggle={(event) => {
                const isOpen = event.currentTarget.open;
                setOpen((previous) => {
                  const next = new Set(previous);
                  if (isOpen) next.add(run.id);
                  else next.delete(run.id);
                  return next;
                });
              }}
            >
              <summary className="cursor-pointer px-3 py-2 text-small text-text-primary">
                {formatRunTime(run.startedAt)}
                {index === 0 ? ' (latest)' : ''} · {providerModelWords(run.provider, run.model)} ·{' '}
                <span className="font-medium">{runResultWords(run)}</span>
              </summary>
              {open.has(run.id) && (
                <div className="px-3 pb-3">
                  <ControlCheckTable run={run} testId={`control-checks-history-table-${run.id}`} />
                </div>
              )}
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
