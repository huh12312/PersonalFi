// SPDX-License-Identifier: MIT
/**
 * The CDP JWT: EdDSA, 120 seconds, uri-bound, fresh every time.
 *
 * Every assertion below is made **from the server's side of the wire** wherever
 * it can be. `FakeCoinbaseApi` decodes the `Authorization` header it actually
 * received and verifies the Ed25519 signature against the public half of the
 * test key, so "the JWT is bound to the request uri" is checked by the thing
 * that would reject it in production rather than by re-reading what we just
 * built. A test that decoded its own token and agreed with itself would pass
 * against a connector that never sent one.
 */
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '@connector/port';
import {
  CDP_JWT_ALGORITHM,
  CDP_JWT_AUDIENCE,
  CDP_JWT_ISSUER,
  CDP_JWT_LIFETIME_SECONDS,
} from '../src/provider.ts';
import { cdpRequestUri, decodeCdpJwtForTest, mintCdpJwt, parseCdpPrivateKey } from '../src/jwt.ts';
import {
  TEST_ECDSA_PRIVATE_KEY_PEM,
  TEST_KEY_NAME,
  TEST_PRIVATE_KEY_BASE64,
  TEST_PRIVATE_KEY_PEM,
} from './fake.ts';
import { NOW, clientHarness, harness } from './harness.ts';

