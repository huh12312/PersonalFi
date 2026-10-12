// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectorManifest } from '../../api/generated/types.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import { AddConnectionDialog } from './AddConnectionDialog.tsx';
import type { PlaidCredentialsStatus } from './plaid-credentials-api.ts';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
}));

const CAPABILITIES: ConnectorManifest['capabilities'] = {
  supports: ['accounts', 'balances', 'transactions'],
  historyWindowDays: 'unbounded',
  minSyncIntervalSeconds: 0,
  refreshBudgetPerDay: null,
  supportsWebhooks: false,
  reconnectFlow: 'none',
  consentWindowDays: null,
  currencies: 'multi',
};

const MANUAL: ConnectorManifest = {
  provider: 'manual',
  displayName: 'Manual account',
  description: 'An account you maintain yourself.',
  iconKey: 'pencil',
  linkKind: 'manual_entry',
  docsUrl: null,
  capabilities: CAPABILITIES,
};

const PLAID: ConnectorManifest = {
  provider: 'plaid',
  displayName: 'Plaid',
  description: 'Link a US bank through Plaid.',
  iconKey: 'bank',
  linkKind: 'provider_hosted',
  docsUrl: null,
  capabilities: { ...CAPABILITIES, reconnectFlow: 'provider_hosted' },
};

const NONE: PlaidCredentialsStatus = {
  configured: false,
  source: 'none',
  env: null,
  clientIdHint: null,
  rotatedAt: null,
  productionAllowed: false,
};

const STORED: PlaidCredentialsStatus = {
  configured: true,
  source: 'stored',
  env: 'sandbox',
  clientIdHint: '89ab',
  rotatedAt: null,
  productionAllowed: false,
};

const SECRET = 'unit-test-secret-9f8e7d6c5b4a'; // gitleaks:allow — synthetic canary, not a credential
const CLIENT_ID = 'unit-test-client-0123456789ab'; // gitleaks:allow — synthetic canary, not a credential

const STEP_UP_REQUIRED = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  code: 'step_up_required',
  correlationId: 'corr_1',
};

