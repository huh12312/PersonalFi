// SPDX-License-Identifier: MIT
/**
 * WP 11.2's unit-test fixtures: an explanation carrying the model's suggestion, a measurement, and the settings
 * shape in each of its five states, in the api's shapes (`CategoryExplanation`, `CategorySuggestionEval`,
 * `CategorySuggestionSettings`). The categories are `api-test-utils.ts`'s `TEST_CATEGORIES`, so the picker and the
 * results block can name them.
 */
import type {
  CategoryExplanation,
  CategorySuggestionEval,
  CategorySuggestionSettings,
} from '../api/generated/types.gen.ts';

export const SUGGESTED_ID = 'cat_dining_coffee';
export const SUGGESTED_KEY = 'dining.coffee';
export const SUGGESTED_LABEL = 'Coffee Shops';
/** The model's own words, rendered verbatim. */
export const SUGGESTED_REASON =
  'The payee reads like a coffee bar and the amount is a small card purchase.';
export const ABSTAINED_LINE =
  'Every tier abstained: none of your 4 rules matched, merchant confirmed 1 of 3 times needed, no bank category, classifier 41 % below its 60 % floor.';

export function buildExplanation(
  transactionId: string,
  overrides: Partial<CategoryExplanation> = {},
): CategoryExplanation {
  return {
    transactionId,
    status: 'abstained',
    source: 'none',
    categoryKey: null,
    confidence: null,
    decidedAt: '2026-10-20T08:00:00.000Z',
    line: ABSTAINED_LINE,
    tiers: [],
    suggestion: {
      source: 'model',
      categoryId: SUGGESTED_ID,
      categoryKey: SUGGESTED_KEY,
      categoryLabel: SUGGESTED_LABEL,
      reason: SUGGESTED_REASON,
      suggestedAt: '2026-10-20T08:05:00.000Z',
    },
    ...overrides,
  };
}

export const NARRATOR_MODEL = 'qwen2.5:7b-instruct-q4_K_M';
export const CLASSIFIER_MODEL = 'llama3.2:3b-instruct-q4_K_M';

/** Below the gate: 72 % over 25 scored rows. */
export function belowGateEval(
  overrides: Partial<CategorySuggestionEval> = {},
): CategorySuggestionEval {
  return {
    id: '0190c000-0000-7000-8000-000000000001',
    modelChoice: 'narrator',
    model: NARRATOR_MODEL,
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
      { expected: 'transfers.internal', got: 'dining', count: 1 },
    ],
    measuredAt: '2026-10-20T10:00:00.000Z',
    ...overrides,
  };
}

/** Above the gate: 91 % over 34 scored rows. */
export function aboveGateEval(
  overrides: Partial<CategorySuggestionEval> = {},
): CategorySuggestionEval {
  return belowGateEval({
    id: '0190c000-0000-7000-8000-000000000002',
    scored: 34,
    correct: 31,
    abstained: 5,
    refused: 1,
    precision: 31 / 34,
    coverage: 34 / 40,
    confusions: [{ expected: 'dining.restaurants', got: 'dining.coffee', count: 3 }],
    measuredAt: '2026-10-21T10:00:00.000Z',
    ...overrides,
  });
}

const GATE_OPEN = { open: true, reason: null, minPrecision: 0.85, minScored: 20 } as const;

export type SettingsState = CategorySuggestionSettings['state'];

/** The settings in `state`, with the narrator's local model chosen and no second model unless asked. */
export function buildSettings(
  state: SettingsState,
  overrides: Partial<CategorySuggestionSettings> = {},
): CategorySuggestionSettings {
  const latest =
    state === 'below_gate'
      ? belowGateEval()
      : state === 'ready' || state === 'on'
        ? aboveGateEval()
        : null;
  return {
    state,
    enabled: state === 'on',
    gate:
      state === 'ready' || state === 'on'
        ? GATE_OPEN
        : {
            open: false,
            reason: state === 'below_gate' ? 'below_precision' : 'not_measured',
            minPrecision: 0.85,
            minScored: 20,
          },
    modelChoice: 'narrator',
    models: [
      {
        choice: 'narrator',
        label: state === 'no_model' ? null : NARRATOR_MODEL,
        provider: state === 'no_model' ? null : 'ollama',
        available: state !== 'no_model',
        unavailableReason: state === 'no_model' ? 'the narrator is off' : null,
        latest,
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
        'Send merchant names and my category list to the hosted provider to suggest categories. Merchant names leave this machine.',
      consentTextSha256: `sha256:${'ab'.repeat(32)}`,
    },
    ...overrides,
  };
}

/** A second local model, available, with its own measurement. */
export function withClassifier(
  settings: CategorySuggestionSettings,
  latest: CategorySuggestionEval | null,
): CategorySuggestionSettings {
  return {
    ...settings,
    models: settings.models.map((model) =>
      model.choice === 'classifier'
        ? {
            ...model,
            label: CLASSIFIER_MODEL,
            provider: 'ollama',
            available: true,
            unavailableReason: null,
            latest,
          }
        : model,
    ),
  };
}
