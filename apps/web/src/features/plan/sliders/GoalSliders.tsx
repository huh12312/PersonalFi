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
import { buildPreviewJob, defaultLevers, type SliderLevers } from './buildPreviewJob.ts';
import { FALLBACK_DEBOUNCE_MS, PREVIEW_PATHS, REFINE_PATHS } from './defaults.ts';
import { SliderField } from './SliderField.tsx';

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
  const [levers, setLevers] = useState<SliderLevers>(() => defaultLevers(scenario));
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
    setLevers(next);
    if (available) {
      runPreview(next, PREVIEW_PATHS, false);
    } else {
      scheduleFallbackFetch();
    }
  }

  function handleCommit(patch: Partial<SliderLevers>): void {
    const next = { ...levers, ...patch };
    setLevers(next);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- `runPreview` calls `setPhase` synchronously before its async `client.run` resolves; see this effect's own comment.
    if (available && bands === null) runPreview(levers, PREVIEW_PATHS, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per worker becoming available
  }, [available]);

  const lastYearIndex = bands === null ? -1 : bands.years - 1;
  const lastAge = bands === null ? null : bands.startAge + lastYearIndex;
  const p50Index = bands === null ? -1 : bands.levels.indexOf(0.5);
  const lastP50 =
    bands === null || p50Index < 0
      ? null
      : (bands.bands[lastYearIndex + bands.years * p50Index] ?? null);
  const successProbability =
    bands === null || bands.paths === 0 ? null : bands.successCount / bands.paths;

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
          max={2_000_000}
          step={10_000}
          format={formatUsd}
          onChange={(v) => handleChange({ startingBalance: v })}
          onCommit={(v) => handleCommit({ startingBalance: v })}
        />
      </div>

      <div
        className="flex flex-col gap-1 rounded-md bg-bg-inset p-3 transition-opacity duration-normal ease-standard"
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
            Your saved plan:{' '}
            <Percent
              value={Number(projectionQuery.data.run.successProbability)}
              signDisplay="never"
            />{' '}
            of simulated paths succeed.
          </p>
        )}
      </div>
    </section>
  );
}
