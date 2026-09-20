// SPDX-License-Identifier: MIT
/**
 * The composition root's domain wiring: Ledger and Connections, joined up.
 *
 * `apps/` is the only layer allowed to do this. `@ctx/connections` declares the
 * three ledger functions it needs as a *port* (`LedgerWriter`) because
 * `personalfi/layer-imports` denies `@ctx/*` → `@ctx/*` unconditionally, and the
 * port's own doc comment names this file as where the real implementations get
 * passed in.
 *
 * ## `ledgerWriter` is the type check
 *
 * The three properties below are bare references to `@ctx/ledger`'s exports, not
 * adapter functions. That is deliberate and it is the entire safety mechanism:
 * the day the ledger changes `applyProviderTransactions`'s signature,
 * `pnpm typecheck` fails *here*, in the eleven lines that assert the two halves
 * still fit. WP 1.2's evidence note lists this as its one deferred item —
 * "nothing in `@ctx/connections`'s own test suite can prove the shapes still
 * match" — and this is the thing that closes it.
 *
 * ## Process-local adapters, and their durable staging (decision D-5)
 *
 * `ManualConnector` and `CsvImportConnector` each keep a fast, in-process
 * buffer (`ManualStore`, `CsvImportConnector`'s own `#staged`) as their
 * primary read/write path — `connect()` and `addFile()` still write to it
 * synchronously, unchanged from WP 1.2. `attachDurableStaging` below (called
 * from `createDomainRuntime`, the one function every call site — `app.ts`,
 * `worker.ts`, and every test that builds a runtime — already calls with a
 * `database` and the `registry` it built) points both at `@ctx/connections`'s
 * durable `connection_staged_facts` table (migration
 * `0008_connections_staging.sql`), which every subsequent call that carries a
 * `ConnectionHandle` (`listAccounts`, `syncTransactions`, `syncBalances`)
 * reads from and writes to, so that a *different* process — the worker, or
 * the api after a restart — can pick up exactly where the process that
 * staged the rows left off. It is attached here, rather than inside
 * `createConnectorRegistry`, specifically so that `app.ts` and `worker.ts`
 * need no change: both already call `createConnectorRegistry()` with no
 * database (it has none to give at that point — see `app.ts`'s "constructed,
 * not initialised" note) and both already call `createDomainRuntime({
 * database, registry, … })` once the database is available. `SeedConnector`
 * is deliberately excluded: it is a demo fixture with no user data to
 * protect, and its rows are meant to be regenerable, not durable.
 *
 * `PROCESS_LOCAL_PROVIDERS` still exists, but now controls exactly one thing:
 * whether `apps/api/src/routes/connections.ts` runs a user-triggered sync
 * *inline* (immediate feedback in the HTTP response, and the only way
 * `POST /imports/csv` can return `staged`/`skipped` counts in the same
 * response) or *enqueues* it for the worker. That used to be load-bearing for
 * correctness — a job enqueued for one of these providers landed on the
 * worker's own, unrelated in-memory store and produced a successful sync of
 * nothing (gate-security-review.md §8.6 N-7). Now that both stores are
 * durable, it is purely a UX choice: the worker *can* sync a Manual or CSV
 * connection correctly, which is why `apps/api/src/modules.ts`'s nightly
 * fan-out no longer filters by this set (re-gated below).
 */
