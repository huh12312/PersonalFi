// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { riskAnswerFixture, riskInstrumentFixture, riskProfileFixture } from './fixtures.ts';
import { RiskProfileSummary } from './RiskProfileSummary.tsx';
import { RiskQuestionnaire } from './RiskQuestionnaire.tsx';
import { RouterForTest } from './routerTest.tsx';

function mount(node: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterForTest>{node}</RouterForTest>
    </QueryClientProvider>,
  );
}

describe('RiskQuestionnaire', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks every question with its framing, refuses an incomplete answering, then sends exactly what was chosen', async () => {
    let body: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/risk-profile',
        method: 'GET',
        handle: () => jsonResponse(riskInstrumentFixture()),
      },
      {
        match: '/api/risk-profile',
        method: 'PUT',
        handle: async ({ request }) => {
          body = await request.json();
          return jsonResponse(riskAnswerFixture());
        },
      },
    ]);
    const user = userEvent.setup();
    mount(<RiskQuestionnaire />);

    await user.click(await screen.findByRole('button', { name: 'Take the questionnaire' }));
    const stated = screen.getByTestId('risk-item-drawdown.stated');
    const revealed = screen.getByTestId('risk-item-drawdown.revealed');
    expect(stated).toHaveTextContent('What you say');
    expect(revealed).toHaveTextContent('What you have done');

    await user.click(
      within(stated).getByRole('radio', { name: 'Hold and keep contributing as planned' }),
    );
    await user.click(screen.getByRole('button', { name: 'See my risk profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1 is still open');
    expect(body).toBeNull();

    await user.click(within(revealed).getByRole('radio', { name: 'I sold all or most of it' }));
    await user.type(screen.getByLabelText('Years until you start using this money'), '25');
    await user.selectOptions(
      screen.getByLabelText('How soon might you need cash from it?'),
      'high',
    );
    await user.click(screen.getByRole('button', { name: 'See my risk profile' }));

    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toEqual({
      answers: { 'drawdown.stated': 'hold', 'drawdown.revealed': 'sold_all' },
      horizonYears: 25,
      liquidityNeed: 'high',
    });
    const result = await screen.findByTestId('risk-result');
    expect(screen.getByTestId('risk-result-tolerance')).toHaveTextContent(
      'Moderately conservative',
    );
    // The server's explanation, verbatim; the score and the penalty it moved by.
    expect(screen.getByTestId('risk-explanation')).toHaveTextContent(
      'the score follows what you did',
    );
    expect(result).toHaveTextContent('consistency penalty of 2 from 9');
    expect(result).toHaveTextContent('Averaging your answers would have said moderate');
  });

  it('sends the income only when given, with its filing status', async () => {
    let body: Record<string, unknown> = {};
    stubFetchRoutes([
      {
        match: '/api/risk-profile',
        method: 'GET',
        handle: () => jsonResponse(riskInstrumentFixture()),
      },
      {
        match: '/api/risk-profile',
        method: 'PUT',
        handle: async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>;
          return jsonResponse(riskAnswerFixture());
        },
      },
    ]);
    const user = userEvent.setup();
    mount(<RiskQuestionnaire />);
    await user.click(await screen.findByRole('button', { name: 'Take the questionnaire' }));
    await user.click(screen.getByRole('radio', { name: 'Hold and keep contributing as planned' }));
    await user.click(screen.getByRole('radio', { name: 'I changed nothing' }));
    await user.type(screen.getByLabelText('Years until you start using this money'), '10');
    await user.type(screen.getByLabelText('Taxable income, per year (optional)'), '85000');
    await user.selectOptions(screen.getByLabelText('Filing status'), 'mfj');
    await user.click(screen.getByRole('button', { name: 'See my risk profile' }));
    await waitFor(() => expect(body['income']).toBeDefined());
    expect(body['income']).toEqual({
      taxableIncome: { minor: '8500000', currency: 'USD' },
      filingStatus: 'mfj',
    });
  });

  it('says there is no profile yet, or states the current one', async () => {
    stubFetchRoutes([
      {
        match: '/api/risk-profile',
        method: 'GET',
        handle: () => jsonResponse(riskInstrumentFixture()),
      },
    ]);
    const first = mount(<RiskQuestionnaire />);
    expect(await screen.findByTestId('risk-current')).toHaveTextContent('have not answered');
    first.unmount();

    stubFetchRoutes([
      {
        match: '/api/risk-profile',
        method: 'GET',
        handle: () => jsonResponse(riskInstrumentFixture(riskProfileFixture())),
      },
    ]);
    mount(<RiskQuestionnaire />);
    expect(await screen.findByTestId('risk-current')).toHaveTextContent(
      'Moderately conservative risk tolerance, answered 2026-10-05',
    );
    expect(screen.getByRole('button', { name: 'Retake the questionnaire' })).toBeInTheDocument();
  });
});

describe('RiskProfileSummary (what the plan screen reads)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  it('states the stored tolerance and says the projection does not use it', async () => {
    stubFetchRoutes([
      {
        match: '/api/risk-profile',
        method: 'GET',
        handle: () =>
          jsonResponse(riskInstrumentFixture(riskProfileFixture({ tolerance: 'aggressive' }))),
      },
    ]);
    mount(<RiskProfileSummary />);
    const text = await screen.findByTestId('plan-risk-profile-text');
    expect(text).toHaveTextContent('Aggressive risk tolerance');
    expect(screen.getByTestId('plan-risk-profile')).toHaveTextContent(
      'The projection does not use this',
    );
    expect(
      screen.getByRole('link', { name: 'Review or retake the questionnaire' }),
    ).toHaveAttribute('href', '/goals#risk-profile');
  });

  it('offers the questionnaire when there is no profile, and words a failed read', async () => {
    stubFetchRoutes([
      {
        match: '/api/risk-profile',
        method: 'GET',
        handle: () => jsonResponse(riskInstrumentFixture()),
      },
    ]);
    const first = mount(<RiskProfileSummary />);
    expect(await screen.findByRole('link', { name: 'Take the questionnaire' })).toBeInTheDocument();
    first.unmount();

    stubFetchRoutes([
      {
        match: '/api/risk-profile',
        method: 'GET',
        handle: () =>
          jsonResponse({ type: 'about:blank', title: 'x', status: 503, code: 'unavailable' }, 503),
      },
    ]);
    mount(<RiskProfileSummary />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
