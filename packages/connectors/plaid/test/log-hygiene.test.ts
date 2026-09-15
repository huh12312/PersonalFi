// SPDX-License-Identifier: MIT
/**
 * P0-1 / P0-12: no token, anywhere, ever.
 *
 * Plaid access tokens **do not expire** (01 §1.10). A leaked bearer token with a
 * lifetime is an incident with a clock on it; this one is an incident until
 * somebody notices and calls `/item/remove`. That asymmetry is why this file
 * exists and why it is deliberately paranoid about *where* it looks.
 *
 * ## What it searches
 *
 * Not just the log lines. Every artefact the adapter hands back or throws:
 *
 *   * every captured log line, context object included, through
 *     `util.inspect(…, {depth: null})` — which walks getters, `cause` chains and
 *     non-enumerable properties, i.e. everything `JSON.stringify` silently
 *     misses and a pino serialiser or an unhandled-rejection dump does not;
 *   * every thrown `ConnectorError`: message, `redactedContext`, own properties
 *     and the whole `cause` chain;
 *   * the `ConnectionHandle`, serialised;
 *   * every fact returned by every method, `raw` payload included.
 *
 * ## What it searches *for*
 *
 * The access token, the public token, and a stand-in `PLAID-SECRET`. `FakePlaidApi`
 * throws errors with `config.data` set to the real request body and
 * `config.headers` carrying that secret, exactly as axios does — so the trap is
 * armed on every failure path, not just described in a comment.
 *
 * ## The scanner is itself tested
 *
 * `detects a planted leak` plants each secret in each kind of artefact and
 * asserts the scanner finds it. A hygiene test that cannot fail is worse than no
 * hygiene test, because it reads like evidence.
 */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { FAKE_PLAID_SECRET, PLAID_ERRORS, plaidAxiosError } from './fake.ts';
import {
  ACCESS_TOKEN,
  PUBLIC_TOKEN,
  SECOND_ACCESS_TOKEN,
  disposableItemSpec,
  handleFor,
  harness,
  type LogLine,
} from './harness.ts';

const SECRETS = [ACCESS_TOKEN, PUBLIC_TOKEN, SECOND_ACCESS_TOKEN, FAKE_PLAID_SECRET];

/**
 * Every rendering something downstream might plausibly produce from a value.
 *
 * `inspect` with `depth: null` is the important one: it is what `console.log`,
 * a debugger and Node's unhandled-rejection handler all do, and it follows the
 * `cause` chain that `JSON.stringify` drops on the floor.
 */
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

/** Which secrets, if any, are visible in any rendering of `value`. */
function leaksIn(value: unknown, secrets: readonly string[] = SECRETS): string[] {
  const rendered = renderings(value);
  return secrets.filter((secret) => rendered.some((text) => text.includes(secret)));
}

function expectNoLeak(label: string, value: unknown): void {
  expect(leaksIn(value), `${label} leaked a credential`).toEqual([]);
}

function expectLogsClean(lines: readonly LogLine[]): void {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) expectNoLeak(`log line "${line.message}"`, line);
}

// ---------------------------------------------------------------------------
// The scanner itself
// ---------------------------------------------------------------------------

