// SPDX-License-Identifier: MIT
/**
 * Everything the Plaid suites share: the fixtures, the fake, and a connector
 * wired to it.
 *
 * ## Why a harness and not `@ctx/connections/test/harness.ts`
 *
 * `personalfi/layer-imports` denies `packages/connectors/*` → `@ctx/*`, which is
 * exactly the rule that keeps an adapter free of the orchestrator. So the three
 * helpers this package needs from that harness — a clock, a `SyncOptions`, a
 * bare `ConnectionHandle` — are re-stated here in about thirty lines rather than
 * imported across a boundary the lint (rightly) forbids. `conformance.test.ts`
 * does the same with `describeConnectorConformance`, and `@connector/port`'s
 * `conformance.ts` was written runner-agnostic precisely so that it could.
 *
 * ## The two tokens are deliberately unmistakable strings
 *
 * `ACCESS_TOKEN` and `PUBLIC_TOKEN` are long, unique, and contain no substring
 * of any other fixture value. `log-hygiene.test.ts` greps every artefact the
 * adapter produces — log lines, thrown errors, `JSON.stringify` of the handle
 * and of every fact — for them. A short token like `'tok'` would collide with
 * ordinary text and turn a real leak into a test that passes by luck.
 */
import type { ConnectionHandle, SyncOptions } from '@connector/port';
import { mutableClock, type MutableClock } from '@core/kernel';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AccountBase,
  Holding,
  InvestmentTransaction,
  InvestmentsHoldingsGetResponse,
  InvestmentsTransactionsGetResponse,
  ItemWithConsentFields,
  LiabilitiesGetResponse,
  LiabilitiesObject,
  Security,
  TransactionsSyncResponse,
} from 'plaid';
// From `provider.ts` rather than `index.ts`: the barrel re-exports
// `createPlaidApi`, and importing it would load `plaid`'s runtime — and
// therefore axios — into every suite that touches this harness. `client.ts` says
// that is the one thing it is kept apart for, and `pins.test.ts` is the only
// file here that legitimately imports it.
import { PLAID_ACCESS_TOKEN } from '../src/provider.ts';
import type { PlaidLinkSettings, PlaidLogger } from '../src/api.ts';
import { PlaidConnector, type PlaidConnectorOptions } from '../src/connector.ts';
import { FakePlaidApi, plainItemOf, type FakeFailure, type FakeItemSpec } from './fake.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const ACCOUNTS: readonly AccountBase[] = fixture<AccountBase[]>('accounts');
export const ITEM: ItemWithConsentFields = fixture<ItemWithConsentFields>('item');
export const LIABILITIES: LiabilitiesObject = fixture<LiabilitiesObject>('liabilities');

interface InvestmentsFixture {
  readonly securities: Security[];
  readonly holdings: Holding[];
  readonly investment_transactions: InvestmentTransaction[];
}

export const INVESTMENTS: InvestmentsFixture = fixture<InvestmentsFixture>('investments');

/**
 * The three recorded `/transactions/sync` pages, with the account list attached.
 *
 * A real response repeats the full `accounts` array on **every** page; the
 * fixture stores it once (in `accounts.json`) and it is spliced in here, because
 * five accounts copied three times into a JSON file is the kind of duplication
 * that goes stale silently. The adapter's own pass-through — "Plaid volunteers
 * the full account list on every page… passed through on every page rather than
 * only the first" — is asserted against this, so the splice has to happen
 * somewhere and doing it once beats doing it in three files.
 */
export const SYNC_PAGES: readonly TransactionsSyncResponse[] = fixture<TransactionsSyncResponse[]>(
  'transactions-sync',
).map((page) => ({ ...page, accounts: [...ACCOUNTS] }));

