// SPDX-License-Identifier: MIT
/**
 * How this context reads the ledger: a port, not an import.
 *
 * `personalfi/layer-imports` forbids one context importing another, and
 * docs/CONVENTIONS.md gives the remedy in one line — "where a cycle seems
 * necessary, the answer is a domain event, not an import". Recurring needs both
 * halves of that: it *reacts* to `ledger.TransactionsUpserted` (an event, via
 * the pump) and it *reads* the transactions that event named, which the payload
 * deliberately does not carry.
 *
 * So the read is a port. This file declares the shape; `apps/api/src/domain.ts`
 * — the composition root, the only layer allowed to wire things together —
 * supplies the adapter over `@ctx/ledger`'s `listTransactions` and
 * `listForCategorization`. Three things fall out of that, and all three are
 * worth the indirection:
 *
 *   * the boundary lint stays intact and stays *meaningful*: no exception was
 *     carved for this context;
 *   * every test here runs against `inMemoryLedgerPort` below, so the
 *     lifecycle, forecast and idempotence proofs measure this context and not
 *     `@ctx/ledger`'s query planner;
 *   * the day a transaction can come from somewhere other than `@ctx/ledger` —
 *     a CSV preview that shows what *would* be detected before importing — the
 *     pipeline already works on it.
 *
 * ## The port is read-only, and unusually strictly so
 *
 * `@ctx/categorization`'s `LedgerPort` has one write (`writeRuleCategory`).
 * This one has none, and that is a security property rather than an omission:
 * decision D25 says a `merchants` row means "a payee was involved", and the
 * control that keeps detection from minting them is that there is no way to
 * ask. A port with a write method is a port somebody can be tempted to widen;
 * `test/db/no-merchant-creation.test.ts` asserts the outcome (row count **and**
 * ids unchanged after a full pass) and the schema-ownership check asserts the
 * mechanism (no non-test file under this package may name `merchants` in SQL).
 *
 * ## What the rows carry, and what they must not
 *
 * `RecurringTransaction` is `@ctx/recurring`'s own shape and maps 1:1 onto the
 * engine's `RecurringInput`. It carries a `merchantId` and **no descriptor, no
 * payee, no merchant name** — WP 2.2's `no-merchant-writes.test.ts` runs the
 * whole engine behind a `Proxy` that throws on any key outside that contract,
 * with `descriptor`/`payee`/`merchantName` physically present as decoys, so a
 * field added here that carried payee text would fail a test that already
 * exists.
 */
import type { DateOnly, Money } from '@core/kernel';

/** Everything detection is allowed to see about a transaction. */
export interface RecurringTransaction {
  readonly id: string;
  readonly accountId: string;
  /**
   * D25 merchant identity, or `null` when the gate refused it (`empty`,
   * `too_few_letters`, `self_transfer`, `bank_operation`). A `null` row is
   * dropped before the engine sees it: a recurring series with no payee is not
   * a thing this context can express.
   */
  readonly merchantId: string | null;
  /** House sign convention: negative = outflow, positive = inflow. */
  readonly amount: Money;
  /** The ledger's budget date — a calendar date, never an instant. */
  readonly date: DateOnly;
  /**
   * Pending rows are dropped by the engine, not modelled: a pending charge
   * becomes a posted charge with its own row within days, and counting both
   * puts a phantom occurrence into every young stream.
   */
  readonly pending: boolean;
  /** A paired internal transfer is regular, fixed, monthly — and not a subscription. */
  readonly isTransfer: boolean;
}

