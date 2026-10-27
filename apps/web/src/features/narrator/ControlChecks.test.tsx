// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import { ControlChecksSection } from './ControlChecksSection.tsx';
import {
  controlChecksReply,
  finishedRun,
  initialControlChecksState,
  LOCAL_COST,
  pendingRun,
  type ControlChecksFixtureState,
} from './control-checks-fixtures.ts';
import {
  checkStatusWord,
  formatCheckDuration,
  formatClock,
  nextAllowedWords,
  progressWords,
  providerModelWords,
  runResultWords,
  type ControlCheckRun,
} from './control-checks-words.ts';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
}));

/**
 * WP 10.16: Settings › Language model › Control checks, against `control-checks-fixtures.ts` (the api's rules, with
 * real state): the cost said before the button, the passkey step-up for a run, the twelve checks ticking over with a
 * polite live region, the results table in words (never colour alone), the button unavailable until the api's
 * `nextAllowedAt`, the api's 409 in words, and every past run behind a disclosure.
 */

const MINUTE = 60_000;

function api(overrides: Partial<ControlChecksFixtureState> = {}) {
  const state = initialControlChecksState(overrides);
  const routes: FetchRoute[] = [
    {
      match: '/api/narrator/control-checks',
      handle: async ({ request }) => {
        const text = request.method === 'GET' ? '' : await request.text();
        const reply = controlChecksReply(
          state,
          request.method,
          text === '' ? undefined : JSON.parse(text),
        );
        return new Response(JSON.stringify(reply.body), {
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
        state.calls.push('step-up');
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
      <ControlChecksSection />
    </QueryClientProvider>,
  );
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A run with one of every result the table can draw. */
function everyKindRun(): ControlCheckRun {
  return finishedRun('11111111-1111-4111-8111-111111111111', ago(30 * MINUTE), {
    egress_allowlist: {
      status: 'fail',
      reason: 'The adapter connected to a host it does not list.',
      facts: ['It reached example.invalid before refusing.'],
      durationMs: 1234,
    },
    narration_badge: { durationMs: null },
  });
}

describe('control checks, in words', () => {
  it('names every result in words; a provider skip is "Not applicable"', () => {
    expect(checkStatusWord({ status: 'pass', notApplicable: false })).toBe('Pass');
    expect(checkStatusWord({ status: 'fail', notApplicable: false })).toBe('Fail');
    expect(checkStatusWord({ status: 'skipped', notApplicable: false })).toBe('Skipped');
    expect(checkStatusWord({ status: 'skipped', notApplicable: true })).toBe('Not applicable');
    expect(checkStatusWord({ status: 'reported', notApplicable: false })).toBe('Reported');
    expect(checkStatusWord({ status: 'pending', notApplicable: false })).toBe('Pending');
    expect(checkStatusWord({ status: 'running', notApplicable: false })).toBe('Running');
  });

  it('names a run’s result in words', () => {
    expect(runResultWords({ state: 'finished', overall: 'pass' })).toBe('Pass');
    expect(runResultWords({ state: 'finished', overall: 'fail' })).toBe('Fail');
    expect(runResultWords({ state: 'finished', overall: 'partial' })).toBe(
      'Partial: some checks could not run',
    );
    expect(runResultWords({ state: 'interrupted', overall: null })).toBe('Interrupted');
    expect(runResultWords({ state: 'running', overall: null })).toBe('Running');
  });

  it('formats durations, the provider and model, progress, and the wait', () => {
    expect(formatCheckDuration(1234)).toBe('1.2 s');
    expect(formatCheckDuration(40)).toBe('0.0 s');
    expect(formatCheckDuration(65_000)).toBe('1 min 5 s');
    expect(formatCheckDuration(null)).toBe('—');
    expect(providerModelWords('anthropic', 'anthropic:claude-sonnet-5-5')).toBe(
      'Anthropic, claude-sonnet-5-5',
    );
    expect(providerModelWords('ollama', `qwen2.5:7b@sha256:${'ab'.repeat(32)}`)).toBe(
      'Ollama (local), qwen2.5:7b at sha256:abababababab…',
    );
    expect(providerModelWords('off', null)).toBe('Off (no model)');
    const run = pendingRun('r', ago(0));
    expect(progressWords(run)).toBe('0 of 12 checks done.');
    const now = new Date(2026, 9, 19, 14, 22);
    const later = new Date(2026, 9, 19, 14, 32).toISOString();
    expect(nextAllowedWords(later, now)).toBe('You can run the checks again at 14:32.');
    expect(formatClock(later, now)).toBe('14:32');
    expect(nextAllowedWords(new Date(2026, 9, 19, 14, 0).toISOString(), now)).toBeNull();
    expect(nextAllowedWords(null, now)).toBeNull();
  });
});

describe('Settings › Language model › Control checks (WP 10.16)', () => {
  beforeEach(() => {
    ensureApiClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('states the cost, verbatim, before the Run control checks button', async () => {
    stubFetchRoutes(api().routes);
    renderSection();
    const cost = await screen.findByTestId('control-checks-cost');
    expect(cost).toHaveTextContent(LOCAL_COST.message);
    const button = screen.getByRole('button', { name: 'Run control checks' });
    // The cost precedes the button in the reading order.
    expect(cost.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('control-checks-never')).toHaveTextContent(
      'The controls have not been checked on this install yet.',
    );
  });

  it('draws the results table: a caption, scoped headers, every result in words, the reason before the facts, durations', async () => {
    stubFetchRoutes(api({ runs: [everyKindRun()] }).routes);
    renderSection();
    const table = await screen.findByTestId('control-checks-table');
    expect(table.tagName).toBe('TABLE');
    expect(table.querySelector('caption')).toHaveTextContent(
      /^Control checks of .+, with Ollama \(local\), qwen2\.5:7b-instruct-q4_K_M at sha256:3f3f3f3f3f3f…: Fail\.$/,
    );
    const columns = within(table).getAllByRole('columnheader');
    expect(columns.map((th) => th.textContent)).toEqual(['Check', 'Result', 'Facts', 'Duration']);
    for (const th of columns) expect(th).toHaveAttribute('scope', 'col');
    const rowHeaders = within(table).getAllByRole('rowheader');
    expect(rowHeaders).toHaveLength(12);
    for (const th of rowHeaders) expect(th).toHaveAttribute('scope', 'row');

    const row = (id: string) => within(table).getByTestId(`control-check-${id}`);
    // The name, with what it proves as secondary text.
    expect(row('approval_gate')).toHaveTextContent('Payload approval gate');
    expect(row('approval_gate')).toHaveTextContent(
      'A narration whose payload shape has no live approval is refused payload_not_approved',
    );
    const result = (id: string) => within(row(id)).getByTestId('control-check-result');
    expect(result('approval_gate')).toHaveTextContent(/^Pass$/);
    expect(result('egress_allowlist')).toHaveTextContent(/^Fail$/);
    expect(result('inspector_digest')).toHaveTextContent(/^Skipped$/);
    expect(result('consent_withdrawal')).toHaveTextContent(/^Not applicable$/);
    expect(result('module_switch')).toHaveTextContent(/^Reported$/);

    // Facts: the reason first, then the facts as a list.
    const facts = within(row('egress_allowlist')).getByTestId('control-check-facts');
    const reason = within(facts).getByTestId('control-check-reason');
    expect(reason).toHaveTextContent('The adapter connected to a host it does not list.');
    const list = within(facts).getByRole('list');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['It reached example.invalid before refusing.']);
    expect(reason.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(row('inspector_digest')).getByTestId('control-check-facts')).toHaveTextContent(
      'No narration has run yet with its payload retained (the last 30 days).',
    );
    expect(
      within(within(row('module_switch')).getByTestId('control-check-facts')).getAllByRole(
        'listitem',
      ),
    ).toHaveLength(2);

    // Duration.
    expect(within(row('egress_allowlist')).getByTestId('control-check-duration')).toHaveTextContent(
      '1.2 s',
    );
    expect(within(row('narration_badge')).getByTestId('control-check-duration')).toHaveTextContent(
      '—',
    );
    // Narrow screens: the same words under the result (the Facts and Duration columns are not displayed there).
    const narrow = within(row('egress_allowlist')).getByTestId('control-check-narrow');
    expect(narrow).toHaveClass('sm:hidden');
    expect(narrow).toHaveTextContent('The adapter connected to a host it does not list.');
    expect(narrow).toHaveTextContent('Took 1.2 s');
    expect(within(row('egress_allowlist')).getByTestId('control-check-facts')).toHaveClass(
      'hidden',
      'sm:table-cell',
    );
    expect(screen.getByTestId('control-checks-summary')).toHaveTextContent(
      /Result: Fail\. 7 passed, 1 failed, 1 skipped, 2 not applicable, 1 reported\./,
    );
  });

  it('shows Pending and Running in words while a run goes', async () => {
    const run = pendingRun('22222222-2222-4222-8222-222222222222', ago(5_000));
    const done = finishedRun(run.id, run.startedAt);
    run.results = run.results.map((row, i) =>
      i < 2 ? done.results[i]! : i === 2 ? { ...row, status: 'running' } : row,
    );
    stubFetchRoutes(api({ runs: [run], advancePerRead: 0 }).routes);
    renderSection();
    const table = await screen.findByTestId('control-checks-table');
    const resultOf = (id: string) =>
      within(within(table).getByTestId(`control-check-${id}`)).getByTestId('control-check-result');
    expect(resultOf('numerals_refusal')).toHaveTextContent(/^Running$/);
    expect(resultOf('schema_refusal')).toHaveTextContent(/^Pending$/);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Running control checks… 2 of 12 checks done.',
    );
    expect(screen.getByTestId('control-checks-run')).toHaveTextContent('Running control checks…');
    expect(screen.getByTestId('control-checks-run')).toHaveAttribute('aria-disabled', 'true');
  });

  it('runs the checks through the passkey step-up; the rows tick over in a polite live region to the final table', async () => {
    const { state, routes } = api();
    stubFetchRoutes(routes);
    const user = userEvent.setup();
    renderSection();
    const button = await screen.findByRole('button', { name: 'Run control checks' });
    await user.click(button);

    // Refused for want of a step-up, the ceremony, then the retry.
    await waitFor(() => expect(state.stepUps).toBe(1));
    expect(state.calls.filter((c) => !c.startsWith('GET'))).toEqual([
      'POST /api/narrator/control-checks',
      'step-up',
      'POST /api/narrator/control-checks',
    ]);
    expect(state.bodies).toEqual([{}]);

    const live = screen.getByTestId('control-checks-progress');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(live).toHaveTextContent(/of 12 checks done\./));
    // Focus stays on the button: it is aria-disabled, never disabled.
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveTextContent('Running control checks…');

    await waitFor(
      () =>
        expect(live).toHaveTextContent(
          'Control checks finished. Result: Partial: some checks could not run.',
        ),
      { timeout: 10_000 },
    );
    const table = screen.getByTestId('control-checks-table');
    expect(within(table).getAllByRole('rowheader')).toHaveLength(12);
    expect(table.querySelectorAll('[data-status="pending"], [data-status="running"]')).toHaveLength(
      0,
    );
    expect(button).toHaveTextContent('Run control checks');
    expect(screen.getByTestId('control-checks-wait')).toHaveTextContent(
      /^You can run the checks again at \d{2}:\d{2}\.$/,
    );
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute(
      'aria-describedby',
      screen.getByTestId('control-checks-wait').id,
    );
  }, 20_000);

  it('asks for kill switch 1 to be proven only when the box is ticked', async () => {
    const { state, routes } = api({ fresh: true });
    stubFetchRoutes(routes);
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole('checkbox', {
        name: 'Also prove kill switch 1 (turns the module off inside a transaction that is rolled back)',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Run control checks' }));
    await waitFor(() => expect(state.bodies).toEqual([{ proveSwitch: true }]));
  });

  it('is unavailable until nextAllowedAt, and says when in words; pressing it sends nothing', async () => {
    const { state, routes } = api({
      fresh: true,
      runs: [finishedRun('33333333-3333-4333-8333-333333333333', ago(2 * MINUTE))],
    });
    stubFetchRoutes(routes);
    const user = userEvent.setup();
    renderSection();
    const wait = await screen.findByTestId('control-checks-wait');
    expect(wait).toHaveTextContent(/^You can run the checks again at \d{2}:\d{2}\.$/);
    const button = screen.getByRole('button', { name: 'Run control checks' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(wait.textContent ?? '');
    await user.click(button);
    expect(state.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
  });

  it('shows the api’s 409 in words', async () => {
    const { routes } = api({
      fresh: true,
      reportWindow: false,
      runs: [finishedRun('44444444-4444-4444-8444-444444444444', ago(2 * MINUTE))],
    });
    stubFetchRoutes(routes);
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: 'Run control checks' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'The controls were checked less than 10 minutes ago. Try again in 8 min.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists every past run with its result in words, and opens one to its table', async () => {
    const older = finishedRun('55555555-5555-4555-8555-555555555555', ago(3 * 24 * 60 * MINUTE));
    const interrupted: ControlCheckRun = {
      ...pendingRun('66666666-6666-4666-8666-666666666666', ago(2 * 24 * 60 * MINUTE)),
      state: 'interrupted',
    };
    stubFetchRoutes(api({ runs: [everyKindRun(), interrupted, older] }).routes);
    const user = userEvent.setup();
    renderSection();
    const history = await screen.findByTestId('control-checks-history');
    const summaries = history.querySelectorAll('summary');
    expect([...summaries].map((s) => s.textContent)).toEqual([
      expect.stringMatching(/ \(latest\) · Ollama \(local\), qwen2\.5.+ · Fail$/),
      expect.stringMatching(/ · Interrupted$/),
      expect.stringMatching(/ · Partial: some checks could not run$/),
    ]);
    expect(screen.queryByTestId(`control-checks-history-table-${older.id}`)).toBeNull();
    await user.click(summaries[2] as HTMLElement);
    const table = await screen.findByTestId(`control-checks-history-table-${older.id}`);
    expect(within(table).getAllByRole('rowheader')).toHaveLength(12);
  });

  it('says the checks cannot be read, and offers no button, when the route fails', async () => {
    stubFetchRoutes([
      {
        match: '/api/narrator/control-checks',
        handle: () => jsonResponse({ code: 'internal' }, 500),
      },
    ]);
    renderSection();
    expect(
      await screen.findByText(
        'The control checks cannot be read right now. Try again in a moment.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run control checks' })).toBeNull();
  });
});
