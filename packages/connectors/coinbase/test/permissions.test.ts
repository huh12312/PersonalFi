// SPDX-License-Identifier: MIT
/**
 * The scope assertion — the control this whole work package exists for.
 *
 * The Phase 3 risk table states the failure it prevents: *"A read-only
 * credential that is not read-only. A CDP key with trade permission is
 * indistinguishable from a `can_view` key until the day something posts an
 * order."* The control is `GET /key_permissions` asserted **at startup and again
 * before every sync**, and the gate's sabotage is "hand it a key claiming
 * `trade` and watch the connector refuse".
 *
 * So these tests do exactly that sabotage, from the fixture, and then do the
 * harder one: prove the check is not cached, by widening the key's permissions
 * *between* two calls on a connector that has already run successfully. A
 * control that only fires at boot would pass the first case and fail the second,
 * which is why the second exists.
 */
import { describe, expect, it } from 'vitest';
import { ConnectorError, retryPolicyFor } from '@connector/port';
import { CoinbaseConnector } from '../src/connector.ts';
import { FakeCoinbaseApi, TEST_KEY_NAME, TEST_PRIVATE_KEY_BASE64 } from './fake.ts';
import { handleFor, harness, syncOptions, testClock } from './harness.ts';

const TRADING_KEY = { can_view: true, can_trade: true, can_transfer: false };
const TRANSFERRING_KEY = { can_view: true, can_trade: false, can_transfer: true };
const BOTH = { can_view: true, can_trade: true, can_transfer: true };

function connectInput(): unknown {
  return { keyName: TEST_KEY_NAME, privateKey: TEST_PRIVATE_KEY_BASE64 };
}

describe('key_permissions', () => {
  it('a key claiming can_trade is refused at startup', async () => {
    const { connector } = harness({ permissions: TRADING_KEY });

    const thrown = await connector.connect(connectInput()).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ConnectorError);
    expect(thrown).toMatchObject({
      kind: 'permanent',
      condition: 'INSUFFICIENT_SCOPE',
      providerCode: 'KEY_NOT_READ_ONLY',
    });
    expect((thrown as ConnectorError).message).toMatch(/can_trade/);
    expect((thrown as ConnectorError).redactedContext).toMatchObject({ forbidden: ['can_trade'] });

    // The orchestrator's answer: stop, and tell the user. Not "retry tonight".
    expect(retryPolicyFor(thrown as ConnectorError)).toMatchObject({
      retryable: false,
      userActionRequired: true,
    });
  });

  it('…and again before a sync, not only at boot', async () => {
    // A connector that checked once at construction, or cached the answer, would
    // pass the case above and fail this one. The key is widened *after* two
    // successful syncs, exactly as it would be if someone edited it in the CDP
    // portal between two nightly runs.
    const clock = testClock();
    const permissions = { value: { can_view: true, can_trade: false, can_transfer: false } };
    const api = new FakeCoinbaseApi({
      nowMs: () => clock.nowMs(),
      get permissions() {
        return permissions.value;
      },
    });
    const connector = new CoinbaseConnector({ transport: api.transport, clock });
    const handle = handleFor();
    const options = syncOptions(clock);

    await connector.listAccounts(handle);
    await connector.syncBalances(handle, options);

    permissions.value = TRADING_KEY;

    for (const [label, run] of [
      ['listAccounts', () => connector.listAccounts(handle)],
      ['syncTransactions', () => connector.syncTransactions(handle, null, options)],
      ['syncBalances', () => connector.syncBalances(handle, options)],
      ['syncHoldings', () => connector.syncHoldings(handle, options)],
      ['syncInvestmentTransactions', () => connector.syncInvestmentTransactions(handle, options)],
      ['health', () => connector.health(handle)],
    ] as const) {
      const thrown = await run().catch((error: unknown) => error);
      expect(thrown, `${label} did not re-check the key`).toMatchObject({
        condition: 'INSUFFICIENT_SCOPE',
        providerCode: 'KEY_NOT_READ_ONLY',
      });
    }
  });

  /**
   * "Refused **before any data call**" is a stronger claim than "refused", and
   * it is the one the scope says: a key that can trade must not have read a
   * balance either. This asserts it from the server's request log.
   */
  it('a key with can_trade is refused before any data call', async () => {
    const { connector, api } = harness({ permissions: BOTH });

    await connector.connect(connectInput()).catch(() => undefined);
    await connector.syncBalances(handleFor(), syncOptions()).catch(() => undefined);
    await connector.syncHoldings(handleFor(), syncOptions()).catch(() => undefined);
    await connector.syncInvestmentTransactions(handleFor(), syncOptions()).catch(() => undefined);

    // Four attempts, four permission checks, and not one other request.
    expect(api.requests.map((request) => request.endpoint)).toEqual([
      'key_permissions',
      'key_permissions',
      'key_permissions',
      'key_permissions',
    ]);
  });

  it('refuses can_transfer for the same reason, and names both when both are set', async () => {
    const transferring = harness({ permissions: TRANSFERRING_KEY });
    const thrown = await transferring.connector
      .connect(connectInput())
      .catch((error: unknown) => error);
    expect((thrown as ConnectorError).redactedContext).toMatchObject({
      forbidden: ['can_transfer'],
    });

    const both = harness({ permissions: BOTH });
    const thrownBoth = await both.connector
      .connect(connectInput())
      .catch((error: unknown) => error);
    expect((thrownBoth as ConnectorError).message).toMatch(/can_trade and can_transfer/);
  });

  it('refuses a key that cannot even view, rather than producing a stream of 403s', async () => {
    const { connector } = harness({
      permissions: { can_view: false, can_trade: false, can_transfer: false },
    });
    const thrown = await connector.connect(connectInput()).catch((error: unknown) => error);
    expect(thrown).toMatchObject({
      condition: 'INSUFFICIENT_SCOPE',
      providerCode: 'KEY_CANNOT_VIEW',
    });
  });

  it('accepts can_receive, which cannot move money out', async () => {
    // A key created by ticking "view" in a portal that also grants receive is
    // the common case. Refusing it would reject a read-only key for a permission
    // that can only ever produce a deposit address.
    const { connector } = harness({
      permissions: { can_view: true, can_trade: false, can_transfer: false, can_receive: true },
    });
    const connected = await connector.connect(connectInput());
    expect(connected.providerConnectionId).toBe('3a1b8c44-0000-4000-8000-0000000000p1');
  });

  it('health reports the scope refusal by throwing, not as a soft "unreachable"', async () => {
    // Deliberate divergence from PlaidConnector.health, documented on the
    // method: a key that has acquired can_trade is not an unhealthy connection,
    // it is one we refuse to operate — and reporting it as unreachable would let
    // a caller retry it forever.
    const { connector, handle } = harness({ permissions: TRADING_KEY });
    await expect(connector.health(handle)).rejects.toMatchObject({
      condition: 'INSUFFICIENT_SCOPE',
    });

    // A provider outage still *reports*, because that genuinely is health.
    const down = harness({
      failures: { key_permissions: { status: 503, body: { error: 'UNAVAILABLE' } } },
    });
    await expect(down.connector.health(down.handle)).resolves.toMatchObject({
      reachable: false,
      detail: 'UNAVAILABLE',
    });
  });
});
