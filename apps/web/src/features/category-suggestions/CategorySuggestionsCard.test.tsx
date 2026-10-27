// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CategorySuggestionEval,
  CategorySuggestionSettings,
} from '../../api/generated/types.gen.ts';
import {
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import {
  aboveGateEval,
  belowGateEval,
  buildSettings,
  CLASSIFIER_MODEL,
  NARRATOR_MODEL,
  withClassifier,
} from '../../test-support/suggestion-fixtures.ts';
import { CategorySuggestionsCard } from './CategorySuggestionsCard.tsx';
import { chipWords, enableWords, statusWords } from './suggestion-words.ts';

/**
 * WP 11.2: Settings › Language model › Category suggestions, against a stand-in for
 * `apps/api/src/routes/category-suggestions.ts` with real state: the status line in each of the five states, the
 * Enable switch held off below the gate with its reason in words, Measure → polling → the result, the model choice
 * with both models' measurements, the hosted consent shown only when it applies and unticked, and the payload
 * preview's approval.
 */
interface Api {
  settings: CategorySuggestionSettings;
  /** The result the worker reports, and after how many settings reads following a measure. */
  measured?: {
    latest: CategorySuggestionEval;
    afterReads: number;
    then: Partial<CategorySuggestionSettings>;
  };
  /** `METHOD path body` of every write. */
  writes: Array<{ call: string; body: unknown }>;
  reads: number;
  refuseEnable?: { code: string; detail: string };
}

function stubApi(api: Api): void {
  let readsSinceMeasure: number | null = null;
  stubFetchRoutes([
    categoriesRoute(),
    {
      match: '/api/categories/suggestions/settings',
      method: 'GET',
      handle: () => {
        api.reads += 1;
        if (readsSinceMeasure !== null && api.measured !== undefined) {
          readsSinceMeasure += 1;
          if (readsSinceMeasure >= api.measured.afterReads) {
            const { latest, then } = api.measured;
            api.settings = {
              ...api.settings,
              ...then,
              models: api.settings.models.map((model) =>
                model.choice === latest.modelChoice ? { ...model, latest } : model,
              ),
            };
            readsSinceMeasure = null;
          }
        }
        return jsonResponse(api.settings);
      },
    },
    {
      match: '/api/categories/suggestions/settings',
      method: 'PUT',
      handle: async ({ request }) => {
        const body = (await request.json()) as { modelChoice: 'narrator' | 'classifier' };
        api.writes.push({ call: 'PUT settings', body });
        api.settings = { ...api.settings, modelChoice: body.modelChoice };
        return jsonResponse(api.settings);
      },
    },
    {
      match: '/api/categories/suggestions/measure',
      method: 'POST',
      handle: async ({ request }) => {
        const body = (await request.json()) as { modelChoice?: 'narrator' | 'classifier' };
        api.writes.push({ call: 'POST measure', body });
        readsSinceMeasure = 0;
        return jsonResponse(
          {
            jobId: '0190d000-0000-7000-8000-000000000001',
            deduped: false,
            modelChoice: body.modelChoice ?? api.settings.modelChoice,
          },
          202,
        );
      },
    },
    {
      match: '/api/categories/suggestions/enabled',
      method: 'POST',
      handle: async ({ request }) => {
        const body = (await request.json()) as { enabled: boolean };
        api.writes.push({ call: 'POST enabled', body });
        if (body.enabled && (api.refuseEnable !== undefined || !api.settings.gate.open)) {
          const refusal = api.refuseEnable ?? {
            code: 'categorization.suggestions_below_gate',
            detail: 'Suggestions stay off below 85 % precision.',
          };
          return jsonResponse(
            { type: 'about:blank', title: 'Conflict', status: 409, ...refusal },
            409,
          );
        }
        api.settings = {
          ...api.settings,
          enabled: body.enabled,
          state: body.enabled ? 'on' : 'ready',
        };
        return jsonResponse(api.settings);
      },
    },
    {
      match: '/api/categories/suggestions/hosted-consent',
      method: 'PUT',
      handle: async ({ request }) => {
        const body = (await request.json()) as { consent: boolean };
        api.writes.push({ call: 'PUT hosted-consent', body });
        api.settings = {
          ...api.settings,
          hosted: { ...api.settings.hosted, consented: body.consent },
        };
        return jsonResponse(api.settings);
      },
    },
    {
      match: '/api/categories/suggestions/preview',
      method: 'GET',
      handle: () =>
        jsonResponse({
          advisorId: 'builtin.categorization.suggest',
          advisorVersion: '1.0.0',
          queryShape: 'suggest:v1:rows=3',
          scopes: ['categorization.residue'],
          promptTemplateHash: `sha256:${'cd'.repeat(32)}`,
          provider: 'ollama',
          model: NARRATOR_MODEL,
          payload: { rows: 3 },
          prompt: { text: '{"messages":[]}', hash: `sha256:${'ef'.repeat(32)}` },
          approved: api.settings.approval.approved,
        }),
    },
    {
      match: '/api/categories/suggestions/approve',
      method: 'POST',
      handle: async ({ request }) => {
        const body = (await request.json()) as { queryShape: string };
        api.writes.push({ call: 'POST approve', body });
        api.settings = {
          ...api.settings,
          approval: { queryShape: body.queryShape, approved: true, live: 1 },
        };
        return jsonResponse({
          approvalId: '0190d000-0000-7000-8000-0000000000aa',
          queryShape: body.queryShape,
        });
      },
    },
  ]);
}

function renderCard(settings: CategorySuggestionSettings, extra: Partial<Api> = {}): Api {
  const api: Api = { settings, writes: [], reads: 0, ...extra };
  stubApi(api);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CategorySuggestionsCard />
    </QueryClientProvider>,
  );
  return api;
}

