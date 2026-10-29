// SPDX-License-Identifier: MIT
import type { Route } from '@playwright/test';

/**
 * WP 11.6's network layer (merchant display-name suggestions), in the shapes `apps/api/src/routes/merchant-names.ts`
 * really sends.
 *
 * - `handleMerchantNames` answers `/api/merchants/name-suggestions*` with real state, wired into `mock-api.ts` so every
 *   spec that mounts the transactions screen gets an answer (by default: nothing suggested, nothing pending, the
 *   pass off, which draws no chip and no note). `POST .../accept` renames the merchant's transactions the holder has
 *   not renamed (through the general fixture's `renameMerchant`) and marks the suggestion accepted; `POST .../dismiss`
 *   removes it; both are session-only (no step-up).
 * - `seedMerchantNames` fills the state: `suggested` (an Ebay and a Patreon suggestion on the bank's own text, and one
 *   noise merchant not asked about yet, the pass available) or `unavailable` (no suggestion yet, the three noise
 *   merchants pending, and a reason).
 * - `handleMerchantNameAdvisor` is the `merchant.name` advisor row and its preview, scopes, grants and runs, answered by
 *   `mock-advisors.ts` once the state says the advisor is listed. Approving the payload shape (a step-up) makes the pass
 *   available.
 */

export const MERCHANT_NAME_ADVISOR_ID = 'merchant.name';
export const MERCHANT_NAME_ADVISOR_NAME = 'Merchant name suggestions (local model)';
export const MERCHANT_NAME_MODEL = 'qwen2.5:7b-instruct-q4_K_M';
export const MERCHANT_NAME_MODEL_SHORT = 'qwen2.5:7b';

export const EBAY_MERCHANT_ID = 'merch_ebay';
export const EBAY_SUGGESTION_ID = '0190c000-0000-7000-8000-0000000b0001';
export const EBAY_TXN_IDS = ['txn_ebay_1', 'txn_ebay_2'] as const;
export const EBAY_BANK_TEXT = 'PAYPAL *EBAYINC';
export const EBAY_NAME = 'Ebay';

export const PATREON_MERCHANT_ID = 'merch_patreon';
export const PATREON_SUGGESTION_ID = '0190c000-0000-7000-8000-0000000b0002';
export const PATREON_TXN_ID = 'txn_patreon';
export const PATREON_BANK_TEXT = 'CKO*PATREON* MEMBERSHIP';
export const PATREON_NAME = 'Patreon Membership';

export const NOISE_MERCHANT_ID = 'merch_noise';
export const NOISE_TXN_ID = 'txn_noise';
export const NOISE_BANK_TEXT = 'SQ *XJ7Q2 0042';

/** What the chip's second line reads for a suggested name. */
export const SUGGESTED_BY_LINE = `Suggested by the local model (${MERCHANT_NAME_MODEL_SHORT}) from the bank’s text`;
export const NOT_APPROVED_NOTE =
  'No name is suggested yet: approve “Merchant name suggestions (local model)” in Advisors.';
export const HOSTED_NOTE =
  'Names stay on this machine, so name suggestions run only with the local model.';

export const CONSENT = {
  version: 'merchant-name-consent/1',
  sha256: `sha256:${'5e'.repeat(32)}`,
  text:
    'Merchant name suggestions run on the local model on this machine only. For a merchant whose name the bank ' +
    'sent as noise, the bank’s text as the app cleaned it, and the payment processor’s prefix it removed (if ' +
    'any), are sent to that model: no amount, date, account or category, and no other merchant. Nothing leaves ' +
    'this machine; with a hosted narrator no suggestion is made. A suggestion may only reuse words from the ' +
    'bank’s text, is shown beside it, and renames nothing until you tap Accept.',
};

const QUERY_SHAPE = `sha256:${'a7'.repeat(32)}`;
const PROMPT_HASH = `sha256:${'b8'.repeat(32)}`;