/**
 * `accounts` is left empty on the two investments responses on purpose.
 *
 * Plaid really does return an `InvestmentAccount[]` there, but that is a
 * *different* interface from `AccountBase` (its balances carry a margin loan
 * amount) and `syncHoldings` / `syncInvestmentTransactions` read neither field —
 * they take currency from the holding or the transaction itself. Populating it
 * would mean laundering `accounts.json` through a cast to a type the adapter
 * never touches: a lie that buys no coverage. `/liabilities/get` below is the
 * opposite case — it returns `AccountBase[]` and the adapter genuinely uses it,
 * via `currencyByAccountOf`, so there it is real.
 */
export const HOLDINGS_RESPONSE: InvestmentsHoldingsGetResponse = {
  accounts: [],
  holdings: INVESTMENTS.holdings,
  securities: INVESTMENTS.securities,
  item: plainItemOf(ITEM),
  request_id: 'req-investments-holdings-get',
};

export function investmentTransactionsResponse(
  transactions: readonly InvestmentTransaction[] = INVESTMENTS.investment_transactions,
): InvestmentsTransactionsGetResponse {
  return {
    accounts: [],
    securities: INVESTMENTS.securities,
    investment_transactions: [...transactions],
    total_investment_transactions: transactions.length,
    item: plainItemOf(ITEM),
    request_id: 'req-investments-transactions-get',
  };
}

export const LIABILITIES_RESPONSE: LiabilitiesGetResponse = {
  accounts: [...ACCOUNTS],
  liabilities: LIABILITIES,
  item: plainItemOf(ITEM),
  request_id: 'req-liabilities-get',
};

// ---------------------------------------------------------------------------
// Credentials that are not credentials
// ---------------------------------------------------------------------------

/** Unmistakable on purpose. See the file comment. */
export const ACCESS_TOKEN = 'access-sandbox-NEVER-REAL-9f2c4d7a1b6e8350';
export const PUBLIC_TOKEN = 'public-sandbox-NEVER-REAL-3e8b1a5c9d0f4276';
export const SECOND_ACCESS_TOKEN = 'access-sandbox-NEVER-REAL-SECOND-0c1d2e3f4a5b';
export const SECOND_PUBLIC_TOKEN = 'public-sandbox-NEVER-REAL-SECOND-6a7b8c9d0e1f';

// ---------------------------------------------------------------------------
// Clock, options, handle
// ---------------------------------------------------------------------------

/** Fixed, and after every date in the fixtures, so nothing drifts with wall time. */
export const NOW = new Date('2026-06-04T12:00:00.000Z');

export function testClock(): MutableClock {
  return mutableClock(NOW);
}

export function syncOptions(
  clock: MutableClock = testClock(),
  overrides: Partial<SyncOptions> = {},
): SyncOptions {
  return {
    reason: 'scheduled',
    historyDays: 730,
    pageSize: 500,
    deadline: new Date(clock.nowMs() + 60_000),
    signal: new AbortController().signal,
    clock,
    ...overrides,
  };
}

/**
 * A handle that really does hand back the access token, as `@ctx/connections`
 * does after opening the sealed blob.
 *
 * `secret` is a closure over a parameter, never a field: the conformance check
 * `secrets/a serialised handle contains no credential` is only meaningful if the
 * handle under test is one that actually holds a secret to leak.
 */
