// SPDX-License-Identifier: MIT
/**
 * The shared conformance suite (`@connector/port`), run against
 * `WalletRpcConnector` over the fakes — the same wrapper shape
 * `packages/connectors/coinbase/test/conformance.test.ts` uses.
 *
 * The conformance subject is an **ethereum address with a zero balance**.
 * That is deliberate, not an oversight: `holdings/every position names a
 * security` calls `syncHoldings` unconditionally once `holdings` is declared,
 * and this connector raises `DATA_UNAVAILABLE` for any *non-zero* balance (see
 * `connector.ts`'s header) because it has no price source. A zero balance
 * lets that check observe an honestly-empty `[]` rather than an unhandled
 * throw; `unpriced.test.ts` is the file that exercises the non-zero path this
 * subject deliberately avoids.
 */
import { connectorConformanceChecks, type ConformanceSubject } from '@connector/port';
import { describe, it } from 'vitest';
import { harness, handleFor } from './harness.ts';

const ETH_ADDRESS = '0x00000000219ab540356cbb839cbe05303d7705fa';

async function subject(): Promise<ConformanceSubject> {
  const { connector, syncOptions } = harness({
    etherscan: { balances: new Map([[ETH_ADDRESS, '0']]) },
  });
  const connectResult = await connector.connect({ chain: 'ethereum', value: ETH_ADDRESS });
  const handle = handleFor(connectResult);

  return {
    connector,
    handle,
    options: syncOptions,
    // This connector never seals a credential — `connect()` returns
    // `credentials: {}` — so there is nothing to assert is absent beyond the
    // generic credential-shaped-field check the suite always runs.
    secrets: [],
    disposable: async () => {
      const disposableResult = await connector.connect({ chain: 'ethereum', value: ETH_ADDRESS });
      return { handle: handleFor(disposableResult) };
    },
    provokeFailure: async () => {
      const brokenHandle = handleFor(null); // no wallet on record at all
      return connector.syncBalances(brokenHandle, syncOptions);
    },
    maxPages: 5,
  };
}

describe('conformance: WalletRpcConnector', () => {
  for (const { name } of connectorConformanceChecks({} as ConformanceSubject)) {
    it(name, async () => {
      const check = connectorConformanceChecks(await subject()).find(
        (candidate) => candidate.name === name,
      );
      if (check === undefined) throw new Error(`conformance check ${name} disappeared`);
      await check.run();
    });
  }
});