import { CSV_MANIFEST, CsvImportConnector, IMPORT_PROVIDER } from '@connector/csv';
import {
  MANUAL_MANIFEST,
  MANUAL_PROVIDER,
  ManualConnector,
  ManualStore,
  SEED_PROVIDER,
} from '@connector/manual';
import {
  createPlaidApi,
  PLAID_MANIFEST,
  PLAID_PROVIDER,
  PlaidConnector,
  type PlaidLinkSettings,
} from '@connector/plaid';
import type { AppConfig, PlaidConfig } from '@core/config';
import type { Database } from '@core/db';
import { DateOnly, Money, systemClock, type Clock } from '@core/kernel';
import type { PlatformLogger } from '@core/platform';
import type { SecretBox } from '@core/secretbox';
import {
  ConnectorRegistry,
  SyncOrchestrator,
  createCsvStagingStore,
  createManualStagingStore,
  type LedgerWriter,
  type RegisteredConnector,
} from '@ctx/connections';
import { listCategories, type LedgerPort } from '@ctx/categorization';
import {
  getPeriod,
  listBudgets,
  listPeriods,
  type BudgetingDatabase,
  type LedgerPort as BudgetingLedgerPort,
} from '@ctx/budgeting';
import type {
  BudgetPort as InsightsBudgetPort,
  CashAccountType,
  InsightsAccount,
  InsightsBudgetLine,
  InsightsBudgetPeriod,
  InsightsRecurringStream,
  InsightsTransaction,
  LedgerPort as InsightsLedgerPort,
  MonthlyCashflowRow,
  RecurringPort as InsightsRecurringPort,
} from '@ctx/insights';
import {
  createEgressPolicy,
  createNtfyChannel,
  createSmtpChannel,
  type ChannelRegistry,
  type EgressPolicy,
} from '@ctx/notifications';
import {
  listSeries,
  periodsPerYear,
  type Cadence,
  type LedgerPort as RecurringLedgerPort,
  type RecurringDatabase,
} from '@ctx/recurring';
import {
  applyProviderTransactions,
  listAccounts,
  listForCategorization,
  listTransactions,
  netWorthNow,
  recordBalance,
  setRuleCategory,
  upsertAccount,
  type AccountSummary,
  type LedgerDatabase,
} from '@ctx/ledger';

/**
 * `@ctx/ledger`, as `@ctx/connections` asked for it.
 *
 * Three references and no adapter functions. If this stops compiling, the port
 * and the system of record have drifted and one of them is wrong.
 */
export const ledgerWriter: LedgerWriter = {
  applyProviderTransactions,
  upsertAccount,
  recordBalance,
};

/**
 * `@ctx/categorization`'s `LedgerPort`, for real.
 *
 * Unlike `ledgerWriter` above, this is a genuine adapter rather than bare
 * function references, and has to be: `@ctx/categorization`'s
 * `CategorizableTransaction` and `@ctx/ledger`'s `listForCategorization` row are
 * deliberately two different types (`@ctx/ledger` cannot import the other
 * context's type without importing the other context, which is exactly what
 * this port exists to avoid — decision D8), so something has to translate
 * between them, and this file — the composition root — is the only layer
 * allowed to.
 *
 * `writeRuleCategory` is the one write `@ctx/categorization` makes into another
 * context's table, and it is routed through `setRuleCategory` — the one ledger
 * function that touches `rule_category_id` and nothing else (wp1.4 evidence §6).
 * It is deliberately not routed through the categorization write's own
 * transaction: the two contexts do not share one, by design, the same way
 * `ledgerWriter`'s three functions each open their own.
 */
export function createCategorizationLedgerPort(database: LedgerDatabase, clock: Clock): LedgerPort {
  return {
    async listForCategorization(input) {
      const page = await listForCategorization(database, {
        userId: input.userId,
        filters: {
          ...(input.transactionIds === undefined ? {} : { transactionIds: input.transactionIds }),
          ...(input.accountIds === undefined ? {} : { accountIds: input.accountIds }),
          ...(input.dateFrom === undefined ? {} : { dateFrom: input.dateFrom }),
          ...(input.dateTo === undefined ? {} : { dateTo: input.dateTo }),
        },
        cursor: input.cursor ?? null,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return {
        items: page.items.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          accountType: row.accountType,
          payee: row.payee,
          rawDescriptor: row.rawDescriptor,
          providerMerchantName: row.providerMerchantName,
          merchantId: row.merchantId,
          amountMinor: row.amount.minor,
          currency: row.amount.currency,
          date: row.date,
          providerCategory: row.providerCategory,
          // No provider or import path populates an MCC yet (wp1.4 evidence §8,
          // "MCC tier"); @ctx/ledger has no column to read one from.
          mcc: null,
          isTransfer: row.isTransfer,
          userCategoryId: row.userCategoryId,
        })),
        nextCursor: page.nextCursor,
      };
    },
    async writeRuleCategory(input) {
      await database.transaction(async (tx) =>
        setRuleCategory(
          tx,
          {
            userId: input.userId,
            transactionId: input.transactionId,
            ruleCategoryId: input.ruleCategoryId,
          },
          { clock, correlationId: input.correlationId, causationId: input.causationId ?? null },
        ),
      );
    },
  };
}

