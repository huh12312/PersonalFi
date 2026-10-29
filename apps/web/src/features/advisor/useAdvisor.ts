// SPDX-License-Identifier: MIT
/**
 * The Advisor (WP 11.5d): the overview (availability, engine, examples, the holder's history), the ways to move a
 * session on (start, answer, pick, close), and the poll of one session.
 *
 * Rendering reads `GET /advisor/sessions` only - nothing is asked of a model until the holder sends a question. A
 * session that is going (its worker has a step to do) is read every `pollMs`; one that waits on the holder
 * (answers, a pick) or has ended is not. A `GET` that fails keeps what is on screen; a write that fails says so in
 * words (409 `insights.advisor_unavailable` refreshes the overview, which then says why).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getAdvisorOverviewOptions,
  getAdvisorOverviewQueryKey,
  getAdvisorSessionOptions,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { Sdk } from '../../api/generated/sdk.gen.ts';
import type { Problem } from '../../api/generated/types.gen.ts';
import {
  ADVISOR_POLL_MS,
  BRIEF_UNKNOWN_WORDS,
  EMPTY_QUESTION_WORDS,
  FINDING_NOT_FOUND_WORDS,
  FINDING_NOT_GRANTED_WORDS,
  FINDING_NOT_SUPPORTED_WORDS,
  IN_FLIGHT_WORDS,
  REQUEST_FAILED_WORDS,
  isIsoWeek,
  isWorking,
  type AdvisorOverview,
  type AdvisorSession,
} from './advisor-words.ts';

/** A session read from the overview carries no inspector; the detail read supplies one. */
const EMPTY_INSPECTOR = { contextDigest: null, steps: [] };

function problemOf(error: unknown): Problem | null {
  if (typeof error === 'object' && error !== null && 'code' in error) return error as Problem;
  return null;
}

/** The sentence for a failed write, from the problem's code (the api's own `detail` where it is plain words). */
export function advisorErrorWords(error: unknown): string {
  const problem = problemOf(error);
  switch (problem?.code) {
    case 'insights.advisor_in_flight':
      return IN_FLIGHT_WORDS;
    case 'insights.advisor_question_empty':
      return EMPTY_QUESTION_WORDS;
    case 'insights.advisor_unavailable':
      return 'The advisor cannot start a session right now.';
    case 'insights.advisor_finding_not_found':
      return FINDING_NOT_FOUND_WORDS;
    case 'insights.advisor_finding_not_supported':
      return FINDING_NOT_SUPPORTED_WORDS;
    case 'insights.advisor_finding_not_granted':
      return FINDING_NOT_GRANTED_WORDS;
    case 'insights.advisor_brief_unknown':
      return BRIEF_UNKNOWN_WORDS;
    case 'insights.advisor_not_awaiting_answers':
    case 'insights.advisor_not_awaiting_pick':
    case 'insights.advisor_session_closed':
      return 'This session has already moved on; it is shown as it stands.';
    default:
      return REQUEST_FAILED_WORDS;
  }
}

export interface UseAdvisorOptions {
  readonly pollMs?: number;
  /**
   * WP 11.5e, from the URL: `finding` (with its optional `week`) starts one session about that finding, once;
   * `session` opens an existing one. `onUrlSession` is told the id of the session the finding opened (so the URL can
   * carry `?session=` and a refresh never posts again) or `null` when it did not open one (so the URL sheds the
   * finding and a refresh does not retry).
   */
  readonly finding?: string | undefined;
  readonly week?: string | undefined;
  readonly session?: string | undefined;
  readonly onUrlSession?: (id: string | null) => void;
}

/** The body of `POST /advisor/sessions`: exactly one of a question and an origin. */
type StartBody =
  | { readonly question: string }
  | { readonly origin: { readonly insightId: string; readonly briefWeek?: string } };

export interface Advisor {
  readonly overview: AdvisorOverview | undefined;
  readonly overviewError: boolean;
  /** The session on screen (polled while it is going), or `null` when none is selected. */
  readonly session: AdvisorSession | null;
  /** True once the holder started, answered, picked or opened a session in this mount (so the result can take focus). */
  readonly touched: boolean;
  /** True while a request of the holder's own is on its way to the api. */
  readonly sending: boolean;
  readonly error: string | null;
  readonly start: (question: string, onSent?: () => void) => void;
  readonly answer: (answers: string[]) => void;
  readonly pick: (optionId: string) => void;
  readonly close: () => void;
  readonly select: (id: string) => void;
}

