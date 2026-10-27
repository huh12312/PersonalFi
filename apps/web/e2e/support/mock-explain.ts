// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * WP 11.3 ("Explain this"): `GET`/`POST /api/insights/{insightId}/explain` and
 * `GET`/`POST /api/insights/health/{pillar}/explain`, as a layerable mock in the shapes
 * `apps/api/src/routes/insight-explain.ts` sends (`InsightExplanationState`) and with its words.
 *
 * Every entity starts `idle` (nothing asked for its evidence). A test scripts an entity with `scriptExplanation`:
 * what `GET` answers before anything is asked, what `POST` answers, and — when `POST` answers 202 `computing` — how
 * many reads stay `computing` before the result. Every call is recorded (`calls`), so "rendering only reads" is
 * checkable. A `POST` for an unscripted entity answers what the api answers with the narrator Off.
 *
 * No model is involved anywhere: the explanation texts are fixtures, and each quotes only figures its entity's own
 * mocked evidence carries.
 */

export type ExplainEntityKind = 'insight' | 'health_pillar';

export interface ExplainBody {
  state: 'idle' | 'computing' | 'shown' | 'refused' | 'unavailable' | 'failed';
  entityKind: ExplainEntityKind;
  entityId: string;
  explanation: {
    text: string;
    provider: 'ollama' | 'openai' | 'openrouter' | 'anthropic';
    providerName: string;
    model: string;
    createdAt: string;
    runId: string;
  } | null;
  refusal: string | null;
  reason: string | null;
  message: string | null;
}

export interface ExplainScript {
  /** What `GET` answers before any `POST`. Default `idle`. */
  readonly initial?: ExplainBody;
  /** What `POST` answers. A `computing` body answers 202 and starts the reads below. */
  readonly post?: ExplainBody;
  /** How many `GET`s stay `computing` after a 202 before `result`. Default 1. */
  readonly computingReads?: number;
  /** What `GET` answers once the computing reads are spent. */
  readonly result?: ExplainBody;
}

interface Entry {
  script: ExplainScript;
  current: ExplainBody;
  readsLeft: number;
}

export interface ExplainMockState {
  /** `METHOD /path` of every explain call, in order. */
  readonly calls: string[];
  readonly entries: Map<string, Entry>;
}

/** The local model the mocks name: a pinned tag at a digest, as the api reports it. */
export const EXPLAIN_LOCAL_MODEL = `qwen2.5:7b-instruct-q4_K_M@sha256:${'3f'.repeat(32)}`;
export const EXPLAIN_LOCAL_BADGE =
  'Explained by the local model qwen2.5:7b-instruct-q4_K_M@sha256:3f3f3f3f3f3f…';

export const EXPLAIN_REFUSED_WORDS =
  "The explanation didn't pass the checks; the evidence below is the arithmetic.";
export const EXPLAIN_OFF_WORDS =
  'The language model is Off in Settings, so nothing can be explained.';

/** The Groceries insight (`mock-recurring-insights.ts`): its evidence carries $420.00; its value line $840.00. */
export const GROCERIES_EXPLANATION =
  'Groceries came to $420.00 in a recent month, more than it usually runs. If that gap holds for a year it adds up to the $840.00 this card says it is worth.';

/** The savings-rate pillar (`mock-health.ts`): 12 months of income $90,000.00 and spending $82,800.00, kept 8%. */
export const SAVINGS_RATE_EXPLANATION =
  'Over 12 months you brought in $90,000.00 and spent $82,800.00, so you kept 8% of your income. That is what puts this pillar in the fair band.';

export function explainBody(
  entityKind: ExplainEntityKind,
  entityId: string,
  state: ExplainBody['state'],
  overrides: Partial<ExplainBody> = {},
): ExplainBody {
  return {
    state,
    entityKind,
    entityId,
    explanation: null,
    refusal: null,
    reason: null,
    message: null,
    ...overrides,
  };
}

export function shownBody(
  entityKind: ExplainEntityKind,
  entityId: string,
  text: string,
): ExplainBody {
  return explainBody(entityKind, entityId, 'shown', {
    explanation: {
      text,
      provider: 'ollama',
      providerName: 'Local model',
      model: EXPLAIN_LOCAL_MODEL,
      createdAt: '2026-10-27T09:00:00.000Z',
      runId: '0190c000-0000-7000-8000-000000000113',
    },
  });
}

export function refusedBody(entityKind: ExplainEntityKind, entityId: string): ExplainBody {
  return explainBody(entityKind, entityId, 'refused', {
    refusal: 'figure_not_in_evidence',
    message: EXPLAIN_REFUSED_WORDS,
  });
}

const keyOf = (kind: ExplainEntityKind, id: string) => `${kind}:${id}`;

/** Scripts one entity (and resets it to its `initial`). */
export function scriptExplanation(
  state: ExplainMockState,
  kind: ExplainEntityKind,
  id: string,
  script: ExplainScript,
): void {
  state.entries.set(keyOf(kind, id), {
    script,
    current: script.initial ?? explainBody(kind, id, 'idle'),
    readsLeft: 0,
  });
}

function entryOf(state: ExplainMockState, kind: ExplainEntityKind, id: string): Entry {
  const key = keyOf(kind, id);
  let entry = state.entries.get(key);
  if (entry === undefined) {
    entry = { script: {}, current: explainBody(kind, id, 'idle'), readsLeft: 0 };
    state.entries.set(key, entry);
  }
  return entry;
}

function fulfil(route: Route, body: ExplainBody): Promise<void> {
  return route.fulfill({
    status: body.state === 'computing' ? 202 : 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/** Answers an explain path; `false` for any other path (the caller falls back). */
export async function handleExplain(
  route: Route,
  path: string,
  method: string,
  state: ExplainMockState,
): Promise<boolean> {
  const pillar = /^\/api\/insights\/health\/([^/]+)\/explain$/.exec(path);
  const insight = pillar === null ? /^\/api\/insights\/([^/]+)\/explain$/.exec(path) : null;
  if (pillar === null && insight === null) return false;
  if (method !== 'GET' && method !== 'POST') return false;
  const kind: ExplainEntityKind = pillar !== null ? 'health_pillar' : 'insight';
  const id = (pillar ?? insight)![1]!;
  state.calls.push(`${method} ${path}`);
  const entry = entryOf(state, kind, id);

  if (method === 'GET') {
    if (entry.current.state === 'computing') {
      if (entry.readsLeft > 0) entry.readsLeft -= 1;
      else entry.current = entry.script.result ?? shownBody(kind, id, 'An explanation.');
    }
    await fulfil(route, entry.current);
    return true;
  }

  const answer =
    entry.script.post ??
    explainBody(kind, id, 'unavailable', { reason: 'off', message: EXPLAIN_OFF_WORDS });
  entry.current = answer;
  entry.readsLeft = answer.state === 'computing' ? (entry.script.computingReads ?? 1) : 0;
  await fulfil(route, answer);
  return true;
}

export function createExplainState(): ExplainMockState {
  return { calls: [], entries: new Map() };
}

/** The layer on its own (`installSweepMocks` installs it for every screen). */
export async function installExplainMocks(page: Page): Promise<ExplainMockState> {
  const state = createExplainState();
  await page.route('**/api/insights/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (await handleExplain(route, path, request.method(), state)) return;
    return route.fallback();
  });
  return state;
}
