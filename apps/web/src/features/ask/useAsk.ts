// SPDX-License-Identifier: MIT
/**
 * Ask PersonalFi (WP 11.5c): the overview (availability, examples, the holder's history), the way to ask, and the
 * poll of one session.
 *
 * Rendering reads `GET /ask` only - nothing is asked of a model until the holder sends a question. `POST /ask`
 * answers 200 with a session that is already finished (the pre-check refused it, or it is out of scope) or 202 with
 * one that is `compiling`; the screen then reads `GET /ask/{id}` every `pollMs` until its status is not
 * `compiling`, `running` or `narrating`. A `GET` that fails keeps what is on screen; a `POST` that fails says so in
 * words (409 `insights.ask_unavailable` refreshes the overview, which then says why).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getAskOverviewOptions,
  getAskOverviewQueryKey,
  getAskSessionOptions,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { Sdk } from '../../api/generated/sdk.gen.ts';
import type { AskOverview, AskSession, Problem } from '../../api/generated/types.gen.ts';
import {
  ASK_POLL_MS,
  EMPTY_QUESTION_WORDS,
  IN_FLIGHT_WORDS,
  REQUEST_FAILED_WORDS,
  isInFlight,
  type AskStatus,
} from './ask-words.ts';

function problemOf(error: unknown): Problem | null {
  if (typeof error === 'object' && error !== null && 'code' in error) return error as Problem;
  return null;
}

/** The sentence for a failed `POST`, from the problem's code (the api's own `detail` for an unavailable one). */
export function askErrorWords(error: unknown): string {
  const problem = problemOf(error);
  switch (problem?.code) {
    case 'insights.ask_in_flight':
      return IN_FLIGHT_WORDS;
    case 'insights.ask_question_empty':
      return EMPTY_QUESTION_WORDS;
    case 'insights.ask_unavailable':
      return problem.detail ?? 'Questions cannot be asked right now.';
    default:
      return REQUEST_FAILED_WORDS;
  }
}

export interface UseAskOptions {
  readonly pollMs?: number;
}

export interface Ask {
  readonly overview: AskOverview | undefined;
  readonly overviewLoading: boolean;
  readonly overviewError: boolean;
  /** The session on screen (polled while it is going), or `null` when none is selected. */
  readonly session: AskSession | null;
  /** True once the holder sent a question or picked one in this mount (so the answer can take focus). */
  readonly touched: boolean;
  /** True while the question is on its way to the api (before any session exists). */
  readonly sending: boolean;
  readonly error: string | null;
  /** Sends a question; `onSent` runs once the api has taken it (so the box can be cleared). */
  readonly send: (question: string, onSent?: () => void) => void;
  readonly select: (id: string) => void;
}

export function useAsk({ pollMs = ASK_POLL_MS }: UseAskOptions = {}): Ask {
  const queryClient = useQueryClient();
  const overviewQuery = useQuery({ ...getAskOverviewOptions(), retry: false });
  const overview = overviewQuery.data;

  const [chosenId, setSelectedId] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A question that was going when the screen opened (a reload mid-run) is picked up where it stands: decided once,
  // from the first overview, while rendering (React's "adjust state when a value changes" pattern).
  const [resumedId, setResumedId] = useState<string | null | undefined>(undefined);
  if (resumedId === undefined && overview !== undefined) {
    setResumedId(overview.sessions.find((s) => isInFlight(s.status))?.id ?? null);
  }
  const selectedId = chosenId ?? resumedId ?? null;

  const fromOverview = overview?.sessions.find((s) => s.id === selectedId);
  const sessionQuery = useQuery({
    ...getAskSessionOptions({ path: { sessionId: selectedId ?? '' } }),
    enabled: selectedId !== null,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    ...(fromOverview === undefined ? {} : { initialData: fromOverview }),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status !== undefined && isInFlight(status) ? pollMs : false;
    },
  });
  const session = selectedId === null ? null : (sessionQuery.data ?? fromOverview ?? null);

  // When the going session finishes the history needs its new row.
  const status = session?.status;
  const lastStatus = useRef<AskStatus | undefined>(undefined);
  useEffect(() => {
    if (lastStatus.current !== undefined && isInFlight(lastStatus.current)) {
      if (status !== undefined && !isInFlight(status)) {
        void queryClient.invalidateQueries({ queryKey: getAskOverviewQueryKey() });
      }
    }
    lastStatus.current = status;
  }, [status, queryClient]);

  const mutation = useMutation({
    mutationFn: async (question: string): Promise<AskSession> => {
      const { data } = await Sdk.__registry.get().askQuestion({
        body: { question },
        throwOnError: true,
      });
      return data;
    },
    onMutate: () => setError(null),
    onSuccess: (created) => {
      queryClient.setQueryData(
        getAskSessionOptions({ path: { sessionId: created.id } }).queryKey,
        created,
      );
      setSelectedId(created.id);
      setTouched(true);
      void queryClient.invalidateQueries({ queryKey: getAskOverviewQueryKey() });
    },
    onError: (cause) => {
      setError(askErrorWords(cause));
      if (problemOf(cause)?.code === 'insights.ask_unavailable') {
        void queryClient.invalidateQueries({ queryKey: getAskOverviewQueryKey() });
      }
    },
  });

  const { mutate } = mutation;
  const send = useCallback(
    (question: string, onSent?: () => void) => {
      if (mutation.isPending) return;
      mutate(question, { onSuccess: () => onSent?.() });
    },
    [mutate, mutation.isPending],
  );
  const select = useCallback((id: string) => {
    setError(null);
    setSelectedId(id);
    setTouched(true);
  }, []);

  return {
    overview,
    overviewLoading: overviewQuery.isLoading,
    overviewError: overviewQuery.isError,
    session,
    touched,
    sending: mutation.isPending,
    error,
    send,
    select,
  };
}
