// SPDX-License-Identifier: MIT
/**
 * `/narrator/control-checks` (WP 10.16): the GenAI controls self-test, Settings › Language model › Control checks.
 *
 * `GET` lists the last 20 runs (newest first), what a run costs in words, when the next run is allowed and when the
 * controls were last proven. While the newest run is `running` the list is read again every second, so its rows tick
 * over pending → running → pass / fail / skipped / reported. `POST` starts a run: session plus the passkey step-up
 * (the caller wraps it in `useStepUpRetry`), 202 with the run, every check pending.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  listNarratorControlChecksOptions,
  runNarratorControlChecksMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { ControlCheckRun, ControlCheckRuns } from './control-checks-words.ts';

/** How often the list is read while a run is going. */
export const CONTROL_CHECKS_POLL_MS = 1_000;

const listOptions = () => listNarratorControlChecksOptions();

/** The newest run is still going: keep reading. */
export function isRunning(data: ControlCheckRuns | undefined): boolean {
  return data?.runs[0]?.state === 'running';
}

/** `GET /narrator/control-checks`. `retry: false`: an api that predates the route degrades to a sentence. */
export function useControlChecksQuery() {
  return useQuery({
    ...listOptions(),
    staleTime: 10_000,
    retry: false,
    refetchInterval: (query) => (isRunning(query.state.data) ? CONTROL_CHECKS_POLL_MS : false),
  });
}

/** Re-reads the list now (e.g. once `nextAllowedAt` has passed, or after a 409). */
export function useRefreshControlChecks() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: listOptions().queryKey });
}

/**
 * `POST /narrator/control-checks` - step-up. The run it answers with goes to the top of the cached list at once,
 * so the table shows fifteen pending rows without waiting for the next read, and polling starts.
 */
export function useRunControlChecksMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...runNarratorControlChecksMutation(),
    gcTime: 0,
    onSuccess: async (run: ControlCheckRun) => {
      const key = listOptions().queryKey;
      queryClient.setQueryData<ControlCheckRuns>(key, (previous) =>
        previous === undefined
          ? previous
          : { ...previous, runs: [run, ...previous.runs.filter((r) => r.id !== run.id)] },
      );
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
