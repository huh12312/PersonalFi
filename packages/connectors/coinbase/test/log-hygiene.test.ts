// SPDX-License-Identifier: MIT
/**
 * P0-1 / P0-12, for a credential that can sign and a token that is live.
 *
 * Three things must never appear in anything this package produces:
 *
 *   * **the CDP private key** — the only secret whose loss is total. A CDP key
 *     does not expire; it is revoked, by hand, in a portal, and until somebody
 *     does that a leaked key is an account somebody else can read;
 *   * **the minted JWT** — a bearer token that is valid for the next 120
 *     seconds. Short, but 120 seconds is a long time in a log aggregator;
 *   * **the nonce** — on its own it is not a secret, but it is the field that
 *     would tell an observer how to distinguish two otherwise identical
 *     requests, and there is no reason for it to be anywhere but the wire.
 *
 * ## Where it looks
 *
 * Not just the log lines: every artefact the adapter hands back or throws,
 * rendered through `util.inspect(…, {depth: null, showHidden: true, getters:
 * true})` — which walks getters, `cause` chains and non-enumerable properties,
 * i.e. everything `JSON.stringify` silently misses and a pino serialiser, a
 * debugger and Node's unhandled-rejection dump do not.
 *
 * ## The scanner is itself tested
 *
 * `detects a planted leak` plants each secret in each kind of artefact and
 * asserts the scanner finds it. A hygiene test that cannot fail is worse than no
 * hygiene test, because it reads like evidence.
 */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { TEST_KEY_NAME, TEST_PRIVATE_KEY_BASE64, TEST_PRIVATE_KEY_PEM } from './fake.ts';
import { cursorBeforeTheDeposit, handleFor, harness, type LogLine } from './harness.ts';

/** The seed, in the two shapes it can appear in, plus the PEM body. */
const KEY_MATERIAL = [
  TEST_PRIVATE_KEY_BASE64,
  TEST_PRIVATE_KEY_PEM.split('\n').filter((line) => !line.startsWith('---'))[0] ?? '',
];

function renderings(value: unknown): string[] {
  const out = [inspect(value, { depth: null, showHidden: true, getters: true })];
  try {
    out.push(JSON.stringify(value) ?? 'undefined');
  } catch {
    // A circular structure. `inspect` already covered it.
  }
  if (value instanceof Error) {
    out.push(value.message, value.stack ?? '');
    for (const key of Object.getOwnPropertyNames(value)) {
      out.push(inspect((value as unknown as Record<string, unknown>)[key], { depth: null }));
    }
  }
  return out;
}

function leaksIn(value: unknown, secrets: readonly string[]): string[] {
  const rendered = renderings(value);
  return secrets.filter(
    (secret) => secret.length > 0 && rendered.some((text) => text.includes(secret)),
  );
}

describe('the scanner can fail', () => {
  it.each([
    [
      'a log context field',
      (s: string) => ({ level: 'debug', context: { body: s }, message: 'x' }),
    ],
    ['an Authorization header', (s: string) => ({ headers: { Authorization: `Bearer ${s}` } })],
    ['an error message', (s: string) => new Error(`request failed for ${s}`)],
    ['an error cause chain', (s: string) => new Error('wrapped', { cause: new Error(s) })],
    ['a non-enumerable property', (s: string) => Object.defineProperty({}, 'k', { value: s })],
    [
      'a getter',
      (s: string) => ({
        get key() {
          return s;
        },
      }),
    ],
  ])('detects a planted leak in %s', (_label, plant) => {
    for (const secret of KEY_MATERIAL) {
      expect(leaksIn(plant(secret), KEY_MATERIAL)).toContain(secret);
    }
  });

  it('does not fire on ordinary adapter output', () => {
    expect(
      leaksIn({ provider: 'coinbase', endpoint: 'accounts', httpStatus: 200 }, KEY_MATERIAL),
    ).toEqual([]);
  });
});