/** A tiny stand-in for the api's three routes plus the connector list, with real state. */
function plaidApi(initial: PlaidCredentialsStatus, options: { rejectWith?: unknown } = {}) {
  const state = {
    status: initial,
    putBodies: [] as unknown[],
    putAttempts: 0,
    deletes: 0,
    deleteAttempts: 0,
    stepUps: 0,
    fresh: false,
  };
  const listed = (): boolean => state.status.configured || state.status.source === 'files';
  const routes: FetchRoute[] = [
    {
      match: '/api/connectors',
      handle: () => jsonResponse({ connectors: listed() ? [MANUAL, PLAID] : [MANUAL] }),
    },
    {
      match: '/api/connections/providers/plaid/credentials',
      method: 'GET',
      handle: () => jsonResponse(state.status),
    },
    {
      match: '/api/connections/providers/plaid/credentials',
      method: 'PUT',
      handle: async ({ request }) => {
        state.putAttempts += 1;
        if (!state.fresh) return jsonResponse(STEP_UP_REQUIRED, 403);
        state.putBodies.push(await request.json());
        if (options.rejectWith !== undefined) return jsonResponse(options.rejectWith, 422);
        state.status = { ...STORED, rotatedAt: null };
        return jsonResponse(state.status);
      },
    },
    {
      match: '/api/connections/providers/plaid/credentials',
      method: 'DELETE',
      handle: () => {
        state.deleteAttempts += 1;
        if (!state.fresh) return jsonResponse(STEP_UP_REQUIRED, 403);
        state.deletes += 1;
        state.status = NONE;
        return jsonResponse(state.status);
      },
    },
    {
      match: '/api/auth/step-up/options',
      handle: () => jsonResponse({ options: {} }),
    },
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

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <AddConnectionDialog open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('Set up Plaid in the Add connection dialog (WP 10.1)', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers "Set up Plaid" when nothing is configured: the secret is masked, sandbox is the only environment, and the storage and step-up are stated', async () => {
    const api = plaidApi(NONE);
    stubFetchRoutes(api.routes);
    renderDialog();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Plaid' }));
    const form = await screen.findByRole('form', { name: 'Set up Plaid' });

    const secret = within(form).getByLabelText('Plaid secret');
    expect(secret).toHaveAttribute('type', 'password');
    // Paste is allowed: nothing blocks it (no onPaste handler, no readonly).
    expect(secret).not.toHaveAttribute('readonly');
    await user.click(within(form).getByRole('button', { name: 'Show secret' }));
    expect(secret).toHaveAttribute('type', 'text');
    await user.click(within(form).getByRole('button', { name: 'Hide secret' }));
    expect(secret).toHaveAttribute('type', 'password');

    expect(within(form).getByRole('radio', { name: /Sandbox/u })).toBeChecked();
    expect(within(form).queryByRole('radio', { name: /Production/u })).not.toBeInTheDocument();
    expect(within(form).getByText(/Stored encrypted in this install/u)).toBeInTheDocument();
    expect(within(form).getByText(/Saving asks for your passkey/u)).toBeInTheDocument();
    // Nothing to submit until both values are present.
    expect(within(form).getByRole('button', { name: 'Save and continue' })).toBeDisabled();
  });

  it('offers Production only when the api says it is allowed', async () => {
    const api = plaidApi({ ...NONE, productionAllowed: true });
    stubFetchRoutes(api.routes);
    renderDialog();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Plaid' }));
    const form = await screen.findByRole('form', { name: 'Set up Plaid' });
    expect(within(form).getByRole('radio', { name: /Production/u })).toBeInTheDocument();
    expect(within(form).getByRole('radio', { name: /Sandbox/u })).toBeChecked();
  });

  it('saves through the step-up, never keeps or shows the secret, and the Link card appears without a reload', async () => {
    const api = plaidApi(NONE);
    stubFetchRoutes(api.routes);
    renderDialog();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Plaid' }));
    const form = await screen.findByRole('form', { name: 'Set up Plaid' });
    await user.type(within(form).getByLabelText('Plaid client ID'), CLIENT_ID);
    await user.type(within(form).getByLabelText('Plaid secret'), SECRET);
    await user.click(within(form).getByRole('button', { name: 'Save and continue' }));

    // The Plaid tab now carries the Link card: Plaid is listed, and the form is gone.
    expect(await screen.findByRole('button', { name: 'Connect with Plaid' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Set up Plaid' })).not.toBeInTheDocument();

    // The first PUT was refused for want of a step-up; the ceremony ran once; the retry went through.
    expect(api.state.putAttempts).toBe(2);
    expect(api.state.stepUps).toBe(1);
    expect(api.state.putBodies).toEqual([{ clientId: CLIENT_ID, secret: SECRET, env: 'sandbox' }]);

    // Never echoed: the secret is nowhere in the document, as text or as a field value.
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
    // What the holder sees instead: where it is kept, the environment, the last four characters.
    expect(screen.getByText(/Stored encrypted in this install/u)).toBeInTheDocument();
    expect(screen.getByText('89ab')).toBeInTheDocument();
  });

  it("shows the api's refusal in words and keeps nothing when Plaid rejects the keys", async () => {
    const detail = 'Plaid did not accept these credentials (INVALID_API_KEYS). Check them.';
    const api = plaidApi(NONE, {
      rejectWith: {
        type: 'about:blank',
        title: 'Unprocessable Content',
        status: 422,
        code: 'provider_credentials.rejected',
        detail,
      },
    });
    stubFetchRoutes(api.routes);
    renderDialog();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Plaid' }));
    const form = await screen.findByRole('form', { name: 'Set up Plaid' });
    await user.type(within(form).getByLabelText('Plaid client ID'), CLIENT_ID);
    await user.type(within(form).getByLabelText('Plaid secret'), SECRET);
    await user.click(within(form).getByRole('button', { name: 'Save and continue' }));

    expect(await within(form).findByRole('alert')).toHaveTextContent(detail);
    // The secret was cleared from the form the moment the request was built.
    expect(within(form).getByLabelText('Plaid secret')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Connect with Plaid' })).not.toBeInTheDocument();
  });

  it("says the operator's files configure Plaid, read-only, with no way to change them here", async () => {
    const api = plaidApi({
      configured: true,
      source: 'files',
      env: 'sandbox',
      clientIdHint: null,
      rotatedAt: null,
      productionAllowed: false,
    });
    stubFetchRoutes(api.routes);
    renderDialog();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Plaid' }));
    expect(
      await screen.findByText(/Plaid is configured by the operator.s secret files \(Sandbox\)/u),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect with Plaid' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Set up Plaid' })).not.toBeInTheDocument();
  });

  it('with stored keys: Link plus Change and Remove, and Remove goes through a confirmation and the step-up', async () => {
    const api = plaidApi(STORED);
    stubFetchRoutes(api.routes);
    renderDialog();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Plaid' }));
    expect(await screen.findByRole('button', { name: 'Connect with Plaid' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(/does not revoke the keys at Plaid/u)).toBeInTheDocument();
    expect(api.state.deleteAttempts).toBe(0); // nothing sent until confirmed
    await user.click(screen.getByRole('button', { name: 'Remove credentials' }));

    await waitFor(() => expect(api.state.deletes).toBe(1));
    expect(api.state.stepUps).toBe(1);
    // Back to "Set up Plaid" on the same tab.
    expect(await screen.findByRole('form', { name: 'Set up Plaid' })).toBeInTheDocument();
  });

  it('Change opens the form for the stored keys and cancel puts it away', async () => {
    const api = plaidApi(STORED);
    stubFetchRoutes(api.routes);
    renderDialog();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('tab', { name: 'Plaid' }));
    await user.click(await screen.findByRole('button', { name: 'Change' }));
    const form = screen.getByRole('form', { name: 'Change Plaid credentials' });
    expect(within(form).getByLabelText('Plaid secret')).toHaveValue('');
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(
      screen.queryByRole('form', { name: 'Change Plaid credentials' }),
    ).not.toBeInTheDocument();
  });

  it('offers no Plaid setup when the api does not answer the credentials route', async () => {
    stubFetchRoutes([
      { match: '/api/connectors', handle: () => jsonResponse({ connectors: [MANUAL] }) },
      {
        match: '/api/connections/providers/plaid/credentials',
        handle: () => jsonResponse({ code: 'not_found' }, 404),
      },
    ]);
    renderDialog();
    expect(await screen.findByRole('tab', { name: 'Manual account' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: 'Plaid' })).not.toBeInTheDocument(),
    );
  });
});