async function status(): Promise<HTMLElement> {
  return screen.findByTestId('suggestions-status');
}

function enableSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: 'Show category suggestions' });
}

describe('category suggestions, in words', () => {
  it('says each state', () => {
    expect(statusWords(buildSettings('no_model'))).toBe('Off: no model');
    expect(statusWords(buildSettings('not_measured'))).toBe('Off: not measured yet');
    expect(statusWords(buildSettings('below_gate'))).toBe(
      'Off: below the 85 % gate — 72 % on your history, 25 rows scored',
    );
    expect(statusWords(buildSettings('ready'))).toBe('Ready to turn on');
    expect(statusWords(buildSettings('on'))).toBe('On');
  });

  it('says too few rows and a failed measurement apart from low precision', () => {
    const few = buildSettings('below_gate', {
      gate: { open: false, reason: 'too_few_rows', minPrecision: 0.85, minScored: 20 },
    });
    const fewModels = few.models.map((m) =>
      m.choice === 'narrator'
        ? { ...m, latest: belowGateEval({ scored: 12, precision: 0.92 }) }
        : m,
    );
    expect(statusWords({ ...few, models: fewModels })).toBe(
      'Off: below the 85 % gate — 92 % on your history, but only 12 rows scored (20 needed)',
    );
    const failed = buildSettings('below_gate', {
      gate: { open: false, reason: 'measurement_failed', minPrecision: 0.85, minScored: 20 },
    });
    expect(statusWords(failed)).toBe('Off: the last measurement did not finish');
  });

  it('says why Enable is held, with the last measurement', () => {
    expect(enableWords(buildSettings('below_gate'))).toBe(
      'Turns on at 85 % precision over at least 20 of your own transactions; last measured 72 % on 25.',
    );
    expect(enableWords(buildSettings('not_measured'))).toBe(
      'Turns on at 85 % precision over at least 20 of your own transactions; not measured yet.',
    );
    expect(enableWords(buildSettings('no_model'))).toMatch(
      /^No model can suggest categories: the narrator is off\./,
    );
  });

  it('words the chip with its source and the reason as given', () => {
    expect(chipWords({ categoryLabel: 'Groceries', reason: 'A supermarket name.' })).toBe(
      'Suggested by the model: Groceries — A supermarket name.',
    );
  });
});

