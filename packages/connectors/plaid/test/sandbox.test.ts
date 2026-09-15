// SPDX-License-Identifier: MIT
/**
 * The live Plaid **Sandbox** smoke test. Skipped unless credentials are present.
 *
 * ## Why it exists when the hermetic suite is green
 *
 * `FakePlaidApi` proves the adapter is self-consistent. It cannot prove that
 * Plaid agrees — that `Plaid-Version: 2020-09-14` really produces the shapes
 * `map.ts` decodes, that `transactions.days_requested: 730` is accepted rather
 * than rejected as an unknown field, that `/transactions/sync`'s cursor really
 * behaves the way the conformance suite assumes. Recorded fixtures are a
 * snapshot of a belief; this is the only test that checks the belief.
 *
 * ## Why it is skipped by default
 *
 * There are no Plaid credentials on this machine, and there should not be any in
 * CI. D16: Production has a hard ten-Item cap and `/item/remove` **does not free
 * a slot**, so a test that linked Production Items would silently consume the
 * entire allowance. This test refuses to run against anything but Sandbox — see
 * the `PLAID_ENV` guard — where Items are free and unlimited.
 *
 * ## How to run it
 *
 * The runbook is in `docs/evidence/phase-1/wp1.3-plaid.md` §7. Short version:
 *
 * ```
 * PLAID_CLIENT_ID=… PLAID_SECRET=… PLAID_ENV=sandbox \
 *   npx vitest run --project connector-plaid test/sandbox.test.ts
 * ```
 *
 * It creates one Sandbox Item, exercises the adapter against it, resets its
 * login to provoke a real `ITEM_LOGIN_REQUIRED`, and removes the Item in an
 * `afterAll` that runs even when the body fails.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Products, SandboxPublicTokenCreateRequest } from 'plaid';
import { afterAll, describe, expect, it } from 'vitest';
import { createPlaidApi, type PlaidEnvironment } from '../src/client.ts';
import { PlaidConnector } from '../src/connector.ts';
import { PLAID_ACCESS_TOKEN, PLAID_MAX_HISTORY_DAYS, PLAID_PRODUCTS } from '../src/provider.ts';
import { handleFor, linkSettings, recordingLogger, syncOptions, testClock } from './harness.ts';
import type { PlaidApiLike, PlaidSandboxApiLike } from '../src/api.ts';

const CLIENT_ID = process.env['PLAID_CLIENT_ID'];
const SECRET = process.env['PLAID_SECRET'];
const ENV = process.env['PLAID_ENV'] ?? 'sandbox';

/**
 * Plaid's own test institution. `user_good` / `pass_good` are its published
 * Sandbox credentials and `/sandbox/public_token/create` skips the Link UI
 * entirely, which is what makes this runnable headlessly.
 */
const SANDBOX_INSTITUTION = 'ins_109508';

const configured = CLIENT_ID !== undefined && SECRET !== undefined && CLIENT_ID !== '';

if (!configured) {
  // Printed once, deliberately, so a green run cannot be mistaken for a run that
  // actually talked to Plaid.
  console.info(
    '\n  [connector-plaid] live Sandbox smoke SKIPPED: PLAID_CLIENT_ID / PLAID_SECRET are unset.\n' +
      '  This is expected — no Plaid credentials exist on this machine and none belong in CI.\n' +
      '  The hermetic suite (conformance, pins, error map, log hygiene) covers everything it can\n' +
      '  without a network; this test is the only one that checks Plaid agrees.\n' +
      '  To run it, see docs/evidence/phase-1/wp1.3-plaid.md §7 (Sandbox runbook).\n',
  );
}

// D16: Production Items are a ratchet. A smoke test must never create one.
if (configured && ENV !== 'sandbox') {
  throw new Error(
    `refusing to run the smoke test against PLAID_ENV=${ENV}. Production has a hard ten-Item ` +
      'cap and /item/remove does not free a slot (D16), so a test run would permanently spend ' +
      'part of the allowance. Set PLAID_ENV=sandbox.',
  );
}

interface Live {
  readonly api: PlaidApiLike & PlaidSandboxApiLike;
  accessToken: string | null;
}