describe('the scanner can fail', () => {
  it.each([
    [
      'a log context field',
      (s: string) => ({ level: 'debug', context: { body: s }, message: 'x' }),
    ],
    ['a nested request body', (s: string) => ({ config: { data: JSON.stringify({ t: s }) } })],
    ['an error message', (s: string) => new Error(`request failed for ${s}`)],
    ['an error cause chain', (s: string) => new Error('wrapped', { cause: new Error(s) })],
    [
      'a cause two levels deep',
      (s: string) => new Error('a', { cause: new Error('b', { cause: { token: s } }) }),
    ],
    ['a non-enumerable property', (s: string) => Object.defineProperty({}, 'secret', { value: s })],
    [
      'a getter',
      (s: string) => ({
        get token() {
          return s;
        },
      }),
    ],
  ])('detects a planted leak in %s', (_label, plant) => {
    for (const secret of SECRETS) {
      expect(leaksIn(plant(secret))).toContain(secret);
    }
  });

  it('does not fire on ordinary adapter output', () => {
    expect(
      leaksIn({ provider: 'plaid', endpoint: 'transactions/sync', requestId: 'req-1' }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('a successful run logs no credential', () => {
  it('walks every method and finds nothing in the logs or the facts', async () => {
    const { api, connector, logger, handle, options } = harness();
    api.addItem(disposableItemSpec());

    const connected = await connector.connect({ publicToken: PUBLIC_TOKEN });
    await connector.createLinkToken({ clientUserId: handle.userId });
    await connector.createUpdateLinkToken(handle);
    await connector.listAccounts(handle);
    const first = await connector.syncTransactions(handle, null, options);
    const second = await connector.syncTransactions(handle, first.nextCursor, options);
    const third = await connector.syncTransactions(handle, second.nextCursor, options);
    const balances = await connector.syncBalances(handle, options);
    const holdings = await connector.syncHoldings(handle, options);
    const investments = await connector.syncInvestmentTransactions(handle, options);
    const liabilities = await connector.syncLiabilities(handle, options);
    const health = await connector.health(handle);
    await connector.disconnect(handleFor(SECOND_ACCESS_TOKEN));

    expectLogsClean(logger.lines);
    for (const [label, value] of [
      ['transaction pages', [first, second, third]],
      ['balances', balances],
      ['holdings', holdings],
      ['investment transactions', investments],
      ['liabilities', liabilities],
      ['health', health],
      ['the handle', handle],
      // `raw` carries the whole Plaid object on every fact. A Plaid transaction
      // object carries no token, and this is what proves it rather than assumes
      // it.
      ['raw payloads', [...first.added, ...second.added, ...third.added].map((f) => f.raw)],
    ] as const) {
      expectNoLeak(label, value);
    }

    // The one legitimate exception, and it is deliberately narrow: `connect`
    // hands the access token back exactly once so @ctx/connections can seal it.
    expect(connected.credentials['access_token']).toBe(ACCESS_TOKEN);
    expectNoLeak('the ConnectResult minus its credentials', {
      ...connected,
      credentials: undefined,
    });
  });

  it('logs only provider, endpoint and the Plaid request id — never the body', async () => {
    // The request body contains `access_token` on every call after linking, and
    // the response object hangs the whole axios request config off itself.
    const { connector, logger, handle, options } = harness();
    await connector.syncTransactions(handle, null, options);

    const debug = logger.lines.filter((line) => line.level === 'debug');
    expect(debug.length).toBeGreaterThan(0);
    for (const line of debug) {
      expect(Object.keys(line.context).sort()).toEqual(['endpoint', 'provider', 'requestId']);
      expect(line.context['provider']).toBe('plaid');
    }
  });
});

// ---------------------------------------------------------------------------
// The failure paths, where axios hands us a loaded gun
// ---------------------------------------------------------------------------

describe('a failing run logs no credential', () => {
  it.each([
    ['a broken Item', PLAID_ERRORS.ITEM_LOGIN_REQUIRED],
    ['a rate limit', PLAID_ERRORS.RATE_LIMIT_EXCEEDED],
    ['an institution outage', PLAID_ERRORS.INSTITUTION_DOWN],
    ['a product that was never linked', PLAID_ERRORS.PRODUCTS_NOT_SUPPORTED],
    ['a Plaid-side fault', PLAID_ERRORS.PLAID_INTERNAL],
  ])('survives %s on every call', async (_label, error) => {
    const { connector, logger, handle, options } = harness({ failWith: { error } });

    const thrown: unknown[] = [];
    const attempt = async (run: () => Promise<unknown>): Promise<void> => {
      await run().catch((caught: unknown) => void thrown.push(caught));
    };
    await attempt(() => connector.syncTransactions(handle, null, options));
    await attempt(() => connector.listAccounts(handle));
    await attempt(() => connector.syncBalances(handle, options));
    await attempt(() => connector.syncHoldings(handle, options));
    await attempt(() => connector.syncInvestmentTransactions(handle, options));
    await attempt(() => connector.syncLiabilities(handle, options));

    expect(thrown.length).toBe(6);
    expectLogsClean(logger.lines);
    for (const caught of thrown) expectNoLeak('a thrown ConnectorError', caught);
  });

  it('never attaches the axios error, whose config.data is the request body', async () => {
    // The trap: `FakePlaidApi` builds errors with `config.data` set to the real
    // body (containing `access_token`) and `config.headers` carrying a stand-in
    // PLAID-SECRET, exactly as axios does. `errors.ts` reads four fields and
    // lets the object go; attaching it as a `cause` would print the token on the
    // first structured log line.
    const armed = plaidAxiosError('transactions/sync', PLAID_ERRORS.INSTITUTION_DOWN, {
      access_token: ACCESS_TOKEN,
    });
    // Sanity: the gun really is loaded.
    expect(leaksIn(armed)).toEqual(expect.arrayContaining([ACCESS_TOKEN, FAKE_PLAID_SECRET]));

    const { connector, logger, handle, options } = harness({
      failWith: { error: PLAID_ERRORS.INSTITUTION_DOWN },
    });
    const caught = await connector
      .syncTransactions(handle, null, options)
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({ name: 'ConnectorError' });
    expect((caught as Error).cause).toBeUndefined();
    expectNoLeak('the ConnectorError', caught);
    expectLogsClean(logger.lines);
  });

  it('logs a failure as five classification fields and nothing else', async () => {
    const { connector, logger, handle, options } = harness({
      failWith: { error: PLAID_ERRORS.INSTITUTION_DOWN },
    });
    await connector.syncTransactions(handle, null, options).catch(() => undefined);

    const warn = logger.lines.filter((line) => line.message === 'plaid request failed');
    expect(warn).toHaveLength(1);
    expect(Object.keys(warn[0]?.context ?? {}).sort()).toEqual([
      'condition',
      'endpoint',
      'kind',
      'provider',
      'providerCode',
    ]);
  });

  it('keeps a malformed link payload out of the error, token and all', async () => {
    // A malformed Link result can still contain a real public token.
    const { connector, logger } = harness();
    const caught = await connector
      .connect({ publicToken: 42, spare: PUBLIC_TOKEN })
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({ kind: 'invalid_input' });
    expectNoLeak('the rejected connect()', caught);
    expect(leaksIn(logger.lines)).toEqual([]);
  });

  it('keeps the token out of the "no credential" error, which is the tempting place to put it', async () => {
    const { connector, options } = harness();
    const caught = await connector
      .syncTransactions({ ...handleFor(), secret: () => null }, null, options)
      .catch((error: unknown) => error);
    expectNoLeak('the missing-credential error', caught);
    // It names the *key*, which is a constant, not the value.
    expect((caught as { redactedContext: Record<string, unknown> }).redactedContext).toMatchObject({
      credential: 'access_token',
    });
  });
});

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

describe('the ConnectionHandle', () => {
  it('holds its secret in a closure, so serialising it yields nothing', () => {
    // The port: `secret` is a function, not a field, because "a field survives
    // JSON.stringify, a structured log line, an error's redactedContext and a
    // debugger's object dump; a closure does not".
    const handle = handleFor();
    expect(handle.secret('access_token')).toBe(ACCESS_TOKEN);
    expectNoLeak('the handle', handle);
    expect(JSON.stringify(handle)).not.toContain(ACCESS_TOKEN);
    expect(inspect(handle, { depth: null, showHidden: true })).not.toContain(ACCESS_TOKEN);
  });
});
