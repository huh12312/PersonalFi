// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdvisorSettings } from '../../api/generated/types.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import { AdvisorHostedConsentCard } from './AdvisorHostedConsentCard.tsx';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
}));

/**
 * WP 11.5d: Advisor management › "Advisor sessions on a hosted provider" (D31) against a stand-in for
 * `GET`/`PUT /advisor/settings` with real state: the api's own consent text shown verbatim with its version, unticked
 * by default and saying the advisor then runs on the local model, ticking naming the text's sha256 through the
 * passkey step-up, unticking, the provider choice, and a reworded consent re-read on a 409.
 */

const SHA = 'a'.repeat(64);
const TEXT =
  'I allow the advisor to send its approved payloads to the hosted provider I choose, for advisor sessions only.';

function settings(overrides: Partial<AdvisorSettings> = {}): AdvisorSettings {
  return {
    consent: { version: '2026-10-v1', sha256: SHA, text: TEXT },
    hostedConsented: false,
    hostedConsentedAt: null,
    hostedProvider: null,
    ...overrides,
  };
}

const STEP_UP_REQUIRED = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  code: 'step_up_required',
  correlationId: 'corr_1',
};

function api(options: { current?: AdvisorSettings; changed?: boolean } = {}) {
  const state = {
    current: options.current ?? settings(),
    puts: [] as unknown[],
    attempts: 0,
    stepUps: 0,
    fresh: false,
    changed: options.changed ?? false,
  };
  const routes: FetchRoute[] = [
    {
      match: '/api/advisor/settings',
      method: 'GET',
      handle: () => jsonResponse(state.current),
    },
    {
      match: '/api/advisor/settings',
      method: 'PUT',
      handle: async ({ request }) => {
        state.attempts += 1;
        if (!state.fresh) return jsonResponse(STEP_UP_REQUIRED, 403);
        const body = (await request.json()) as {
          hostedConsent?: boolean;
          consentTextSha256?: string;
          hostedProvider?: AdvisorSettings['hostedProvider'];
        };
        state.puts.push(body);
        if (state.changed) {
          state.changed = false;
          state.current = settings({
            consent: {
              version: '2026-11-v2',
              sha256: 'b'.repeat(64),
              text: 'The reworded consent.',
            },
          });
          return jsonResponse(
            {
              type: 'about:blank',
              title: 'Conflict',
              status: 409,
              code: 'insights.advisor_consent_changed',
              detail: 'The consent text changed since it was shown. Read it again before ticking.',
            },
            409,
          );
        }
        if (body.hostedConsent !== undefined) {
          state.current = {
            ...state.current,
            hostedConsented: body.hostedConsent,
            hostedConsentedAt: body.hostedConsent ? '2026-10-28T14:00:00.000Z' : null,
          };
        }
        if (body.hostedProvider !== undefined) {
          state.current = { ...state.current, hostedProvider: body.hostedProvider };
        }
        return jsonResponse(state.current);
      },
    },
    { match: '/api/auth/step-up/options', handle: () => jsonResponse({ options: {} }) },
    {
      match: '/api/auth/step-up/verify',
      handle: () => {
        state.stepUps += 1;
        state.fresh = true;
        return jsonResponse({ freshUntil: new Date(Date.now() + 300_000).toISOString() });
      },
    },
  ];
  return { state, routes };
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AdvisorHostedConsentCard />
    </QueryClientProvider>,
  );
}

describe('Advisor management › hosted consent (WP 11.5d)', () => {
  beforeEach(() => {
    ensureApiClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the api’s consent text and version, unticked, and says plainly that the advisor then runs on the local model', async () => {
    const { routes, state } = api();
    stubFetchRoutes(routes);
    renderCard();
    expect(
      await screen.findByRole('heading', { name: 'Advisor sessions on a hosted provider' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('advisor-consent-text')).toHaveTextContent(TEXT);
    expect(screen.getByTestId('advisor-consent-version')).toHaveTextContent('2026-10-v1');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByTestId('advisor-consent-default')).toHaveTextContent(
      'Unticked, the advisor runs on the local model',
    );
    expect(screen.getByLabelText('Hosted provider for the advisor')).toHaveValue('');
    expect(state.attempts).toBe(0);
  });

  it('ticking names the text’s sha256, asks for the passkey once, and records the consent', async () => {
    const user = userEvent.setup();
    const { routes, state } = api();
    stubFetchRoutes(routes);
    renderCard();
    await user.click(await screen.findByRole('checkbox'));
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked());
    expect(state.stepUps).toBe(1);
    expect(state.puts).toEqual([{ hostedConsent: true, consentTextSha256: SHA }]);
    expect(await screen.findByRole('status')).toHaveTextContent('Recorded.');
  });

  it('unticking withdraws it, naming no hash', async () => {
    const user = userEvent.setup();
    const { routes, state } = api({ current: settings({ hostedConsented: true }) });
    stubFetchRoutes(routes);
    renderCard();
    const box = await screen.findByRole('checkbox');
    expect(box).toBeChecked();
    await user.click(box);
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
    expect(state.puts).toEqual([{ hostedConsent: false }]);
  });

  it('the provider select offers the narrator’s provider and the three hosted ones, and saves the choice', async () => {
    const user = userEvent.setup();
    const { routes, state } = api();
    stubFetchRoutes(routes);
    renderCard();
    const select = await screen.findByLabelText('Hosted provider for the advisor');
    expect(Array.from(select.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Same as the narrator',
      'OpenAI',
      'OpenRouter',
      'Anthropic',
    ]);
    await user.selectOptions(select, 'anthropic');
    await waitFor(() => expect(state.puts).toEqual([{ hostedProvider: 'anthropic' }]));
    await waitFor(() => expect(select).toHaveValue('anthropic'));
  });

  it('a reworded consent is re-read on a 409 and the old tick is not recorded', async () => {
    const user = userEvent.setup();
    const { routes } = api({ changed: true });
    stubFetchRoutes(routes);
    renderCard();
    await user.click(await screen.findByRole('checkbox'));
    expect(await screen.findByRole('alert')).toHaveTextContent('The consent text changed');
    await waitFor(() =>
      expect(screen.getByTestId('advisor-consent-text')).toHaveTextContent('The reworded consent.'),
    );
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('says so when the settings cannot be read', async () => {
    stubFetchRoutes([
      {
        match: '/api/advisor/settings',
        handle: () => jsonResponse({ status: 500, code: 'x' }, 500),
      },
    ]);
    renderCard();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load');
  });
});
