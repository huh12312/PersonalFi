// SPDX-License-Identifier: MIT
/**
 * "**No trading endpoint appears anywhere in the adapter's code.**"
 *
 * That claim is checked two ways, because either one alone is weak:
 *
 *  1. **Dynamically**, from the server's request log. Every public method of the
 *     connector is driven and every request the fake actually received is
 *     asserted to be a `GET` on one of the five read-only paths. This is the
 *     strong half: it cannot be satisfied by a comment, and it would catch a
 *     trading call made through a helper, a variable or a template.
 *  2. **Statically**, over `src/**` with comments stripped. This is the half
 *     that catches code which is *present but not reached by these tests* — a
 *     `POST` behind a flag, a path built for a future branch. It is deliberately
 *     narrow (method literals and path construction) rather than a grep for the
 *     word "orders", because `provider.ts` and `ledger-gap.ts` both *describe*
 *     the trading surface in prose and in data, and a test that forbade naming
 *     the thing would push the documentation out of the package.
 *
 * ## Sabotage
 *
 * Adding `method: 'POST'` anywhere in `src/**`, or a `client.#get` call for a
 * path outside the allow-list, fails one of these. The evidence doc records both
 * observed red.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConnectorError } from '@connector/port';
import { assertReadOnlyPath, isReadOnlyPath } from '../src/client.ts';
import { COINBASE_READ_ONLY_PATHS } from '../src/provider.ts';
import { cursorBeforeTheDeposit, handleFor, harness } from './harness.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every `.ts` under `src/`, with its own name. */
function sources(): readonly { readonly name: string; readonly text: string }[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(join(SRC, name), 'utf8') }));
}

/**
 * Drop whole-line comments and block-comment bodies.
 *
 * This codebase writes documentation as `/** … *\/` blocks whose continuation
 * lines begin with `*`, so dropping those lines plus `//`-only lines removes the
 * prose without touching a single string literal — which matters, because
 * `ledger-gap.ts` legitimately *names* `POST /portfolios/{uuid}/move_funds` in
 * its determination table as a thing this connector may not call.
 */