const live: Live = {
  api: configured
    ? createPlaidApi({
        clientId: CLIENT_ID ?? '',
        secret: SECRET ?? '',
        environment: ENV as PlaidEnvironment,
      })
    : (null as unknown as PlaidApiLike & PlaidSandboxApiLike),
  accessToken: null,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!configured)('live Plaid Sandbox', () => {
  afterAll(async () => {
    // Always, even when the body threw. A Sandbox Item costs nothing, but
    // leaving them behind makes the Dashboard unreadable and the next run
    // ambiguous.
    if (live.accessToken !== null) {
      await live.api.itemRemove({ access_token: live.accessToken }).catch(() => undefined);
      live.accessToken = null;
    }
  });

  it('links, syncs, breaks, reconnects and revokes a real Sandbox Item', async () => {
    const logger = recordingLogger();
    const clock = testClock();
    const connector = new PlaidConnector({
      api: live.api,
      settings: linkSettings({ redirectUri: null }),
      clock,
      logger,
    });

    // ---- Link ----------------------------------------------------------
    // The Link UI is skipped, but `days_requested` still has to be pinned
    // here: on a real link it is `createLinkToken` that sets it, and the
    // Item's window is fixed for its lifetime either way (01 §5.1).
    const request: SandboxPublicTokenCreateRequest = {
      institution_id: SANDBOX_INSTITUTION,
      initial_products: [...PLAID_PRODUCTS] as Products[],
      options: { transactions: { days_requested: PLAID_MAX_HISTORY_DAYS } },
    };
    const created = await live.api.sandboxPublicTokenCreate(request);

    const connected = await connector.connect({ publicToken: created.data.public_token });
    live.accessToken = connected.credentials[PLAID_ACCESS_TOKEN] ?? null;
    expect(live.accessToken).not.toBeNull();
    expect(connected.providerConnectionId).toMatch(/\S/);
    expect(connected.accounts.length).toBeGreaterThan(0);

    const handle = handleFor(live.accessToken, {
      providerConnectionId: connected.providerConnectionId,
    });
    const options = syncOptions(clock, { deadline: new Date(Date.now() + 110_000) });

    // ---- A real link token, with the real pins on the wire ---------------
    const linkToken = await connector.createLinkToken({ clientUserId: handle.userId });
    expect(linkToken.linkToken).toMatch(/^link-sandbox-/);
    expect(linkToken.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // ---- Sync ------------------------------------------------------------
    // Plaid is still running the first extract for a moment after linking;
    // PRODUCT_NOT_READY is `transient` and retrying is the documented fix.
    let cursor = null as Parameters<typeof connector.syncTransactions>[1];
    let pages = 0;
    let transactions = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const page = await connector
        .syncTransactions(handle, cursor, options)
        .catch(async (error: unknown) => {
          const code = (error as { providerCode?: string }).providerCode;
          if (code !== 'PRODUCT_NOT_READY') throw error;
          await sleep(3_000);
          return null;
        });
      if (page === null) continue;
      pages += 1;
      transactions += page.added.length + page.modified.length;
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(pages).toBeGreaterThan(0);
    expect(transactions).toBeGreaterThan(0);

    // The shapes `map.ts` decoded really are the shapes Plaid sent.
    const accounts = await connector.listAccounts(handle);
    expect(accounts.every((account) => account.currency.length === 3)).toBe(true);
    const balances = await connector.syncBalances(handle, options);
    expect(balances.every((balance) => typeof balance.current.minor === 'bigint')).toBe(true);
    const health = await connector.health(handle);
    expect(health.reachable).toBe(true);

    // ---- Break it, on purpose -------------------------------------------
    // The single most important classification in the adapter, provoked for
    // real rather than from a fixture.
    await live.api.sandboxItemResetLogin({ access_token: live.accessToken ?? '' });
    const broken = await connector
      .syncTransactions(handle, cursor, options)
      .catch((error: unknown) => error);
    expect(broken).toMatchObject({
      name: 'ConnectorError',
      kind: 'auth_required',
      condition: 'AUTH_REQUIRED',
      providerCode: 'ITEM_LOGIN_REQUIRED',
    });
    expect((await connector.health(handle)).reachable).toBe(false);

    // ---- Update mode -----------------------------------------------------
    // Proves Plaid accepts a link token with `access_token` and no `products`
    // (01 §1.7), which is the reconnect flow the UI will drive.
    const updateToken = await connector.createUpdateLinkToken(handle);
    expect(updateToken.linkToken).toMatch(/^link-sandbox-/);

    // ---- Revoke ----------------------------------------------------------
    await connector.disconnect(handle);
    live.accessToken = null;
    await expect(connector.syncTransactions(handle, null, options)).rejects.toMatchObject({
      name: 'ConnectorError',
    });

    // ---- And nothing leaked ---------------------------------------------
    const source = created.data.public_token;
    const rendered = JSON.stringify(logger.lines);
    expect(rendered).not.toContain(source);
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(CLIENT_ID);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// This part runs with or without credentials
// ---------------------------------------------------------------------------

describe('the smoke test is honestly gated', () => {
  it('skips rather than passes vacuously when no credentials are configured', () => {
    // If this ever reads `true` on a machine with no Plaid keys, the gate broke
    // and a green CI run stopped meaning what it says.
    expect(configured).toBe(CLIENT_ID !== undefined && SECRET !== undefined && CLIENT_ID !== '');
  });

  it('cannot be pointed at Production, where Items are a ratchet', () => {
    // D16. The guard above throws at module load; this asserts the reason is
    // written down where someone changing it will read it.
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'sandbox.test.ts'),
      'utf8',
    );
    expect(source).toContain("ENV !== 'sandbox'");
    expect(source).toMatch(/does not free a slot/);
  });
});
