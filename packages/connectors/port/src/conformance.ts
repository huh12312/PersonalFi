// SPDX-License-Identifier: MIT
/**
 * The shared conformance suite.
 *
 * 08 §2.7 is unusually direct about this: "**Run the shared conformance suite** —
 * it is the deliverable, not an afterthought… The conformance suite is what
 * makes this a day instead of a week, and it is what makes the Plaid→SimpleFIN
 * fallback a config change under pressure rather than a rewrite under pressure."
 *
 * So it lives beside the port rather than inside `@ctx/connections`, for the
 * same reason the port does: `personalfi/layer-imports` denies
 * `packages/connectors/*` → `@ctx/*`, and a suite an adapter package cannot
 * import is a suite that only the adapters someone remembered to wire up will
 * ever run. `packages/contexts/connections/test/conformance.ts` wraps these as a
 * vitest `describe`, and a future `packages/connectors/plaid/test/*.test.ts` can
 * wrap the same checks without reaching across a context boundary.
 *
 * The checks are **runner-agnostic** — named async functions that throw, not
 * `it()` calls. That is what lets both wrappers exist, and it costs one
 * eight-line `assert`.
 *
 * ## What is asserted, and why each one is here
 *
 * Every item is a real failure mode, most of them from 08 §2.7's own list:
 *
 *  1. `capabilities/declared` — a declared dataset must actually work, and an
 *     *un*declared one must **throw**, not return `[]`. A silently-empty dataset
 *     is indistinguishable from "this account holds nothing", which is how a
 *     brokerage drops out of net worth for three weeks.
 *  2. `sync/idempotent` — the same cursor twice is the same page twice.
 *  3. `cursor/monotonic` — a page's `nextCursor` never goes backwards, and the
 *     terminal page does not reset it to `null` (which would mean "no
 *     incremental support", cursor-contract rule 3).
 *  4. `sync/terminates` — `hasMore` reaches `false` in bounded time.
 *  5. `sync/resumable` — stopping at page two and resuming from the last
 *     committed cursor yields the same end state as running straight through.
 *  6. `removed/never-reappears` — an id in `removed[]` is not later re-added by
 *     the same stream.
 *  7. `money/signed-and-denominated` — every amount carries a currency, and the
 *     sign convention holds (negative = outflow).
 *  8. `fingerprint/present` — mandatory on every adapter (08 §2.5).
 *  9. `pending/settles-to-one` — a pending row that posts is expressed as
 *     `removed` + `added` with `pendingTransactionId`, which is what lets the
 *     ledger keep one transaction instead of making two (decision D10).
 * 10. `errors/typed` — every failure path is a `ConnectorError`, never a bare
 *     `Error` the orchestrator would have to classify as `permanent`.
 * 11. `secrets/not-serialisable` — `JSON.stringify(handle)` contains no
 *     credential. P0-12, and the reason `ConnectionHandle.secret` is a closure.
 * 12. `disconnect/revokes` — after `disconnect`, the adapter refuses to sync.
 * 13. `holdings/names a security` — a position identifies what it is a position
 *     *in*, with a kind from `SECURITY_IDENTIFIER_KINDS` and a non-empty value,
 *     and its quantity is a decimal string. WP 3.1: the port has carried
 *     `ProviderHoldingFact` since Phase 1 and asserted nothing about it, so an
 *     adapter could name a security by a bare provider id and nothing noticed.
 * 14. `investment-txns/fingerprinted` — mandatory fingerprint, unique
 *     `providerTransactionId` within one window (there is no cursor to dedupe
 *     with — 01 §5.5), and quantity/price as decimal strings.
 */
import type { Capability } from './capabilities.ts';
import { supports } from './capabilities.ts';
import type {
  ConnectionHandle,
  Connector,
  Cursor,
  SyncOptions,
  TransactionPage,
} from './connector.ts';
import { isConnectorError } from './errors.ts';
import { SECURITY_IDENTIFIER_KINDS, type ProviderTransactionFact } from './facts.ts';