export function useAdvisor({
  pollMs = ADVISOR_POLL_MS,
  finding,
  week,
  session: sessionParam,
  onUrlSession,
}: UseAdvisorOptions = {}): Advisor {
  const queryClient = useQueryClient();
  const overviewQuery = useQuery({ ...getAdvisorOverviewOptions(), retry: false });
  const overview = overviewQuery.data;

  const [chosenId, setSelectedId] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A session that was going when the screen opened (a reload mid-run) is picked up where it stands: decided once,
  // from the first overview, while rendering (React's "adjust state when a value changes" pattern).
  const [resumedId, setResumedId] = useState<string | null | undefined>(undefined);
  if (resumedId === undefined && overview !== undefined) {
    setResumedId(overview.sessions.find((s) => isWorking(s))?.id ?? null);
  }
  const selectedId = chosenId ?? resumedId ?? null;

  const fromOverview = overview?.sessions.find((s) => s.id === selectedId);
  const sessionQuery = useQuery({
    ...getAdvisorSessionOptions({ path: { sessionId: selectedId ?? '' } }),
    enabled: selectedId !== null,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    ...(fromOverview === undefined
      ? {}
      : { initialData: { ...fromOverview, inspector: EMPTY_INSPECTOR } }),
    refetchInterval: (q) => {
      const data = q.state.data;
      return data !== undefined && isWorking(data) ? pollMs : false;
    },
  });
  const session: AdvisorSession | null =
    selectedId === null ? null : (sessionQuery.data ?? fromOverview ?? null);

  // When the going session reaches a state that waits or ends, the history needs its new row.
  const working = session === null ? undefined : isWorking(session);
  const lastWorking = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (lastWorking.current === true && working === false) {
      void queryClient.invalidateQueries({ queryKey: getAdvisorOverviewQueryKey() });
    }
    lastWorking.current = working;
  }, [working, queryClient]);

  const sessionKey = (id: string) => getAdvisorSessionOptions({ path: { sessionId: id } }).queryKey;

  /** A write answers with the whole session (200 or 202): written straight into the cache. */
  function took(next: AdvisorSession): void {
    queryClient.setQueryData(sessionKey(next.id), { inspector: EMPTY_INSPECTOR, ...next });
    setSelectedId(next.id);
    setTouched(true);
    void queryClient.invalidateQueries({ queryKey: getAdvisorOverviewQueryKey() });
  }

  function failed(cause: unknown): void {
    setError(advisorErrorWords(cause));
    const code = problemOf(cause)?.code;
    if (code === 'insights.advisor_unavailable') {
      void queryClient.invalidateQueries({ queryKey: getAdvisorOverviewQueryKey() });
    } else if (selectedId !== null && code !== undefined && code.startsWith('insights.advisor_')) {
      void queryClient.invalidateQueries({ queryKey: sessionKey(selectedId) });
    }
  }

  const startMutation = useMutation({
    mutationFn: async (body: StartBody): Promise<AdvisorSession> => {
      const { data } = await Sdk.__registry.get().startAdvisorSession({
        body,
        throwOnError: true,
      });
      return data;
    },
    onMutate: () => setError(null),
    // A session opened from a finding tells the URL, win or lose, so a refresh never posts a second time.
    onSuccess: (next, body) => {
      took(next);
      if ('origin' in body) onUrlSession?.(next.id);
    },
    onError: (cause, body) => {
      failed(cause);
      if ('origin' in body) onUrlSession?.(null);
    },
  });

  const answerMutation = useMutation({
    mutationFn: async (answers: string[]): Promise<AdvisorSession> => {
      const { data } = await Sdk.__registry.get().answerAdvisorSession({
        path: { sessionId: selectedId ?? '' },
        body: { answers },
        throwOnError: true,
      });
      return data;
    },
    onMutate: () => setError(null),
    onSuccess: took,
    onError: failed,
  });

  const pickMutation = useMutation({
    mutationFn: async (optionId: string): Promise<AdvisorSession> => {
      const { data } = await Sdk.__registry.get().pickAdvisorOption({
        path: { sessionId: selectedId ?? '' },
        body: { optionId: optionId as 'o1' },
        throwOnError: true,
      });
      return data;
    },
    onMutate: () => setError(null),
    onSuccess: took,
    onError: failed,
  });

  const closeMutation = useMutation({
    mutationFn: async (): Promise<AdvisorSession> => {
      const { data } = await Sdk.__registry.get().cancelAdvisorSession({
        path: { sessionId: selectedId ?? '' },
        throwOnError: true,
      });
      return data;
    },
    onMutate: () => setError(null),
    onSuccess: took,
    onError: failed,
  });

  const sending =
    startMutation.isPending ||
    answerMutation.isPending ||
    pickMutation.isPending ||
    closeMutation.isPending;

  const { mutate: mutateStart } = startMutation;
  const { mutate: mutateAnswer } = answerMutation;
  const { mutate: mutatePick } = pickMutation;
  const { mutate: mutateClose } = closeMutation;

  const start = useCallback(
    (question: string, onSent?: () => void) => {
      if (sending) return;
      mutateStart({ question }, { onSuccess: () => onSent?.() });
    },
    [mutateStart, sending],
  );
  const answer = useCallback(
    (answers: string[]) => {
      if (!sending) mutateAnswer(answers);
    },
    [mutateAnswer, sending],
  );
  const pick = useCallback(
    (optionId: string) => {
      if (!sending) mutatePick(optionId);
    },
    [mutatePick, sending],
  );
  const close = useCallback(() => {
    if (!sending) mutateClose();
  }, [mutateClose, sending]);
  const select = useCallback((id: string) => {
    setError(null);
    setSelectedId(id);
    setTouched(true);
  }, []);

  // `?session=<id>`: open that session (a link from the Brief, a refresh after a finding opened one). Adjusted while
  // rendering, when the URL's value changes (React's "adjust state when a value changes" pattern).
  const [seenSessionParam, setSeenSessionParam] = useState<string | undefined>(undefined);
  if (sessionParam !== seenSessionParam) {
    setSeenSessionParam(sessionParam);
    if (sessionParam !== undefined && sessionParam !== '') {
      setError(null);
      setSelectedId(sessionParam);
      setTouched(true);
    }
  }

  // `?finding=<id>`: start one session about it. The ref is what makes it once: it survives a StrictMode
  // remount, and the URL is replaced by `?session=` (or by nothing, on a refusal) as soon as the api has answered.
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (finding === undefined || finding === '' || startedFor.current === finding) return;
    startedFor.current = finding;
    const origin =
      week !== undefined && isIsoWeek(week)
        ? { insightId: finding, briefWeek: week }
        : { insightId: finding };
    mutateStart({ origin });
  }, [finding, week, mutateStart]);

  return {
    overview,
    overviewError: overviewQuery.isError,
    session,
    touched,
    sending,
    error,
    start,
    answer,
    pick,
    close,
    select,
  };
}