/**
 * `@ctx/budgeting`'s read-only view of the ledger.
 *
 * Read-only in the strong sense: unlike the categorization port, there is no
 * column in `@ctx/ledger` that budgeting is the producer of. Lines to add per
 * `docs/evidence/phase-2/wp2.1-budgeting.md` §10, verified against the current
 * `@ctx/ledger` surface rather than assumed.
 */
export function createBudgetingLedgerPort(database: LedgerDatabase): BudgetingLedgerPort {
  // `AccountType` is not on `@ctx/ledger`'s public surface — only
  // `schema/index.ts` exports it — so the summary's own field type is used.
  const roleOf = (type: AccountSummary['type']): 'CASH' | 'CREDIT' | 'OFF_BUDGET' => {
    if (type === 'credit') return 'CREDIT';
    if (type === 'depository' || type === 'manual') return 'CASH';
    // loan / investment / crypto: in net worth, not in the envelope budget.
    return 'OFF_BUDGET';
  };

  const accountsOf = (userId: string) =>
    // `includeClosed` on purpose: `listAccounts` defaults to `closed_at IS NULL`,
    // so without it a closed account can never be reported as `closed: true`,
    // and a card closed mid-period would silently vanish from identity II.
    listAccounts(database, { userId, includeClosed: true });

  return {
    async listForBudget(input) {
      // `LedgerTransaction` carries no account type, so the map is the only way
      // to answer 07 §1.3's "which asset actually moved".
      const accounts = await accountsOf(input.userId);
      const typeOf = new Map(accounts.map((account) => [account.id, account.type] as const));

      const page = await listTransactions(database, {
        userId: input.userId,
        filters: {
          ...(input.accountIds === undefined ? {} : { accountIds: input.accountIds }),
          dateFrom: input.dateFrom,
          // The budget grid is half-open and `listTransactions` applies `dateTo`
          // inclusively (`read.ts:167`), so the last day is stepped back one.
          dateTo: DateOnly.addDays(input.dateTo, -1),
          // A superseded cross-provider duplicate would otherwise be counted
          // twice in every envelope. `sumTransactions` (`read.ts:576`) sets the
          // same default for its own totals.
          includeDuplicates: false,
          // `excluded` and `transfers` are deliberately left unset. The port
          // contract is that both are *returned with their flags* and
          // `src/actuals.ts` decides — one rule in one place, and the counts of
          // what was dropped stay observable.
        },
        cursor: input.cursor ?? null,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });

      return {
        items: page.items.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          budgetDate: row.effective.date,
          amount: row.effective.amount,
          categoryId: row.effective.categoryId,
          funding: typeOf.get(row.accountId) === 'credit' ? 'CREDIT' : 'CASH',
          transferLinkId: row.transferLinkId,
          isTransfer: row.isTransfer,
          refundOfId: row.refundOfId,
          excluded: row.effective.excluded,
        })),
        nextCursor: page.nextCursor,
      };
    },

    async listBudgetAccounts(input) {
      const accounts = await accountsOf(input.userId);
      return accounts.map((account) => ({
        id: account.id,
        type: account.type,
        role: roleOf(account.type),
        // 07 §1.4 rule 3's `working_balance`, approximated — see the open item.
        workingBalance: account.balance?.current ?? null,
        closed: account.closedAt !== null,
      }));
    },
  };
}

/**
 * `@ctx/recurring`'s read-only view of the ledger.
 *
 * Two properties are deliberate. There is no write method — not "no write we
 * use", none to call, which is the mechanism behind D25 rather than a
 * convention. And no field carries payee text: no descriptor, no payee, no
 * merchant name. Lines to add per
 * `docs/evidence/phase-2/wp2.3-recurring.md` §6.
 */