export function handleFor(
  accessToken: string | null = ACCESS_TOKEN,
  overrides: Partial<Omit<ConnectionHandle, 'secret'>> = {},
): ConnectionHandle {
  return {
    connectionId: '01930000-0000-7000-8000-00000000c0de',
    userId: '01920000-0000-7000-8000-0000000000aa',
    provider: 'plaid',
    providerConnectionId: ITEM.item_id,
    secret: (name) => (name === PLAID_ACCESS_TOKEN ? accessToken : null),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface LogLine {
  readonly level: 'debug' | 'warn';
  readonly context: Record<string, unknown>;
  readonly message: string;
}

export interface RecordingLogger extends PlaidLogger {
  readonly lines: LogLine[];
}

/**
 * Captures every log call, context object included.
 *
 * The context is kept by reference rather than serialised eagerly: a leak that
 * only shows up when something *else* serialises the object later — pino's
 * `util.inspect` fallback, an unhandled-rejection dump — is precisely the leak
 * `log-hygiene.test.ts` has to be able to see.
 */
export function recordingLogger(): RecordingLogger {
  const lines: LogLine[] = [];
  return {
    lines,
    debug: (context, message) => void lines.push({ level: 'debug', context, message }),
    warn: (context, message) => void lines.push({ level: 'warn', context, message }),
  };
}

// ---------------------------------------------------------------------------
// Settings and the connector
// ---------------------------------------------------------------------------

/** D12's default deployment: a Tailscale redirect, and **no** webhook. */
export function linkSettings(overrides: Partial<PlaidLinkSettings> = {}): PlaidLinkSettings {
  return {
    clientName: 'PersonalFi',
    countryCodes: ['US'],
    language: 'en',
    redirectUri: 'https://nuc.tailnet-fake.ts.net/link/oauth',
    webhookUrl: null,
    ...overrides,
  };
}

export interface HarnessOptions {
  /** Extra Items beyond the default one, e.g. the broken or rate-limited ones. */
  readonly items?: readonly FakeItemSpec[];
  readonly settings?: Partial<PlaidLinkSettings>;
  readonly connector?: Partial<Omit<PlaidConnectorOptions, 'api' | 'settings'>>;
  /** Applied to the default Item only. */
  readonly failWith?: FakeFailure;
  /** Applied to `/item/remove` on the default Item only. */
  readonly failRemoveWith?: FakeFailure;
  readonly mutateAtPage?: number;
  readonly pages?: readonly TransactionsSyncResponse[];
  /** Omit a product so `PRODUCTS_NOT_SUPPORTED` comes back for it. */
  readonly withoutHoldings?: boolean;
  readonly withoutInvestmentTransactions?: boolean;
  readonly withoutLiabilities?: boolean;
  readonly investmentTransactions?: readonly InvestmentTransaction[];
}

export function defaultItemSpec(options: HarnessOptions = {}): FakeItemSpec {
  return {
    accessToken: ACCESS_TOKEN,
    publicToken: PUBLIC_TOKEN,
    item: ITEM,
    accounts: ACCOUNTS,
    pages: options.pages ?? SYNC_PAGES,
    ...(options.withoutHoldings === true ? {} : { holdings: HOLDINGS_RESPONSE }),
    ...(options.withoutInvestmentTransactions === true
      ? {}
      : {
          investmentTransactions: investmentTransactionsResponse(options.investmentTransactions),
        }),
    ...(options.withoutLiabilities === true ? {} : { liabilities: LIABILITIES_RESPONSE }),
    ...(options.failWith === undefined ? {} : { failWith: options.failWith }),
    ...(options.failRemoveWith === undefined ? {} : { failRemoveWith: options.failRemoveWith }),
    ...(options.mutateAtPage === undefined ? {} : { mutateAtPage: options.mutateAtPage }),
  };
}

export interface Harness {
  readonly api: FakePlaidApi;
  readonly connector: PlaidConnector;
  readonly logger: RecordingLogger;
  readonly clock: MutableClock;
  readonly handle: ConnectionHandle;
  readonly options: SyncOptions;
}

export function harness(options: HarnessOptions = {}): Harness {
  const api = new FakePlaidApi([defaultItemSpec(options), ...(options.items ?? [])]);
  const logger = recordingLogger();
  const clock = testClock();
  const connector = new PlaidConnector({
    api,
    settings: linkSettings(options.settings),
    clock,
    logger,
    ...options.connector,
  });
  return { api, connector, logger, clock, handle: handleFor(), options: syncOptions(clock) };
}

/** A second, throwaway Item — what `disconnect/revokes` destroys. */
export function disposableItemSpec(): FakeItemSpec {
  return {
    accessToken: SECOND_ACCESS_TOKEN,
    publicToken: SECOND_PUBLIC_TOKEN,
    item: { ...ITEM, item_id: 'item-northwind-0002' },
    accounts: ACCOUNTS,
    pages: SYNC_PAGES,
  };
}
