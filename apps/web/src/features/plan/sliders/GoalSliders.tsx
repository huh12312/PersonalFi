// SPDX-License-Identifier: MIT
/**
 * The client projection worker's UI — `docs/plan/04-phase-4-dispatch.md` §3
 * "WP 4.11", `docs/research/05-frontend-architecture.md` §5.7. A quick
 * what-if sandbox beside the server-authoritative fan chart above it
 * (`../FanChart.tsx`) — **never a replacement for it** (D20: the server
 * remains authoritative for saved scenarios; this panel's own header in
 * `./buildPreviewJob.ts` states exactly where its numbers approximate).
 *
 * Mechanics, per the dispatch:
 *   * The worker (`../../../workers/projection-client.ts`) is created once,
 *     on this component's mount — which happens when `/plan` itself mounts,
 *     not on the first drag — with a `requestIdleCallback` warm-up.
 *   * While a slider drags (`onValueChange`): 250 paths, no debounce, no
 *     network request — the whole point of running the kernel locally.
 *   * On release (`onValueCommitted`): 5,000 paths, and the status text says
 *     "Refining…" until that heavier run resolves.
 *   * A newer request always wins over a slower, older one (`requestIdRef`) —
 *     dragging fast must never let a stale 250-path reply clobber a later
 *     one, and a refine must never lose to a preview that started after it
 *     but resolved first is impossible by construction (each new call
 *     bumps the id before the previous await can apply its result).
 *   * `Worker` unavailable: every lever change instead debounces 300ms
 *     (`FALLBACK_DEBOUNCE_MS`) and re-fetches the *server's* existing
 *     projection for the loaded scenario (`../api.ts#useProjectionQuery`,
 *     already fetched by `../PlanScreen.tsx` — calling the hook again here
 *     shares its cache, no duplicate subscription cost) — a real network
 *     request, and a visible state names why.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { BaselineScenario } from '../../../api/generated/types.gen.ts';
import { Percent } from '../../../components/finance/Percent.tsx';
import {
  createProjectionClient,
  type ProjectionBands,
  type ProjectionClient,
} from '../../../workers/projection-client.ts';
import { useProjectionQuery } from '../api.ts';
import { isProbabilistic, SINGLE_PATH_OUTCOME_WORDS, singlePathOutcome } from '../engine.ts';
import {
  buildPreviewJob,
  defaultLevers,
  leverSources,
  type SliderLevers,
} from './buildPreviewJob.ts';
import { FALLBACK_DEBOUNCE_MS, PREVIEW_PATHS, REFINE_PATHS } from './defaults.ts';
import { PLACEHOLDER_REASON_WORDS } from './sealedStart.ts';
import { SliderField } from './SliderField.tsx';
import { useSealedStart } from './useSealedStart.ts';

export interface GoalSlidersProps {
  readonly scenario: BaselineScenario;
}

type Phase = 'previewing' | 'refining' | 'ready';

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function formatUsd(value: number): string {
  return USD.format(value);
}

/** A 64-bit pattern in `[0, 2^64)` — the kernel's own seed contract (`../../../workers/kernel/prng.ts`). */
function randomSeed64(): bigint {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    // No Web Crypto (an old or hardened browser): still deterministic-shaped, just not
    // cryptographically random — this seed only ever drives a client-side preview, never
    // anything persisted or compared against the server's own seed.
    return BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
  }
  const words = crypto.getRandomValues(new Uint32Array(2));
  return ((BigInt(words[0] ?? 0) << 32n) | BigInt(words[1] ?? 0)) & ((1n << 64n) - 1n);
}

