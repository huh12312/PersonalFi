// SPDX-License-Identifier: MIT
/**
 * "Explain this" (WP 11.3): where an explanation stands for one insight or one health pillar, and the way to ask
 * for one.
 *
 * Rendering reads `GET …/explain` only — it never asks for anything: `idle` when nothing has been asked for the
 * evidence as it stands, an explanation (or its refusal) that is already there (asked earlier, or prefetched with
 * the Brief) shows without a tap, and `computing` resumes polling. Only the holder's tap (or "Try again") sends
 * `POST …/explain`, which answers 200 (`shown` / `refused` / `unavailable`) or 202 `computing` — the worker has
 * been asked, and the screen polls `GET` every 1.5 s until the state is anything else. Past three minutes of
 * `computing` it stops polling and says so, with a retry.
 *
 * A `GET` that fails (an api that predates the route, a network error) reads as `idle`: the button is offered and
 * the `POST` says why it cannot run, if it cannot. A `POST` that fails reads as `failed`, with a retry.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryFunction,
  type QueryKey,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getHealthPillarExplanationOptions,
  getInsightExplanationOptions,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { Sdk } from '../../api/generated/sdk.gen.ts';
import type { InsightExplanationState } from '../../api/generated/types.gen.ts';
import type { HealthComponentId } from '../health/types.ts';

export type { InsightExplanationState };
export type ExplanationStatus = InsightExplanationState['state'];

/** What is being explained: an insight by id, or a health pillar by its component id. */
export type ExplainEntity =
  | { readonly kind: 'insight'; readonly insightId: string }
  | { readonly kind: 'health_pillar'; readonly pillar: HealthComponentId };

/** How often `GET` is read while the worker is explaining. */
export const EXPLAIN_POLL_MS = 1_500;
/** How long the screen waits on `computing` before it stops polling and offers a retry. */
export const EXPLAIN_GIVE_UP_MS = 180_000;

/** Said when a `POST` itself fails (no state came back to say why). */
export const EXPLAIN_REQUEST_FAILED =
  'The explanation could not be asked for right now. The evidence is unchanged.';
/** Said, with a retry, once `computing` has run past `EXPLAIN_GIVE_UP_MS`. */
export const EXPLAIN_TAKING_LONG =
  'This is taking longer than usual. The evidence is unchanged; you can ask again.';

function queryFor(entity: ExplainEntity): {
  queryKey: QueryKey;
  queryFn: QueryFunction<InsightExplanationState>;
} {
  const options =
    entity.kind === 'insight'
      ? getInsightExplanationOptions({ path: { insightId: entity.insightId } })
      : getHealthPillarExplanationOptions({ path: { pillar: entity.pillar } });
  return {
    queryKey: options.queryKey,
    queryFn: options.queryFn as QueryFunction<InsightExplanationState>,
  };
}

async function post(entity: ExplainEntity): Promise<InsightExplanationState> {
  const sdk = Sdk.__registry.get();
  const { data } =
    entity.kind === 'insight'
      ? await sdk.explainInsight({ path: { insightId: entity.insightId }, throwOnError: true })
      : await sdk.explainHealthPillar({ path: { pillar: entity.pillar }, throwOnError: true });
  return data;
}

export interface Explanation {
  /** The state to draw. `computing` past the give-up time reads as `timed_out`. */
  readonly status: ExplanationStatus | 'loading' | 'timed_out';
  readonly data: InsightExplanationState | null;
  /** The sentence for `unavailable`, `refused`, `failed` and `timed_out` (the api's, or the screen's own). */
  readonly message: string | null;
  /** Ask (the button, or "Try again"). A no-op while a request is in flight. */
  readonly ask: () => void;
  /** True once the holder has asked in this mount (so the result can take focus when it lands). */
  readonly asked: boolean;
}

export interface UseExplanationOptions {
  readonly pollMs?: number;
  readonly giveUpMs?: number;
}

export function useExplanation(
  entity: ExplainEntity,
  { pollMs = EXPLAIN_POLL_MS, giveUpMs = EXPLAIN_GIVE_UP_MS }: UseExplanationOptions = {},
): Explanation {
  const queryClient = useQueryClient();
  const { queryKey, queryFn } = queryFor(entity);
  const [timedOut, setTimedOut] = useState(false);
  // Bumped by each ask, so the give-up clock restarts even when the state was already `computing`.
  const [attempt, setAttempt] = useState(0);
  const [asked, setAsked] = useState(false);
  const [postFailed, setPostFailed] = useState(false);

  const query = useQuery({
    queryKey,
    queryFn,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: (q) => (q.state.data?.state === 'computing' && !timedOut ? pollMs : false),
  });

  const mutation = useMutation({
    mutationFn: () => post(entity),
    onMutate: () => {
      setPostFailed(false);
      setTimedOut(false);
    },
    onSuccess: (state) => {
      queryClient.setQueryData(queryKey, state);
    },
    onError: () => setPostFailed(true),
  });

  const data = query.data ?? null;
  const serverState = data?.state ?? null;

  // The give-up clock: starts the first time `computing` is seen (on mount, or from a POST) and is cleared by any
  // other state. Past `giveUpMs` polling stops (`refetchInterval` reads `timedOut`) and the screen offers a retry.
  const computingSince = useRef<number | null>(null);
  useEffect(() => {
    if (serverState !== 'computing') {
      computingSince.current = null;
      return;
    }
    computingSince.current ??= Date.now();
    const left = computingSince.current + giveUpMs - Date.now();
    const timer = setTimeout(() => setTimedOut(true), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [serverState, giveUpMs, attempt]);

  const { mutate, isPending } = mutation;
  const ask = useCallback(() => {
    if (isPending) return;
    computingSince.current = null;
    setAsked(true);
    setAttempt((n) => n + 1);
    mutate();
  }, [isPending, mutate]);

  let status: Explanation['status'];
  let message: string | null = data?.message ?? null;
  if (mutation.isPending) status = 'computing';
  else if (postFailed) {
    status = 'failed';
    message = EXPLAIN_REQUEST_FAILED;
  } else if (query.isLoading) status = 'loading';
  else if (data === null) status = 'idle';
  else if (data.state === 'computing' && timedOut) {
    status = 'timed_out';
    message = EXPLAIN_TAKING_LONG;
  } else status = data.state;

  return { status, data, message, ask, asked };
}
