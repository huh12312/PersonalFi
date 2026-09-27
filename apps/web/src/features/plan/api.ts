// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  comparePlanScenariosOptions,
  createPlanLifeEventMutation,
  createPlanScenarioMutation,
  deletePlanLifeEventMutation,
  getAssumptionsOptions,
  getAssumptionsQueryKey,
  listPlanLifeEventsOptions,
  listPlanScenariosOptions,
  putAssumptionsOverridesMutation,
  updatePlanLifeEventMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { Sdk } from '../../api/generated/index.ts';
import type {
  CreatePlanScenarioData,
  RunPlanProjectionResponse,
  SolveRequiredSavingsData,
  SolveRequiredSavingsResponse,
} from '../../api/generated/types.gen.ts';

const STALE_TIME_MS = 15_000;

function invalidatePlanScenarios(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: listPlanScenariosOptions().queryKey });
}

function invalidateLifeEvents(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: listPlanLifeEventsOptions().queryKey });
}

/** `GET /plan/scenarios` — the baseline plus every fork the caller has saved. */
export function useScenariosQuery() {
  return useQuery({ ...listPlanScenariosOptions(), staleTime: STALE_TIME_MS });
}

/** `POST /plan/scenarios` — either shape (`docs/evidence/phase-4/wp4.8-routes.md` §2). */
export function useCreatePlanScenarioMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...createPlanScenarioMutation(),
    onSuccess: () => invalidatePlanScenarios(queryClient),
  });
}

/**
 * `POST /plan/scenarios/{id}/projections` — read via `useQuery`, not
 * `useMutation`: the route is a `POST` only because running an engine is not
 * side-effect-free at the database layer, but the response itself is a pure
 * function of `(scenario, assumptions, seed, method, paths)` and the server
 * already caches by that hash and re-serves an identical request without
 * re-running the engine (`wp4.8-routes.md` §6). Modelling it as a query
 * means a slider/tab change that lands back on an already-fetched
 * `(scenarioId, method, paths)` triple costs nothing.
 */
export function useProjectionQuery(
  scenarioId: string | undefined,
  params: { readonly method?: 'deterministic' | 'monte_carlo'; readonly paths?: number } = {},
) {
  return useQuery({
    queryKey: [{ _id: 'runPlanProjection', scenarioId, ...params }],
    queryFn: async ({ signal }) => {
      const { data } = await Sdk.__registry.get().runPlanProjection({
        path: { scenarioId: scenarioId ?? '' },
        body: params,
        signal,
        throwOnError: true,
      });
      return data;
    },
    enabled: scenarioId !== undefined,
    staleTime: STALE_TIME_MS,
  });
}

/** `GET /plan/compare?a=&b=` — both scenarios' projections plus the deltas, in one response. */
export function useCompareQuery(a: string | undefined, b: string | undefined) {
  return useQuery({
    ...comparePlanScenariosOptions({ query: { a: a ?? '', b: b ?? '' } }),
    enabled: a !== undefined && b !== undefined && a !== b,
    staleTime: STALE_TIME_MS,
  });
}

/** `GET /assumptions` — the whole cited file plus the caller's applied overrides. */
export function useAssumptionsQuery() {
  return useQuery({ ...getAssumptionsOptions(), staleTime: 60_000 });
}

/**
 * `PUT /assumptions/overrides` — full-set replacement semantics
 * (`docs/evidence/phase-4/wp4.8-routes.md` §11 item 4: "replaces the
 * *override set*"), so the caller must send every currently-applied override
 * plus its own change, never a single-path patch. Invalidates
 * `GET /assumptions` on success so the panel re-renders from the server's own
 * resolved value rather than an optimistic guess — an override is exactly the
 * kind of number this screen must never restate without the server's say-so.
 */
export function useOverrideAssumptionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...putAssumptionsOverridesMutation(),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: getAssumptionsQueryKey() }),
  });
}

/** `GET /plan/life-events` — draggable timeline markers. */
export function useLifeEventsQuery() {
  return useQuery({ ...listPlanLifeEventsOptions(), staleTime: STALE_TIME_MS });
}

export function useCreateLifeEventMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...createPlanLifeEventMutation(),
    onSuccess: () => invalidateLifeEvents(queryClient),
  });
}

/** `PATCH /plan/life-events/{id}` — moves a life event's date (the drag) or edits its amount/name. */
export function useUpdateLifeEventMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...updatePlanLifeEventMutation(),
    onSuccess: () => invalidateLifeEvents(queryClient),
  });
}

export function useDeleteLifeEventMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...deletePlanLifeEventMutation(),
    onSuccess: () => invalidateLifeEvents(queryClient),
  });
}

export interface RequiredSavingsState {
  readonly result: SolveRequiredSavingsResponse | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly solve: (body: SolveRequiredSavingsData['body']) => Promise<void>;
  readonly clear: () => void;
}

/**
 * `POST /plan/required-savings` — the dotted gap line's click handler
 * (`docs/plan/04-phase-4-dispatch.md` §3: "renders the answer — or renders
 * `unreachable` with its binding constraint, never a number implying a
 * solution"). Imperative, like `useBasisMethodElection`
 * (`features/investments/api.ts`), because the result renders in a fixed
 * panel next to the chart rather than as a row in a list a `useMutation`'s
 * cache would key naturally.
 */
export function useRequiredSavings(): RequiredSavingsState {
  const [result, setResult] = useState<SolveRequiredSavingsResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function solve(body: SolveRequiredSavingsData['body']): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const { data } = await Sdk.__registry.get().solveRequiredSavings({
        body,
        throwOnError: true,
      });
      setResult(data);
    } catch (cause) {
      setError(refusalMessageOf(cause));
      setResult(null);
    } finally {
      setPending(false);
    }
  }

  function clear(): void {
    setResult(null);
    setError(null);
  }

  return { result, pending, error, solve, clear };
}

/** Same rule as `features/investments/api.ts`'s own copy: the server's refusal, verbatim, never re-worded here. */
function refusalMessageOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const problem = cause as { detail?: unknown; title?: unknown };
    if (typeof problem.detail === 'string' && problem.detail !== '') return problem.detail;
    if (typeof problem.title === 'string' && problem.title !== '') return problem.title;
  }
  return 'The required-savings solver could not answer.';
}

export type { CreatePlanScenarioData, RunPlanProjectionResponse };
