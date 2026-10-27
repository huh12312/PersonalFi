// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * WP 11.2's network layer, in the shapes `apps/api/src/routes/category-suggestions.ts` really sends.
 *
 * - `handleCategorySuggestions` answers `/api/categories/suggestions/*` with real state, wired into `mock-api.ts`
 *   (so Settings › Language model always has the card): every write needs a fresh step-up (403
 *   `step_up_required`, as the api's `requireFreshSession`); `POST .../measure` answers 202 and the next queued
 *   result appears in the settings after `readsToResult` reads (the worker's run); the gate opens at 85 % over at
 *   least 20 scored rows; `POST .../enabled` refuses below it with the api's 409 `categorization.suggestions_below_gate`.
 * - `installCategorySuggestionMocks` is layered **on top of** `installApiMocks` (or `installSweepMocks`), registered
 *   after them so it runs first and `route.fallback()`s the rest: `GET /transactions/explanations` with the model's
 *   suggestion on `mock-api.ts`'s `txn_1` (Blue Bottle Coffee → Coffee Shops), and
 *   `POST /transactions/{id}/suggestion/reject`, after which that merchant's suggestion is gone. `PATCH
 *   /transactions/{id}` is recorded and handed on to `mock-api.ts`, which files the row.
 */

export const SUGGESTED_TRANSACTION_ID = 'txn_1';
export const SUGGESTED_MERCHANT = 'Blue Bottle Coffee';
export const SUGGESTED_CATEGORY_ID = 'cat_dining_coffee';
export const SUGGESTED_CATEGORY_KEY = 'dining.coffee';
export const SUGGESTED_CATEGORY_LABEL = 'Coffee Shops';
export const SUGGESTED_REASON =
  'The payee reads like a coffee bar and the amount is a small card purchase.';
export const SUGGESTION_CHIP = `Suggested by the model: ${SUGGESTED_CATEGORY_LABEL} — ${SUGGESTED_REASON}`;
export const ABSTAINED_LINE =
  'Every tier abstained: none of your 4 rules matched, merchant confirmed 1 of 3 times needed, no bank category, classifier 41 % below its 60 % floor.';
const NOT_RECORDED_LINE = 'No categorisation pass has recorded its working for this yet.';

export const SUGGEST_MODEL = 'qwen2.5:7b-instruct-q4_K_M';
const MIN_PRECISION = 0.85;
const MIN_SCORED = 20;

type Choice = 'narrator' | 'classifier';

export interface SuggestionEval {
  id: string;
  modelChoice: Choice;
  model: string;
  modelDigest: string | null;
  status: 'completed' | 'failed';
  failure: string | null;
  goldTotal: number;
  residue: number;
  asked: number;
  scored: number;
  correct: number;
  abstained: number;
  refused: number;
  precision: number | null;
  coverage: number | null;
  confusions: Array<{ expected: string; got: string; count: number }>;
  measuredAt: string;
}

interface SuggestionModel {
  choice: Choice;
  label: string | null;
  provider: string | null;
  available: boolean;
  unavailableReason: string | null;
  latest: SuggestionEval | null;
}

export interface SuggestionSettingsBody {
  state: 'no_model' | 'not_measured' | 'below_gate' | 'ready' | 'on';
  enabled: boolean;
  gate: {
    open: boolean;
    reason: 'not_measured' | 'measurement_failed' | 'too_few_rows' | 'below_precision' | null;
    minPrecision: number;
    minScored: number;
  };
  modelChoice: Choice;
  models: SuggestionModel[];
  approval: { queryShape: string | null; approved: boolean; live: number };
  hosted: { applies: boolean; consented: boolean; consentText: string; consentTextSha256: string };
}

/** 72 % over 25 scored rows: below the gate. */
export const BELOW_GATE_RESULT: SuggestionEval = {
  id: '0190c000-0000-7000-8000-00000000e201',
  modelChoice: 'narrator',
  model: SUGGEST_MODEL,
  modelDigest: `sha256:${'3f'.repeat(32)}`,
  status: 'completed',
  failure: null,
  goldTotal: 140,
  residue: 40,
  asked: 40,
  scored: 25,
  correct: 18,
  abstained: 12,
  refused: 3,
  precision: 0.72,
  coverage: 0.625,
  confusions: [
    { expected: 'dining.restaurants', got: 'dining.coffee', count: 4 },
    { expected: 'dining.coffee', got: 'dining.restaurants', count: 2 },
    { expected: 'groceries', got: 'dining', count: 1 },
  ],
  measuredAt: '2026-10-20T10:00:00.000Z',
};

/** 91 % over 34 scored rows: past the gate. */
export const ABOVE_GATE_RESULT: SuggestionEval = {
  ...BELOW_GATE_RESULT,
  id: '0190c000-0000-7000-8000-00000000e202',
  scored: 34,
  correct: 31,
  abstained: 5,
  refused: 1,
  precision: 31 / 34,
  coverage: 34 / 40,
  confusions: [{ expected: 'dining.restaurants', got: 'dining.coffee', count: 3 }],
  measuredAt: '2026-10-21T10:00:00.000Z',
};

export interface CategorySuggestionsMockState {
  settings: SuggestionSettingsBody;
  /** What the next measurements report, in order (a measure with none left reports nothing). */
  results: SuggestionEval[];
  /** Settings reads after a measure before its result appears. */
  readsToResult: number;
  /** `METHOD path` + body of every write that got past the step-up. */
  writes: Array<{ call: string; body: unknown }>;
  /** Writes refused for a stale session. */
  stepUpsAsked: number;
  pending: { choice: Choice; reads: number; result: SuggestionEval } | null;
}

export function createCategorySuggestionsState(
  overrides: Partial<CategorySuggestionsMockState> = {},
): CategorySuggestionsMockState {
  return {
    settings: {
      state: 'not_measured',
      enabled: false,
      gate: {
        open: false,
        reason: 'not_measured',
        minPrecision: MIN_PRECISION,
        minScored: MIN_SCORED,
      },
      modelChoice: 'narrator',
      models: [
        {
          choice: 'narrator',
          label: SUGGEST_MODEL,
          provider: 'ollama',
          available: true,
          unavailableReason: null,
          latest: null,
        },
        {
          choice: 'classifier',
          label: null,
          provider: null,
          available: false,
          unavailableReason: 'no second local model is configured',
          latest: null,
        },
      ],
      approval: { queryShape: null, approved: false, live: 0 },
      hosted: {
        applies: false,
        consented: false,
        consentText:
          'Send the names of merchants the categoriser could not decide, with my category list, to the hosted provider to suggest a category. Merchant names leave this machine.',
        consentTextSha256: `sha256:${'ab'.repeat(32)}`,
      },
    },
    results: [BELOW_GATE_RESULT, ABOVE_GATE_RESULT],
    readsToResult: 2,
    writes: [],
    stepUpsAsked: 0,
    pending: null,
    ...overrides,
  };
}

/** Recomputes `state` and the gate from the chosen model's latest result, as the api does on every read. */
function settle(settings: SuggestionSettingsBody): void {
  const model = settings.models.find((m) => m.choice === settings.modelChoice);
  const latest = model?.latest ?? null;
  if (model === undefined || !model.available) {
    settings.gate = { ...settings.gate, open: false, reason: 'not_measured' };
    settings.state = 'no_model';
    settings.enabled = false;
    return;
  }
  const reason =
    latest === null
      ? 'not_measured'
      : latest.status === 'failed'
        ? 'measurement_failed'
        : latest.scored < MIN_SCORED
          ? 'too_few_rows'
          : (latest.precision ?? 0) < MIN_PRECISION
            ? 'below_precision'
            : null;
  settings.gate = { ...settings.gate, open: reason === null, reason };
  if (reason !== null) settings.enabled = false;
  settings.state = settings.enabled
    ? 'on'
    : reason === null
      ? 'ready'
      : reason === 'not_measured'
        ? 'not_measured'
        : 'below_gate';
}

/** Puts a measurement in place for the chosen model (a test that starts from a measured state). */
export function seedSuggestionResult(
  state: CategorySuggestionsMockState,
  result: SuggestionEval,
): void {
  state.settings.models = state.settings.models.map((m) =>
    m.choice === result.modelChoice ? { ...m, latest: result } : m,
  );
  settle(state.settings);
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

const STEP_UP = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  code: 'step_up_required',
};

export async function handleCategorySuggestions(
  route: Route,
  path: string,
  method: string,
  state: CategorySuggestionsMockState,
  isFresh: () => boolean,
): Promise<boolean> {
  if (!path.startsWith('/api/categories/suggestions/')) return false;
  const raw = route.request().postData();
  const body = raw === null || raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
  const settings = state.settings;

  if (path === '/api/categories/suggestions/settings' && method === 'GET') {
    if (state.pending !== null) {
      state.pending.reads += 1;
      if (state.pending.reads >= state.readsToResult) {
        const result = { ...state.pending.result, modelChoice: state.pending.choice };
        state.pending = null;
        seedSuggestionResult(state, result);
      }
    }
    await route.fulfill(json(settings));
    return true;
  }

  if (path === '/api/categories/suggestions/preview' && method === 'GET') {
    await route.fulfill(
      json({
        advisorId: 'builtin.categorization.suggest',
        advisorVersion: '1.0.0',
        queryShape: 'categorization.suggest:v1',
        scopes: ['categorization.residue'],
        promptTemplateHash: `sha256:${'cd'.repeat(32)}`,
        provider: 'ollama',
        model: SUGGEST_MODEL,
        payload: { rows: 2 },
        prompt: {
          text: JSON.stringify({
            messages: [
              {
                role: 'system',
                content:
                  'Suggest one category key from the list for each row, or abstain. Reply in the format given.',
              },
              {
                role: 'user',
                content:
                  '<untrusted_data>{"rows":[{"payee_tokens":["blue","bottle"],"amount_bucket":"2"}]}</untrusted_data>',
              },
            ],
          }),
          hash: `sha256:${'ef'.repeat(32)}`,
        },
        approved: settings.approval.approved,
      }),
    );
    return true;
  }

  const writes = new Set([
    'PUT /api/categories/suggestions/settings',
    'PUT /api/categories/suggestions/hosted-consent',
    'POST /api/categories/suggestions/approve',
    'POST /api/categories/suggestions/measure',
    'POST /api/categories/suggestions/enabled',
  ]);
  const call = `${method} ${path}`;
  if (!writes.has(call)) return false;
  if (!isFresh()) {
    state.stepUpsAsked += 1;
    await route.fulfill(json(STEP_UP, 403));
    return true;
  }
  state.writes.push({ call, body });

  switch (call) {
    case 'PUT /api/categories/suggestions/settings': {
      settings.modelChoice = body['modelChoice'] === 'classifier' ? 'classifier' : 'narrator';
      settle(settings);
      await route.fulfill(json(settings));
      return true;
    }
    case 'PUT /api/categories/suggestions/hosted-consent': {
      settings.hosted = { ...settings.hosted, consented: body['consent'] === true };
      await route.fulfill(json(settings));
      return true;
    }
    case 'POST /api/categories/suggestions/approve': {
      settings.approval = {
        queryShape: String(body['queryShape']),
        approved: true,
        live: 1,
      };
      await route.fulfill(
        json({
          approvalId: '0190d000-0000-7000-8000-00000000e2aa',
          queryShape: body['queryShape'],
        }),
      );
      return true;
    }
    case 'POST /api/categories/suggestions/measure': {
      const choice: Choice = body['modelChoice'] === 'classifier' ? 'classifier' : 'narrator';
      const deduped = state.pending !== null;
      const next = deduped ? undefined : state.results.shift();
      if (next !== undefined) state.pending = { choice, reads: 0, result: next };
      await route.fulfill(
        json({ jobId: '0190d000-0000-7000-8000-00000000e2bb', deduped, modelChoice: choice }, 202),
      );
      return true;
    }
    case 'POST /api/categories/suggestions/enabled': {
      const enabled = body['enabled'] === true;
      settle(settings);
      if (enabled && !settings.gate.open) {
        const latest = settings.models.find((m) => m.choice === settings.modelChoice)?.latest;
        const figure =
          latest === null || latest === undefined || latest.precision === null
            ? 'not measured yet'
            : `${String(Math.round(latest.precision * 100))} % on ${String(latest.scored)}`;
        await route.fulfill(
          json(
            {
              type: 'about:blank',
              title: 'Conflict',
              status: 409,
              code: 'categorization.suggestions_below_gate',
              detail: `Suggestions stay off below 85 % precision over at least 20 rows of your own history (${figure}).`,
            },
            409,
          ),
        );
        return true;
      }
      settings.enabled = enabled;
      settle(settings);
      await route.fulfill(json(settings));
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The chip's layer: explanations with a suggestion, and "Not this"
// ---------------------------------------------------------------------------

export interface SuggestionChipMockState {
  /** The `ids` of every `GET /transactions/explanations`. */
  readonly explanationBatches: string[];
  /** `POST /transactions/{id}/suggestion/reject`, by transaction id, in order. */
  readonly rejects: string[];
  /** `PATCH /transactions/{id}` bodies, in order (each also answered by `mock-api.ts`). */
  readonly patches: Array<{ transactionId: string; body: Record<string, unknown> }>;
}

function explanationFor(transactionId: string, rejected: ReadonlySet<string>) {
  if (transactionId === SUGGESTED_TRANSACTION_ID) {
    return {
      transactionId,
      status: 'abstained',
      source: 'none',
      categoryKey: null,
      confidence: null,
      decidedAt: '2026-10-20T08:00:00.000Z',
      line: ABSTAINED_LINE,
      tiers: [
        { source: 'rule', won: false, detail: 'No rule matched.' },
        { source: 'merchant_default', won: false, detail: 'Merchant confirmed 1 of 3 times.' },
        { source: 'provider', won: false, detail: 'No bank category.' },
        { source: 'classifier', won: false, detail: 'Below the confidence floor.' },
      ],
      suggestion: rejected.has(transactionId)
        ? null
        : {
            source: 'model',
            categoryId: SUGGESTED_CATEGORY_ID,
            categoryKey: SUGGESTED_CATEGORY_KEY,
            categoryLabel: SUGGESTED_CATEGORY_LABEL,
            reason: SUGGESTED_REASON,
            suggestedAt: '2026-10-20T08:05:00.000Z',
          },
    };
  }
  return {
    transactionId,
    status: 'not_recorded',
    source: null,
    categoryKey: null,
    confidence: null,
    decidedAt: null,
    line: NOT_RECORDED_LINE,
    tiers: [],
    suggestion: null,
  };
}

export async function installCategorySuggestionMocks(page: Page): Promise<SuggestionChipMockState> {
  const state: SuggestionChipMockState = { explanationBatches: [], rejects: [], patches: [] };
  const rejected = new Set<string>();

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/transactions/explanations' && method === 'GET') {
      const ids = url.searchParams
        .getAll('ids')
        .flatMap((value) => value.split(','))
        .filter((id) => id !== '');
      state.explanationBatches.push(ids.join(','));
      return route.fulfill(json({ items: ids.map((id) => explanationFor(id, rejected)) }));
    }

    const rejectMatch = /^\/api\/transactions\/([^/]+)\/suggestion\/reject$/.exec(path);
    if (rejectMatch && method === 'POST') {
      const id = rejectMatch[1]!;
      state.rejects.push(id);
      const had = id === SUGGESTED_TRANSACTION_ID && !rejected.has(id);
      rejected.add(id);
      return route.fulfill(json({ outcome: had ? 'rejected' : 'no_suggestion' }));
    }

    const patchMatch = /^\/api\/transactions\/([^/]+)$/.exec(path);
    if (patchMatch && method === 'PATCH') {
      state.patches.push({
        transactionId: patchMatch[1]!,
        body: request.postDataJSON() as Record<string, unknown>,
      });
      return route.fallback();
    }

    return route.fallback();
  });

  return state;
}
