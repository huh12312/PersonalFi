// SPDX-License-Identifier: MIT
/**
 * Key custody: where the CDP key is allowed to exist, and for how long.
 *
 * ## What this file proves, and what it deliberately does not
 *
 * The plan's exit test for this work package is *"the raw `sealed_credentials`
 * column contains no plaintext CDP key"* — the WP 1.3b pattern, a `psql` read of
 * the raw `bytea` performed in `apps/api/test/db/plaid-routes.test.ts:146`.
 * **That test cannot live here.** It needs a scratch database, the migrations,
 * and `@ctx/connections` to do the sealing, and this package owns none of those:
 * `personalfi/layer-imports` denies `packages/connectors/*` → `@ctx/*` outright,
 * and the `connector-coinbase` vitest project is hermetic by design. Writing a
 * test with that *name* here that never read a column would be worse than not
 * writing it — a control that has never been exercised, dressed as evidence.
 *
 * So the database half is specified for the orchestrator in
 * `docs/evidence/phase-3/wp3.5-coinbase.md` §3, and this file proves the half
 * that is genuinely this package's: **the key leaves here exactly once, under
 * the two names the seal covers, and exists nowhere else at any point.**
 *
 * The two halves together are the claim. Neither alone is.
 */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { COINBASE_CREDENTIAL_NAMES, CDP_KEY_NAME, CDP_PRIVATE_KEY } from '../src/provider.ts';
import { CoinbaseClient } from '../src/client.ts';
import { credentialsFrom } from '../src/connector.ts';
import { TEST_KEY_NAME, TEST_PRIVATE_KEY_BASE64 } from './fake.ts';
import { cursorBeforeTheDeposit, handleFor, harness, testCredentials } from './harness.ts';

describe('the CDP key', () => {
  it('leaves this package exactly once, in ConnectResult.credentials', async () => {
    const { connector, logger, handle, options } = harness();

    const connected = await connector.connect({
      keyName: TEST_KEY_NAME,
      privateKey: TEST_PRIVATE_KEY_BASE64,
    });

    // The one handover. Both halves, under the two documented names, so the
    // `SecretBox` blob `@ctx/connections` writes covers the whole credential —
    // a key name without its key is useless, and a key without its name cannot
    // be used either, so sealing one and not the other is not a saving.
    expect(Object.keys(connected.credentials).sort()).toEqual(
      [...COINBASE_CREDENTIAL_NAMES].sort(),
    );
    expect(connected.credentials[CDP_KEY_NAME]).toBe(TEST_KEY_NAME);
    expect(connected.credentials[CDP_PRIVATE_KEY]).toBe(TEST_PRIVATE_KEY_BASE64);

    // And nowhere else in the result.
    const rest = inspect({ ...connected, credentials: undefined }, { depth: null, getters: true });
    expect(rest).not.toContain(TEST_PRIVATE_KEY_BASE64);

    // Every later call re-reads the sealed pair; nothing is retained between
    // them. If the connector held the key on `this`, this handle would be
    // unnecessary — and a purged handle would still work, which the next test
    // proves it does not.
    await connector.listAccounts(handle);
    await connector.syncTransactions(handle, cursorBeforeTheDeposit(), options);
    expect(inspect(connector, { depth: null, showHidden: true })).not.toContain(
      TEST_PRIVATE_KEY_BASE64,
    );
    expect(inspect(logger.lines, { depth: null })).not.toContain(TEST_PRIVATE_KEY_BASE64);
  });

  /**
   * Revocation, for a provider that has no revocation endpoint.
   *
   * `disconnect` cannot call anything — see `connector.ts`. What makes
   * revocation observable is the caller purging `sealed_credentials`, and this
   * asserts the consequence: every method refuses, typed, with no network call
   * attempted.
   */
  it('a purged sealed blob makes every call refuse, with nothing signed', async () => {
    const { api, connector, options } = harness();
    const purged = handleFor(null);
    await connector.disconnect(purged);

    for (const [label, run] of [
      ['listAccounts', () => connector.listAccounts(purged)],
      ['syncTransactions', () => connector.syncTransactions(purged, null, options)],
      ['syncBalances', () => connector.syncBalances(purged, options)],
      ['syncHoldings', () => connector.syncHoldings(purged, options)],
      ['syncInvestmentTransactions', () => connector.syncInvestmentTransactions(purged, options)],
      ['health', () => connector.health(purged)],
    ] as const) {
      const thrown = await run().catch((error: unknown) => error);
      expect(thrown, `${label} did not refuse`).toMatchObject({
        kind: 'invalid_input',
        condition: 'CONFIG_ERROR',
      });
    }
    // Not one request was signed or sent.
    expect(api.requests).toEqual([]);
    expect(api.tokens).toEqual([]);
  });

  it('refuses a half-purged blob, naming which half is missing', () => {
    const onlyName = handleFor({ keyName: TEST_KEY_NAME, privateKeyMaterial: '' });
    expect(() => credentialsFrom(onlyName)).toThrowError(/holds no CDP key/);
    try {
      credentialsFrom(onlyName);
    } catch (error) {
      expect((error as { redactedContext: Record<string, unknown> }).redactedContext).toMatchObject(
        {
          credential: CDP_PRIVATE_KEY,
        },
      );
    }
  });

  it('never keeps the parsed key: one KeyObject per request, and no cache to find', async () => {
    // The `CoinbaseClient` holds the *material* for the life of one method call
    // and parses it per request. There is no field, no module-level map and no
    // memoisation keyed on the key name — a cache is a place a credential
    // survives a request, which is the whole reason this is asserted rather
    // than described.
    const { api, client } = (() => {
      const h = harness();
      return {
        api: h.api,
        client: new CoinbaseClient({
          transport: h.api.transport,
          credentials: testCredentials(),
          clock: h.clock,
        }),
      };
    })();

    await client.keyPermissions();
    await client.portfolios();

    const dumped = inspect(client, { depth: null, showHidden: true, getters: true });
    // The material is a constructor argument and is visibly held for the call's
    // lifetime — that much is by design and is what the dump shows. What must
    // not be there is a parsed `KeyObject`, because that is the thing that can
    // sign without the material.
    expect(dumped).not.toContain('KeyObject');
    expect(dumped).not.toContain('asymmetricKeyType');
    // Two requests, two independent signatures, two nonces.
    expect(new Set(api.nonces).size).toBe(2);
  });

  it('the cursor the orchestrator persists carries no credential', async () => {
    const { connector, handle, options } = harness();
    const page = await connector.syncTransactions(handle, null, options);
    const cursor = String(page.nextCursor);
    // It is stored in `sync_state` and shown in a sync-run detail view, so it
    // is scanned like everything else.
    expect(cursor).not.toContain(TEST_PRIVATE_KEY_BASE64);
    expect(cursor).not.toContain(TEST_KEY_NAME);
    const decoded = Buffer.from(cursor.replace('cb1.', ''), 'base64url').toString('utf8');
    expect(decoded).not.toContain(TEST_PRIVATE_KEY_BASE64);
    expect(decoded).not.toContain('apiKeys');
  });
});
