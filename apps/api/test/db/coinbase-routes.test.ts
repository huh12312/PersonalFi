// SPDX-License-Identifier: MIT
/**
 * Phase 3 gate C-4 (G3-16, MEDIUM; `docs/evidence/phase-3/gate-security-review.md`
 * §6; `docs/evidence/phase-3/wp3.5-coinbase.md` §2.1, "the database half of
 * the custody proof is not in this package"): the WP 1.3b pattern —
 * `apps/api/test/db/plaid-routes.test.ts:146-158`'s raw `bytea` read —
 * reproduced for the CDP key pair. WP 3.5's own suite proves the connector
 * never leaks the key anywhere *inside its own boundary* (`custody.test.ts`);
 * this file proves the one place a leak would actually reach disk: the
 * `connections.sealed_credentials` column `@ctx/connections` writes after
 * `connector.connect()` returns.
 *
 * `CoinbaseConnector` is real; only the network is a double. `FakeCoinbaseApi`
 * (`@connector/coinbase/test`) is the same hermetic fake `packages/connectors/coinbase`
 * proves itself against (conformance, custody, the on-ramp) — not a second
 * fake built one layer up that could quietly stop matching real Coinbase
 * behaviour. `createConnectorRegistry` (`apps/api/src/domain.ts`) always
 * builds a real, network-bound transport for Coinbase, so this suite injects
 * its own connector through `createApiHarness`'s `coinbaseConnector` option
 * (the same seam `plaidConnector` already uses), never that function.
 */
import { CoinbaseConnector, COINBASE_PROVIDER } from '@connector/coinbase';
import { FakeCoinbaseApi, TEST_KEY_NAME, TEST_PRIVATE_KEY_BASE64 } from '@connector/coinbase/test';
import { systemClock } from '@core/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface LinkResultBody {
  readonly connectionId: string;
  readonly relinked: boolean;
  readonly accountIds: string[];
}

async function readSealedCredentials(h: ApiHarness, connectionId: string): Promise<Buffer> {
  const result = await h.database.pool.query(
    `SELECT sealed_credentials FROM connections WHERE id = $1`,
    [connectionId],
  );
  const row = result.rows[0] as { sealed_credentials: Uint8Array } | undefined;
  expect(row, 'no connections row for that id').toBeDefined();
  return Buffer.from(row?.sealed_credentials ?? new Uint8Array());
}

/** The Plaid assertion, character for character — WP 1.3b's own pattern. */
function assertNeverLeaked(raw: Buffer, secret: string): void {
  expect(raw.length).toBeGreaterThan(0);
  expect(raw.toString('utf8')).not.toContain(secret);
  expect(raw.toString('latin1')).not.toContain(secret);
  for (let i = 0; i + 8 <= secret.length; i += 4) {
    expect(raw.toString('latin1')).not.toContain(secret.slice(i, i + 8));
  }
}

describe.skipIf(NO_DATABASE)('coinbase routes — CDP key custody (Phase 3 gate C-4)', () => {
  let h: ApiHarness;
  let api: FakeCoinbaseApi;
  let connectionId: string;

  beforeAll(async () => {
    api = new FakeCoinbaseApi({});
    const connector = new CoinbaseConnector({ transport: api.transport, clock: systemClock });
    h = await createApiHarness({ suite: 'cbcust', coinbaseConnector: connector });

    const response = await h.request({
      method: 'POST',
      url: '/connections',
      session: h.fresh,
      body: {
        provider: COINBASE_PROVIDER,
        input: { keyName: TEST_KEY_NAME, privateKey: TEST_PRIVATE_KEY_BASE64 },
      },
    });
    expectStatus(response, 201);
    connectionId = (response.json() as LinkResultBody).connectionId;
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  it(
    'links a Coinbase connection and stores the CDP key pair encrypted — never as plaintext, ' +
      'not the key name and not the private key, anywhere in the raw column (WP 1.3b pattern)',
    async () => {
      const raw = await readSealedCredentials(h, connectionId);
      assertNeverLeaked(raw, TEST_KEY_NAME);
      assertNeverLeaked(raw, TEST_PRIVATE_KEY_BASE64);
    },
  );

  it('the response itself carries neither half of the credential', async () => {
    // Re-fetch through the read route rather than trust the link response is
    // still in scope — same claim, over the same connection, a second way.
    const response = await h.request({ method: 'GET', url: '/connections', session: h.stale });
    expectStatus(response, 200);
    expect(response.body).not.toContain(TEST_KEY_NAME);
    expect(response.body).not.toContain(TEST_PRIVATE_KEY_BASE64);
  });

  it(
    "SABOTAGE: this file's own sweep is caught by the exact leak it exists to catch — the " +
      'negative control `custody.test.ts` names (a custody test that would pass against a ' +
      'system that leaked is worse than none)',
    async () => {
      const sealed = await readSealedCredentials(h, connectionId);
      // Reproduce the leak directly against the raw bytes this sweep reads —
      // never against a second, hand-rolled "insert unsealed" path, so the
      // sabotage exercises the exact assertion helper the green test above
      // depends on, not a different one that happens to share a name.
      const leaked = Buffer.concat([sealed, Buffer.from(TEST_KEY_NAME, 'utf8')]);
      expect(() => assertNeverLeaked(leaked, TEST_KEY_NAME)).toThrow();
    },
  );
});
