// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MarketDataCredentialsStatus } from '../../api/generated/types.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import { MarketDataKeysSection } from './MarketDataKeysSection.tsx';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
}));

/**
 * WP 10.4: Settings › Market data › API keys - the WP 10.1 Plaid setup's shape (`PlaidSetup.test.tsx`), per
 * market-data provider: the field is masked, the key is cleared from the form once the request is built (on
 * success and on failure), the operator's file is read-only, Remove sits behind a confirmation, both writes go
 * through the step-up, and the only thing about a stored key ever shown is its last four characters.
 */

const KEY = 'unitFredKey0123456789abcdWXYZ'; // gitleaks:allow — synthetic canary, not a credential
const STORED_KEY_CANARY = 'unitStoredCoinGeckoKeyDoNotShow9f2c'; // gitleaks:allow — synthetic canary

type Provider = MarketDataCredentialsStatus['provider'];

const PURPOSE: Record<Provider, string> = {
  tiingo: 'Equity, ETF and fund end-of-day closes.',
  fred: 'Macro series and FX rates.',
  coingecko: 'Crypto prices (Demo plan).',
  openfigi:
    'Symbol-to-FIGI mapping. Answers anonymously without a key, at 10 jobs per batch instead of 100.',
};

function status(
  provider: Provider,
  overrides: Partial<MarketDataCredentialsStatus> = {},
): MarketDataCredentialsStatus {
  return {
    provider,
    purpose: PURPOSE[provider],
    source: 'none',
    configured: false,
    anonymous: false,
    keyHint: null,
    storedAt: null,
    rotatedAt: null,
    narrowedOut: false,
    ...overrides,
  };
}

const INITIAL: Record<Provider, MarketDataCredentialsStatus> = {
  tiingo: status('tiingo', { source: 'file', configured: true }),
  fred: status('fred'),
  coingecko: status('coingecko', {
    source: 'stored',
    configured: true,
    keyHint: '9f2c',
    storedAt: '2026-09-01T12:00:00.000Z',
    rotatedAt: '2026-10-01T12:00:00.000Z',
  }),
  openfigi: status('openfigi', { anonymous: true }),
};

const STEP_UP_REQUIRED = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  code: 'step_up_required',
  correlationId: 'corr_1',
};

const PATH = /^\/api\/market-data\/providers\/(tiingo|fred|coingecko|openfigi)\/credentials$/u;

function providerOf(url: URL): Provider {
  return (PATH.exec(url.pathname)?.[1] ?? 'fred') as Provider;
}

/** A stand-in for the api's three routes, with real state, and the step-up pair. */
function keysApi(
  options: {
    putFails?: { status: number; body: unknown };
    /** A field a buggy api might one day add; it must never reach the DOM. */
    plant?: Record<string, unknown>;
  } = {},
) {
  const state = {
    statuses: { ...INITIAL },
    putAttempts: 0,
    putBodies: [] as unknown[],
    deleteAttempts: 0,
    deletes: 0,
    stepUps: 0,
    fresh: false,
  };
  const routes: FetchRoute[] = [
    {
      match: PATH,
      method: 'GET',
      handle: ({ url }) =>
        jsonResponse({ ...state.statuses[providerOf(url)], ...(options.plant ?? {}) }),
    },
    {
      match: PATH,
      method: 'PUT',
      handle: async ({ url, request }) => {
        state.putAttempts += 1;
        if (!state.fresh) return jsonResponse(STEP_UP_REQUIRED, 403);
        const body = (await request.json()) as { key: string };
        state.putBodies.push(body);
        if (options.putFails !== undefined) {
          return jsonResponse(options.putFails.body, options.putFails.status);
        }
        const provider = providerOf(url);
        state.statuses[provider] = status(provider, {
          source: 'stored',
          configured: true,
          keyHint: body.key.slice(-4),
          storedAt: '2026-10-14T09:00:00.000Z',
        });
        return jsonResponse(state.statuses[provider]);
      },
    },
    {
      match: PATH,
      method: 'DELETE',
      handle: ({ url }) => {
        state.deleteAttempts += 1;
        if (!state.fresh) return jsonResponse(STEP_UP_REQUIRED, 403);
        state.deletes += 1;
        const provider = providerOf(url);
        state.statuses[provider] = status(provider, { anonymous: provider === 'openfigi' });
        return jsonResponse(state.statuses[provider]);
      },
    },
    { match: '/api/market-data/settings', handle: () => jsonResponse({ providers: [] }) },
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

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MarketDataKeysSection />
    </QueryClientProvider>,
  );
}