describe('Settings › Language model › Category suggestions (WP 11.2)', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('no model: off, Enable held, Measure unavailable with the reason', async () => {
    renderCard(buildSettings('no_model'));

    expect(await status()).toHaveTextContent('Off: no model');
    expect(enableSwitch()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('suggestions-enable-why')).toHaveTextContent(
      'No model can suggest categories: the narrator is off.',
    );
    expect(screen.getByTestId('suggestions-measure')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(/^Nothing to measure: the narrator is off\.$/)).toBeInTheDocument();
  });

  it('not measured: off, Enable held with the rule, nothing leaves this machine, no consent', async () => {
    renderCard(buildSettings('not_measured'));

    expect(await status()).toHaveTextContent('Off: not measured yet');
    expect(enableSwitch()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('suggestions-enable-why')).toHaveTextContent(
      'Turns on at 85 % precision over at least 20 of your own transactions; not measured yet.',
    );
    expect(screen.getByTestId('suggestions-what-leaves')).toHaveTextContent(
      /^What leaves this machine: nothing\./,
    );
    expect(screen.queryByTestId('suggestions-consent')).not.toBeInTheDocument();
    expect(screen.getByTestId('suggestions-results')).toHaveTextContent(
      'No measurement yet for this model.',
    );
  });

  it('below the gate: the figure on your history, the results and the mix-ups, and Enable disabled with why', async () => {
    const api = renderCard(buildSettings('below_gate'));
    const user = userEvent.setup();

    expect(await status()).toHaveTextContent(
      'Off: below the 85 % gate — 72 % on your history, 25 rows scored',
    );
    expect(screen.getByTestId('suggestions-precision')).toHaveTextContent('72 %');
    expect(screen.getByTestId('suggestions-coverage')).toHaveTextContent('63 %');
    expect(screen.getByTestId('suggestions-scored')).toHaveTextContent('25');
    const mixups = await screen.findByTestId('suggestions-confusions');
    await waitFor(() =>
      expect(
        within(mixups)
          .getAllByRole('listitem')
          .map((li) => li.textContent),
      ).toEqual([
        'Restaurants → Coffee Shops: 4 times',
        'Coffee Shops → Restaurants: 2 times',
        'Internal Transfer → Dining: once',
      ]),
    );
    expect(enableSwitch()).toHaveAttribute('aria-disabled', 'true');
    expect(enableSwitch()).toHaveAccessibleDescription(
      /^Turns on at 85 % precision over at least 20 of your own transactions; last measured 72 % on 25\./,
    );
    await user.click(enableSwitch());
    expect(api.writes).toEqual([]);
  });

  it('Measure → Measuring… while the settings are polled → the result, and the gate opens', async () => {
    const api = renderCard(buildSettings('below_gate'), {
      measured: {
        latest: aboveGateEval(),
        afterReads: 2,
        then: {
          state: 'ready',
          gate: { open: true, reason: null, minPrecision: 0.85, minScored: 20 },
        },
      },
    });
    const user = userEvent.setup();

    expect(await status()).toHaveTextContent(/^Off: below the 85 % gate/);
    await user.click(screen.getByRole('button', { name: 'Measure' }));

    const live = screen.getByTestId('suggestions-measure-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(live).toHaveTextContent(/^Measuring…/));
    expect(api.writes).toEqual([{ call: 'POST measure', body: { modelChoice: 'narrator' } }]);
    expect(enableSwitch()).toHaveAttribute('aria-disabled', 'true');

    await waitFor(
      () =>
        expect(live).toHaveTextContent('Measured: 91 % precision, 85 % coverage, 34 rows scored.'),
      { timeout: 8_000 },
    );
    // The first read after the start plus at least one poll.
    expect(api.reads).toBeGreaterThanOrEqual(3);
    expect(await status()).toHaveTextContent('Ready to turn on');
    expect(screen.getByTestId('suggestions-precision')).toHaveTextContent('91 %');
    expect(enableSwitch()).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Measure' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  }, 15_000);

  it('ready: Enable turns suggestions on', async () => {
    const api = renderCard(buildSettings('ready'));
    const user = userEvent.setup();

    expect(await status()).toHaveTextContent('Ready to turn on');
    expect(screen.getByTestId('suggestions-enable-why')).toHaveTextContent(
      /^Measured 91 % on 34 of your own transactions\./,
    );
    await user.click(enableSwitch());

    await waitFor(() => expect(status()).resolves.toHaveTextContent(/^On$/));
    expect(api.writes).toEqual([{ call: 'POST enabled', body: { enabled: true } }]);
    expect(enableSwitch()).toBeChecked();
  });

  it('a refused Enable says the api’s detail', async () => {
    renderCard(buildSettings('ready'), {
      refuseEnable: {
        code: 'categorization.suggestion_model_unavailable',
        detail: 'No model can suggest categories for you (not_configured).',
      },
    });
    const user = userEvent.setup();

    await status();
    await user.click(enableSwitch());

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No model can suggest categories for you (not_configured).',
    );
    expect(enableSwitch()).not.toBeChecked();
  });

  it('on: says On, and the switch turns it off', async () => {
    const api = renderCard(buildSettings('on'));
    const user = userEvent.setup();

    expect(await status()).toHaveTextContent(/^On$/);
    expect(enableSwitch()).toBeChecked();
    await user.click(enableSwitch());
    await waitFor(() =>
      expect(api.writes).toEqual([{ call: 'POST enabled', body: { enabled: false } }]),
    );
    await waitFor(() => expect(enableSwitch()).not.toBeChecked());
  });

  it('offers the second local model only when there is one, with each model’s measurement to compare', async () => {
    const api = renderCard(
      withClassifier(
        buildSettings('below_gate'),
        aboveGateEval({ modelChoice: 'classifier', model: CLASSIFIER_MODEL }),
      ),
    );
    const user = userEvent.setup();

    await status();
    const narrator = screen.getByRole('radio', {
      name: `The narrator's model (${NARRATOR_MODEL})`,
    });
    const second = screen.getByRole('radio', { name: `Second local model (${CLASSIFIER_MODEL})` });
    expect(narrator).toBeChecked();
    expect(narrator).toHaveAccessibleDescription(
      /^Measured .+: 72 % precision, 63 % coverage, 25 rows scored\.$/,
    );
    expect(second).toHaveAccessibleDescription(
      /^Measured .+: 91 % precision, 85 % coverage, 34 rows scored\.$/,
    );
    await user.click(second);
    await waitFor(() =>
      expect(api.writes).toEqual([{ call: 'PUT settings', body: { modelChoice: 'classifier' } }]),
    );
    await waitFor(() => expect(second).toBeChecked());
  });

  it('without a second model, only the narrator’s is offered', async () => {
    renderCard(buildSettings('not_measured'));
    await status();
    expect(screen.getAllByRole('radio')).toHaveLength(1);
  });

  it('the hosted consent: shown only when it applies, the api’s text verbatim, unticked; ticking sends its sha256', async () => {
    const base = buildSettings('not_measured');
    const api = renderCard({ ...base, hosted: { ...base.hosted, applies: true } });
    const user = userEvent.setup();

    await status();
    const box = screen.getByRole('checkbox', { name: base.hosted.consentText });
    expect(box).not.toBeChecked();
    expect(screen.getByTestId('suggestions-what-leaves')).not.toHaveTextContent(/nothing/);
    await user.click(box);
    await waitFor(() =>
      expect(api.writes).toEqual([
        {
          call: 'PUT hosted-consent',
          body: { consent: true, consentTextSha256: base.hosted.consentTextSha256 },
        },
      ]),
    );
    await waitFor(() => expect(box).toBeChecked());
  });

  it('the payload: read on demand, then approved with its query shape', async () => {
    const api = renderCard(buildSettings('ready'));
    const user = userEvent.setup();

    await status();
    expect(screen.getByTestId('suggestions-approval-status')).toHaveTextContent(
      /^Not approved yet/,
    );
    await user.click(screen.getByRole('button', { name: 'Show exactly what a run would send' }));
    const approve = await screen.findByRole('button', { name: 'Approve this payload' });
    expect(screen.getByTestId('suggestions-prompt')).toHaveTextContent('{"messages":[]}');
    await user.click(approve);
    await waitFor(() =>
      expect(api.writes).toEqual([
        { call: 'POST approve', body: { queryShape: 'suggest:v1:rows=3' } },
      ]),
    );
    expect(await screen.findByText('Approved for this payload shape')).toBeInTheDocument();
  });
});