export type MerchantNameReason =
  | 'off'
  | 'not_configured'
  | 'hosted_narrator'
  | 'key_unopenable'
  | 'endpoint_refused'
  | 'advisors_disabled'
  | 'module_disabled'
  | 'kind_disabled'
  | 'advisor_disabled'
  | 'advisor_quarantined'
  | 'payload_not_approved';

export interface MerchantNameSuggestionBody {
  id: string;
  merchantId: string | null;
  descriptor: string;
  strippedPrefix: string | null;
  status: 'suggested' | 'accepted';
  displayName: string;
  provider: 'ollama';
  model: string;
  suggestedAt: string;
  decidedAt: string | null;
}

export interface MerchantNamesMockState {
  availability: {
    available: boolean;
    reason: MerchantNameReason | null;
    provider: 'ollama' | null;
    model: string | null;
  };
  items: MerchantNameSuggestionBody[];
  pending: Array<{ merchantId: string; descriptor: string }>;
  /** `GET /merchants/name-suggestions` reads. */
  listReads: number;
  /** Suggestion ids accepted / dismissed, in order. */
  accepts: string[];
  dismisses: string[];
  /** `merchant.name` is in the advisors list (set by the seed). */
  advisorListed: boolean;
  /** The holder approved the payload shape in Advisors. */
  approved: boolean;
  /** `POST /advisors/merchant.name/payload-approvals` bodies, in order. */
  approvals: unknown[];
}