export interface ListForRecurringInput {
  readonly userId: string;
  /** Scope to these payees. What the consumer passes: only touched merchants. */
  readonly merchantIds?: readonly string[];
  readonly accountIds?: readonly string[];
  readonly dateFrom?: DateOnly;
  readonly dateTo?: DateOnly;
  /** Opaque, straight from `@ctx/ledger`'s keyset pagination. */
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface RecurringTransactionPage {
  readonly items: readonly RecurringTransaction[];
  readonly nextCursor: string | null;
}

export interface LedgerPort {
  /**
   * The window a detection pass runs over.
   *
   * Ordering is not part of the contract: the engine sorts its own inputs and
   * `grouping.test.ts` asserts detection is independent of input order.
   */
  listForRecurring(input: ListForRecurringInput): Promise<RecurringTransactionPage>;
  /**
   * The distinct merchants behind a set of transaction ids.
   *
   * The consumer's whole scoping strategy: an event names transactions, and
   * re-running detection for *every* payee on every sync page would be a full
   * table scan per page. Ids whose merchant identity was refused contribute
   * nothing, which is why the return type is not the same length as the input.
   */
  merchantsOf(input: {
    readonly userId: string;
    readonly transactionIds: readonly string[];
  }): Promise<readonly string[]>;
}

/** Walk every page. Detection needs the whole window, not one page of it. */
export async function collectForRecurring(
  port: LedgerPort,
  input: ListForRecurringInput,
  pageSize = 500,
): Promise<RecurringTransaction[]> {
  const items: RecurringTransaction[] = [];
  let cursor: string | null = input.cursor ?? null;
  do {
    // Spread-then-override would carry an explicit `undefined` into every
    // optional field, which `exactOptionalPropertyTypes` correctly rejects: a
    // property that is present and undefined is not the same as an absent one.
    const page: RecurringTransactionPage = await port.listForRecurring({
      userId: input.userId,
      ...(input.merchantIds === undefined ? {} : { merchantIds: input.merchantIds }),
      ...(input.accountIds === undefined ? {} : { accountIds: input.accountIds }),
      ...(input.dateFrom === undefined ? {} : { dateFrom: input.dateFrom }),
      ...(input.dateTo === undefined ? {} : { dateTo: input.dateTo }),
      cursor,
      limit: pageSize,
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}

/**
 * An in-memory `LedgerPort` over a fixed list of rows.
 *
 * Not a mock: it is a real implementation of the contract, including the
 * pagination the database adapter has, so a test that pages gets paged. Used by
 * every suite in this package — the database tests included, because the
 * properties they assert ("a confirmed series survives", "replaying produces
 * identical rows", "merchants is unchanged") are properties of *this* context's
 * writes, and putting `@ctx/ledger`'s reader in the loop would only add a
 * second thing that can fail.
 */
export function inMemoryLedgerPort(rows: readonly RecurringTransaction[]): LedgerPort {
  const all = [...rows];
  return {
    listForRecurring(input) {
      const merchantFilter =
        input.merchantIds === undefined ? null : new Set<string>(input.merchantIds);
      const accountFilter =
        input.accountIds === undefined ? null : new Set<string>(input.accountIds);
      const matching = all.filter((row) => {
        if (merchantFilter !== null && (row.merchantId === null || !merchantFilter.has(row.merchantId)))
          return false;
        if (accountFilter !== null && !accountFilter.has(row.accountId)) return false;
        if (input.dateFrom !== undefined && row.date < input.dateFrom) return false;
        if (input.dateTo !== undefined && row.date > input.dateTo) return false;
        return true;
      });
      // Sorted by (date, id) so the cursor below is a stable position and not a
      // promise the underlying array happens to keep.
      matching.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? -1 : 1));

      const limit = Math.max(1, input.limit ?? 500);
      const offset = input.cursor === null || input.cursor === undefined ? 0 : Number(input.cursor);
      const page = matching.slice(offset, offset + limit);
      const next = offset + limit < matching.length ? String(offset + limit) : null;
      return Promise.resolve({ items: page, nextCursor: next });
    },
    merchantsOf(input) {
      const wanted = new Set<string>(input.transactionIds);
      const merchants = new Set<string>();
      for (const row of all) {
        if (wanted.has(row.id) && row.merchantId !== null) merchants.add(row.merchantId);
      }
      return Promise.resolve([...merchants].sort());
    },
  };
}
