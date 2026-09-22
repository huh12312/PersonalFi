// SPDX-License-Identifier: MIT
/**
 * The shared conformance suite, run against `CoinbaseConnector` over the fake.
 *
 * 08 §2.7: "Run the shared conformance suite — it is the deliverable, not an
 * afterthought." The checks live in `@connector/port` and are runner-agnostic;
 * this file is the wrapper their own comment predicted an adapter package would
 * write, because `personalfi/layer-imports` denies `packages/connectors/*` →
 * `@ctx/*`.
 *
 * ## Two subject choices worth defending
 *
 * **`secrets`** carries the real private key material, so
 * `secrets/a serialised handle contains no credential` is checking a handle that
 * genuinely holds one. A subject with an empty `secrets` array would make that
 * check vacuous.
 *
 * **`disposable`** returns a handle whose sealed blob has been purged, because
 * that is what revocation *is* for this provider. Coinbase has no endpoint that
 * revokes a CDP key — and if it had, it would be a write, which this connector
 * refuses by construction. The revocation that exists is `@ctx/connections`
 * deleting `sealed_credentials`, after which `handle.secret(...)` answers `null`
 * and every method here fails `invalid_input`. `custody.test.ts` asserts the
 * same property directly and the evidence doc states it rather than implying a
 * revocation we do not perform.
 */
import { connectorConformanceChecks, type ConformanceSubject } from '@connector/port';
import { describe, it } from 'vitest';
import { TEST_KEY_NAME, TEST_PRIVATE_KEY_BASE64 } from './fake.ts';
import { handleFor, harness } from './harness.ts';

function subject(): ConformanceSubject {
  const { connector, handle, options } = harness();
  return {
    connector,
    handle,
    options,
    secrets: [TEST_PRIVATE_KEY_BASE64, TEST_KEY_NAME],
    disposable: async () => ({ handle: handleFor(null) }),
    // A key Coinbase has stopped accepting. `errors/typed` only asks that the
    // failure be a `ConnectorError`; `errors.test.ts` asserts which one.
    provokeFailure: async () => {
      const broken = harness({
        failures: {
          key_permissions: { status: 401, body: { error: 'UNAUTHENTICATED', message: 'revoked' } },
        },
      });
      return broken.connector.syncTransactions(broken.handle, null, broken.options);
    },
    maxPages: 10,
  };
}

describe('conformance: CoinbaseConnector', () => {
  // Names enumerated from a stub so vitest registers one case per check before
  // any subject exists; `connectorConformanceChecks` touches nothing until a
  // check actually runs, which is what makes the stub safe.
  for (const { name } of connectorConformanceChecks({} as ConformanceSubject)) {
    it(name, async () => {
      const check = connectorConformanceChecks(subject()).find(
        (candidate) => candidate.name === name,
      );
      if (check === undefined) throw new Error(`conformance check ${name} disappeared`);
      await check.run();
    });
  }
});