describe('a successful run', () => {
  it('no log line contains the private key, JWT or nonce', async () => {
    const { api, connector, logger, handle, options } = harness();

    const connected = await connector.connect({
      keyName: TEST_KEY_NAME,
      privateKey: TEST_PRIVATE_KEY_BASE64,
    });
    await connector.listAccounts(handle);
    const first = await connector.syncTransactions(handle, null, options);
    const second = await connector.syncTransactions(handle, cursorBeforeTheDeposit(), options);
    const balances = await connector.syncBalances(handle, options);
    const holdings = await connector.syncHoldings(handle, options);
    const investments = await connector.syncInvestmentTransactions(handle, options);
    const health = await connector.health(handle);
    await connector.disconnect(handle);

    // The traps are armed: real tokens and real nonces were minted, and the
    // scanner is looking for the exact strings that went over the wire.
    expect(api.tokens.length).toBeGreaterThan(5);
    expect(api.nonces.length).toBe(api.tokens.length);
    const secrets = [...KEY_MATERIAL, ...api.tokens, ...api.nonces];

    expect(logger.lines.length).toBeGreaterThan(0);
    for (const line of logger.lines) {
      expect(leaksIn(line, secrets), `log line "${line.message}" leaked`).toEqual([]);
    }

    for (const [label, value] of [
      ['the transaction pages', [first, second]],
      ['the cursor', second.nextCursor],
      ['balances', balances],
      ['holdings', holdings],
      ['investment transactions', investments],
      ['health', health],
      ['the handle', handle],
      // `raw` carries the provider payload on every fact. A Coinbase account
      // object carries no credential, and this is what proves it rather than
      // assuming it.
      ['raw payloads', [...holdings.map((h) => h.raw), ...investments.map((i) => i.raw)]],
    ] as const) {
      expect(leaksIn(value, secrets), `${label} leaked`).toEqual([]);
    }

    // The one legitimate exception, deliberately narrow: `connect` hands both
    // halves back exactly once so `@ctx/connections` can seal them.
    expect(connected.credentials['cdp_private_key']).toBe(TEST_PRIVATE_KEY_BASE64);
    expect(leaksIn({ ...connected, credentials: undefined }, secrets)).toEqual([]);
  });

  it('logs four fields on success and five on failure, and nothing else', async () => {
    const { connector, logger, handle, options } = harness();
    await connector.syncBalances(handle, options);

    const debug = logger.lines.filter((line) => line.level === 'debug');
    expect(debug.length).toBeGreaterThan(0);
    for (const line of debug) {
      expect(Object.keys(line.context).sort()).toEqual(['endpoint', 'httpStatus', 'provider']);
      expect(line.context['provider']).toBe('coinbase');
    }

    const failing = harness({
      failures: { accounts: { status: 503, body: { error: 'UNAVAILABLE' } } },
    });
    await failing.connector.syncBalances(failing.handle, failing.options).catch(() => undefined);
    const warn = failing.logger.lines.filter((line) => line.message === 'coinbase request failed');
    expect(warn).toHaveLength(1);
    expect(Object.keys(warn[0]?.context ?? {}).sort()).toEqual([
      'condition',
      'endpoint',
      'kind',
      'provider',
      'providerCode',
    ]);
  });

  it('collapses a product id in the endpoint label, because which coins you hold is user data', async () => {
    const { connector, logger, handle, options } = harness();
    await connector.syncHoldings(handle, options);
    const endpoints = logger.lines.map((line) => line.context['endpoint']);
    expect(endpoints).toContain('products/{product_id}/ticker');
    expect(endpoints).not.toContain('products/BTC-USD/ticker');
  });
});

describe('a failing run', () => {
  it.each([
    ['a broken key', { status: 401, body: { error: 'UNAUTHENTICATED', message: 'bad token' } }],
    ['a scope refusal', { status: 403, body: { error: 'PERMISSION_DENIED', message: 'nope' } }],
    ['a rate limit', { status: 429, body: { error: 'RESOURCE_EXHAUSTED', message: 'slow down' } }],
    ['an outage', { status: 503, body: { error: 'UNAVAILABLE', message: 'try later' } }],
  ])('survives %s on every leg', async (_label, failure) => {
    const { api, connector, logger, handle, options } = harness({
      failures: {
        key_permissions: failure,
        accounts: failure,
        'orders/historical/fills': failure,
      },
    });

    const thrown: unknown[] = [];
    const attempt = async (run: () => Promise<unknown>): Promise<void> => {
      await run().catch((caught: unknown) => void thrown.push(caught));
    };
    await attempt(() => connector.listAccounts(handle));
    await attempt(() => connector.syncTransactions(handle, null, options));
    await attempt(() => connector.syncBalances(handle, options));
    await attempt(() => connector.syncHoldings(handle, options));
    await attempt(() => connector.syncInvestmentTransactions(handle, options));

    expect(thrown).toHaveLength(5);
    const secrets = [...KEY_MATERIAL, ...api.tokens, ...api.nonces];
    for (const caught of thrown) {
      expect(leaksIn(caught, secrets), 'a thrown ConnectorError leaked').toEqual([]);
      // And no `cause`: the response that carried our own Authorization header
      // is read for four fields and then dropped (`errors.ts`).
      expect((caught as Error).cause).toBeUndefined();
    }
    for (const line of logger.lines) expect(leaksIn(line, secrets)).toEqual([]);
  });

  it('keeps a malformed key form out of the error, private key and all', async () => {
    const { connector, logger } = harness();
    const caught = await connector
      .connect({ keyName: 42, privateKey: TEST_PRIVATE_KEY_BASE64, spare: TEST_PRIVATE_KEY_BASE64 })
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({ kind: 'invalid_input' });
    expect(leaksIn(caught, KEY_MATERIAL)).toEqual([]);
    expect(leaksIn(logger.lines, KEY_MATERIAL)).toEqual([]);
    // It names the *fields*, which are constants, not their values.
    expect((caught as { redactedContext: Record<string, unknown> }).redactedContext).toEqual({
      fields: ['keyName'],
    });
  });

  it('keeps the key out of the "no credential" error, which is the tempting place to put it', async () => {
    const { connector, options } = harness();
    const caught = await connector
      .syncBalances(handleFor(null), options)
      .catch((error: unknown) => error);
    expect(leaksIn(caught, KEY_MATERIAL)).toEqual([]);
    expect((caught as { redactedContext: Record<string, unknown> }).redactedContext).toMatchObject({
      credential: 'cdp_key_name',
    });
  });
});

describe('the ConnectionHandle', () => {
  it('holds both halves in a closure, so serialising it yields nothing', () => {
    const handle = handleFor();
    expect(handle.secret('cdp_private_key')).toBe(TEST_PRIVATE_KEY_BASE64);
    expect(leaksIn(handle, KEY_MATERIAL)).toEqual([]);
    expect(JSON.stringify(handle)).not.toContain(TEST_PRIVATE_KEY_BASE64);
    expect(inspect(handle, { depth: null, showHidden: true })).not.toContain(
      TEST_PRIVATE_KEY_BASE64,
    );
  });
});

/** Keeps the `LogLine` import honest, and documents the shape being scanned. */
const SHAPE: LogLine = { level: 'debug', context: {}, message: '' };
void SHAPE;