export function GoalSliders({ scenario }: GoalSlidersProps) {
  const [client, setClient] = useState<ProjectionClient | null>(null);
  // What the holder has changed by hand; everything else is the saved plan's own, or the sealed
  // starting balance (G4-11), re-derived each render so it follows the series query when it settles.
  const [edited, setEdited] = useState<Partial<SliderLevers>>({});
  const sealedStart = useSealedStart();
  const sealedAmount = sealedStart.source.kind === 'sealed' ? sealedStart.source.amount : undefined;
  const levers: SliderLevers = { ...defaultLevers(scenario, sealedAmount), ...edited };
  const sources = leverSources(scenario);
  const [bands, setBands] = useState<ProjectionBands | null>(null);
  const [phase, setPhase] = useState<Phase>('previewing');
  const [fallbackFetching, setFallbackFetching] = useState(false);

  const seedRef = useRef<bigint | undefined>(undefined);
  seedRef.current ??= randomSeed64();
  const requestIdRef = useRef(0);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const projectionQuery = useProjectionQuery(scenario.id);

  // Created once, on mount — dispatch §3: "spun up on route entry (not first drag)". A `useEffect`
  // (not a lazy `useState` initialiser) so React's own lifecycle — including Strict Mode's
  // mount → cleanup → mount in development — owns exactly one live worker per real mount.
  useEffect(() => {
    const created = createProjectionClient();
    // Publishing a newly-created external resource (the worker) — the canonical
    // "synchronize with an external system" case react-hooks/set-state-in-effect can't tell
    // apart from "should have been computed during render" here (it can't: `Worker` construction
    // is itself the side effect).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClient(created);
    return () => created.terminate();
  }, []);

  useEffect(
    () => () => {
      if (fallbackTimerRef.current !== null) clearTimeout(fallbackTimerRef.current);
    },
    [],
  );

  const available = client?.available ?? false;
  const startingBalanceMax = Math.max(
    2_000_000,
    Math.ceil((levers.startingBalance * 1.25) / 100_000) * 100_000,
  );

  function runPreview(nextLevers: SliderLevers, paths: number, committed: boolean): void {
    if (client === null || !client.available) return;
    const requestId = (requestIdRef.current += 1);
    const job = buildPreviewJob({ scenario, levers: nextLevers, seed: seedRef.current!, paths });
    setPhase(committed ? 'refining' : 'previewing');
    void client
      .run(job)
      .then((next) => {
        if (requestIdRef.current !== requestId) return; // a newer request already won
        setBands(next);
        setPhase(committed ? 'ready' : 'previewing');
      })
      .catch(() => {
        // A worker-side refusal/crash: leave the last good bands on screen rather than blank the panel.
      });
  }

  function scheduleFallbackFetch(): void {
    setFallbackFetching(true);
    if (fallbackTimerRef.current !== null) clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = setTimeout(() => {
      void projectionQuery.refetch().finally(() => setFallbackFetching(false));
    }, FALLBACK_DEBOUNCE_MS);
  }

  function handleChange(patch: Partial<SliderLevers>): void {
    const next = { ...levers, ...patch };
    setEdited((previous) => ({ ...previous, ...patch }));
    if (available) {
      runPreview(next, PREVIEW_PATHS, false);
    } else {
      scheduleFallbackFetch();
    }
  }

  function handleCommit(patch: Partial<SliderLevers>): void {
    const next = { ...levers, ...patch };
    setEdited((previous) => ({ ...previous, ...patch }));
    if (available) {
      runPreview(next, REFINE_PATHS, true);
    } else {
      scheduleFallbackFetch();
    }
  }

  // An initial 250-path preview as soon as the worker is ready, so the panel shows something
  // before the first drag rather than an empty state — reacting to an external system (the
  // worker) becoming available, not a value derivable during render.
  useEffect(() => {
    // Waits for the sealed-balance lookup to settle, so the first figure on screen is not one it replaces.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- `runPreview` calls `setPhase` synchronously before its async `client.run` resolves; see this effect's own comment.
    if (available && sealedStart.ready && bands === null) runPreview(levers, PREVIEW_PATHS, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per worker becoming available and the lookup settling
  }, [available, sealedStart.ready]);

  const lastYearIndex = bands === null ? -1 : bands.years - 1;
  const lastAge = bands === null ? null : bands.startAge + lastYearIndex;
  const p50Index = bands === null ? -1 : bands.levels.indexOf(0.5);
  const lastP50 =
    bands === null || p50Index < 0
      ? null
      : (bands.bands[lastYearIndex + bands.years * p50Index] ?? null);
  const successProbability =
    bands === null || bands.paths === 0 ? null : bands.successCount / bands.paths;

  // The starting balance is the preview's one money input the holder never typed: when it is the
  // placeholder, every sentence it feeds is an illustration and says so.
  const illustrationOnly =
    sealedStart.source.kind === 'placeholder' && edited.startingBalance === undefined;

  const statusText = useMemo(() => {
    if (!available) {
      return fallbackFetching
        ? 'Worker unavailable — updating your saved plan’s projection…'
        : 'Worker unavailable — showing your saved plan’s last calculated projection.';
    }
    if (phase === 'refining') return 'Refining…';
    if (bands === null) return 'Preview loading…';
    return `Preview based on ${bands.paths.toLocaleString()} simulated paths`;
  }, [available, fallbackFetching, phase, bands]);

  return (
    <section
      aria-label="Try adjustments"
      className="flex flex-col gap-4 rounded-md border border-border-hairline p-4"
      data-testid="goal-sliders"
    >
      <h2 className="text-h3 font-semibold text-text-primary">Try adjustments</h2>
      <p className="text-caption text-text-muted">
        A quick, local what-if preview — your saved plan above is unchanged until you act on it.
      </p>
      <p className="text-caption text-text-muted" data-testid="slider-preview-divergence-note">
        This preview does not include a dated one-time expense or income, or a crypto holding, if
        your saved plan has one — the plan above does.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <SliderField
          id="slider-retire-age"
          label="Retirement age"
          value={levers.retireAge}
          min={45}
          max={80}
          format={(v) => `Age ${String(v)}`}
          onChange={(v) => handleChange({ retireAge: v })}
          onCommit={(v) => handleCommit({ retireAge: v })}
        />
        <SliderField
          id="slider-annual-spending"
          label="Annual spending"
          value={levers.annualSpending}
          min={0}
          max={200_000}
          step={1_000}
          format={formatUsd}
          onChange={(v) => handleChange({ annualSpending: v })}
          onCommit={(v) => handleCommit({ annualSpending: v })}
        />
        <SliderField
          id="slider-monthly-savings"
          label="Monthly savings"
          value={levers.monthlySavings}
          min={0}
          max={10_000}
          step={100}
          format={formatUsd}
          onChange={(v) => handleChange({ monthlySavings: v })}
          onCommit={(v) => handleCommit({ monthlySavings: v })}
        />
        <SliderField
          id="slider-starting-balance"
          label="Starting balance"
          value={levers.startingBalance}
          min={0}
          max={startingBalanceMax}
          step={10_000}
          inputStep={1}
          format={formatUsd}
          onChange={(v) => handleChange({ startingBalance: v })}
          onCommit={(v) => handleCommit({ startingBalance: v })}
        />
      </div>

      <StartSourceNote
        start={sealedStart}
        edited={edited.startingBalance !== undefined}
        placeholders={[
          ...(sources.annualSpending === 'placeholder' && edited.annualSpending === undefined
            ? ['annual spending']
            : []),
          ...(sources.monthlySavings === 'placeholder' && edited.monthlySavings === undefined
            ? ['monthly savings']
            : []),
        ]}
        startingBalance={levers.startingBalance}
      />

      <div
        className="flex flex-col gap-1 rounded-md bg-bg-inset p-3 transition-opacity duration-base ease-standard"
        style={{ opacity: phase === 'refining' ? 0.7 : 1 }}
        data-testid="slider-preview"
      >
        <p
          role="status"
          aria-live="polite"
          data-testid="slider-status"
          className="text-small text-text-secondary"
        >
          {statusText}
        </p>
        {illustrationOnly && (
          <p className="text-caption text-text-muted" data-testid="slider-placeholder-note">
            Illustration only: the starting balance is a placeholder, not your data.
          </p>
        )}
        {available && bands !== null && lastP50 !== null && successProbability !== null && (
          <p className="text-body text-text-primary">
            Median at age {lastAge}:{' '}
            <span data-testid="slider-preview-median" className="font-semibold tabular-nums">
              {formatUsd(lastP50)}
            </span>{' '}
            — <Percent value={successProbability} signDisplay="never" /> of simulated paths succeed
          </p>
        )}
        {!available && projectionQuery.data?.run != null && (
          <p data-testid="slider-worker-fallback" className="text-body text-text-primary">
            {isProbabilistic(projectionQuery.data.run) ? (
              <>
                Your saved plan:{' '}
                <Percent
                  value={Number(projectionQuery.data.run.successProbability)}
                  signDisplay="never"
                />{' '}
                of simulated paths succeed.
              </>
            ) : (
              <>
                Your saved plan is a single deterministic path, and it{' '}
                {SINGLE_PATH_OUTCOME_WORDS[singlePathOutcome(projectionQuery.data.run)]}.
              </>
            )}
          </p>
        )}
      </div>
    </section>
  );
}

interface StartSourceNoteProps {
  readonly start: ReturnType<typeof useSealedStart>;
  readonly edited: boolean;
  readonly placeholders: readonly string[];
  readonly startingBalance: number;
}

/**
 * Says where the starting balance came from (G4-11): the newest sealed net-worth day, or a
 * placeholder that is not the holder's data. Spending and savings that fall back to this panel's
 * own defaults are named the same way.
 */
function StartSourceNote({ start, edited, placeholders, startingBalance }: StartSourceNoteProps) {
  const { source, ready } = start;
  let text;
  if (!ready) {
    text = 'Looking up your newest sealed net-worth day…';
  } else if (source.kind === 'sealed') {
    text = edited
      ? `Starting balance changed by you. Your investable balance on ${source.asOfDate}, the newest sealed net-worth day, is ${formatUsd(source.amount)}.`
      : `Starting balance: your investable balance on ${source.asOfDate}, the newest sealed net-worth day. Change it to try another figure.`;
  } else {
    text = edited
      ? `Starting balance changed by you. It is not your data: ${PLACEHOLDER_REASON_WORDS[source.reason]}.`
      : `Starting balance: ${formatUsd(startingBalance)} is a placeholder, not your data — ${PLACEHOLDER_REASON_WORDS[source.reason]}.`;
  }
  return (
    <div className="flex flex-col gap-1 text-caption text-text-muted">
      <p
        data-testid="slider-start-source"
        data-start-source={ready ? source.kind : 'loading'}
        data-start-edited={edited ? 'true' : 'false'}
      >
        {text}
      </p>
      {placeholders.length > 0 && (
        <p data-testid="slider-lever-placeholders">
          {placeholders.join(' and ')[0]?.toUpperCase()}
          {placeholders.join(' and ').slice(1)} {placeholders.length === 1 ? 'is' : 'are'} also a
          placeholder: your saved plan does not state {placeholders.length === 1 ? 'it' : 'them'}.
        </p>
      )}
    </div>
  );
}
