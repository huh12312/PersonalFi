// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import { NarratorSettingsSection } from './NarratorSettingsSection.tsx';
import {
  consentText,
  initialNarratorState,
  narratorReply,
  PINNED_MODEL,
  type NarratorFixtureState,
} from './narrator-fixtures.ts';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
}));

/**
 * WP 10.6: Settings › Language model - the narrator's provider (Ollama, OpenAI, OpenRouter, Anthropic or Off) and
 * each provider's consent, key, model and Test, against `narrator-fixtures.ts` (the api's rules, with real state).
 * The WP 10.4 market-data keys' guarantees hold for every key here: the field is masked, it is emptied once the
 * request is built, the operator's file is read-only, Remove sits behind a confirmation, every write goes through
 * the step-up, and the only thing about a stored key ever shown is its last four characters.
 */

const KEY = 'unitAnthropicKey0123456789abcdWXYZ'; // gitleaks:allow — synthetic canary, not a credential
const STORED_KEY_CANARY = 'unitStoredOpenRouterKeyDoNotShow9f2c'; // gitleaks:allow — synthetic canary

function narratorApi(
  overrides: Partial<NarratorFixtureState> = {},
  options: { plant?: boolean } = {},
) {
  const state = initialNarratorState(overrides);
  const routes: FetchRoute[] = [
    {
      match: /^\/api\/narrator\//u,
      handle: async ({ url, request }) => {
        const text = request.method === 'GET' ? '' : await request.text();
        const reply = narratorReply(
          state,
          request.method,
          url.pathname,
          text === '' ? undefined : JSON.parse(text),
        );
        if (reply === null) return jsonResponse({ status: 404 }, 404);
        let body = reply.body;
        if (options.plant === true && request.method === 'GET') {
          // A field a buggy api might one day add; it must never reach the DOM.
          const settings = body as { providers: Array<Record<string, unknown>> };
          body = {
            ...settings,
            key: STORED_KEY_CANARY,
            providers: settings.providers.map((p) => ({
              ...p,
              secret: STORED_KEY_CANARY,
              key: { ...(p['key'] as object), key: STORED_KEY_CANARY, value: STORED_KEY_CANARY },
            })),
          };
        }
        return new Response(JSON.stringify(body), {
          status: reply.status,
          headers: { 'Content-Type': 'application/json', ...(reply.headers ?? {}) },
        });
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

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: NarratorSettingsSection,
  });
  const advisors = createRoute({
    getParentRoute: () => root,
    path: '/settings/advisors',
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([index, advisors]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function card(provider: string): Promise<HTMLElement> {
  return screen.findByTestId(`narrator-card-${provider}`);
}

function writes(state: NarratorFixtureState): string[] {
  return state.calls.filter((call) => !call.startsWith('GET'));
}

describe('Settings › Language model (WP 10.6)', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('says in words what narrates now, and each provider’s key, host and readiness', async () => {
    stubFetchRoutes(narratorApi().routes);
    renderSection();

    expect(await screen.findByTestId('narrator-active')).toHaveTextContent(
      `Narrating with the local model ${PINNED_MODEL}.`,
    );
    const openai = await card('openai');
    expect(openai).toHaveTextContent("Set by the operator's secret file");
    expect(openai).toHaveTextContent('Talks only to api.openai.com.');
    expect(openai).toHaveTextContent('Ready to narrate.');
    const openrouter = await card('openrouter');
    expect(openrouter).toHaveTextContent(/Stored in this install since .*2026/u);
    expect(openrouter).toHaveTextContent('ends in r9Qx');
    expect(openrouter).toHaveTextContent('Not ready: its consent is not ticked');
    const anthropic = await card('anthropic');
    expect(anthropic).toHaveTextContent('Not set.');
    expect(anthropic).toHaveTextContent('Talks only to api.anthropic.com.');
    const ollama = await card('ollama');
    expect(ollama).toHaveTextContent('In use');
    expect(ollama).toHaveTextContent(
      'No bearer token set. Ollama needs none unless your endpoint asks for one.',
    );
    expect(screen.getByTestId('narrator-settings')).toHaveTextContent(
      'merchants pseudonymised — never a transaction, never an account number',
    );
  });

  it('W1: a hosted provider cannot be made active until its consent is ticked AND it has a key — the reason is in words', async () => {
    const api = narratorApi();
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();

    // OpenRouter has a stored key but no consent: the key alone does not make it a choice.
    const openrouterRadio = await screen.findByRole('radio', { name: /^OpenRouter/u });
    expect(openrouterRadio).toBeDisabled();
    expect(openrouterRadio).toHaveAccessibleDescription(
      "Tick OpenRouter's consent on its card first.",
    );

    const radio = await screen.findByRole('radio', { name: /^Anthropic/u });
    expect(radio).toBeDisabled();
    expect(radio).toHaveAccessibleDescription(
      "Tick Anthropic's consent and save a key on its card first.",
    );

    // The consent's label is the api's text, exactly.
    const anthropic = await card('anthropic');
    const consent = within(anthropic).getByRole('checkbox', { name: consentText('anthropic') });
    expect(consent).not.toBeChecked();
    expect(consent).toHaveAccessibleName(
      expect.stringContaining(
        'Brief findings: aggregated amounts, bucketed, merchants pseudonymised — never a transaction, never an account number',
      ),
    );
    await user.click(consent);
    await waitFor(() => expect(consent).toBeChecked());
    expect(api.state.consents.anthropic).not.toBeNull();
    // Consent alone is not enough: there is still no key.
    expect(radio).toBeDisabled();
    expect(radio).toHaveAccessibleDescription('Save a Anthropic key on its card first.');

    await user.type(within(anthropic).getByLabelText('Anthropic API key'), KEY);
    await user.click(within(anthropic).getByRole('button', { name: 'Save with passkey' }));
    await waitFor(() => expect(anthropic).toHaveTextContent('ends in WXYZ'));
    expect(radio).toBeEnabled();
    expect(radio).not.toHaveAttribute('aria-describedby');
  });

  it('W1: the consent goes through the step-up with the version shown, and unticking the active provider turns the narrator off', async () => {
    const api = narratorApi({ activeProvider: 'openai' });
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();

    expect(await screen.findByTestId('narrator-active')).toHaveTextContent(
      'Narrating with OpenAI gpt-6.1-sol.',
    );
    const openai = await card('openai');
    const consent = within(openai).getByRole('checkbox', { name: consentText('openai') });
    expect(consent).toBeChecked();
    await user.click(consent);
    await waitFor(() => expect(consent).not.toBeChecked());
    expect(writes(api.state)).toEqual([
      'DELETE /api/narrator/providers/openai/consent',
      'DELETE /api/narrator/providers/openai/consent',
    ]);
    expect(api.state.stepUps).toBe(1);
    expect(within(openai).getAllByRole('status')[0]).toHaveTextContent(
      'Consent withdrawn. The narrator is now off: the Brief shows its own wording.',
    );
    expect(screen.getByTestId('narrator-active')).toHaveTextContent(
      'Off: the Brief shows its own wording.',
    );
  });

  it('W2: every key field is masked, and the Ollama one is an optional bearer token', async () => {
    stubFetchRoutes(narratorApi().routes);
    renderSection();
    for (const [provider, label] of [
      ['anthropic', 'Anthropic API key'],
      ['openrouter', 'OpenRouter API key'],
      ['ollama', 'Ollama bearer token (optional)'],
    ] as const) {
      const field = within(await card(provider)).getByLabelText(label);
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveValue('');
    }
  });

  it('W3/W4: Save goes through the step-up, the field is emptied and focused, the key never comes back, and its last four show', async () => {
    const api = narratorApi();
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();

    const anthropic = await card('anthropic');
    const field = within(anthropic).getByLabelText('Anthropic API key');
    await user.type(field, KEY);
    await user.click(within(anthropic).getByRole('button', { name: 'Save with passkey' }));

    await waitFor(() => expect(anthropic).toHaveTextContent('ends in WXYZ'));
    // Refused for want of a step-up, the ceremony once, the retry.
    expect(writes(api.state)).toEqual([
      'PUT /api/narrator/providers/anthropic/credentials',
      'PUT /api/narrator/providers/anthropic/credentials',
    ]);
    expect(api.state.stepUps).toBe(1);
    expect(api.state.keyBodies).toEqual([{ key: KEY }]);

    expect(within(anthropic).getByLabelText('Anthropic API key')).toHaveValue('');
    expect(within(anthropic).getByLabelText('Anthropic API key')).toHaveFocus();
    expect(document.body.textContent).not.toContain(KEY);
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument();
    expect(within(anthropic).getByText(/^Saved\. Nothing was sent to Anthropic/u)).toHaveAttribute(
      'role',
      'status',
    );
  });

  it('W3: the field is emptied when the save is refused too, and the api’s words are shown', async () => {
    const api = narratorApi();
    const detail = 'The api refused this key for a reason of its own.';
    stubFetchRoutes([
      {
        match: '/api/narrator/providers/anthropic/credentials',
        method: 'PUT',
        handle: () =>
          jsonResponse(
            { type: 'about:blank', title: 'x', status: 400, code: 'validation', detail },
            400,
          ),
      },
      ...api.routes,
    ]);
    renderSection();
    const user = userEvent.setup();
    const anthropic = await card('anthropic');
    await user.type(within(anthropic).getByLabelText('Anthropic API key'), KEY);
    await user.click(within(anthropic).getByRole('button', { name: 'Save with passkey' }));
    expect(await within(anthropic).findByRole('alert')).toHaveTextContent(detail);
    expect(within(anthropic).getByLabelText('Anthropic API key')).toHaveValue('');
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument();
  });

  it('refuses a malformed key before sending anything', async () => {
    const api = narratorApi();
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();
    const anthropic = await card('anthropic');
    await user.type(within(anthropic).getByLabelText('Anthropic API key'), 'too short!');
    await user.click(within(anthropic).getByRole('button', { name: 'Save with passkey' }));
    expect(await within(anthropic).findByRole('alert')).toHaveTextContent(
      'A key is 16 to 512 letters, digits and - _ . : = + / only. Nothing was sent.',
    );
    expect(writes(api.state)).toEqual([]);
  });

  it('W5: a stored key is removed only after a confirmation, and through the step-up', async () => {
    const api = narratorApi();
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();

    const openrouter = await card('openrouter');
    await user.click(within(openrouter).getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the stored OpenRouter key?' });
    expect(dialog).toHaveTextContent('This does not revoke the key at OpenRouter');
    expect(writes(api.state)).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes(api.state)).toEqual([]);

    await user.click(within(openrouter).getByRole('button', { name: 'Remove' }));
    const again = await screen.findByRole('dialog', { name: 'Remove the stored OpenRouter key?' });
    await user.click(within(again).getByRole('button', { name: 'Remove key' }));
    await waitFor(() =>
      expect(within(openrouter).getByTestId('narrator-key-openrouter-status')).toHaveTextContent(
        'Not set.',
      ),
    );
    expect(writes(api.state)).toEqual([
      'DELETE /api/narrator/providers/openrouter/credentials',
      'DELETE /api/narrator/providers/openrouter/credentials',
    ]);
    expect(api.state.stepUps).toBe(1);
    expect(within(openrouter).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('W6: only the last four characters of a stored key are shown, even if the api sent more', async () => {
    stubFetchRoutes(narratorApi({}, { plant: true }).routes);
    renderSection();
    const openrouter = await card('openrouter');
    expect(openrouter).toHaveTextContent('ends in r9Qx');
    expect(document.body.textContent).not.toContain(STORED_KEY_CANARY);
    expect(screen.queryByDisplayValue(STORED_KEY_CANARY)).not.toBeInTheDocument();
    expect(within(openrouter).getByLabelText('OpenRouter API key')).toHaveValue('');
  });

  it("W7: the operator's file is read-only — no key field, no Save, no Remove — and the rest of the card still works", async () => {
    stubFetchRoutes(narratorApi().routes);
    renderSection();
    const openai = await card('openai');
    expect(openai).toHaveTextContent("Set by the operator's secret file");
    expect(within(openai).queryByLabelText('OpenAI API key')).not.toBeInTheDocument();
    expect(
      within(openai).queryByRole('button', { name: 'Save with passkey' }),
    ).not.toBeInTheDocument();
    expect(within(openai).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(openai.querySelector('input[type="password"]')).toBeNull();
    expect(within(openai).getByRole('button', { name: 'Test OpenAI' })).toBeEnabled();
    expect(within(openai).getByLabelText('Model id')).toBeInTheDocument();
  });

  it('W9: Test shows the api’s result in words in a polite live region, and the 20 s refusal as a sentence', async () => {
    const api = narratorApi();
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();

    const openai = await card('openai');
    const region = within(openai).getByTestId('narrator-test-openai');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();

    await user.click(within(openai).getByRole('button', { name: 'Test OpenAI' }));
    await waitFor(() =>
      expect(region).toHaveTextContent(
        "Test passed. OpenAI answered in 412 ms with gpt-6.1-sol, in the narration's reply format. Nothing personal was sent.",
      ),
    );
    expect(within(openai).getByRole('button', { name: 'Test OpenAI' })).toHaveFocus();

    await user.click(within(openai).getByRole('button', { name: 'Test OpenAI' }));
    await waitFor(() =>
      expect(region).toHaveTextContent(
        'Test did not pass. Tested a moment ago. Try again in 17 s.',
      ),
    );
    expect(api.state.stepUps).toBe(0);

    const anthropic = await card('anthropic');
    await user.click(within(anthropic).getByRole('button', { name: 'Test Anthropic' }));
    await waitFor(() =>
      expect(within(anthropic).getByTestId('narrator-test-anthropic')).toHaveTextContent(
        'Test did not pass. Anthropic has no key yet. Save one first.',
      ),
    );
  });

  it('W10: Off is selectable, goes through the step-up, and says the Brief keeps its own wording', async () => {
    const api = narratorApi();
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();

    const off = await screen.findByRole('radio', { name: /^Off/u });
    expect(off).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Use this provider' })).toBeDisabled();
    await user.click(off);
    await user.click(screen.getByRole('button', { name: 'Use this provider' }));

    const form = screen.getByTestId('narrator-active-form');
    await waitFor(() =>
      expect(within(form).getByRole('status')).toHaveTextContent(
        'Saved. Off: the Brief shows its own wording.',
      ),
    );
    expect(screen.getByTestId('narrator-active')).toHaveTextContent(
      'Off: the Brief shows its own wording.',
    );
    expect(writes(api.state)).toEqual(['PUT /api/narrator/settings', 'PUT /api/narrator/settings']);
    expect(api.state.activeProvider).toBe('off');
    expect(screen.queryByTestId('narrator-approvals-withdrawn')).not.toBeInTheDocument();
    // The button is disabled once the choice is saved; focus goes back to the chosen radio (2.4.3).
    await waitFor(() => expect(screen.getByRole('radio', { name: /^Off/u })).toHaveFocus());
  });

  it('making a provider active that withdraws the payload approval says so, with a link to Advisor management', async () => {
    const api = narratorApi({
      consents: { openai: null, openrouter: null, anthropic: '2026-10-01T00:00:00.000Z' },
      keys: {
        ...initialNarratorState().keys,
        anthropic: {
          source: 'stored',
          hint: 'ab12',
          storedAt: '2026-10-01T00:00:00.000Z',
          rotatedAt: null,
        },
      },
    });
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('radio', { name: /^Anthropic/u }));
    await user.click(screen.getByRole('button', { name: 'Use this provider' }));
    const note = await screen.findByTestId('narrator-approvals-withdrawn');
    expect(note).toHaveTextContent(
      "The narrator's payload approval was withdrawn: approve the payload again under Anthropic claude-sonnet-5-5 in Advisor management.",
    );
    expect(within(note).getByRole('link', { name: 'Advisor management' })).toHaveAttribute(
      'href',
      '/settings/advisors',
    );
    expect(screen.getByTestId('narrator-active')).toHaveTextContent(
      'Narrating with Anthropic claude-sonnet-5-5.',
    );
    expect(api.state.stepUps).toBe(1);
  });

  it("the api's 409 on a switch is shown in its words", async () => {
    const api = narratorApi();
    const detail = "OpenAI has no key: save one (or write the operator's secret file) first.";
    stubFetchRoutes([
      {
        match: '/api/narrator/settings',
        method: 'PUT',
        handle: () =>
          jsonResponse(
            {
              type: 'about:blank',
              title: 'Conflict',
              status: 409,
              code: 'narrator.key_required',
              detail,
            },
            409,
          ),
      },
      ...api.routes,
    ]);
    renderSection();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /^OpenAI/u }));
    await user.click(screen.getByRole('button', { name: 'Use this provider' }));
    expect(
      await within(screen.getByTestId('narrator-active-form')).findByRole('alert'),
    ).toHaveTextContent(detail);
  });

  it('a hosted model id is saved through the step-up, reset to the default with null, and the active one’s change withdraws the approval', async () => {
    const api = narratorApi({ activeProvider: 'openai' });
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();

    const openai = await card('openai');
    const field = within(openai).getByLabelText('Model id');
    expect(field).toHaveAttribute('placeholder', 'gpt-6.1-sol');
    expect(openai).toHaveTextContent('In use: gpt-6.1-sol (the default)');
    await user.type(field, 'gpt-6.1-mini');
    await user.click(within(openai).getByRole('button', { name: 'Save model' }));
    await waitFor(() => expect(openai).toHaveTextContent('Saved. OpenAI uses gpt-6.1-mini.'));
    expect(within(openai).getByTestId('narrator-approvals-withdrawn')).toHaveTextContent(
      'approve the payload again under OpenAI gpt-6.1-mini in Advisor management',
    );
    expect(api.state.models.openai).toBe('gpt-6.1-mini');

    await user.click(within(openai).getByRole('button', { name: 'Use the default' }));
    await waitFor(() =>
      expect(openai).toHaveTextContent('Saved. OpenAI uses its default, gpt-6.1-sol.'),
    );
    expect(api.state.models.openai).toBeNull();
    expect(within(openai).getByLabelText('Model id')).toHaveValue('');
  });

  it("Ollama pinned by the operator's environment is read-only", async () => {
    stubFetchRoutes(narratorApi().routes);
    renderSection();
    const ollama = await card('ollama');
    expect(within(ollama).getByTestId('narrator-ollama-locked')).toHaveTextContent(
      `Model ${PINNED_MODEL}`,
    );
    expect(ollama).toHaveTextContent("Pinned by the operator's environment");
    expect(within(ollama).queryByLabelText('Endpoint')).not.toBeInTheDocument();
    expect(
      within(ollama).queryByRole('button', { name: 'Save local model' }),
    ).not.toBeInTheDocument();
  });

  it('Ollama not pinned: endpoint, model name and digest are saved through the step-up; a refused endpoint shows the api’s words; Clear empties them', async () => {
    const api = narratorApi({
      ollama: { pinned: false, endpoint: null, model: null, digest: null },
    });
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();

    const ollama = await card('ollama');
    expect(ollama).toHaveTextContent('Not ready: no local model is configured');
    const radio = screen.getByRole('radio', { name: /^Ollama \(local\)/u });
    expect(radio).toBeDisabled();

    await user.type(within(ollama).getByLabelText('Endpoint'), 'https://ollama.example.com');
    await user.type(within(ollama).getByLabelText('Model name'), 'llama3.2:3b');
    await user.type(within(ollama).getByLabelText('Model digest'), `sha256:${'a1'.repeat(32)}`);
    await user.click(within(ollama).getByRole('button', { name: 'Save local model' }));
    expect(await within(ollama).findByRole('alert')).toHaveTextContent(
      'That endpoint is refused by the local-endpoint policy',
    );

    await user.clear(within(ollama).getByLabelText('Endpoint'));
    await user.type(within(ollama).getByLabelText('Endpoint'), 'http://ollama:11434');
    await user.click(within(ollama).getByRole('button', { name: 'Save local model' }));
    await waitFor(() => expect(ollama).toHaveTextContent('Ready to narrate.'));
    expect(api.state.ollama).toEqual({
      pinned: false,
      endpoint: 'http://ollama:11434',
      model: 'llama3.2:3b',
      digest: `sha256:${'a1'.repeat(32)}`,
    });
    expect(radio).toBeEnabled();

    await user.click(within(ollama).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(ollama).toHaveTextContent('Not ready: no local model is configured'),
    );
    expect(within(ollama).getByLabelText('Endpoint')).toHaveValue('');
  });

  it('a bad digest is refused before anything is sent', async () => {
    const api = narratorApi({
      ollama: { pinned: false, endpoint: null, model: null, digest: null },
    });
    stubFetchRoutes(api.routes);
    renderSection();
    const user = userEvent.setup();
    const ollama = await card('ollama');
    await user.type(within(ollama).getByLabelText('Endpoint'), 'http://ollama:11434');
    await user.type(within(ollama).getByLabelText('Model name'), 'llama3.2:3b');
    await user.type(within(ollama).getByLabelText('Model digest'), 'sha256:nothex');
    await user.click(within(ollama).getByRole('button', { name: 'Save local model' }));
    expect(await within(ollama).findByRole('alert')).toHaveTextContent(
      'The digest is sha256: followed by 64 lowercase hex characters. Nothing was sent.',
    );
    expect(writes(api.state)).toEqual([]);
  });

  it('settings that cannot be read say so', async () => {
    stubFetchRoutes([
      {
        match: '/api/narrator/settings',
        handle: () => jsonResponse({ type: 'about:blank', title: 'x', status: 500 }, 500),
      },
    ]);
    renderSection();
    expect(
      await screen.findByText(
        'The language-model settings cannot be read right now. Try again in a moment.',
      ),
    ).toBeInTheDocument();
  });
});