export function createRecurringLedgerPort(database: LedgerDatabase): RecurringLedgerPort {
  return {
    async listForRecurring(input) {
      const page = await listTransactions(database, {
        userId: input.userId,
        filters: {
          ...(input.merchantIds === undefined ? {} : { merchantIds: input.merchantIds }),
          ...(input.accountIds === undefined ? {} : { accountIds: input.accountIds }),
          ...(input.dateFrom === undefined ? {} : { dateFrom: input.dateFrom }),
          ...(input.dateTo === undefined ? {} : { dateTo: input.dateTo }),
          // A tombstoned row is not an occurrence. A row the user excluded is
          // not spending, so it is not a stream either. Transfers come through
          // and the engine drops them itself, because `isTransfer` is one of
          // the facts it reports having used.
          includeRemoved: false,
          excluded: false,
        },
        cursor: input.cursor ?? null,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return {
        items: page.items.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          merchantId: row.merchantId,
          amount: row.effective.amount,
          date: row.effective.date,
          pending: row.effective.pending,
          isTransfer: row.isTransfer,
        })),
        nextCursor: page.nextCursor,
      };
    },

    async merchantsOf(input) {
      // `listForCategorization` is the ledger reader that filters on
      // transaction ids (`listTransactions`'s `TransactionFilters` has no such
      // filter). Only `merchantId` is read from the rows it returns; the payee
      // text it also carries never crosses into `@ctx/recurring`.
      const merchants = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await listForCategorization(database, {
          userId: input.userId,
          filters: { transactionIds: input.transactionIds },
          cursor,
          limit: 500,
        });
        for (const row of page.items) {
          if (row.merchantId !== null) merchants.add(row.merchantId);
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
      return [...merchants].sort();
    },
  };
}

/**
 * `@ctx/notifications`'s egress allow-list, built from deployment configuration.
 *
 * An empty list is a deny-all policy and is the correct default: a
 * notification channel is the first outbound path a *user-supplied string*
 * controls, and an operator who has not named a host has not consented to one.
 */
export function createNotificationEgressPolicy(config: AppConfig): EgressPolicy {
  return createEgressPolicy({ allowedHosts: config.notifications.allowedHosts });
}

/** One adapter per channel kind, both sharing the one egress policy. */
export function createNotificationChannels(policy: EgressPolicy): ChannelRegistry {
  return { ntfy: createNtfyChannel({ policy }), smtp: createSmtpChannel({ policy }) };
}

/**
 * A hostname's cash sub-type, from `@ctx/ledger`'s provider `subtype` string.
 *
 * Best-effort text matching over whatever a provider (or a manual account)
 * happened to write there — `@ctx/ledger` has no closed enum for it. Anything
 * this does not recognise, and every non-cash account, is `'other'`; the
 * insights snapshot only distinguishes cash sub-types for the `cash.summary`
 * block (`CASH_ACCOUNT_TYPES`), never for a decision.
 */
function cashAccountTypeOf(account: AccountSummary): CashAccountType {
  const isCashLike = account.type === 'depository' || account.type === 'manual';
  if (!isCashLike) return 'other';
  const subtype = (account.subtype ?? '').toLowerCase();
  if (subtype.includes('saving')) return 'savings';
  if (subtype.includes('money market') || subtype.includes('money_market')) return 'money_market';
  if (subtype.includes('cash management') || subtype.includes('cash_management')) {
    return 'cash_management';
  }
  if (subtype.includes('checking')) return 'checking';
  return 'other';
}

/**
 * `@ctx/insights`'s read-only view of the ledger.
 *
 * `listAccounts` and `listTransactions` are real reads over `@ctx/ledger`'s own
 * published readers. `netWorthTrend`, `monthlyCashflow`, `categorySpend` and
 * `topMerchants` are aggregated here, in process, over `listTransactions` pages
 * and `listCategories`'s id→slug map, because `@ctx/ledger` publishes no
 * history-aware read model for any of the four yet (only `netWorthNow`, a
 * single point in time). **Open item, named rather than worked around:**
 * `netWorthTrend` therefore returns at most one point — the true net worth
 * right now, from `netWorthNow` — never a reconstructed history; a month-end
 * balance for a prior month is not derivable from transactions alone for an
 * investment or crypto account, whose value can move with no transaction at
 * all. Fabricating one would be exactly the "advisor invents a number" risk
 * 02-phase-2-dispatch.md §5 exists to prevent.
 */
