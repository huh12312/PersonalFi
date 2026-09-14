// SPDX-License-Identifier: MIT
/**
 * The conformance suite, run against every adapter WP 1.2 ships.
 *
 * `ManualConnector` and `CsvImportConnector` implementing the same port as Plaid
 * is, per 08 §2.6, "the tell that the abstraction is right". This file is where
 * that claim is checked rather than asserted: the same twelve properties, the
 * same code, three very different adapters — an in-memory log, a parsed file,
 * and a generated 24-month dataset.
 *
 * `SeedConnector` is included deliberately. It is the largest and most
 * awkwardly-shaped stream of the three (thousands of transactions, a real
 * pending → posted lifecycle, removals interleaved with additions), and running
 * the suite over it is what makes the seed path evidence about the orchestrator
 * rather than a fixture that only ever takes the happy road.
 */
import {
  connectorConformanceChecks,
  type ConformanceSubject,
  type Connector,
  type ProviderTransactionFact,
} from '@connector/port';
import { DateOnly, money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { describeConformance } from './conformance.ts';
import {
  CsvImportConnector,
  ManualConnector,
  ManualStore,
  SeedConnector,
  TEST_ACCOUNT,
  bareHandle,
  generateDemoData,
  manualTransaction,
  syncOptions,
  testClock,
} from './harness.ts';

const ACCOUNTS = [
  { providerAccountId: TEST_ACCOUNT.providerAccountId, name: 'Everyday Checking', type: 'depository', currency: 'USD' },
];

function manualFacts(count: number, from = '2026-05-01'): ReturnType<typeof manualTransaction>[] {
  return Array.from({ length: count }, (_unused, index) =>
    manualTransaction({
      providerAccountId: TEST_ACCOUNT.providerAccountId,
      providerTransactionId: `txn-${String(index).padStart(4, '0')}`,
      amount: money(BigInt(-100 * (index + 1)), 'USD'),
      postedDate: DateOnly.addDays(DateOnly.parse(from), index),
      name: `MERCHANT ${index}`,
    }),
  );
}

// ---------------------------------------------------------------------------
// ManualConnector
// ---------------------------------------------------------------------------

describeConformance('ManualConnector', async () => {
  const store = new ManualStore();
  const connector = new ManualConnector({ store, pageSize: 3 });
  const { providerConnectionId } = await connector.connect({
    displayName: 'Cash and oddments',
    accounts: ACCOUNTS,
  });

  const facts = manualFacts(10);
  store.append(providerConnectionId, { added: facts.slice(0, 6) });
  // A pending charge that settles: the delete-plus-insert Plaid performs, so the
  // `pending/` check has something real to look at.
  const pending = manualTransaction({
    providerAccountId: TEST_ACCOUNT.providerAccountId,
    providerTransactionId: 'txn-pending',
    amount: money(-4_500n, 'USD'),
    postedDate: DateOnly.parse('2026-05-18'),
    name: 'SHELL OIL 4471',
    pending: true,
  });
  store.append(providerConnectionId, { added: [pending] });
  store.append(providerConnectionId, {
    removed: [
      { providerAccountId: TEST_ACCOUNT.providerAccountId, providerTransactionId: 'txn-pending' },
    ],
    added: [
      manualTransaction({
        providerAccountId: TEST_ACCOUNT.providerAccountId,
        providerTransactionId: 'txn-posted',
        amount: money(-4_712n, 'USD'),
        postedDate: DateOnly.parse('2026-05-20'),
        name: 'SHELL OIL 4471',
        pendingTransactionId: 'txn-pending',
      }),
    ],
  });

  return {
    connector,
    handle: bareHandle(providerConnectionId, connector.provider),
    options: syncOptions(testClock()),
    disposable: async () => {
      const disposable = await connector.connect({ displayName: 'Throwaway', accounts: ACCOUNTS });
      return { handle: bareHandle(disposable.providerConnectionId, connector.provider) };
    },
  };
});

// ---------------------------------------------------------------------------
// CsvImportConnector
// ---------------------------------------------------------------------------

const CSV = [
  'Date,Description,Amount',
  ...Array.from(
    { length: 9 },
    (_unused, index) => `2026-05-${String(index + 1).padStart(2, '0')},MERCHANT ${index},-${index + 1}.00`,
  ),
  // A deliberate duplicate of row 1: two identical purchases on one day are real,
  // and `occurrence` is what keeps them distinct without breaking re-import.
  '2026-05-01,MERCHANT 0,-1.00',
].join('\n');

describeConformance('CsvImportConnector', async () => {
  const connector = new CsvImportConnector({ pageSize: 4 });
  const files = [
    {
      name: 'statement.csv',
      content: CSV,
      profile: 'iso_signed',
      account: {
        providerAccountId: TEST_ACCOUNT.providerAccountId,
        name: 'Everyday Checking',
        type: 'depository' as const,
        currency: 'USD',
      },
    },
  ];
  const { providerConnectionId } = await connector.connect({ displayName: 'Bank export', files });

  return {
    connector,
    handle: bareHandle(providerConnectionId, connector.provider),
    options: syncOptions(testClock()),
    disposable: async () => {
      const disposable = await connector.connect({ displayName: 'Throwaway', files });
      return { handle: bareHandle(disposable.providerConnectionId, connector.provider) };
    },
    provokeFailure: () =>
      Promise.resolve(
        connector.addFile(providerConnectionId, {
          name: 'garbage.csv',
          content: 'Date,Description,Amount\nnot-a-date,X,1.00\n',
          profile: 'iso_signed',
          account: files[0]?.account,
        }),
      ),
  };
});

// ---------------------------------------------------------------------------
// SeedConnector
// ---------------------------------------------------------------------------

describeConformance('SeedConnector', () => {
  const connector = new SeedConnector({ pageSize: 250 });
  const dataset = generateDemoData(1);
  const providerConnectionId = connector.load('seed-conformance', dataset, {
    asOf: new Date('2026-06-01T12:00:00.000Z'),
  });

  return {
    connector,
    handle: bareHandle(providerConnectionId, connector.provider),
    options: syncOptions(testClock()),
    // The dataset is thousands of rows at 250 a page; the default bound of 50
    // would trip before the stream ends.
    maxPages: 200,
    disposable: () =>
      Promise.resolve({
        handle: bareHandle(
          connector.load('seed-throwaway', dataset, { asOf: new Date('2026-06-01T12:00:00.000Z') }),
          connector.provider,
        ),
      }),
  };
});

// ---------------------------------------------------------------------------
// Claims the suite itself makes
// ---------------------------------------------------------------------------

describe('the conformance suite, sabotaged', () => {
  /** Build a subject whose adapter has been broken in one specific way. */
  async function subjectWith(
    patch: (connector: ManualConnector) => Partial<Connector>,
  ): Promise<ConformanceSubject> {
    const store = new ManualStore();
    const honest = new ManualConnector({ store, pageSize: 3 });
    const { providerConnectionId } = await honest.connect({
      displayName: 'Sabotage',
      accounts: ACCOUNTS,
    });
    store.append(providerConnectionId, { added: manualFacts(5) });

    // A prototype-preserving proxy: the broken methods are the patch's, and
    // everything else is the real adapter, so the check fails for the reason
    // under test and not because the stand-in is a stub.
    const broken = Object.create(Object.getPrototypeOf(honest) as object) as ManualConnector;
    Object.assign(broken, honest, patch(honest));

    return {
      connector: broken,
      handle: bareHandle(providerConnectionId, honest.provider),
      options: syncOptions(testClock()),
    };
  }

  async function expectCheckToFail(subject: ConformanceSubject, prefix: string): Promise<void> {
    const check = connectorConformanceChecks(subject).find((candidate) =>
      candidate.name.startsWith(prefix),
    );
    if (check === undefined) throw new Error(`no conformance check starting with ${prefix}`);
    await expect(check.run()).rejects.toThrow();
  }

  // A gate that has never been observed failing something is not evidence. Each
  // of these breaks the adapter in one way and asserts the suite notices.

  it('fails an adapter that declares a dataset it cannot produce', async () => {
    const subject = await subjectWith((honest) => ({
      capabilities: () => ({
        ...honest.capabilities(),
        supports: [...honest.capabilities().supports, 'holdings'],
      }),
    }));
    await expectCheckToFail(subject, 'capabilities/');
  });

  it('fails an adapter whose pages are not reproducible from the same cursor', async () => {
    let call = 0;
    const subject = await subjectWith((honest) => ({
      syncTransactions: async (handle, cursor, options) => {
        const page = await honest.syncTransactions(handle, cursor, options);
        call += 1;
        // Drop a row on every other call: exactly the shape of a provider
        // whose stream is not stable under replay.
        return call % 2 === 0 ? { ...page, added: page.added.slice(1) } : page;
      },
    }));
    await expectCheckToFail(subject, 'sync/idempotent');
  });

  it('fails an adapter whose cursor never terminates', async () => {
    const subject = await subjectWith((honest) => ({
      syncTransactions: async (handle, cursor, options) => ({
        ...(await honest.syncTransactions(handle, cursor, options)),
        hasMore: true,
      }),
    }));
    await expectCheckToFail(subject, 'sync/terminates');
  });

  it('fails an adapter that re-adds a transaction it removed on an earlier page', async () => {
    let retracted: ProviderTransactionFact | null = null;
    const subject = await subjectWith((honest) => ({
      syncTransactions: async (handle, cursor, options) => {
        const page = await honest.syncTransactions(handle, cursor, options);
        if (retracted === null) {
          // First page: retract a row we just handed over.
          retracted = page.added[0] ?? null;
          if (retracted === null) return page;
          return {
            ...page,
            removed: [
              {
                providerAccountId: retracted.providerAccountId,
                providerTransactionId: retracted.providerTransactionId,
              },
            ],
          };
        }
        // A later page hands it straight back, with no explanation. The
        // orchestrator would have no way to know which statement is current.
        return { ...page, added: [retracted, ...page.added] };
      },
    }));
    await expectCheckToFail(subject, 'removed/');
  });

  it('fails an adapter that omits the mandatory fingerprint', async () => {
    const subject = await subjectWith((honest) => ({
      syncTransactions: async (handle, cursor, options) => {
        const page = await honest.syncTransactions(handle, cursor, options);
        return { ...page, added: page.added.map((fact) => ({ ...fact, fingerprint: '' })) };
      },
    }));
    await expectCheckToFail(subject, 'fingerprint/');
  });

  it('fails an adapter that rejects bad link input with an untyped error', async () => {
    const subject = await subjectWith(() => ({
      connect: () => Promise.reject(new Error('nope')),
    }));
    await expectCheckToFail(subject, 'errors/');
  });

  it('fails a handle that carries its credential as data', async () => {
    const subject = await subjectWith(() => ({}));
    const leaky: ConformanceSubject = {
      ...subject,
      handle: { ...subject.handle, secret: () => 'access-sandbox-1234' } as ConformanceSubject['handle'],
      secrets: ['access-sandbox-1234'],
    };
    // The honest handle passes, because `secret` is a closure.
    const honestCheck = connectorConformanceChecks(leaky).find((candidate) =>
      candidate.name.startsWith('secrets/'),
    );
    await expect(honestCheck?.run()).resolves.toBeUndefined();

    // The same check fails the moment the value is a field instead.
    await expectCheckToFail(
      {
        ...leaky,
        handle: {
          ...leaky.handle,
          // @ts-expect-error the whole point is that this shape is forbidden
          credentials: { access_token: 'access-sandbox-1234' },
        },
      },
      'secrets/',
    );
  });
});