export function createMerchantNamesState(): MerchantNamesMockState {
  return {
    availability: { available: false, reason: 'off', provider: null, model: null },
    items: [],
    pending: [],
    listReads: 0,
    accepts: [],
    dismisses: [],
    advisorListed: false,
    approved: false,
    approvals: [],
  };
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function problem(status: number, code: string, title: string, detail: string) {
  return json(
    { type: 'about:blank', title, status, code, detail, correlationId: 'corr_mn' },
    status,
  );
}

/** What the seed needs of the general fixture (structural, so this file does not import `mock-api.ts`). */
export interface MerchantNameFixtureHost {
  addTransaction(overrides: Record<string, unknown> & { id: string }): void;
  merchantNames: MerchantNamesMockState;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export type MerchantNameSeed =
  | { readonly mode: 'suggested' }
  | { readonly mode: 'unavailable'; readonly reason: MerchantNameReason };

/**
 * Adds the noise merchants' transactions to the general fixture (after its own four rows, so every other spec's
 * counts are untouched) and fills the suggestion state. The rows read the bank's text as their name, as the api's
 * resolved payee does until the holder renames them.
 */
export function seedMerchantNames(host: MerchantNameFixtureHost, seed: MerchantNameSeed): void {
  const row = (id: string, name: string, merchantId: string, minor: string, days: number): void => {
    host.addTransaction({
      id,
      accountId: 'acct_1',
      date: daysAgo(days),
      amount: { minor, currency: 'USD' },
      name,
      merchantId,
      merchantName: null,
      categoryId: null,
    });
  };
  row(EBAY_TXN_IDS[0], EBAY_BANK_TEXT, EBAY_MERCHANT_ID, '-4599', 3);
  row(EBAY_TXN_IDS[1], EBAY_BANK_TEXT, EBAY_MERCHANT_ID, '-1299', 9);
  row(PATREON_TXN_ID, PATREON_BANK_TEXT, PATREON_MERCHANT_ID, '-500', 4);
  row(NOISE_TXN_ID, NOISE_BANK_TEXT, NOISE_MERCHANT_ID, '-870', 5);

  const state = host.merchantNames;
  state.advisorListed = true;
  state.approved = seed.mode === 'suggested';
  if (seed.mode === 'suggested') {
    state.availability = {
      available: true,
      reason: null,
      provider: 'ollama',
      model: MERCHANT_NAME_MODEL,
    };
    state.items = [
      {
        id: EBAY_SUGGESTION_ID,
        merchantId: EBAY_MERCHANT_ID,
        descriptor: 'Ebayinc',
        strippedPrefix: 'PAYPAL *',
        status: 'suggested',
        displayName: EBAY_NAME,
        provider: 'ollama',
        model: MERCHANT_NAME_MODEL,
        suggestedAt: '2026-10-28T03:10:00.000Z',
        decidedAt: null,
      },
      {
        id: PATREON_SUGGESTION_ID,
        merchantId: PATREON_MERCHANT_ID,
        descriptor: 'PATREON MEMBERSHIP',
        strippedPrefix: 'CKO*',
        status: 'suggested',
        displayName: PATREON_NAME,
        provider: 'ollama',
        model: MERCHANT_NAME_MODEL,
        suggestedAt: '2026-10-28T03:10:30.000Z',
        decidedAt: null,
      },
    ];
    state.pending = [{ merchantId: NOISE_MERCHANT_ID, descriptor: 'XJ7Q2 0042' }];
  } else {
    state.availability = { available: false, reason: seed.reason, provider: null, model: null };
    state.items = [];
    state.pending = [
      { merchantId: EBAY_MERCHANT_ID, descriptor: 'Ebayinc' },
      { merchantId: PATREON_MERCHANT_ID, descriptor: 'PATREON MEMBERSHIP' },
      { merchantId: NOISE_MERCHANT_ID, descriptor: 'XJ7Q2 0042' },
    ];
  }
}

/** `GET /merchants/name-suggestions`, and the accept and dismiss writes. */
export async function handleMerchantNames(
  route: Route,
  path: string,
  method: string,
  state: MerchantNamesMockState,
  renameMerchant: (merchantId: string, name: string) => number,
): Promise<boolean> {
  if (path === '/api/merchants/name-suggestions' && method === 'GET') {
    state.listReads += 1;
    await route.fulfill(
      json({ availability: state.availability, items: state.items, pending: state.pending }),
    );
    return true;
  }

  const decision = /^\/api\/merchants\/name-suggestions\/([^/]+)\/(accept|dismiss)$/.exec(path);
  if (decision === null || method !== 'POST') return false;
  const id = decision[1]!;
  const item = state.items.find((candidate) => candidate.id === id);
  if (item === undefined) {
    await route.fulfill(
      problem(404, 'ledger.merchant_name_suggestion_not_found', 'Not found', 'No such suggestion.'),
    );
    return true;
  }

  if (decision[2] === 'accept') {
    state.accepts.push(id);
    const renamed =
      item.merchantId === null ? 0 : renameMerchant(item.merchantId, item.displayName);
    item.status = 'accepted';
    item.decidedAt = '2026-10-29T10:00:00.000Z';
    await route.fulfill(json({ suggestion: item, renamed }));
    return true;
  }

  state.dismisses.push(id);
  state.items = state.items.filter((candidate) => candidate.id !== id);
  await route.fulfill(json({ outcome: 'dismissed', suggestionId: id }));
  return true;
}

// ---------------------------------------------------------------------------
// The `merchant.name` advisor, in Advisor management
// ---------------------------------------------------------------------------

const SUBJECT = { descriptor: 'Ebayinc', stripped_prefix: 'PAYPAL *' };

export function merchantNameAdvisorRow() {
  return {
    advisorId: MERCHANT_NAME_ADVISOR_ID,
    displayName: MERCHANT_NAME_ADVISOR_NAME,
    kind: 'local_model',
    version: '1.0.0',
    enabled: true,
    quarantinedAt: null,
    quarantineReason: null,
    consecutiveFailures: 0,
    lastRunAt: null,
    grantedScopes: ['transactions.residue'],
    lastRunStatus: null,
    lastRunRejected: null,
  };
}

function previewBody(state: MerchantNamesMockState) {
  const messages = [
    {
      role: 'system',
      content:
        "You tidy the name of one merchant in one person's personal-finance app. Build the name ONLY from words of the descriptor, in the order they appear there.",
    },
    {
      role: 'user',
      content: `<untrusted_data>\n${JSON.stringify({ merchant: SUBJECT })}\n</untrusted_data>\n\nSuggest a display name for the merchant in the data above, following the rules. Reply with the JSON object only.`,
    },
  ];
  return {
    advisorId: MERCHANT_NAME_ADVISOR_ID,
    kind: 'local_model',
    queryShape: QUERY_SHAPE,
    scopes: ['transactions.residue'],
    promptTemplateHash: PROMPT_HASH,
    request: {
      contract_version: 1,
      request_id: 'req_mn',
      advisor_id: MERCHANT_NAME_ADVISOR_ID,
      advisor_version: '1.0.0',
      kind: 'local_model',
      generated_at: '2026-10-29T00:00:00.000Z',
      base_currency: 'USD',
      time_zone: 'UTC',
      today: '2026-10-29',
      granted_scopes: ['transactions.residue'],
      input_digest: `sha256:${'c9'.repeat(32)}`,
      limits: {
        max_insights: 1,
        max_response_bytes: 4096,
        deadline: '2026-10-29T00:03:00.000Z',
      },
      subject: SUBJECT,
      snapshot: { transactions_residue: SUBJECT },
      consent: CONSENT,
    },
    prompt: { text: JSON.stringify({ messages }), hash: `sha256:${'d1'.repeat(32)}` },
    approvalRequired: true,
    approved: state.approved,
  };
}

/** The `/api/advisors/merchant.name/*` routes; the list's row is `merchantNameAdvisorRow`. */
export async function handleMerchantNameAdvisor(
  route: Route,
  path: string,
  method: string,
  state: MerchantNamesMockState,
  steppedUp: () => boolean,
): Promise<boolean> {
  const base = `/api/advisors/${MERCHANT_NAME_ADVISOR_ID}`;
  if (path === `${base}/scopes` && method === 'GET') {
    await route.fulfill(
      json({
        advisorId: MERCHANT_NAME_ADVISOR_ID,
        kind: 'local_model',
        scopes: [
          {
            scope: 'transactions.residue',
            sensitivity: 6,
            key: 'transactions.residue',
            yields:
              'The bank’s text for one merchant the bank sent as noise, as the app cleaned it.',
            drops: 'No amount, date, account or category, and no other merchant.',
            externalAllowed: false,
            requiresPerRunConsent: false,
            sourcedInPhase2: true,
            granted: true,
            requested: true,
          },
        ],
      }),
    );
    return true;
  }
  if (path === `${base}/grant-events` && method === 'GET') {
    await route.fulfill(json({ advisorId: MERCHANT_NAME_ADVISOR_ID, events: [] }));
    return true;
  }
  if (path === `${base}/runs` && method === 'GET') {
    await route.fulfill(json({ runs: [] }));
    return true;
  }
  if (path === `${base}/payload-preview` && method === 'GET') {
    await route.fulfill(json(previewBody(state)));
    return true;
  }
  if (path === `${base}/payload-approvals` && method === 'POST') {
    if (!steppedUp()) {
      await route.fulfill(
        json(
          {
            type: 'about:blank',
            title: 'Step-up required',
            status: 403,
            code: 'step_up_required',
            correlationId: 'corr_su',
          },
          403,
        ),
      );
      return true;
    }
    state.approvals.push(route.request().postDataJSON());
    state.approved = true;
    // The pass can ask now; nothing is suggested until tonight's run.
    state.availability = {
      available: true,
      reason: null,
      provider: 'ollama',
      model: MERCHANT_NAME_MODEL,
    };
    await route.fulfill(json({ approvalId: 'appr_mn', queryShape: QUERY_SHAPE }));
    return true;
  }
  return false;
}