describe('the CDP JWT', () => {
  it('a JWT is EdDSA, expires in 120 s and is bound to one method and path', async () => {
    const { api, client } = clientHarness();
    await client.keyPermissions();

    expect(api.rejections).toEqual([]);
    const token = api.tokens.at(-1);
    expect(token).toBeDefined();
    const decoded = decodeCdpJwtForTest(token ?? '');

    // 01 §3.2, and the one thing the dispatch says an agent will get wrong:
    // ES256 is Plaid's *webhook* algorithm and lives in a different package.
    expect(decoded.header.alg).toBe('EdDSA');
    expect(CDP_JWT_ALGORITHM).toBe('EdDSA');
    expect(decoded.header.typ).toBe('JWT');
    expect(decoded.header.kid).toBe(TEST_KEY_NAME);

    expect(decoded.payload.sub).toBe(TEST_KEY_NAME);
    expect(decoded.payload.iss).toBe(CDP_JWT_ISSUER);
    expect(decoded.payload.aud).toEqual([...CDP_JWT_AUDIENCE]);
    expect(decoded.payload.exp - decoded.payload.nbf).toBe(CDP_JWT_LIFETIME_SECONDS);
    expect(CDP_JWT_LIFETIME_SECONDS).toBe(120);
    expect(decoded.payload.nbf).toBe(Math.floor(NOW.getTime() / 1000));

    // Bound to one method and one path. The fake computed the same string from
    // the request it received and would have answered 401 if they differed.
    expect(decoded.payload.uri).toBe('GET api.coinbase.com/api/v3/brokerage/key_permissions');
  });

  it('a JWT is not reused across two endpoints', async () => {
    const { api, client } = clientHarness();
    await client.keyPermissions();
    await client.portfolios();

    expect(api.rejections).toEqual([]);
    expect(api.tokens).toHaveLength(2);
    const [first, second] = api.tokens as [string, string];
    expect(first).not.toBe(second);

    const uris = api.tokens.map((token) => decodeCdpJwtForTest(token).payload.uri);
    expect(uris).toEqual([
      'GET api.coinbase.com/api/v3/brokerage/key_permissions',
      'GET api.coinbase.com/api/v3/brokerage/portfolios',
    ]);
  });

  /**
   * The freshness property stated as the thing that actually matters: not "the
   * strings differ" but "the server never saw a nonce twice, and every token it
   * saw was bound to the request it arrived on".
   */
  it('the JWT is fresh per request and bound to the request uri', async () => {
    const { api, connector, handle, options } = harness();
    await connector.listAccounts(handle);
    await connector.syncBalances(handle, options);

    expect(api.rejections).toEqual([]);
    // Several requests happened: two scope assertions, two account listings and
    // a ticker call per priced asset.
    expect(api.tokens.length).toBeGreaterThan(4);
    expect(new Set(api.tokens).size).toBe(api.tokens.length);
    expect(new Set(api.nonces).size).toBe(api.nonces.length);
    for (const nonce of api.nonces) expect(nonce).toMatch(/^[0-9a-f]{32}$/);

    // The fake asserts `uri` against the request it received; this asserts the
    // pairing explicitly, request by request, so a fake that stopped checking
    // would not quietly take this test with it.
    for (const [index, request] of api.requests.entries()) {
      const token = api.tokens[index];
      expect(token).toBeDefined();
      expect(decodeCdpJwtForTest(token ?? '').payload.uri).toBe(
        `GET api.coinbase.com${request.path}`,
      );
    }
  });

  it('leaves the query string out of the uri claim, which is the tempting mistake', () => {
    // 01 §3.2's worked example is `GET api.coinbase.com/api/v3/brokerage/accounts`.
    // Including `?limit=250` produces a 401 that looks like clock skew.
    expect(cdpRequestUri('get', 'api.coinbase.com', '/api/v3/brokerage/accounts?limit=250')).toBe(
      'GET api.coinbase.com/api/v3/brokerage/accounts',
    );
  });

  it('sends the query on the wire while leaving it out of the signature', async () => {
    const { api, client } = clientHarness();
    await client.accounts({ cursor: null, limit: 250 });
    // The request really did carry `limit`…
    expect(api.requests.at(-1)?.query).toEqual({ limit: '250' });
    // …and the server, which recomputes `uri` from method and path, accepted it.
    expect(api.rejections).toEqual([]);
    expect(decodeCdpJwtForTest(api.tokens.at(-1) ?? '').payload.uri).toBe(
      'GET api.coinbase.com/api/v3/brokerage/accounts',
    );
  });

  it('signs the same claims from a PEM key and from the portal base64 key', () => {
    const fromPem = mintCdpJwt({
      keyName: TEST_KEY_NAME,
      privateKey: parseCdpPrivateKey(TEST_PRIVATE_KEY_PEM),
      method: 'GET',
      host: 'api.coinbase.com',
      path: '/api/v3/brokerage/accounts',
      nowMs: NOW.getTime(),
    });
    const fromBase64 = mintCdpJwt({
      keyName: TEST_KEY_NAME,
      privateKey: parseCdpPrivateKey(TEST_PRIVATE_KEY_BASE64),
      method: 'GET',
      host: 'api.coinbase.com',
      path: '/api/v3/brokerage/accounts',
      nowMs: NOW.getTime(),
    });

    // The nonce differs, so the tokens differ; the claims do not.
    expect(fromPem).not.toBe(fromBase64);
    const a = decodeCdpJwtForTest(fromPem);
    const b = decodeCdpJwtForTest(fromBase64);
    expect(a.payload).toEqual(b.payload);
    expect(a.header.nonce).not.toBe(b.header.nonce);
  });

  /**
   * The algorithm downgrade, refused by name.
   *
   * This is the single classic JWT vulnerability and the one place in this
   * package where it could happen. `parseCdpPrivateKey` refuses an ECDSA key
   * rather than signing ES256 with it.
   */
  it('refuses an ECDSA key rather than signing ES256 with it', () => {
    let thrown: unknown;
    try {
      parseCdpPrivateKey(TEST_ECDSA_PRIVATE_KEY_PEM);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConnectorError);
    expect(thrown).toMatchObject({ kind: 'invalid_input', condition: 'CONFIG_ERROR' });
    expect((thrown as ConnectorError).message).toMatch(/Ed25519/);
    expect((thrown as ConnectorError).redactedContext).toMatchObject({
      reason: 'wrong_algorithm',
      keyType: 'ec',
    });
  });

  it.each([
    ['an empty key', '', 'empty'],
    [
      'a truncated PEM',
      '-----BEGIN PRIVATE KEY-----\nnot base64\n-----END PRIVATE KEY-----',
      'unreadable_pem',
    ],
    [
      'a base64 blob of the wrong length',
      Buffer.from('too short').toString('base64'),
      'unrecognised_format',
    ],
  ])('refuses %s and says why without quoting it', (_label, material, reason) => {
    let thrown: unknown;
    try {
      parseCdpPrivateKey(material);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ kind: 'invalid_input' });
    expect((thrown as ConnectorError).redactedContext).toMatchObject({ reason });
    // Whatever was handed in, no part of it travels in the error.
    if (material.length > 8) {
      expect(JSON.stringify(thrown)).not.toContain(material.slice(0, 8));
    }
  });

  /**
   * The sabotage this test exists to catch, run as a positive control: a token
   * minted for one path and replayed at another must be rejected by the server.
   */
  it('a token minted for one path does not authenticate another', async () => {
    const { api, client } = clientHarness();
    await client.keyPermissions();
    const stolen = api.tokens[0] ?? '';

    const replayed = await api.transport({
      method: 'GET',
      host: 'api.coinbase.com',
      path: '/api/v3/brokerage/accounts',
      query: {},
      headers: { Authorization: `Bearer ${stolen}` },
      signal: null,
      timeoutMs: 1_000,
    });

    expect(replayed.status).toBe(401);
    expect(api.rejections.at(-1)).toMatch(/nonce was reused|uri is/);
  });
});
