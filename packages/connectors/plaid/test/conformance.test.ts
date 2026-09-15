// SPDX-License-Identifier: MIT
/**
 * The shared conformance suite, run against `PlaidConnector` over `FakePlaidApi`.
 *
 * 08 §2.7: "Run the shared conformance suite — it is the deliverable, not an
 * afterthought." The checks live in `@connector/port` and are runner-agnostic;
 * this file is the eleven-line vitest wrapper its own comment predicted an
 * adapter package would have to write, because `personalfi/layer-imports` denies
 * `packages/connectors/*` → `@ctx/*` and `describeConnectorConformance` lives
 * inside `@ctx/connections`.
 *
 * The subject is rebuilt per check on purpose: `disconnect/revokes` destroys the
 * Item it is given, and several checks page the stream to exhaustion.
 */
import { connectorConformanceChecks, type ConformanceSubject } from '@connector/port';
import { describe, it } from 'vitest';
import { PLAID_ERRORS } from './fake.ts';
import {
  ACCESS_TOKEN,
  SECOND_ACCESS_TOKEN,
  disposableItemSpec,
  handleFor,
  harness,
} from './harness.ts';

function subject(): ConformanceSubject {
  const { api, connector, handle, options } = harness();
  api.addItem(disposableItemSpec());

  return {
    connector,
    handle,
    options,
    // The real thing, so `secrets/a serialised handle contains no credential`
    // is checking a handle that genuinely holds one.
    secrets: [ACCESS_TOKEN],
    disposable: async () => ({ handle: handleFor(SECOND_ACCESS_TOKEN) }),
    // An Item Plaid has stopped talking to. `errors/typed` only asks that the
    // failure be a `ConnectorError`; `errors.test.ts` asserts which one.
    provokeFailure: async () => {
      const broken = harness({ failWith: { error: PLAID_ERRORS.ITEM_LOGIN_REQUIRED } });
      return broken.connector.syncTransactions(broken.handle, null, broken.options);
    },
    maxPages: 10,
  };
}

describe('conformance: PlaidConnector', () => {
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