export interface ConformanceCheck {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface ConformanceSubject {
  readonly connector: Connector;
  /** A live handle for a connection with some data behind it. */
  readonly handle: ConnectionHandle;
  readonly options: SyncOptions;
  /**
   * Values that must never appear in a serialised handle: the credentials the
   * adapter was linked with. Empty for an adapter that holds none, and the check
   * then asserts only that the handle carries no `credentials` field at all.
   */
  readonly secrets?: readonly string[];
  /**
   * Produce a fresh, *disconnected* handle so `disconnect/revokes` can run
   * without destroying the subject every other check shares.
   */
  readonly disposable?: () => Promise<{ handle: ConnectionHandle }>;
  /** Ask the adapter to fail. Used by `errors/typed`. */
  readonly provokeFailure?: () => Promise<unknown>;
  /** Bound on pagination, so a broken adapter fails instead of hanging. */
  readonly maxPages?: number;
}

class ConformanceFailure extends Error {
  override readonly name = 'ConformanceFailure';
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ConformanceFailure(message);
}

/** Page through to the end, collecting everything. */
async function drain(
  subject: ConformanceSubject,
  from: Cursor | null = null,
  stopAfter = Number.POSITIVE_INFINITY,
): Promise<{ pages: TransactionPage[]; cursor: Cursor | null }> {
  const limit = subject.maxPages ?? 50;
  const pages: TransactionPage[] = [];
  let cursor = from;

  for (let index = 0; index < limit; index += 1) {
    const page = await subject.connector.syncTransactions(subject.handle, cursor, subject.options);
    pages.push(page);
    cursor = page.nextCursor;
    if (!page.hasMore || pages.length >= stopAfter) return { pages, cursor };
  }
  throw new ConformanceFailure(
    `syncTransactions still reported hasMore after ${limit} pages: pagination does not terminate`,
  );
}

function factsOf(pages: readonly TransactionPage[]): ProviderTransactionFact[] {
  return pages.flatMap((page) => [...page.added, ...page.modified]);
}

function idsOf(pages: readonly TransactionPage[]): string[] {
  return factsOf(pages).map((fact) => fact.providerTransactionId);
}

/** A stable, comparable summary of a page: what `sync/idempotent` compares. */
function shapeOf(page: TransactionPage): string {
  return JSON.stringify({
    added: page.added.map((fact) => [fact.providerTransactionId, fact.amount.minor.toString()]),
    modified: page.modified.map((fact) => [
      fact.providerTransactionId,
      fact.amount.minor.toString(),
    ]),
    removed: page.removed.map((ref) => ref.providerTransactionId),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  });
}

/**
 * Build the check list.
 *
 * Nothing here touches `subject` until a check *runs* — every access is inside a
 * `run` closure. That is what lets a caller enumerate the suite's names with a
 * stub (`connectorConformanceChecks({} as ConformanceSubject)`) in order to
 * register one test case per check before it has an adapter to run them
 * against, which is exactly what the vitest wrapper in `@ctx/connections` does.
 */
export function connectorConformanceChecks(subject: ConformanceSubject): ConformanceCheck[] {
  const connector = (): Connector => subject.connector;
  const capabilitiesOf = (): ReturnType<Connector['capabilities']> =>
    subject.connector.capabilities();

  return [
    {
      name: 'capabilities/declared datasets work and undeclared ones throw',
      run: async () => {
        assert(
          capabilitiesOf().supports.length > 0,
          'an adapter that supports nothing is not an adapter',
        );
        assert(
          supports(capabilitiesOf(), 'transactions'),
          'every adapter in Phase 1 must support transactions',
        );

        await connector().syncTransactions(subject.handle, null, subject.options);

        for (const [capability, method] of [
          ['balances', 'syncBalances'],
          ['holdings', 'syncHoldings'],
          ['investment_txns', 'syncInvestmentTransactions'],
          ['liabilities', 'syncLiabilities'],
        ] as const) {
          const implemented = typeof connector()[method] === 'function';
          const declared = supports(capabilitiesOf(), capability as Capability);

          if (declared) {
            assert(implemented, `${capability} is declared but ${method} is not implemented`);
            continue;
          }
          if (!implemented) continue;

          // Implemented but undeclared: it must refuse, not return nothing.
          let refused = false;
          try {
            await (
              connector()[method] as (h: ConnectionHandle, o: SyncOptions) => Promise<unknown>
            )(subject.handle, subject.options);
          } catch (error) {
            refused = isConnectorError(error);
          }
          assert(
            refused,
            `${method} is implemented but ${capability} is not declared: it must throw a ` +
              'ConnectorError rather than return an empty result, which is indistinguishable ' +
              'from "there is genuinely nothing here"',
          );
        }
      },
    },

    {
      name: 'sync/idempotent: the same cursor twice is the same page twice',
      run: async () => {
        const first = await connector().syncTransactions(subject.handle, null, subject.options);
        const second = await connector().syncTransactions(subject.handle, null, subject.options);
        assert(
          shapeOf(first) === shapeOf(second),
          'replaying a cursor produced a different page; a retry after a failed commit would ' +
            'then diverge from what was rolled back',
        );

        if (first.nextCursor !== null && first.hasMore) {
          const third = await connector().syncTransactions(
            subject.handle,
            first.nextCursor,
            subject.options,
          );
          const fourth = await connector().syncTransactions(
            subject.handle,
            first.nextCursor,
            subject.options,
          );
          assert(shapeOf(third) === shapeOf(fourth), 'replaying a mid-stream cursor diverged');
        }
      },
    },

    {
      name: 'cursor/monotonic and never null mid-stream',
      run: async () => {
        const { pages } = await drain(subject);
        const seen = new Set<string>();
        for (const [index, page] of pages.entries()) {
          if (page.hasMore) {
            assert(
              page.nextCursor !== null,
              `page ${index} says hasMore but returned a null cursor; there is no way to ask ` +
                'for the next one',
            );
          }
          if (page.nextCursor === null) continue;
          assert(
            !seen.has(page.nextCursor) || !page.hasMore,
            `cursor ${page.nextCursor} was returned twice while still paginating: the loop ` +
              'would never terminate',
          );
          seen.add(page.nextCursor);
        }
      },
    },

    {
      name: 'sync/terminates and the terminal page repeats its cursor',
      run: async () => {
        const { pages, cursor } = await drain(subject);
        const last = pages.at(-1);
        assert(last !== undefined, 'draining produced no pages at all');
        assert(!last.hasMore, 'draining stopped while hasMore was still true');

        // One more call at the end must be a no-op that leaves the cursor where
        // it is. A terminal page that reset it to null would tell the
        // orchestrator "this provider has no incremental support" and trigger a
        // full re-pull on every run.
        const after = await connector().syncTransactions(subject.handle, cursor, subject.options);
        assert(!after.hasMore, 'a sync past the end reported more data');
        assert(after.added.length === 0, 'a sync past the end returned new transactions');
        assert(
          after.nextCursor === cursor,
          'a sync past the end moved the cursor; it must stay exactly where it was',
        );
      },
    },

    {
      name: 'sync/resumable: stopping at page two and resuming reaches the same state',
      run: async () => {
        const straight = await drain(subject);
        const partial = await drain(subject, null, 2);
        const resumed = await drain(subject, partial.cursor);

        assert(
          resumed.cursor === straight.cursor,
          'resuming from a committed cursor ended at a different cursor than running straight ' +
            'through: a crash mid-backfill would leave a permanent gap',
        );
        const combined = new Set([...idsOf(partial.pages), ...idsOf(resumed.pages)]);
        for (const id of idsOf(straight.pages)) {
          assert(combined.has(id), `transaction ${id} was lost when the run resumed mid-stream`);
        }
      },
    },

    {
      name: 'removed/never reappears in the same stream',
      run: async () => {
        const { pages } = await drain(subject);
        const removed = new Set<string>();
        for (const page of pages) {
          for (const fact of [...page.added, ...page.modified]) {
            assert(
              !removed.has(fact.providerTransactionId),
              `${fact.providerTransactionId} was removed and then re-added in the same stream; ` +
                'the orchestrator cannot tell which statement is current',
            );
          }
          for (const ref of page.removed) removed.add(ref.providerTransactionId);
        }
      },
    },

    {
      name: 'money/every amount carries a currency and the sign convention holds',
      run: async () => {
        const { pages } = await drain(subject);
        for (const fact of factsOf(pages)) {
          assert(
            typeof fact.amount.currency === 'string' && fact.amount.currency.length === 3,
            `${fact.providerTransactionId} has no ISO currency on its amount`,
          );
          assert(
            typeof fact.amount.minor === 'bigint',
            `${fact.providerTransactionId} carries a non-bigint amount; a float in a ledger is a ` +
              'correctness bug, not a style preference',
          );
          assert(
            fact.isoCurrency === null || fact.isoCurrency.length > 0,
            `${fact.providerTransactionId} has an empty isoCurrency; use null for "not stated"`,
          );
        }
      },
    },

    {
      name: 'fingerprint/present on every transaction',
      run: async () => {
        const { pages } = await drain(subject);
        for (const fact of factsOf(pages)) {
          assert(
            /^[0-9a-f]{64}$/.test(fact.fingerprint),
            `${fact.providerTransactionId} has no sha256 fingerprint; it is mandatory for every ` +
              'adapter, including ones with stable ids (08 §2.5)',
          );
          assert(
            fact.providerAccountId.length > 0,
            `${fact.providerTransactionId} does not say which account it belongs to`,
          );
        }
      },
    },

    {
      name: 'pending/a settled transaction links back to the pending one it replaces',
      run: async () => {
        const { pages } = await drain(subject);
        const facts = factsOf(pages);
        const byId = new Map(facts.map((fact) => [fact.providerTransactionId, fact]));

        for (const fact of facts) {
          if (fact.pendingTransactionId === null) continue;
          assert(
            !fact.pending,
            `${fact.providerTransactionId} is pending and also claims to replace a pending ` +
              'transaction; one of the two is wrong',
          );
          const predecessor = byId.get(fact.pendingTransactionId);
          // The predecessor may legitimately predate this stream — it was sent
          // in an earlier sync. But if it *is* here, it must have been pending.
          if (predecessor === undefined) continue;
          assert(
            predecessor.pending,
            `${fact.providerTransactionId} claims to replace ${fact.pendingTransactionId}, which ` +
              'was never pending',
          );
        }
      },
    },

    {
      // WP 3.1. The investments datasets were on the port from Phase 1 but
      // nothing asserted anything about their contents, so an adapter could
      // return a position naming a security by a bare provider id and no check
      // would notice — which is exactly how one asset becomes two `securities`
      // rows, allocation double-counts it, and TWR is wrong for both halves.
      name: 'holdings/every position names a security and carries a decimal quantity',
      run: async () => {
        if (!supports(capabilitiesOf(), 'holdings')) return;
        const syncHoldings = connector().syncHoldings;
        assert(
          syncHoldings !== undefined,
          'holdings is declared but syncHoldings is not implemented',
        );

        const holdings = await syncHoldings.call(connector(), subject.handle, subject.options);
        for (const holding of holdings) {
          assert(
            holding.providerAccountId.length > 0,
            'a holding does not say which account it belongs to',
          );
          assert(
            SECURITY_IDENTIFIER_KINDS.includes(holding.security.kind),
            `a holding names its security with an unknown identifier kind ` +
              `'${String(holding.security.kind)}'`,
          );
          assert(
            holding.security.value.trim().length > 0,
            'a holding carries an empty security identifier value',
          );
          assert(
            holding.security.kind !== 'chain_contract' || holding.security.chain !== null,
            'a holding names a chain_contract with no chain; a contract address without its ' +
              'chain is not an identifier — the same address exists on every EVM network',
          );
          // A float here is the D3 failure the whole quantity type exists to
          // prevent: 18-decimal tokens do not survive IEEE-754, and the error
          // compounds the moment quantity is multiplied by a price and summed.
          assert(
            typeof holding.quantity === 'string' && /^-?\d+(\.\d+)?$/.test(holding.quantity),
            `a holding carries a non-decimal-string quantity (${String(holding.quantity)}); ` +
              'Quantity is a decimal string, never a number',
          );
          assert(
            typeof holding.value.minor === 'bigint' && holding.value.currency.length === 3,
            'a holding carries a value that is not a (bigint minor, ISO currency) pair',
          );
        }
      },
    },

    {
      name: 'investment-txns/every fact is fingerprinted and never floats a price',
      run: async () => {
        if (!supports(capabilitiesOf(), 'investment_txns')) return;
        const syncInvestments = connector().syncInvestmentTransactions;
        assert(
          syncInvestments !== undefined,
          'investment_txns is declared but syncInvestmentTransactions is not implemented',
        );

        const facts = await syncInvestments.call(connector(), subject.handle, subject.options);
        const ids = new Set<string>();
        for (const fact of facts) {
          assert(
            /^[0-9a-f]{64}$/.test(fact.fingerprint),
            `${fact.providerTransactionId} has no sha256 fingerprint; it is mandatory for every ` +
              'adapter, including ones with stable ids (08 §2.5)',
          );
          // 01 §5.5: there is no `/investments/transactions/sync`, so the only
          // thing standing between a re-run of the same date window and a
          // duplicated position is this id being unique and stable.
          assert(
            !ids.has(fact.providerTransactionId),
            `${fact.providerTransactionId} appeared twice in one window; it is the upsert key`,
          );
          ids.add(fact.providerTransactionId);
          assert(
            typeof fact.quantity === 'string' && typeof fact.price === 'string',
            `${fact.providerTransactionId} carries a numeric quantity or price; both are decimal ` +
              'strings, and a float price times a float quantity is how cost basis drifts',
          );
          assert(
            typeof fact.amount.minor === 'bigint' && fact.amount.currency.length === 3,
            `${fact.providerTransactionId} carries an amount that is not a Money pair`,
          );
          assert(
            fact.security === null || fact.security.value.trim().length > 0,
            `${fact.providerTransactionId} names a security with an empty value; use null for ` +
              '"this transaction has no security", which a cash sweep or a fee genuinely has not',
          );
        }
      },
    },

    {
      name: 'errors/every failure is a typed ConnectorError',
      run: async () => {
        // A cursor the adapter did not issue. Every adapter must reject it as a
        // typed error rather than crash or, worse, silently start from scratch.
        let thrown: unknown;
        try {
          await connector().syncTransactions(
            subject.handle,
            'not-a-cursor-this-adapter-ever-issued' as Cursor,
            subject.options,
          );
        } catch (error) {
          thrown = error;
        }
        if (thrown !== undefined) {
          assert(
            isConnectorError(thrown),
            'a bad cursor produced an untyped error; the orchestrator would classify it as ' +
              '`permanent` and stop syncing a healthy connection',
          );
        }

        let connectThrown: unknown;
        try {
          await connector().connect({ nonsense: true });
        } catch (error) {
          connectThrown = error;
        }
        assert(connectThrown !== undefined, 'connect() accepted obvious nonsense');
        assert(
          isConnectorError(connectThrown),
          'connect() rejected bad input with an untyped error',
        );
        assert(
          isConnectorError(connectThrown) && connectThrown.kind === 'invalid_input',
          'bad link input must be `invalid_input`: it is not retryable and the user must fix it',
        );

        if (subject.provokeFailure !== undefined) {
          let provoked: unknown;
          try {
            await subject.provokeFailure();
          } catch (error) {
            provoked = error;
          }
          assert(provoked !== undefined, 'provokeFailure() did not fail');
          assert(isConnectorError(provoked), 'the provoked failure was not a ConnectorError');
        }
      },
    },

    {
      name: 'secrets/a serialised handle contains no credential',
      // `async` even though nothing is awaited: every check must fail by
      // *rejecting*, not by throwing synchronously, or a caller that wraps
      // `run()` in a promise assertion never sees the failure.
      run: async () => {
        const serialised = JSON.stringify(subject.handle);
        for (const secret of subject.secrets ?? []) {
          assert(
            !serialised.includes(secret),
            'a credential survived JSON.stringify of the connection handle; it would reach the ' +
              'first log line that serialises context (P0-12)',
          );
        }
        assert(
          !/\bcredential|token|secret\s*"?\s*:/i.test(serialised),
          'the handle exposes a credential-shaped field; `secret` must be a function, not data',
        );
      },
    },

    {
      name: 'disconnect/revokes: a disconnected connection refuses to sync',
      run: async () => {
        if (subject.disposable === undefined) return;
        const { handle } = await subject.disposable();
        await connector().disconnect(handle);

        let thrown: unknown;
        try {
          await connector().syncTransactions(handle, null, subject.options);
        } catch (error) {
          thrown = error;
        }
        assert(
          thrown !== undefined,
          'a disconnected connection still returned data; revocation must be observable',
        );
        assert(
          isConnectorError(thrown),
          'syncing a disconnected connection threw an untyped error',
        );
      },
    },
  ];
}
