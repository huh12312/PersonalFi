// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  Account,
  ListMerchantNameSuggestionsResponse,
  MerchantNameSuggestion,
  Transaction,
} from '../../api/generated/types.gen.ts';
import { routeTree } from '../../routeTree.gen.ts';
import {
  buildTransaction,
  buildTransactionDetail,
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { DEFAULT_OVERLAY } from '../accounts/fixtures.ts';

/**
 * WP 11.6: the local model's display name for a noise merchant, as a chip beside the bank's text on the transaction
 * list and in the detail sheet; the one-line note where it cannot be asked for. The whole screen is mounted (router,
 * list, sheet) against a stubbed network that keeps state, so what is asserted is what the holder would see and what
 * was really sent.
 */
const SESSION = {
  userId: 'user_1',
  displayName: 'Chris',
  displayTimezone: 'UTC',
  authMethod: 'webauthn',
  trustedDevice: true,
  fresh: true,
  idleExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  credentialCount: 1,
  totpEnrolled: true,
  recoveryCodesRemaining: 10,
};

const ACCOUNT: Account = {
  id: 'acct_1',
  connectionId: 'conn_1',
  provider: 'manual',
  name: 'Everyday Checking',
  officialName: null,
  type: 'depository',
  subtype: null,
  classification: 'asset',
  currency: 'USD',
  mask: '1234',
  closedAt: null,
  includeInNetWorth: true,
  balance: null,
  overlay: DEFAULT_OVERLAY,
};

const MODEL = 'qwen2.5:7b-instruct-q4_K_M';
const EBAY = 'merch_ebay';
const SUGGESTION_ID = '0190c000-0000-7000-8000-000000000001';

function suggestion(overrides: Partial<MerchantNameSuggestion> = {}): MerchantNameSuggestion {
  return {
    id: SUGGESTION_ID,
    merchantId: EBAY,
    descriptor: 'PAYPAL *EBAYINC',
    strippedPrefix: 'PAYPAL *',
    status: 'suggested',
    displayName: 'Ebay',
    provider: 'ollama',
    model: MODEL,
    suggestedAt: '2026-10-20T08:05:00.000Z',
    decidedAt: null,
    ...overrides,
  };
}

const AVAILABLE = { available: true, reason: null, provider: 'ollama', model: MODEL } as const;

interface Recorded {
  lists: number;
  accepts: string[];
  dismisses: string[];
  /** Every request that is not a GET: nothing may be sent on render. */
  writes: string[];
}

interface World {
  items: MerchantNameSuggestion[];
  pending: Array<{ merchantId: string; descriptor: string }>;
  availability: ListMerchantNameSuggestionsResponse['availability'];
  rows: Transaction[];
  renamed?: number;
}

function setup(world: World) {
  const recorded: Recorded = { lists: 0, accepts: [], dismisses: [], writes: [] };
  stubFetchRoutes([
    categoriesRoute(),
    { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
    { match: '/api/accounts', handle: () => jsonResponse({ accounts: [ACCOUNT] }) },
    {
      match: '/api/transactions/explanations',
      handle: () => jsonResponse({ items: [] }),
    },
    {
      match: '/api/merchants/name-suggestions',
      method: 'GET',
      handle: () => {
        recorded.lists += 1;
        return jsonResponse({
          availability: world.availability,
          items: world.items,
          pending: world.pending,
        });
      },
    },
    {
      match: /^\/api\/merchants\/name-suggestions\/[^/]+\/accept$/,
      method: 'POST',
      handle: ({ url }) => {
        const id = url.pathname.split('/')[4] ?? '';
        recorded.accepts.push(id);
        recorded.writes.push(`POST ${url.pathname}`);
        const accepted = world.items.find((item) => item.id === id);
        if (accepted === undefined) return jsonResponse({ code: 'ledger.not_found' }, 404);
        let renamed = 0;
        world.rows = world.rows.map((row) => {
          if (row.merchantId !== accepted.merchantId) return row;
          renamed += 1;
          return { ...row, name: accepted.displayName };
        });
        world.items = world.items.map((item) =>
          item.id === id
            ? { ...item, status: 'accepted', decidedAt: '2026-10-29T10:00:00.000Z' }
            : item,
        );
        return jsonResponse({ suggestion: { ...accepted, status: 'accepted' }, renamed });
      },
    },
    {
      match: /^\/api\/merchants\/name-suggestions\/[^/]+\/dismiss$/,
      method: 'POST',
      handle: ({ url }) => {
        const id = url.pathname.split('/')[4] ?? '';
        recorded.dismisses.push(id);
        recorded.writes.push(`POST ${url.pathname}`);
        world.items = world.items.filter((item) => item.id !== id);
        return jsonResponse({ outcome: 'dismissed', suggestionId: id });
      },
    },
    {
      match: /^\/api\/transactions\/[^/]+$/,
      method: 'GET',
      handle: ({ url }) => {
        const row = world.rows.find((candidate) => candidate.id === url.pathname.split('/')[3]);
        if (row === undefined) return jsonResponse({ code: 'not_found' }, 404);
        const detail = buildTransactionDetail(row);
        // The bank's own text is the provider name; the row's `name` is the holder's when renamed.
        return jsonResponse({
          ...detail,
          provenance: { ...detail.provenance, providerName: 'PAYPAL *EBAYINC' },
        });
      },
    },
    {
      match: '/api/transactions',
      method: 'GET',
      handle: () =>
        jsonResponse({
          items: world.rows,
          nextCursor: null,
          summary: { count: world.rows.length, totals: [] },
        }),
    },
  ]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ['/transactions'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { recorded, router };
}

const ebayRow = (id: string, overrides: Partial<Transaction> = {}) =>
  buildTransaction({
    id,
    name: 'PAYPAL *EBAYINC',
    merchantId: EBAY,
    merchantName: null,
    ...overrides,
  });

function rowOf(id: string): HTMLElement {
  return document.querySelector(`[data-transaction-id="${id}"]`) as HTMLElement;
}

describe('merchant name suggestions on the transaction list (WP 11.6)', () => {
  beforeEach(() => {
    ensureApiClient();
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const suggestedWorld = (): World => ({
    items: [suggestion()],
    pending: [],
    availability: AVAILABLE,
    rows: [
      ebayRow('txn_a'),
      ebayRow('txn_b', { date: '2026-05-30' }),
      buildTransaction({
        id: 'txn_c',
        name: 'Corner Roastery',
        merchantName: null,
        merchantId: 'merch_c',
      }),
    ],
  });

  it('shows the suggested name beside the bank’s text with who made it, and sends nothing on render', async () => {
    const { recorded } = setup(suggestedWorld());

    const chips = await screen.findAllByTestId('merchant-name-chip');
    // Two rows of the merchant carry the chip; the unrelated row does not. One read of the list, not one per row.
    expect(chips).toHaveLength(2);
    expect(rowOf('txn_c').querySelector('[data-testid="merchant-name-chip"]')).toBeNull();
    const first = chips[0] as HTMLElement;
    expect(within(first).getByTestId('merchant-name-chip-name')).toHaveTextContent('Ebay');
    expect(within(first).getByTestId('merchant-name-chip-provenance')).toHaveTextContent(
      'Suggested by the local model (qwen2.5:7b) from the bank’s text',
    );
    // The bank's text is still the row's own, right above the chip.
    expect(within(rowOf('txn_a')).getByText('PAYPAL *EBAYINC')).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: 'Accept the name Ebay' })).toBeVisible();
    expect(within(first).getByRole('button', { name: 'Dismiss the name Ebay' })).toBeVisible();

    expect(recorded.lists).toBe(1);
    expect(recorded.writes).toEqual([]);
  });

  it('shows a chip on a row that arrived after the accept, and none on a row already renamed', async () => {
    setup({
      ...suggestedWorld(),
      items: [suggestion({ status: 'accepted', decidedAt: '2026-10-28T09:00:00.000Z' })],
      rows: [ebayRow('txn_new'), ebayRow('txn_old', { name: 'Ebay' })],
    });

    const chip = await screen.findByTestId('merchant-name-chip');
    expect(chip).toHaveAttribute('data-status', 'accepted');
    expect(chip.closest('[role="row"]')).toHaveAttribute('data-transaction-id', 'txn_new');
    expect(within(chip).getByTestId('merchant-name-chip-provenance')).toHaveTextContent(
      'You accepted it for this merchant before; this row still reads the bank’s text.',
    );
    expect(screen.getAllByTestId('merchant-name-chip')).toHaveLength(1);
  });

  it('Accept sends the one write, renames the rows, reads the list again and says what changed', async () => {
    const world = suggestedWorld();
    const { recorded } = setup(world);
    const user = userEvent.setup();

    const chips = await screen.findAllByTestId('merchant-name-chip');
    await user.click(
      within(chips[0] as HTMLElement).getByRole('button', { name: 'Accept the name Ebay' }),
    );

    await waitFor(() => expect(recorded.accepts).toEqual([SUGGESTION_ID]));
    expect(await screen.findByTestId('merchant-name-status')).toHaveTextContent(
      'Renamed 2 transactions to Ebay.',
    );
    await waitFor(() => expect(screen.queryByTestId('merchant-name-chip')).not.toBeInTheDocument());
    expect(within(rowOf('txn_a')).getByText('Ebay')).toBeInTheDocument();
    expect(within(rowOf('txn_b')).getByText('Ebay')).toBeInTheDocument();
    expect(recorded.lists).toBeGreaterThan(1);
    expect(recorded.dismisses).toEqual([]);
    // Focus is on the row, not lost to the body, and the press did not open the detail.
    expect(document.activeElement).toBe(rowOf('txn_a'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Dismiss records it, removes the chip, leaves the bank’s text and opens nothing', async () => {
    const { recorded } = setup(suggestedWorld());
    const user = userEvent.setup();

    const chips = await screen.findAllByTestId('merchant-name-chip');
    await user.click(
      within(chips[0] as HTMLElement).getByRole('button', { name: 'Dismiss the name Ebay' }),
    );

    await waitFor(() => expect(recorded.dismisses).toEqual([SUGGESTION_ID]));
    await waitFor(() => expect(screen.queryByTestId('merchant-name-chip')).not.toBeInTheDocument());
    expect(screen.getByTestId('merchant-name-status')).toHaveTextContent(
      'Dismissed the name Ebay. The bank’s text stays.',
    );
    expect(within(rowOf('txn_a')).getByText('PAYPAL *EBAYINC')).toBeInTheDocument();
    expect(recorded.accepts).toEqual([]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('is reachable and operable by keyboard: Tab reaches Accept then Dismiss, Enter on Accept accepts without opening the row', async () => {
    const { recorded } = setup(suggestedWorld());
    const user = userEvent.setup();

    const chips = await screen.findAllByTestId('merchant-name-chip');
    const chip = chips[0] as HTMLElement;
    const accept = within(chip).getByRole('button', { name: 'Accept the name Ebay' });
    const dismiss = within(chip).getByRole('button', { name: 'Dismiss the name Ebay' });
    // Real buttons, in the tab order, not disabled.
    expect(accept.tagName).toBe('BUTTON');
    expect(accept).not.toBeDisabled();
    expect(accept.tabIndex).toBe(0);
    expect(dismiss.tabIndex).toBe(0);

    const row = rowOf('txn_a');
    row.focus();
    for (let presses = 0; presses < 8 && document.activeElement !== accept; presses += 1) {
      await user.tab();
    }
    expect(document.activeElement).toBe(accept);
    await user.tab();
    expect(document.activeElement).toBe(dismiss);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(accept);

    await user.keyboard('{Enter}');
    await waitFor(() => expect(recorded.accepts).toEqual([SUGGESTION_ID]));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(recorded.dismisses).toEqual([]);
  });

  it('focusing a chip button does not move the list’s roving row, so a pointer press is not lost to a scroll', async () => {
    setup(suggestedWorld());

    const chips = await screen.findAllByTestId('merchant-name-chip');
    const first = rowOf('txn_a');
    const second = rowOf('txn_b');
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);

    // React's `onFocus` listens to `focusin`, which bubbles from the button to the row.
    fireEvent.focusIn(
      within(chips[1] as HTMLElement).getByRole('button', { name: 'Accept the name Ebay' }),
    );

    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);
  });

  it('tells a failed Accept in words, keeps the chip and changes nothing', async () => {
    const { recorded } = setup(suggestedWorld());
    // The suggestion was dismissed elsewhere since the list was read: the api answers 409.
    stubClosed();
    const user = userEvent.setup();

    const chips = await screen.findAllByTestId('merchant-name-chip');
    await user.click(
      within(chips[0] as HTMLElement).getByRole('button', { name: 'Accept the name Ebay' }),
    );
    expect(recorded.accepts).toEqual([]);
    expect(await within(chips[0] as HTMLElement).findByRole('alert')).toHaveTextContent(
      'That name was dismissed, so it cannot be accepted.',
    );
    expect(screen.getAllByTestId('merchant-name-chip')).toHaveLength(2);
    expect(screen.queryByTestId('merchant-name-status')).toHaveTextContent('');
  });
});

/** Re-stubs only the accept route so it answers the api's 409 `ledger.merchant_name_suggestion_closed`. */
function stubClosed(): void {
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url, 'http://localhost/').pathname.endsWith('/accept')) {
      return jsonResponse(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          code: 'ledger.merchant_name_suggestion_closed',
          detail: 'That name was dismissed, so it cannot be accepted.',
        },
        409,
      );
    }
    return original(input, init);
  });
}

describe('the note where no name can be suggested (WP 11.6)', () => {
  beforeEach(() => {
    ensureApiClient();
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const noiseWorld = (reason: NonNullable<World['availability']['reason']> | null): World => ({
    items: [],
    pending: [{ merchantId: 'merch_noise', descriptor: 'SQ *XJ7Q2 0042' }],
    availability:
      reason === null ? AVAILABLE : { available: false, reason, provider: null, model: null },
    rows: [
      buildTransaction({
        id: 'txn_n1',
        name: 'SQ *XJ7Q2 0042',
        merchantName: null,
        merchantId: 'merch_noise',
      }),
      buildTransaction({
        id: 'txn_n2',
        name: 'SQ *XJ7Q2 0042',
        merchantId: 'merch_noise',
        date: '2026-05-30',
      }),
      buildTransaction({
        id: 'txn_c',
        name: 'Corner Roastery',
        merchantName: null,
        merchantId: 'merch_c',
      }),
    ],
  });

  it('says the shape is not approved, links to Advisors, and appears once for the merchant', async () => {
    const { recorded } = setup(noiseWorld('payload_not_approved'));

    const note = await screen.findByTestId('merchant-name-note');
    expect(note).toHaveTextContent(
      'No name is suggested yet: approve “Merchant name suggestions (local model)” in Advisors.',
    );
    const link = within(note).getByRole('link', { name: 'Advisors' });
    expect(link).toHaveAttribute('href', '/settings/advisors');
    // Two rows of the merchant, one note: quiet. And it is inside the row it belongs to.
    expect(screen.getAllByTestId('merchant-name-note')).toHaveLength(1);
    expect(note.closest('[role="row"]')).toHaveAttribute('data-transaction-id', 'txn_n1');
    expect(recorded.writes).toEqual([]);
  });

  it('follows the link to Advisors without opening the row', async () => {
    const { router } = setup(noiseWorld('payload_not_approved'));
    const user = userEvent.setup();

    const note = await screen.findByTestId('merchant-name-note');
    await user.click(within(note).getByRole('link', { name: 'Advisors' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/advisors'));
  });

  it('says a hosted narrator keeps names on this machine', async () => {
    setup(noiseWorld('hosted_narrator'));
    expect(await screen.findByTestId('merchant-name-note')).toHaveTextContent(
      'Names stay on this machine, so name suggestions run only with the local model.',
    );
  });

  it('says no local model is set up for off and for not configured', async () => {
    setup(noiseWorld('not_configured'));
    expect(await screen.findByTestId('merchant-name-note')).toHaveTextContent(
      'No local model is set up, so no name is suggested.',
    );
  });

  it('shows no note when the pass could ask, and none for a merchant that is not noise', async () => {
    const { recorded } = setup(noiseWorld(null));
    await waitFor(() => expect(recorded.lists).toBe(1));
    await screen.findByText('Corner Roastery');
    expect(screen.queryByTestId('merchant-name-note')).not.toBeInTheDocument();
  });
});

describe('merchant name suggestions in the detail sheet (WP 11.6)', () => {
  beforeEach(() => {
    ensureApiClient();
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(1200);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the bank’s text with the chip, accepts from the sheet, and puts focus on the confirmation', async () => {
    const world: World = {
      items: [suggestion()],
      pending: [],
      availability: AVAILABLE,
      rows: [ebayRow('txn_a')],
    };
    const { recorded } = setup(world);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('row', { name: /PAYPAL \*EBAYINC/u }));
    const section = await screen.findByTestId('merchant-name-section');
    expect(within(section).getByTestId('merchant-name-bank-text')).toHaveTextContent(
      'PAYPAL *EBAYINC',
    );
    const chip = within(section).getByTestId('merchant-name-chip');
    expect(within(chip).getByTestId('merchant-name-chip-provenance')).toHaveTextContent(
      'Suggested by the local model (qwen2.5:7b) from the bank’s text',
    );
    expect(recorded.writes).toEqual([]);

    await user.click(within(chip).getByRole('button', { name: 'Accept the name Ebay' }));

    await waitFor(() => expect(recorded.accepts).toEqual([SUGGESTION_ID]));
    const status = await within(section).findByRole('status');
    expect(status).toHaveTextContent('Renamed 1 transaction to Ebay.');
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(within(section).queryByTestId('merchant-name-chip')).not.toBeInTheDocument();
  });

  it('shows the note, and nothing at all for a merchant the model has no part in', async () => {
    const world: World = {
      items: [],
      pending: [{ merchantId: EBAY, descriptor: 'PAYPAL *EBAYINC' }],
      availability: { available: false, reason: 'hosted_narrator', provider: null, model: null },
      rows: [ebayRow('txn_a'), buildTransaction({ id: 'txn_c', name: 'Corner Roastery' })],
    };
    setup(world);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('row', { name: /PAYPAL \*EBAYINC/u }));
    const section = await screen.findByTestId('merchant-name-section');
    expect(within(section).getByTestId('merchant-name-note')).toHaveTextContent(
      'Names stay on this machine',
    );
  });
});
