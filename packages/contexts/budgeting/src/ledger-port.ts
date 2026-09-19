// SPDX-License-Identifier: MIT
/**
 * How this context reads the ledger: a port, not an import.
 *
 * `personalfi/layer-imports` forbids one context importing another, and
 * docs/CONVENTIONS.md gives the remedy in one line — "where a cycle seems
 * necessary, the answer is a domain event, not an import". Budgeting needs both
 * halves of that. It *reacts* to `ledger.TransactionsUpserted` and four other
 * event types through the pump, and it *reads* the rows those events named,
 * which an event payload deliberately does not carry (`@ctx/ledger`'s
 * `events.ts`: "payloads are ids and counts, never rows").
 *
 * So the read is a port. This file declares the shape;
 * `apps/api/src/domain.ts`, the composition root and the only layer allowed to
 * wire contexts together, supplies the adapter over `listTransactions` and
 * `listAccounts`. The exact lines to add are in
 * `docs/evidence/phase-2/wp2.1-budgeting.md` §7.
 *
 * The port is **read-only**. Budgeting writes its own six tables and its own
 * events and never touches the ledger's — unlike `@ctx/categorization`, whose
 * port has one write path into `transactions.rule_category_id`, there is no
 * column in `@ctx/ledger` that budgeting is the producer of.
 *
 * ## What the shape has to carry, and why each field is load-bearing
 *
 * The v0.8 rung is "budgets exclude transfers and net refunds". Both exclusions
 * are decided *here*, at the port boundary, from facts only the ledger has:
 *
 *   * `transferLinkId` — a paired internal movement contributes zero activity.
 *     Not "roughly zero": both legs are dropped, so the two do not have to
 *     cancel to the cent across a pair that the FX rate moved. 07 §1.3 line 120
 *     wants exactly this for a card payment ("balances move naturally via the
 *     transfer; no category activity").
 *   * `refundOfId` — a refund is *netted against its original*, which is a
 *     different operation from being excluded. A $40 refund of a $100 purchase
 *     leaves $60 of activity in the envelope, not $0 and not $100.
 *   * `funding` — 07 §1.3's whole distinction is "which asset actually moved",
 *     and only the ledger knows the account type. Deriving it in the consumer
 *     from a name or a subtype string would put that decision in two places.
 *
 * ## A field `@ctx/ledger` does not have yet: `budgetDate`
 *
 * 07 §1.4 wants three dates — `authorized_date`, `posted_date` and a
 * user-overridable `budget_date` that "all budget period assignment" uses.
 * `@ctx/ledger`'s `transactions` has no `budget_date` column and no overlay
 * field for one (migration `0004_ledger.sql`; `OverlayPatch` in
 * `packages/contexts/ledger/src/overlay.ts`). The port therefore declares
 * `budgetDate` as the concept and the adapter maps it to the ledger's resolved
 * `effective.date`, which already implements the *default* half of §1.4 rule 1
 * (authorized, falling back to posted). What is missing is only the user's
 * ability to override it. Reported as an open item in the evidence note rather
 * than worked around: adding a column to another context's table from here is
 * the exact thing schema ownership exists to prevent.
 */
import { Money, type DateOnly, type Money as MoneyType } from '@core/kernel';
import type { FundingSource } from './envelope.ts';

/** How an account participates in a budget. Derived by the adapter from type. */
export type AccountRole = 'CASH' | 'CREDIT' | 'OFF_BUDGET';

export interface BudgetAccount {
  readonly id: string;
  /** `depository` | `credit` | `loan` | `investment` | `crypto` | `manual`. */
  readonly type: string;
  readonly role: AccountRole;
  /**
   * 07 §1.4 rule 3's `working_balance` — every observation, pending included —
   * in house sign convention: a card you owe $50 on is `-5000`.
   *
   * Null for an account that has never reported one. A null is not a zero: a
   * budget whose identity silently treats an unreported account as empty is a
   * budget that will be wrong by the size of that account and say nothing.
   */
  readonly workingBalance: MoneyType | null;
  readonly closed: boolean;
}

/** One ledger row, reduced to what the envelope math is allowed to see. */
export interface BudgetTransaction {
  readonly id: string;
  readonly accountId: string;
  /** See the header: `effective.date` today, a real `budget_date` eventually. */
  readonly budgetDate: DateOnly;
  /** Signed. Negative = outflow. */
  readonly amount: MoneyType;
  /** The *effective* category — user overlay, then rule, then provider. */
  readonly categoryId: string | null;
  readonly funding: FundingSource;
  /** Non-null when this row is one leg of a paired internal transfer. */
  readonly transferLinkId: string | null;
  /** True when `@ctx/ledger` has flagged it a transfer at all, paired or not. */
  readonly isTransfer: boolean;
  /** The purchase this reverses, when the ledger has hinted one. */
  readonly refundOfId: string | null;
  /** The user excluded this row from totals. */
  readonly excluded: boolean;
}