async function card(provider: Provider): Promise<HTMLElement> {
  return screen.findByTestId(`market-data-key-${provider}`);
}

describe('Settings › Market data › API keys (WP 10.4)', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says where each key comes from in words, with the purpose line', async () => {
    stubFetchRoutes(keysApi().routes);
    renderSection();

    const tiingo = await card('tiingo');
    expect(tiingo).toHaveTextContent('Tiingo');
    expect(tiingo).toHaveTextContent(PURPOSE.tiingo);
    expect(tiingo).toHaveTextContent("Set by the operator's secret file");

    expect(await card('fred')).toHaveTextContent('Not set.');

    const coingecko = await card('coingecko');
    expect(coingecko).toHaveTextContent(/Stored in this install since .*2026/u);
    expect(coingecko).toHaveTextContent('ends in 9f2c');
    expect(coingecko).toHaveTextContent(/replaced .*2026/u);

    expect(await card('openfigi')).toHaveTextContent(
      'Not set — using OpenFIGI anonymously (10 per request)',
    );
  });

  it("is read-only when the operator's secret file supplies the key: no field, no Save, no Remove", async () => {
    stubFetchRoutes(keysApi().routes);
    renderSection();
    const tiingo = await card('tiingo');
    expect(within(tiingo).queryByLabelText('Tiingo API key')).not.toBeInTheDocument();
    expect(within(tiingo).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(tiingo).queryByRole('button')).not.toBeInTheDocument();
  });

  it('masks the key field, and offers Remove only for a stored key', async () => {
    stubFetchRoutes(keysApi().routes);
    renderSection();
    const fred = await card('fred');
    const field = within(fred).getByLabelText('FRED API key');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).not.toHaveAttribute('readonly');
    expect(within(fred).getByRole('button', { name: 'Save with passkey' })).toBeDisabled();
    expect(within(fred).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    const coingecko = await card('coingecko');
    expect(within(coingecko).getByLabelText('CoinGecko API key')).toHaveAttribute(
      'type',
      'password',
    );
    expect(within(coingecko).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('saves through the step-up, clears the field, never shows the key, and shows its last four characters', async () => {
    const api = keysApi();
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();

    const fred = await card('fred');
    const field = within(fred).getByLabelText('FRED API key');
    await user.type(field, KEY);
    await user.click(within(fred).getByRole('button', { name: 'Save with passkey' }));

    await waitFor(() => expect(fred).toHaveTextContent('ends in WXYZ'));
    // The first PUT was refused for want of a step-up; the ceremony ran once; the retry went through.
    expect(api.state.putAttempts).toBe(2);
    expect(api.state.stepUps).toBe(1);
    expect(api.state.putBodies).toEqual([{ key: KEY }]);

    expect(within(fred).getByLabelText('FRED API key')).toHaveValue('');
    expect(document.body.textContent).not.toContain(KEY);
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument();
    expect(within(fred).getByRole('status')).toHaveTextContent('FRED accepted the key');
  });

  it("shows the api's detail when the provider refuses the key, and clears the field anyway", async () => {
    const detail =
      'fred did not accept this key (HTTP 400). Check that it is the whole key, copied from your account with the provider. Nothing was saved.';
    const api = keysApi({
      putFails: {
        status: 422,
        body: {
          type: 'about:blank',
          title: 'Unprocessable Content',
          status: 422,
          code: 'provider_credentials.rejected',
          detail,
        },
      },
    });
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();

    const fred = await card('fred');
    await user.type(within(fred).getByLabelText('FRED API key'), KEY);
    await user.click(within(fred).getByRole('button', { name: 'Save with passkey' }));

    expect(await within(fred).findByRole('alert')).toHaveTextContent(detail);
    expect(within(fred).getByLabelText('FRED API key')).toHaveValue('');
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument();
    expect(fred).toHaveTextContent('Not set.');
  });

  it("shows the api's detail when the operator's file took over (409) and when the provider cannot be reached (502)", async () => {
    for (const [code, statusCode, detail] of [
      [
        'provider_credentials.managed_by_files',
        409,
        "The fred key is supplied by the operator's secret file, which takes precedence.",
      ],
      [
        'provider_credentials.provider_unavailable',
        502,
        'fred could not be reached to check this key. Nothing was saved.',
      ],
    ] as const) {
      const api = keysApi({
        putFails: {
          status: statusCode,
          body: { type: 'about:blank', title: 'x', status: statusCode, code, detail },
        },
      });
      stubFetchRoutes(api.routes);
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const view = render(
        <QueryClientProvider client={queryClient}>
          <MarketDataKeysSection />
        </QueryClientProvider>,
      );
      const user = userEvent.setup();
      const fred = await screen.findByTestId('market-data-key-fred');
      await user.type(within(fred).getByLabelText('FRED API key'), KEY);
      await user.click(within(fred).getByRole('button', { name: 'Save with passkey' }));
      expect(await within(fred).findByRole('alert')).toHaveTextContent(detail);
      expect(within(fred).getByLabelText('FRED API key')).toHaveValue('');
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('refuses a malformed key before sending anything', async () => {
    const api = keysApi();
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();
    const fred = await card('fred');
    await user.type(within(fred).getByLabelText('FRED API key'), 'too short!');
    await user.click(within(fred).getByRole('button', { name: 'Save with passkey' }));
    expect(await within(fred).findByRole('alert')).toHaveTextContent(
      '16 to 256 letters, digits, dashes or underscores',
    );
    expect(api.state.putAttempts).toBe(0);
  });

  it('removes a stored key only after a confirmation, and through the step-up', async () => {
    const api = keysApi();
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();

    const coingecko = await card('coingecko');
    await user.click(within(coingecko).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the stored CoinGecko key?' });
    expect(dialog).toHaveTextContent('This does not revoke the key at CoinGecko');
    // Nothing has been sent: the confirmation comes first.
    expect(api.state.deleteAttempts).toBe(0);

    // "Keep" sends nothing.
    await user.click(within(dialog).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.state.deleteAttempts).toBe(0);

    await user.click(within(coingecko).getByRole('button', { name: 'Remove' }));
    const again = await screen.findByRole('dialog', { name: 'Remove the stored CoinGecko key?' });
    await user.click(within(again).getByRole('button', { name: 'Remove key' }));

    await waitFor(() => expect(coingecko).toHaveTextContent('Not set.'));
    expect(api.state.deleteAttempts).toBe(2);
    expect(api.state.stepUps).toBe(1);
    expect(api.state.deletes).toBe(1);
    expect(within(coingecko).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('shows the last four characters of a stored key and nothing else about it, even if the api sent more', async () => {
    stubFetchRoutes(
      keysApi({ plant: { key: STORED_KEY_CANARY, secret: STORED_KEY_CANARY } }).routes,
    );
    renderSection();
    const coingecko = await card('coingecko');
    expect(coingecko).toHaveTextContent('ends in 9f2c');
    expect(document.body.textContent).not.toContain(STORED_KEY_CANARY);
    expect(screen.queryByDisplayValue(STORED_KEY_CANARY)).not.toBeInTheDocument();
    // The stored key's field starts empty: replacing a key means pasting a new one.
    expect(within(coingecko).getByLabelText('CoinGecko API key')).toHaveValue('');
  });

  it('a provider whose status cannot be read says so; the others still work', async () => {
    const api = keysApi();
    stubFetchRoutes([
      {
        match: '/api/market-data/providers/fred/credentials',
        method: 'GET',
        handle: () => jsonResponse({ type: 'about:blank', title: 'x', status: 500 }, 500),
      },
      ...api.routes,
    ]);
    renderSection();
    expect(
      await screen.findByText(/Where this key comes from cannot be read right now/u),
    ).toBeInTheDocument();
    expect(await card('coingecko')).toHaveTextContent('ends in 9f2c');
  });
});
