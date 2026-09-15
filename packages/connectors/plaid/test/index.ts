// SPDX-License-Identifier: MIT
/**
 * `@connector/plaid/test` — the hermetic double, for a consumer outside this
 * package.
 *
 * `apps/api`'s Plaid route tests (link-token, exchange, update-link-token, the
 * D16 ten-Item ratchet, the encrypted-custody assertion) need a real
 * `PlaidConnector` wired to something that is not the live network.
 * `FakePlaidApi` is exactly that double — proven against the shared
 * conformance suite, the request-pin assertions and the live Sandbox smoke
 * (`docs/evidence/phase-1/wp1.3-plaid.md`) — not a second, drifting fake built
 * one layer up that could quietly stop matching real Plaid behaviour.
 *
 * This is the package's second `exports` entry (`package.json`'s
 * `"./test": "./test/index.ts"`), added deliberately narrow: nothing under
 * `src/` imports it, it performs no I/O, and it is documented here rather than
 * a new dependency being added to reach the same fixtures.
 */
export {
  FAKE_PLAID_SECRET,
  FakePlaidApi,
  PLAID_ERRORS,
  plaidAxiosError,
  plainItemOf,
  type FakeCall,
  type FakeFailure,
  type FakeItemSpec,
  type PlaidAxiosLikeError,
} from './fake.ts';

export {
  ACCESS_TOKEN,
  ACCOUNTS,
  HOLDINGS_RESPONSE,
  INVESTMENTS,
  ITEM,
  LIABILITIES,
  LIABILITIES_RESPONSE,
  NOW,
  PUBLIC_TOKEN,
  SECOND_ACCESS_TOKEN,
  SECOND_PUBLIC_TOKEN,
  SYNC_PAGES,
  defaultItemSpec,
  disposableItemSpec,
  investmentTransactionsResponse,
  linkSettings,
  syncOptions,
  testClock,
  type HarnessOptions,
} from './harness.ts';

import type { FakeItemSpec } from './fake.ts';
import { ACCOUNTS, ITEM, SYNC_PAGES } from './harness.ts';

/**
 * A distinct Plaid Item for a scenario that needs several — the D16 ten-Item
 * ratchet is the motivating case, where one connection per Item means one
 * distinct access/public token pair and one distinct `item_id` per row.
 *
 * `account_id` is namespaced by `itemId` (`ACCOUNTS`'s ids, prefixed), not
 * reused verbatim: `@ctx/ledger`'s natural key is
 * `(user_id, provider, provider_account_id)`, so two Items handing back the
 * identical fixture account ids would resolve to *one* ledger account and the
 * second `createConnection` would fail linking it — `connection_accounts`'s
 * own `(user_id, account_id)` unique index refuses to let two connections
 * claim the same account, which is exactly the invariant 08 §3.9 relies on.
 * A real institution never hands out another bank's account id, so this only
 * matters for a fake standing in for several distinct institutions.
 */
export function fakePlaidItem(options: {
  readonly accessToken: string;
  readonly publicToken: string;
  readonly itemId: string;
}): FakeItemSpec {
  return {
    accessToken: options.accessToken,
    publicToken: options.publicToken,
    item: { ...ITEM, item_id: options.itemId },
    accounts: ACCOUNTS.map((account) => ({
      ...account,
      account_id: `${options.itemId}-${account.account_id}`,
    })),
    pages: SYNC_PAGES,
  };
}