export function createInsightsLedgerPort(
  database: LedgerDatabase,
  clock: Clock,
): InsightsLedgerPort {
  const categorySlugMap = async (userId: string): Promise<ReadonlyMap<string, string>> => {
    const categories = await listCategories(database, userId, { includeArchived: true });
    return new Map(categories.map((category) => [category.id, category.key] as const));
  };

  /** Every non-transfer, non-excluded, non-duplicate row in `[from, to]`. */
  const spendingRows = async (
    userId: string,
    from: DateOnly,
    to: DateOnly,
  ): Promise<InsightsTransaction[]> => {
    const slugOf = await categorySlugMap(userId);
    const rows: InsightsTransaction[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await listTransactions(database, {
        userId,
        filters: {
          dateFrom: from,
          dateTo: to,
          transfers: 'exclude',
          excluded: false,
          includeDuplicates: false,
        },
        cursor,
        limit: 500,
      });
      for (const row of page.items) {
        rows.push({
          id: row.id,
          date: row.effective.date,
          merchantId: row.merchantId,
          categorySlug:
            row.effective.categoryId === null
              ? null
              : (slugOf.get(row.effective.categoryId) ?? null),
          amount: row.effective.amount,
        });
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return rows;
  };

  return {
    async listAccounts(input) {
      const accounts = await listAccounts(database, { userId: input.userId, includeClosed: true });
      const result: InsightsAccount[] = accounts.map((account) => ({
        id: account.id,
        type: cashAccountTypeOf(account),
        isCash: account.type === 'depository' || account.type === 'manual',
        balance: account.balance?.current ?? Money.zero(account.currency),
        // `@ctx/ledger` has no APY column on any account (a rate is investment
        // or high-yield-savings metadata Phase 3 has not built); always null.
        apy: null,
        closed: account.closedAt !== null,
      }));
      return result;
    },

    async netWorthTrend(input) {
      const now = await netWorthNow(database, { userId: input.userId });
      if (now.totals.length === 0) return [];
      // Multi-currency net worth has no single number (`NetWorthNow`'s own
      // doc: an FX rate with an as-of date is a Phase 3 concern); the largest
      // total by absolute magnitude is the honest single figure until then.
      const largest = [...now.totals].sort((a, b) => {
        const av = a.net.minor < 0n ? -a.net.minor : a.net.minor;
        const bv = b.net.minor < 0n ? -b.net.minor : b.net.minor;
        return av === bv ? 0 : av > bv ? -1 : 1;
      })[0];
      if (largest === undefined) return [];
      const month = DateOnly.startOfMonth(todayOf(clock)).slice(0, 7);
      return [{ month, netWorth: largest.net }].slice(0, Math.max(0, input.months));
    },

    async monthlyCashflow(input) {
      const today = todayOf(clock);
      const from = DateOnly.startOfMonth(DateOnly.addMonths(today, -(input.months - 1)));
      const rows = await spendingRows(input.userId, from, today);
      const slugOf = await categorySlugMap(input.userId);
      const idBySlug = new Map([...slugOf.entries()].map(([id, slug]) => [slug, id] as const));

      const byMonth = new Map<
        string,
        { income: MoneyAcc; expense: MoneyAcc; byCategory: Map<string, MoneyAcc> }
      >();
      for (const row of rows) {
        const month = row.date.slice(0, 7);
        const bucket = byMonth.get(month) ?? {
          income: Money.zero(row.amount.currency),
          expense: Money.zero(row.amount.currency),
          byCategory: new Map<string, MoneyAcc>(),
        };
        if (Money.isPositive(row.amount)) {
          bucket.income = Money.add(bucket.income, row.amount);
        } else {
          const spend = Money.absolute(row.amount);
          bucket.expense = Money.add(bucket.expense, spend);
          if (row.categorySlug !== null) {
            const existing = bucket.byCategory.get(row.categorySlug) ?? Money.zero(spend.currency);
            bucket.byCategory.set(row.categorySlug, Money.add(existing, spend));
          }
        }
        byMonth.set(month, bucket);
      }

      const result: MonthlyCashflowRow[] = [...byMonth.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([month, bucket]) => ({
          month,
          income: bucket.income,
          expense: bucket.expense,
          byCategory: [...bucket.byCategory.entries()].map(([slug, amount]) => ({
            categoryId: idBySlug.get(slug) ?? slug,
            slug,
            amount,
          })),
        }));
      return result;
    },

    async categorySpend(input) {
      const today = todayOf(clock);
      const from = DateOnly.startOfMonth(DateOnly.addMonths(today, -(input.months - 1)));
      const rows = await spendingRows(input.userId, from, today);
      const slugOf = await categorySlugMap(input.userId);
      const idBySlug = new Map([...slugOf.entries()].map(([id, slug]) => [slug, id] as const));

      const byCategory = new Map<string, { count: number; total: MoneyAcc }>();
      for (const row of rows) {
        if (row.categorySlug === null || !Money.isNegative(row.amount)) continue;
        const bucket = byCategory.get(row.categorySlug) ?? {
          count: 0,
          total: Money.zero(row.amount.currency),
        };
        bucket.count += 1;
        bucket.total = Money.add(bucket.total, row.amount);
        byCategory.set(row.categorySlug, bucket);
      }

      return [...byCategory.entries()].map(([slug, bucket]) => ({
        categoryId: idBySlug.get(slug) ?? slug,
        slug,
        count: bucket.count,
        total: bucket.total,
      }));
    },

    async topMerchants(input) {
      const today = todayOf(clock);
      const from = DateOnly.startOfMonth(DateOnly.addMonths(today, -(input.months - 1)));
      const rows = await spendingRows(input.userId, from, today);

      const byMerchant = new Map<string, { count: number; total: MoneyAcc }>();
      for (const row of rows) {
        if (row.merchantId === null || !Money.isNegative(row.amount)) continue;
        const bucket = byMerchant.get(row.merchantId) ?? {
          count: 0,
          total: Money.zero(row.amount.currency),
        };
        bucket.count += 1;
        bucket.total = Money.add(bucket.total, Money.absolute(row.amount));
        byMerchant.set(row.merchantId, bucket);
      }

      return [...byMerchant.entries()]
        .map(([merchantId, bucket]) => ({ merchantId, count: bucket.count, total: bucket.total }))
        .sort((a, b) =>
          a.total.minor === b.total.minor ? 0 : a.total.minor < b.total.minor ? 1 : -1,
        )
        .slice(0, Math.max(0, input.limit));
    },

    async listTransactions(input) {
      const rows = await spendingRows(input.userId, input.from, input.to);
      return rows.slice(0, Math.max(0, input.limit));
    },
  };
}

/** `todayIn(clock, 'UTC')`, spelled once for the insights ports above. */
function todayOf(clock: Clock): DateOnly {
  return DateOnly.parse(clock.now().toISOString().slice(0, 10));
}

/** A `Money` accumulator. Named only so the aggregation loops above read plainly. */
type MoneyAcc = ReturnType<typeof Money.zero>;

/**
 * `@ctx/insights`'s read-only view of the budget: the period containing
 * `today`, or `null` when no budget exists (07 §3 requires every rule degrade
 * gracefully with no budget — the mechanism is this being absent, never empty).
 */
export function createInsightsBudgetPort(database: BudgetingDatabase): InsightsBudgetPort {
  const slugOf = async (userId: string, categoryId: string | null): Promise<string | null> => {
    if (categoryId === null) return null;
    const categories = await listCategories(database, userId, { includeArchived: true });
    return categories.find((category) => category.id === categoryId)?.key ?? null;
  };

  return {
    async currentPeriod(input): Promise<InsightsBudgetPeriod | null> {
      const budgets = await listBudgets(database, { userId: input.userId });
      const budget = budgets[0];
      if (budget === undefined) return null;

      const periods = await listPeriods(database, { userId: input.userId, budgetId: budget.id });
      const current = periods.find(
        (period) => input.today >= period.startDate && input.today < period.endDate,
      );
      if (current === undefined) return null;

      const view = await getPeriod(database, { userId: input.userId, periodId: current.id });
      if (view === null) return null;

      const lines: InsightsBudgetLine[] = [];
      for (const line of view.lines) {
        lines.push({
          id: line.id,
          categoryId: line.categoryId,
          categorySlug: await slugOf(input.userId, line.categoryId),
          kind: line.kind,
          assigned: line.assigned,
          activity: line.activity,
          available: line.available,
          cashOverspend: line.cashOverspend,
          creditOverspend: line.creditOverspend,
          neededThisPeriod: line.neededThisPeriod,
          underfunded: line.underfunded,
        });
      }

      return {
        startDate: view.startDate,
        endDate: view.endDate,
        kind: view.kind,
        currency: budget.currency,
        readyToAssign: view.readyToAssign,
        lines,
      };
    },
  };
}

/**
 * `@ctx/insights`'s read-only view of recurring streams.
 *
 * `priceChanges` is always empty — an open item. `@ctx/recurring` publishes no
 * reader joining `price_change_events` onto a series yet (`src/read.ts` has
 * none), and this file may not reach into another context's table directly
 * the way `apps/api/src/reports/budget-vs-actual.ts` does for its own owner's
 * cached columns; that exemption is for reading a *cache*, not for
 * reconstructing a join a context has not published.
 */
export function createInsightsRecurringPort(database: RecurringDatabase): InsightsRecurringPort {
  return {
    async listStreams(input) {
      const rows = await listSeries(database, { userId: input.userId });
      const result: InsightsRecurringStream[] = rows.map((row) => {
        let periods = 12;
        try {
          periods = periodsPerYear(row.cadence as Cadence);
        } catch {
          // A cadence the engine never persists as unknown; fall back to a
          // monthly-equivalent rather than throw a snapshot build away.
        }
        return {
          id: row.id,
          merchantId: row.merchantId,
          cadence: row.cadence,
          type: row.type,
          status: row.status,
          userConfirmed: row.userConfirmed,
          confidence: Number(row.confidence),
          typicalAmount: Money.of(row.typicalAmountMinor, row.typicalAmountCurrency),
          observedMin: Money.of(row.observedMinMinor, row.typicalAmountCurrency),
          observedMax: Money.of(row.observedMaxMinor, row.typicalAmountCurrency),
          // `dateColumn` reads back as a plain `string` (`mode: 'string'`);
          // `@ctx/budgeting`'s own `read.ts` casts the same way at this boundary.
          nextDueDate: row.nextDueDate as DateOnly | null,
          firstSeen: row.firstSeen as DateOnly,
          lastSeen: row.lastSeen as DateOnly,
          periodsPerYear: periods,
          eligibleForImpact: row.eligibleForImpact,
          priceChanges: [],
        };
      });
      return result;
    },
  };
}

/**
 * Adapters whose primary read/write path is an in-process buffer rather than
 * a remote API — `ManualConnector`'s `ManualStore`, `CsvImportConnector`'s own
 * `#staged` map, and the demo `SeedConnector`.
 *
 * Since decision D-5 (`attachDurableStaging` above), a connection on one of
 * these providers **can** be synced correctly from a process that never
 * linked it — the worker, or the api after a restart — because the durable
 * mirror hydrates `#local`/`#staged` on first use. `PROCESS_LOCAL_PROVIDERS`
 * therefore no longer gates *correctness* anywhere (the nightly fan-out,
 * `apps/api/src/modules.ts`, does not consult it), only *latency*:
 * `apps/api/src/routes/connections.ts` still reads this set to decide whether
 * a user-triggered sync runs inline in the HTTP response (immediate feedback,
 * and the only way `POST /imports/csv` can return `staged`/`skipped` counts
 * synchronously) or is enqueued for the worker to pick up. A durable adapter —
 * Plaid, SimpleFIN, anything with a credential and a remote — is absent from
 * this set and always goes through the job queue, because there is no
 * "immediate" answer to give for a call that has to leave the process.
 */
export const PROCESS_LOCAL_PROVIDERS: ReadonlySet<string> = new Set([
  MANUAL_PROVIDER,
  IMPORT_PROVIDER,
  SEED_PROVIDER,
]);

export interface ConnectorRegistryOptions {
  /** Extra adapters. The seed connector is injected here by the test harness. */
  readonly extra?: readonly RegisteredConnector[];
  /**
   * `config.plaid` from `@core/config` — `null` when Plaid is not configured
   * (no `plaid_client_id`/`plaid_secret` file present). This is the *only*
   * gate: no `NODE_ENV` check, no feature flag. Feature-detection means a
   * deployment with no Plaid credentials boots exactly as it did before this
   * work package, and one that adds a `secrets/plaid_client_id` file gets the
   * connector on the next restart with no other change.
   */
  readonly plaid?: PlaidConfig | null;
  /** Threaded to `PlaidConnector` for `ConnectorHealth.checkedAt` (wp1.3-plaid.md §8 item 2). */
  readonly clock?: Clock;
  /** One info line at registration, naming the environment and nothing secret. */
  readonly logger?: PlatformLogger;
}

/**
 * Provider id → adapter, for this deployment.
 *
 * 08 §2.7's test of the abstraction is that adding a provider needs no UI change:
 * the "Add a connection" screen renders from `registry.manifests()`, so a new
 * adapter appears in the UI by being registered here and nowhere else.
 */
export function createConnectorRegistry(options: ConnectorRegistryOptions = {}): ConnectorRegistry {
  const registry = new ConnectorRegistry([
    { connector: new ManualConnector({ store: new ManualStore() }), manifest: MANUAL_MANIFEST },
    { connector: new CsvImportConnector(), manifest: CSV_MANIFEST },
  ]);

  const plaid = options.plaid ?? null;
  const logger = options.logger;
  if (plaid === null) {
    // Feature-detect, one info line, no secret ever touches a log line — there
    // is nothing here to redact because there is nothing here but the fact of
    // absence.
    logger?.info({ provider: PLAID_PROVIDER }, 'plaid not configured; connector not registered');
  } else {
    const settings: PlaidLinkSettings = {
      clientName: plaid.clientName,
      countryCodes: plaid.countryCodes,
      language: plaid.language,
      redirectUri: plaid.redirectUri,
      webhookUrl: plaid.webhookUrl,
    };
    const connector = new PlaidConnector({
      // `.reveal()` at the one call site that actually needs the bytes, same
      // pattern as `master_key` reaching `SecretBox.unlock` — never stored,
      // never logged, dropped the moment `createPlaidApi` has used it to build
      // the axios default headers (`client.ts`).
      api: createPlaidApi({
        clientId: plaid.clientId.reveal(),
        secret: plaid.secret.reveal(),
        environment: plaid.environment,
      }),
      settings,
      clock: options.clock ?? systemClock,
    });
    registry.register({ connector, manifest: PLAID_MANIFEST });
    logger?.info(
      { provider: PLAID_PROVIDER, environment: plaid.environment },
      'plaid configured; connector registered',
    );
  }

  for (const entry of options.extra ?? []) registry.register(entry);
  return registry;
}

export interface DomainRuntimeOptions {
  readonly database: Database;
  readonly clock: Clock;
  readonly logger: PlatformLogger;
  readonly registry: ConnectorRegistry;
  /** `null` until the KEK is derived; a locked application has no orchestrator. */
  readonly secretBox: SecretBox;
}

/** Everything a connections route needs, constructed once the app is unlocked. */
export interface DomainRuntime {
  readonly database: Database;
  readonly registry: ConnectorRegistry;
  readonly orchestrator: SyncOrchestrator;
  readonly secretBox: SecretBox;
  readonly clock: Clock;
}

/**
 * Point the registry's Manual and CSV connectors, if registered, at their
 * durable mirror — decision D-5. Idempotent (both connectors' own
 * `attachStagingStore` docs say so), so calling this again on the same
 * registry — `app.ts`'s `deps.connections()` rebuilds a `DomainRuntime` every
 * time the `SecretBox` is re-initialised — costs nothing and changes nothing.
 * A registry built without one of these two providers (a future deployment
 * shape, or a narrow test registry) simply skips it: `registry.has` first,
 * never `registry.get`, so an absent provider is not an error here the way it
 * is at a sync call site.
 */
function attachDurableStaging(registry: ConnectorRegistry, database: Database): void {
  if (registry.has(MANUAL_PROVIDER)) {
    const connector = registry.get(MANUAL_PROVIDER);
    if (connector instanceof ManualConnector) {
      connector.attachStagingStore(createManualStagingStore(database));
    }
  }
  if (registry.has(IMPORT_PROVIDER)) {
    const connector = registry.get(IMPORT_PROVIDER);
    if (connector instanceof CsvImportConnector) {
      connector.attachStagingStore(createCsvStagingStore(database));
    }
  }
}

export function createDomainRuntime(options: DomainRuntimeOptions): DomainRuntime {
  attachDurableStaging(options.registry, options.database);
  const orchestrator = new SyncOrchestrator({
    database: options.database,
    registry: options.registry,
    secretBox: options.secretBox,
    ledgerWriter,
    clock: options.clock,
    logger: options.logger,
  });
  return {
    database: options.database,
    registry: options.registry,
    orchestrator,
    secretBox: options.secretBox,
    clock: options.clock,
  };
}