export interface ListForBudgetInput {
  readonly userId: string;
  /** Half-open, to match the period grid: `dateFrom <= budgetDate < dateTo`. */
  readonly dateFrom: DateOnly;
  readonly dateTo: DateOnly;
  readonly accountIds?: readonly string[];
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface BudgetTransactionPage {
  readonly items: readonly BudgetTransaction[];
  readonly nextCursor: string | null;
}

export interface LedgerPort {
  /**
   * Every row whose `budgetDate` falls in `[dateFrom, dateTo)`, transfers and
   * refunds **included** — the exclusion and the netting are this context's
   * decisions (`src/actuals.ts`), not the adapter's, so that one rule is applied
   * in one place and the counts of what was dropped are observable.
   */
  listForBudget(input: ListForBudgetInput): Promise<BudgetTransactionPage>;
  /** On-budget accounts and their working balances. The right-hand side of identity I. */
  listBudgetAccounts(input: {
    readonly userId: string;
  }): Promise<readonly BudgetAccount[]>;
}

/** Walk every page. Every caller here wants the whole window. */
export async function* streamForBudget(
  port: LedgerPort,
  input: ListForBudgetInput,
  pageSize = 500,
): AsyncGenerator<BudgetTransaction> {
  let cursor: string | null = input.cursor ?? null;
  do {
    // Spread-then-override would carry an explicit `undefined` into the optional
    // fields, which `exactOptionalPropertyTypes` rightly refuses: a property
    // that is present and undefined is not the same as an absent one, and an
    // adapter is entitled to tell them apart.
    const page: BudgetTransactionPage = await port.listForBudget({
      userId: input.userId,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      ...(input.accountIds === undefined ? {} : { accountIds: input.accountIds }),
      cursor,
      limit: pageSize,
    });
    for (const item of page.items) yield item;
    cursor = page.nextCursor;
  } while (cursor !== null);
}

// ---------------------------------------------------------------------------
// The in-memory implementation
// ---------------------------------------------------------------------------

/**
 * A `LedgerPort` over plain arrays.
 *
 * Exported from the package's public surface rather than hidden in `test/` on
 * purpose. Three callers want it and all three are better off with one copy: the
 * pure suites here, which measure the envelope math with no Postgres in the
 * loop; `test/db/`, which pairs it with a real database for the persistence
 * claims; and the Phase 2 gate, whose standard is that an independent reviewer
 * re-runs the load-bearing proofs — a fake they have to re-implement is a fake
 * that will differ from this one in the direction that makes the proof pass.
 *
 * It is a fake, not a mock: it answers from data, has no expectations, and
 * cannot be "verified". The one behaviour it models deliberately is paging, so
 * that `streamForBudget`'s cursor loop is exercised rather than trivially
 * satisfied by a single page.
 */
export interface FakeLedger {
  readonly port: LedgerPort;
  addAccount(account: BudgetAccount): void;
  addTransaction(transaction: BudgetTransaction): void;
  /** Move a balance, the way a sync would. Keeps identity I honest in tests. */
  setBalance(accountId: string, balance: MoneyType): void;
  accounts(): readonly BudgetAccount[];
  transactions(): readonly BudgetTransaction[];
}

export function createFakeLedger(options: { readonly pageSize?: number } = {}): FakeLedger {
  const accounts = new Map<string, BudgetAccount>();
  const transactions: BudgetTransaction[] = [];
  const pageSize = options.pageSize ?? 500;

  const port: LedgerPort = {
    listForBudget(input) {
      const offset = input.cursor === null || input.cursor === undefined ? 0 : Number(input.cursor);
      const matching = transactions
        .filter(
          (row) =>
            row.budgetDate >= input.dateFrom &&
            row.budgetDate < input.dateTo &&
            (input.accountIds === undefined || input.accountIds.includes(row.accountId)),
        )
        // Lexicographic on `YYYY-MM-DD` is chronological, which is half of why
        // `DateOnly` is an ISO string; `id` breaks the tie so a page boundary
        // cannot reorder two same-day rows between two calls.
        .sort((a, b) => (a.budgetDate === b.budgetDate ? a.id.localeCompare(b.id) : a.budgetDate < b.budgetDate ? -1 : 1));
      const limit = Math.min(input.limit ?? pageSize, pageSize);
      const items = matching.slice(offset, offset + limit);
      const next = offset + limit;
      return Promise.resolve({
        items,
        nextCursor: next < matching.length ? String(next) : null,
      });
    },
    listBudgetAccounts() {
      return Promise.resolve([...accounts.values()].filter((account) => !account.closed));
    },
  };

  return {
    port,
    addAccount(account) {
      accounts.set(account.id, account);
    },
    addTransaction(transaction) {
      transactions.push(transaction);
    },
    setBalance(accountId, balance) {
      const existing = accounts.get(accountId);
      if (existing === undefined) throw new Error(`no fake account ${accountId}`);
      accounts.set(accountId, { ...existing, workingBalance: balance });
    },
    accounts: () => [...accounts.values()],
    transactions: () => [...transactions],
  };
}

/**
 * The sum identity I's right-hand side needs: on-budget working balances.
 *
 * Off-budget accounts are dropped and a never-reported balance contributes
 * nothing — but the caller is given `unreported` so it can say so rather than
 * quietly producing a number that is wrong by an unknown amount.
 */
export function onBudgetBalances(
  accounts: readonly BudgetAccount[],
  currency: string,
): { readonly balances: readonly MoneyType[]; readonly unreported: readonly string[] } {
  const balances: MoneyType[] = [];
  const unreported: string[] = [];
  for (const account of accounts) {
    if (account.role === 'OFF_BUDGET' || account.closed) continue;
    if (account.workingBalance === null) {
      unreported.push(account.id);
      continue;
    }
    balances.push(account.workingBalance);
  }
  return { balances: balances.length === 0 ? [Money.zero(currency)] : balances, unreported };
}