function codeOnly(text: string): string {
  let inBlock = false;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.endsWith('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.endsWith('*/')) inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

describe('the read-only surface', () => {
  it('the package contains no code path that POSTs to /orders', () => {
    for (const { name, text } of sources()) {
      const code = codeOnly(text);

      // Every HTTP method literal in the package is GET.
      for (const match of code.matchAll(/method\s*:\s*['"]([A-Za-z]+)['"]/g)) {
        expect(match[1], `${name} builds a ${String(match[1])} request`).toBe('GET');
      }
      // …including the type that declares what a method may be. Written as an
      // equality rather than a negative lookahead, because `(?!'GET')` after a
      // greedy `\s*` backtracks to a zero-width match and passes on anything.
      const methodType = /type CoinbaseMethod = ([^;]+);/.exec(code)?.[1];
      if (methodType !== undefined) {
        expect(methodType.trim(), `${name} widens the method type`).toBe("'GET'");
      }

      // Every brokerage path is built from the prefix constant, and every such
      // construction is one of the five. A literal `/api/v3/brokerage/orders`
      // outside a comment fails here.
      for (const match of code.matchAll(/COINBASE_BROKERAGE_PREFIX\}([^`]*)`/g)) {
        // A template interpolation is the one legitimate variable segment, and
        // `coinbaseTickerPath` validates it separately; stand in a real product
        // id so the assembled path can be checked against the allow-list.
        const suffix = (match[1] ?? '').replace(/\$\{[^}]+\}/g, 'BTC-USD');
        const path = `/api/v3/brokerage${suffix}`;
        expect(isReadOnlyPath(path), `${name} builds ${path}, which is not on the allow-list`).toBe(
          true,
        );
      }

      // The three trading writes named in 01 §3.3 and the Advanced Trade
      // reference, as code rather than as prose.
      expect(code, `${name} contains a batch_cancel call`).not.toMatch(
        /batch_cancel\s*[`'"]?\s*\)/,
      );
      expect(code, `${name} calls fetch outside client.ts`).toSatisfy(
        (value: string) => name === 'client.ts' || !/\bfetch\s*\(/.test(value),
      );
    }
  });

  it('drives every public method and sees only GETs on the five allowed paths', async () => {
    const { api, connector, handle, options } = harness();

    await connector.connect({
      keyName: handle.secret('cdp_key_name') ?? '',
      privateKey: handle.secret('cdp_private_key') ?? '',
    });
    await connector.listAccounts(handle);
    await connector.syncTransactions(handle, null, options);
    await connector.syncTransactions(handle, cursorBeforeTheDeposit(), options);
    await connector.syncBalances(handle, options);
    await connector.syncHoldings(handle, options);
    await connector.syncInvestmentTransactions(handle, options);
    await connector.health(handle);
    await connector.disconnect(handle);

    expect(api.requests.length).toBeGreaterThan(10);
    for (const request of api.requests) {
      expect(request.method).toBe('GET');
      expect(
        isReadOnlyPath(request.path),
        `${request.method} ${request.path} is not on the allow-list`,
      ).toBe(true);
    }
    // And the endpoints it reached are exactly the five, no more.
    expect([...new Set(api.requests.map((request) => request.endpoint))].sort()).toEqual([
      'accounts',
      'key_permissions',
      'orders/historical/fills',
      'portfolios',
      'products/{product_id}/ticker',
    ]);
  });

  it.each([
    ['place an order', '/api/v3/brokerage/orders'],
    ['cancel a batch', '/api/v3/brokerage/orders/batch_cancel'],
    ['edit an order', '/api/v3/brokerage/orders/edit'],
    ['move funds between portfolios', '/api/v3/brokerage/portfolios/abc/move_funds'],
    ['preview an order', '/api/v3/brokerage/orders/preview'],
    ['close a position', '/api/v3/brokerage/orders/close_position'],
  ])('refuses to build a request that would %s', (_label, path) => {
    expect(isReadOnlyPath(path)).toBe(false);
    let thrown: unknown;
    try {
      assertReadOnlyPath(path);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConnectorError);
    expect(thrown).toMatchObject({ kind: 'permanent', condition: 'INTERNAL' });
    expect((thrown as ConnectorError).message).toMatch(/read-only/);
  });

  it('will not let a product id smuggle a different path past the allow-list', () => {
    // The ticker path is the only one with a placeholder, so it is the only
    // place a segment could be attacker- or bug-supplied. `..`, a slash and a
    // query are all refused before anything is signed.
    for (const hostile of [
      '/api/v3/brokerage/products/../../orders/ticker',
      '/api/v3/brokerage/products/BTC-USD/../../orders',
      '/api/v3/brokerage/products/BTC-USD/ticker?x=/orders',
      '/api/v3/brokerage/products//ticker',
    ]) {
      expect(isReadOnlyPath(hostile), `${hostile} was admitted`).toBe(false);
    }
    expect(isReadOnlyPath('/api/v3/brokerage/products/BTC-USD/ticker')).toBe(true);
  });

  it('keeps the allow-list to five paths, all of them reads', () => {
    expect(COINBASE_READ_ONLY_PATHS).toHaveLength(5);
    for (const path of COINBASE_READ_ONLY_PATHS) {
      expect(path.startsWith('/api/v3/brokerage/')).toBe(true);
    }
    // The one that is easiest to widen by accident: `orders/historical/fills` is
    // allowed and its parent is not.
    expect(isReadOnlyPath('/api/v3/brokerage/orders/historical/fills')).toBe(true);
    expect(isReadOnlyPath('/api/v3/brokerage/orders')).toBe(false);
  });

  it('refuses a disconnected handle rather than signing with nothing', async () => {
    const { connector, options } = harness();
    await expect(connector.syncTransactions(handleFor(null), null, options)).rejects.toMatchObject({
      kind: 'invalid_input',
      condition: 'CONFIG_ERROR',
    });
  });
});
