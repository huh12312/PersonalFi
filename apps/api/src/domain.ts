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
import type { AppConfig, CoinbaseConfig, PlaidConfig, Redacted } from '@core/config';
import type { Database } from '@core/db';
import { DateOnly, Money, newId, systemClock, type Clock } from '@core/kernel';
import {
  appendEvent,
  createNodeTransport,
  type Executor,
  type PlatformLogger,
  type TransactionalExecutor,
} from '@core/platform';
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
import {
  COINBASE_MANIFEST,
  COINBASE_PROVIDER,
  CoinbaseConnector,
  fetchTransport,
} from '@connector/coinbase';
import {
  DEFAULT_LADDERS,
  createSecurityResolver,
  drizzleSecurityStore,
  ladderRows,
  outboxOf as investmentsOutboxOf,
  type FigiMapper,
  type InvestmentSyncPort,
  type InvestmentsExecutor,
  type ResolvedHoldingFact,
  type ResolvedTransactionFact,
  type SecurityResolver,
} from '@ctx/investments';
import {
  FX_ROW_SOURCES,
  PRICE_ROW_SOURCES,
  fxRates,
  prices,
  priceSourcePriority,
  securities,
  type FxRowSource,
  type PriceRowSource,
} from '@ctx/investments/schema';
import {
  COINGECKO_WINDOWS,
  FRED_WINDOWS,
  OPENFIGI_WINDOWS,
  TIINGO_WINDOWS,
  apiKeyOf,
  createCoinGeckoPriceSource,
  createFredSource,
  createOpenFigiMapper,
  createProviderClient,
  createRateBudget,
  createTiingoPriceSource,
  missingKey,
  policyFor,
  type ApiKey,
  type MarketDataProvider,
  type MarketDataRunRecorder,
  type MarketDataWriter,
  type PriceSource,
  type RateBudget,
} from '@ctx/integrations';
import { marketDataRuns } from '@ctx/integrations/schema';
import { and, eq, gte, sql, type SQL } from 'drizzle-orm';

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

// ---------------------------------------------------------------------------
// Phase 3 — `@ctx/investments` and `@ctx/integrations`
// ---------------------------------------------------------------------------
//
// The same rule as everything above it, applied to two more contexts:
// `personalfi/layer-imports` denies `@ctx/*` -> `@ctx/*` unconditionally, so
// every cross-context read below is a port one context declared and this file
// implements. `@ctx/integrations` is the stricter of the two — its lint layer
// denies `@ctx/*` outright, including `@ctx/ledger` (08 §1.3 #11) — which is
// why the market-data refresh writes its rows through an injected
// `MarketDataWriter` rather than reaching for a table handle, even though both
// tables live in the same Postgres instance.

/**
 * A `TransactionalExecutor` whose transaction callback hands out the **real
 * Drizzle transaction handle** rather than a narrowed wrapper around it.
 *
 * ## Why this exists, and what it actually changes
 *
 * `@core/platform`'s own `platformExecutor` builds a *fresh object* carrying
 * only `execute` (`packages/platform/src/database.ts:21-29`) and throws the
 * Drizzle handle away. Every Phase 1 and Phase 2 consumer is fine with that —
 * they write raw SQL. WP 3.2's lot consumer is the first that is not:
 * `createLotConsumer` takes `storeFor(context)` as a factory over the pump's
 * transaction precisely so a `LotsUpdated` cannot outlive a rolled-back
 * derivation, and the store it has to build, `drizzleLotStore`, is written
 * against Drizzle's query builder (`db.insert(...)`). Handed a bare
 * `Executor`, it fails at the first write with `db.insert is not a function` —
 * observed, from inside the real pump, by
 * `apps/api/test/db/phase3-wiring.test.ts` before this function existed.
 *
 * `createConsumerPump` takes its `TransactionalExecutor` from the caller, and
 * the caller is this application. So the composition root supplies one whose
 * `transaction` passes the Drizzle transaction through: it satisfies
 * `Executor` structurally (it has `execute`), every existing consumer keeps
 * working unchanged because none of them look for anything else, and the one
 * consumer that needs more finds it there.
 *
 * ## The cast is checked, not assumed
 *
 * `assertDrizzleTransaction` below is what turns this from a cast into a
 * contract. If this executor is ever swapped back for `platformExecutor` — or
 * if a future `@core/platform` narrows the handle again — the failure is one
 * named error at the boundary naming this function, instead of a
 * `TypeError` several frames deep inside a context's store.
 *
 * **The cleaner fix is a `@core/platform` change this wave may not make:**
 * `ConsumerContext` should carry the transaction's own database handle as a
 * declared field rather than leaving it to be recovered structurally. Recorded
 * in `docs/evidence/phase-3/wp3.w-wiring.md` as the seam to close.
 */
export function drizzleTransactionalExecutor(database: Database): TransactionalExecutor {
  return {
    execute: <TRow extends Record<string, unknown>>(query: SQL) =>
      database.execute(query) as unknown as Promise<{ rows: TRow[] }>,
    transaction: <T>(fn: (tx: Executor) => Promise<T>): Promise<T> =>
      database.transaction(async (tx) => fn(tx as unknown as Executor)),
  };
}

/**
 * Recover the Drizzle handle a `drizzleTransactionalExecutor` transaction is
 * carrying, and fail by name if it is not carrying one.
 *
 * The check is `typeof tx.insert === 'function'` rather than an `instanceof`:
 * Drizzle's transaction class is not on its public surface, and what the
 * caller needs is the query builder, not a particular class.
 */
export function assertDrizzleTransaction(tx: Executor): Database {
  const candidate = tx as unknown as Partial<Database>;
  if (typeof candidate.insert !== 'function' || typeof candidate.select !== 'function') {
    throw new Error(
      'the consumer pump was built with an executor that narrows away the Drizzle handle; ' +
        'apps/api must pass drizzleTransactionalExecutor(database) to createConsumerPump ' +
        '(see its doc comment — @ctx/investments’ lot store writes through the query builder)',
    );
  }
  return tx as unknown as Database;
}

/**
 * WP 3.1's `SecurityResolver`, built **per transaction**.
 *
 * Not per process, and the difference is load-bearing: the resolver's
 * `SecurityResolutionFailed` event and the `securities` rows it writes have to
 * land in the same transaction, or a rolled-back sync leaves behind a durable
 * record that a security failed to resolve during work that never happened.
 * `docs/evidence/phase-3/wp3.1-securities.md` §6 states this shape and this
 * file is where it is honoured.
 *
 * `figi` is optional and its absence is a supported mode, not a degradation to
 * apologise for: `createSecurityResolver` falls back to `createFakeFigiMapper()`,
 * whose answers are `no_match`, so the FIGI tier abstains by name and the
 * weaker tiers below it still decide. That is exactly what an install with no
 * `openfigi_api_key` should do.
 */
export function securityResolverFor(
  executor: InvestmentsExecutor,
  clock: Clock,
  figi?: FigiMapper,
): SecurityResolver {
  return createSecurityResolver({
    store: drizzleSecurityStore(executor, clock),
    clock,
    events: {
      append: async (event) => {
        await appendEvent(investmentsOutboxOf(executor), event);
      },
    },
    ...(figi === undefined ? {} : { figi }),
  });
}

/**
 * `@ctx/investments`' `InvestmentSyncPort` — the three reads WP 3.2's lot
 * consumer makes into tables it does not own.
 *
 * `docs/evidence/phase-3/wp3.2-lots.md` §11 names this function and leaves it
 * to the composition root for the usual reason: `factsForRun` reads
 * `@ctx/connections`' sync bookkeeping and `isRetirementAccount` reads
 * `@ctx/ledger`'s accounts, and the lot engine may import neither.
 *
 * ## `factsForRun` answers honestly, and today that answer is empty
 *
 * The port's contract is "the holdings and investment-transaction facts this
 * sync run produced, each already resolved to a `security_id`". **No provider
 * leg persists such a fact yet.** `@connector/port` grew
 * `ProviderHoldingFact` and `ProviderInvestmentTransactionFact` in WP 3.1, and
 * `@connector/coinbase` and `@connector/plaid` can *produce* them, but the
 * orchestrator legs that call `syncHoldings`/`syncInvestmentTransactions` and
 * write the results down are **WP 3.7's**, not this wave's, and
 * `@ctx/connections`' `sync_runs` row carries counts rather than facts.
 *
 * So this returns the run's provider and date with two empty arrays. That is
 * the honest answer to "what did this run produce", and it makes the consumer
 * a no-op rather than a liar: `runLotSync` over no facts touches no holding,
 * opens no lot and appends no event, so `module.investments` can be on, the
 * consumer can catch up over the whole event history on first boot, and
 * nothing is written until there is something real to write. The alternative —
 * leaving the consumer unregistered until WP 3.7 — would mean the first boot
 * after 3.7 replays every `connections.SyncRunCompleted` ever recorded against
 * a port that had by then changed shape, which is a worse first day.
 *
 * **WP 3.7's change is confined to this function.** When the holdings leg
 * lands, `factsForRun` reads the rows it wrote, runs each through
 * `securityResolverFor(...).resolveAll(...)`, drops every position the
 * resolver abstained on (the `SecurityResolutionFailed` event is the record
 * that it existed — a fact with a null `security_id` must never be returned)
 * and returns the rest. Nothing in `modules.ts` or in `@ctx/investments` moves.
 */
export function createInvestmentSyncPort(
  database: Database,
  clock: Clock = systemClock,
): InvestmentSyncPort {
  return {
    async factsForRun(userId, syncRunId) {
      const run = await database.execute<{
        provider: string | null;
        started_at: Date | string | null;
      }>(sql`
        SELECT c.provider AS provider, r.started_at AS started_at
          FROM sync_runs r
          JOIN connections c ON c.id = r.connection_id
         WHERE r.id = ${syncRunId}::uuid AND r.user_id = ${userId}::uuid
      `);
      const row = run.rows[0];
      // `execute` returns whatever the driver parsed, and for a raw statement
      // that is a `timestamptz` *string* rather than the `Date` a Drizzle
      // column mapping would give. Both are handled: guessing wrong here threw
      // `startedAt.toISOString is not a function` on the first real sync run
      // this port ever saw, which is exactly the class of bug a
      // never-exercised adapter hides.
      const startedAt = row?.started_at ?? null;
      const asOf =
        startedAt === null
          ? clock.now()
          : startedAt instanceof Date
            ? startedAt
            : new Date(startedAt);
      const holdings: readonly ResolvedHoldingFact[] = [];
      const transactions: readonly ResolvedTransactionFact[] = [];
      return {
        provider: row?.provider ?? 'unknown',
        asOfDate: DateOnly.parse(asOf.toISOString().slice(0, 10)),
        holdings,
        transactions,
      };
    },

    /**
     * Rev. Rul. 2008-5's case: a wash sale whose replacement lands in an IRA
     * loses the disallowed basis adjustment permanently, so the flag has to
     * know which accounts are tax-advantaged.
     *
     * Read through `listAccounts` — `@ctx/ledger`'s own published reader — and
     * matched against the provider's free-text `subtype`, which is exactly as
     * unconstrained as `cashAccountTypeOf` above says it is ("Provider
     * vocabulary; unconstrained: it changes without notice"). Best-effort text
     * matching is therefore the only thing available, and the failure
     * direction is chosen deliberately: an unrecognised subtype answers
     * `false`, so the wash-sale flag records an adjustment that survives. An
     * over-eager `true` would *silently delete* a basis adjustment the user is
     * entitled to, and a wrong number that quietly favours the tax authority
     * is still a wrong number (04 §5.5's "unavailable, never zero", applied to
     * a different column).
     */
    async isRetirementAccount(accountId) {
      const rows = await database.execute<{ subtype: string | null; type: string }>(sql`
        SELECT subtype, type FROM accounts WHERE id = ${accountId}::uuid
      `);
      const row = rows.rows[0];
      if (row === undefined) return false;
      const subtype = (row.subtype ?? '').toLowerCase().replaceAll(/[\s-]+/gu, '');
      return RETIREMENT_SUBTYPE_MARKERS.some((marker) => subtype.includes(marker));
    },

    /**
     * `securities.type === 'crypto'`. The dated digital-asset exclusion in
     * `DEFAULT_WASH_SALE_CONFIG` is a config value rather than a branch
     * precisely so the day Congress closes it is a data edit; this read is the
     * other half, and it is a column lookup rather than a guess from a ticker.
     */
    async isDigitalAsset(securityId) {
      const rows = await database
        .select({ type: securities.type })
        .from(securities)
        .where(eq(securities.id, securityId))
        .limit(1);
      return rows[0]?.type === 'crypto';
    },
  };
}

/**
 * Provider `subtype` fragments that mean "tax-advantaged", whitespace and
 * hyphens already stripped by the caller.
 *
 * Plaid's own investment subtypes supply most of these (`401k`, `403B`,
 * `457b`, `ira`, `roth`, `sep ira`, `simple ira`, `hsa`, `keogh`) and a manual
 * account's is whatever the user typed. `529` and `hsa` are here because the
 * *reason* the flag exists — a permanently lost basis adjustment — applies to
 * any account whose gains are not taxed on realisation, not only to an IRA.
 */
const RETIREMENT_SUBTYPE_MARKERS: readonly string[] = Object.freeze([
  '401k',
  '401a',
  '403b',
  '457',
  'ira',
  'roth',
  'keogh',
  'sep',
  'simple',
  'hsa',
  '529',
  'pension',
  'retirement',
  'tsp',
  'rrsp',
  'tfsa',
]);

/**
 * `@ctx/integrations`' `MarketDataWriter`, adapted onto `@ctx/investments`'
 * `prices` and `fx_rates`.
 *
 * This is the seam 08 §1.3 #7 exists for. `@ctx/integrations` *fetches* the
 * numbers and owns `market_data_runs`; the two tables the numbers land in are
 * `@ctx/investments`', and the two contexts may not import each other. So the
 * refresh job takes a writer and the composition root supplies one, which is
 * also what makes the job unit-testable against `inMemoryMarketDataWriter()`
 * with no database at all.
 *
 * **Both upserts are idempotent on the table's own natural key** — `(user,
 * security, date, source, currency)` and `(user, base, quote, date, source)` —
 * so a re-run of the 03:45 refresh, or a retry of a job that already committed
 * its rows, writes the same rows and reports the same count rather than
 * accumulating a second observation for the same day from the same provider.
 * `observedAt` is refreshed on conflict because the 24-hour staleness rule
 * (`PRICE_STALE_AFTER_MS`) is computed from it at read time: a second
 * successful fetch of the same close really is fresher evidence, even though
 * the number did not move.
 *
 * The counts returned are rows *offered*, which for an upsert is the honest
 * figure: "rows written" in `market_data_runs` is a record of what the refresh
 * did, and a refresh that re-confirmed forty prices did forty rows of work.
 */
/**
 * `MarketDataProvider` narrowed to the sources `prices.source` accepts.
 *
 * The two vocabularies are deliberately not the same set, and this is where
 * that is enforced in TypeScript rather than discovered as a CHECK-constraint
 * violation at 03:45. `prices_source_is_an_observation` rejects `last_known`
 * because a carry-forward is a label computed at read time and never a written
 * row; `fred` is rejected for the duller reason that FRED publishes macro
 * series and FX, not security closes; `openfigi` maps identifiers and has no
 * price to give at all.
 *
 * **Throws rather than drops.** A price row arriving from a provider that
 * cannot produce one is a wiring bug — it means an adapter was registered
 * against the wrong operation — and a silently discarded row would leave the
 * refresh reporting rows written that are not there. Failing the run records
 * the truth in `market_data_runs` and leaves yesterday's prices intact.
 */
function priceRowSourceOf(provider: MarketDataProvider): PriceRowSource {
  if (provider === 'fred' || provider === 'openfigi') {
    throw new Error(
      `market data: ${provider} cannot produce a price row (prices.source accepts ${PRICE_ROW_SOURCES.join(', ')})`,
    );
  }
  return provider;
}

/** The same narrowing for `fx_rates.source`, where FRED is the *default* and the crypto/equity feeds are the exceptions. */
function fxRowSourceOf(provider: MarketDataProvider): FxRowSource {
  if (provider === 'openfigi' || provider === 'yfinance') {
    throw new Error(
      `market data: ${provider} cannot produce an FX row (fx_rates.source accepts ${FX_ROW_SOURCES.join(', ')})`,
    );
  }
  return provider;
}

export function createMarketDataWriter(database: Database): MarketDataWriter {
  return {
    async writePrices(userId, rows) {
      if (rows.length === 0) return 0;
      await database
        .insert(prices)
        .values(
          rows.map((row) => ({
            id: newId(),
            userId,
            securityId: row.securityId,
            priceDate: row.priceDate,
            source: priceRowSourceOf(row.source),
            close: row.close,
            currency: row.currency,
            stale: row.stale,
            observedAt: row.observedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [
            prices.userId,
            prices.securityId,
            prices.priceDate,
            prices.source,
            prices.currency,
          ],
          set: {
            close: sql`excluded.close`,
            stale: sql`excluded.stale`,
            observedAt: sql`excluded.observed_at`,
            updatedAt: sql`now()`,
          },
        });
      return rows.length;
    },

    async writeFxRates(userId, rows) {
      if (rows.length === 0) return 0;
      await database
        .insert(fxRates)
        .values(
          rows.map((row) => ({
            id: newId(),
            userId,
            baseCurrency: row.base,
            quoteCurrency: row.quote,
            rateDate: row.rateDate,
            source: fxRowSourceOf(row.source),
            rate: row.rate,
            observedAt: row.observedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [
            fxRates.userId,
            fxRates.baseCurrency,
            fxRates.quoteCurrency,
            fxRates.rateDate,
            fxRates.source,
          ],
          set: {
            rate: sql`excluded.rate`,
            observedAt: sql`excluded.observed_at`,
            updatedAt: sql`now()`,
          },
        });
      return rows.length;
    },
  };
}

/**
 * `market_data_runs`, the table `@ctx/integrations` owns — so unlike the writer
 * above, this adapter exists for injection rather than for ownership.
 *
 * `errorMessage` arrives already redacted (`redactedMessageOf`), which is the
 * property `wp3.4-market-data.md` §6 asserts against *every* text column of
 * this table rather than against one suspect field. Nothing is redacted here,
 * deliberately: a second redaction pass at the write site would make it
 * impossible to tell whether the first one works.
 */
export function createMarketDataRunRecorder(database: Database): MarketDataRunRecorder {
  return {
    async record(run) {
      await database.insert(marketDataRuns).values({
        id: newId(),
        userId: run.userId,
        provider: run.provider,
        operation: run.operation,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        outcome: run.outcome,
        requestsMade: run.requestsMade,
        unitsSpent: run.unitsSpent,
        symbolsAsked: run.symbolsAsked,
        rowsWritten: run.rowsWritten,
        refusalCode: run.refusalCode,
        errorMessage: run.errorMessage,
        retryAfterMs: run.retryAfterMs,
      });
    },
  };
}

/**
 * How far back `hydrateMarketDataBudgets` reads.
 *
 * 48 hours, which is comfortably wider than the widest window any provider
 * publishes (`TIINGO_WINDOWS`' daily one), so a spend old enough to be excluded
 * here cannot affect a verdict.
 */
const HYDRATE_LOOKBACK_MS = 48 * 60 * 60 * 1000;

/** Everything `module.integrations` needs, built once per process. */
export interface MarketDataRuntime {
  /** The adapters whose key is present. A provider with no key is simply absent. */
  readonly sources: readonly PriceSource[];
  /** `undefined` when `openfigi_api_key` is absent; the resolver then abstains at that tier. */
  readonly figi: FigiMapper | undefined;
  /** Every key this process holds, so nothing provider-authored is logged raw. */
  readonly keys: readonly ApiKey[];
  /** Per-provider budgets, kept so `hydrateMarketDataBudgets` can prime them at boot. */
  readonly budgets: ReadonlyMap<MarketDataProvider, RateBudget>;
}

/**
 * The four WP 3.4 adapters, feature-detected on their key files exactly the
 * way `createConnectorRegistry` feature-detects Plaid's credentials.
 *
 * Four properties are deliberate and each one is a line somebody could
 * plausibly have written differently:
 *
 *   * **`policyFor(provider)`, never one shared policy.** Each adapter gets an
 *     allow-list of exactly one host, so a bug in the Tiingo adapter cannot
 *     reach `api.coingecko.com`, let alone `db:5432`. `MARKET_DATA_ALLOWED_HOSTS`
 *     from the environment can only *narrow* this further (see
 *     `packages/config/src/schema.ts`); it is intersected, never substituted,
 *     so a deployment cannot point a price fetcher at a host of its choosing.
 *   * **A provider with no key is left out of `sources` entirely** rather than
 *     included and allowed to answer `skipped_no_key`. Both behave correctly —
 *     the adapters degrade honestly either way, which `@ctx/integrations`
 *     proves in its own suite — but an absent source produces no
 *     `market_data_runs` row and no `PriceSourceUnavailable` event, and a
 *     nightly `skipped_no_key` for a provider the operator never configured is
 *     noise that trains the reader to ignore the table.
 *   * **`now: () => clock.now()`**, not the `Clock` itself: the adapters take a
 *     thunk, and passing `clock.now` unbound would lose `this`.
 *   * **One shared `createNodeTransport()`.** The transport performs no policy;
 *     `createProviderClient` applies the per-provider policy around it.
 */
export function createMarketDataRuntime(options: {
  /**
   * `config.secrets`. The four keys are read by name and nothing else is
   * touched — narrowed to this rather than taking the whole `AppConfig`
   * so the function asks for what it uses, and so a test can exercise the
   * zero-key path without constructing a deployment.
   */
  readonly secrets: Pick<
    AppConfig['secrets'],
    'tiingo_api_key' | 'fred_api_key' | 'coingecko_api_key' | 'openfigi_api_key'
  >;
  /** `config.marketData.allowedHosts`. Empty ⇒ no narrowing of the code's own list. */
  readonly allowedHosts: readonly string[];
  readonly clock?: Clock;
  readonly logger?: PlatformLogger;
}): MarketDataRuntime {
  const clock = options.clock ?? systemClock;
  const logger = options.logger;
  const now = (): Date => clock.now();
  const transport = createNodeTransport();
  const narrowing = options.allowedHosts;

  const keyFor = (provider: MarketDataProvider, secret: Redacted<string> | undefined): ApiKey =>
    secret === undefined ? missingKey(provider) : apiKeyOf(provider, secret.reveal());

  const clientFor = (provider: MarketDataProvider, keys: readonly ApiKey[]) =>
    createProviderClient({
      provider,
      // `policyFor` already pins one host, https and :443. The environment can
      // subtract from that set and nothing else: an empty `narrowing` leaves
      // the code's own host in place, and a `narrowing` that does not name this
      // provider's host leaves it with none, which is how an operator switches
      // one source off without a redeploy.
      policy: policyFor(provider, {}),
      transport,
      keys,
    });

  const sources: PriceSource[] = [];
  const keys: ApiKey[] = [];
  const budgets = new Map<MarketDataProvider, RateBudget>();

  const tiingoKey = keyFor('tiingo', options.secrets.tiingo_api_key);
  const fredKey = keyFor('fred', options.secrets.fred_api_key);
  const coingeckoKey = keyFor('coingecko', options.secrets.coingecko_api_key);
  const openfigiKey = keyFor('openfigi', options.secrets.openfigi_api_key);
  for (const key of [tiingoKey, fredKey, coingeckoKey, openfigiKey]) {
    if (key.present) keys.push(key);
  }

  const announce = (provider: MarketDataProvider, present: boolean): void => {
    logger?.info(
      { provider, host: narrowedOut(provider, narrowing) ? 'narrowed-out' : 'allowed' },
      present
        ? `${provider} configured; price source registered`
        : `${provider} not configured; price source not registered`,
    );
  };

  if (tiingoKey.present && !narrowedOut('tiingo', narrowing)) {
    const budget = createRateBudget(TIINGO_WINDOWS);
    budgets.set('tiingo', budget);
    sources.push(
      createTiingoPriceSource({ client: clientFor('tiingo', keys), key: tiingoKey, now, budget }),
    );
  }
  announce('tiingo', tiingoKey.present);

  if (fredKey.present && !narrowedOut('fred', narrowing)) {
    const budget = createRateBudget(FRED_WINDOWS);
    budgets.set('fred', budget);
    sources.push(createFredSource({ client: clientFor('fred', keys), key: fredKey, now, budget }));
  }
  announce('fred', fredKey.present);

  if (coingeckoKey.present && !narrowedOut('coingecko', narrowing)) {
    const budget = createRateBudget(COINGECKO_WINDOWS);
    budgets.set('coingecko', budget);
    sources.push(
      createCoinGeckoPriceSource({
        client: clientFor('coingecko', keys),
        key: coingeckoKey,
        now,
        budget,
      }),
    );
  }
  announce('coingecko', coingeckoKey.present);

  // The one adapter that is not a `PriceSource`. `createOpenFigiMapper` returns
  // an `OpenFigiMapper`, which `@ctx/integrations` declares as a structural
  // mirror of `@ctx/investments`' `FigiMapper` because the boundary lint
  // forbids the cross-context import — so this assignment is where TypeScript
  // checks the two halves still fit, and it is meant to be the build-time
  // failure if they ever drift (wp3.4-market-data.md §9 item 4).
  let figi: FigiMapper | undefined;
  if (openfigiKey.present && !narrowedOut('openfigi', narrowing)) {
    const budget = createRateBudget(OPENFIGI_WINDOWS);
    budgets.set('openfigi', budget);
    figi = createOpenFigiMapper({
      client: clientFor('openfigi', keys),
      key: openfigiKey,
      now,
      budget,
    });
  }
  announce('openfigi', openfigiKey.present);

  return { sources, figi, keys, budgets };
}

/** `@ctx/integrations`' own host for a provider, per `PROVIDER_HOSTS`. */
const MARKET_DATA_PROVIDER_HOSTS: Readonly<Record<MarketDataProvider, string>> = Object.freeze({
  tiingo: 'api.tiingo.com',
  fred: 'api.stlouisfed.org',
  coingecko: 'api.coingecko.com',
  openfigi: 'api.openfigi.com',
  // Opt-in only and deliberately not allow-listed by `@ctx/integrations`; no
  // adapter exists. Present so this record stays exhaustive over the union.
  yfinance: 'query1.finance.yahoo.com',
});

/**
 * Has `MARKET_DATA_ALLOWED_HOSTS` been set to a list that excludes this
 * provider's host?
 *
 * Empty means "no narrowing", so every provider is allowed — that is the
 * default and the only way the environment can *widen* anything is by not
 * being consulted at all, which is what this returns `false` for.
 */
function narrowedOut(provider: MarketDataProvider, narrowing: readonly string[]): boolean {
  if (narrowing.length === 0) return false;
  return !narrowing.includes(MARKET_DATA_PROVIDER_HOSTS[provider]);
}

/**
 * Prime each provider's rate budget from `market_data_runs` at boot.
 *
 * Without this a restart resets the day's spend to zero, and a container that
 * crash-loops four times spends 5× Tiingo's free daily allowance before lunch
 * — the budget would be a control that a restart disarms. `RateBudget.hydrate`
 * takes `{ at, cost }` pairs; `started_at` and `units_spent` are exactly that,
 * and 48 hours is comfortably more than the widest window any provider
 * publishes (`TIINGO_WINDOWS`' daily one), so anything older cannot affect a
 * verdict.
 *
 * Best-effort by construction: it reads rows this process wrote earlier, and a
 * failure to read them must not stop the worker from booting. The caller logs
 * and continues — a budget that starts empty is the behaviour we had before
 * this function existed, not a new failure mode.
 */
export async function hydrateMarketDataBudgets(
  database: Database,
  userId: string,
  budgets: ReadonlyMap<MarketDataProvider, RateBudget>,
  clock: Clock = systemClock,
): Promise<number> {
  if (budgets.size === 0) return 0;
  const since = new Date(clock.now().getTime() - HYDRATE_LOOKBACK_MS);
  const rows = await database
    .select({
      provider: marketDataRuns.provider,
      startedAt: marketDataRuns.startedAt,
      unitsSpent: marketDataRuns.unitsSpent,
    })
    .from(marketDataRuns)
    .where(and(eq(marketDataRuns.userId, userId), gte(marketDataRuns.startedAt, since)));

  const byProvider = new Map<MarketDataProvider, { at: Date; cost: number }[]>();
  for (const row of rows) {
    if (row.unitsSpent <= 0) continue;
    const bucket = byProvider.get(row.provider) ?? [];
    bucket.push({ at: row.startedAt, cost: row.unitsSpent });
    byProvider.set(row.provider, bucket);
  }
  let hydrated = 0;
  for (const [provider, budget] of budgets) {
    const spends = byProvider.get(provider) ?? [];
    budget.hydrate(spends);
    hydrated += spends.length;
  }
  return hydrated;
}

/**
 * Seed `price_source_priority` for a user from `DEFAULT_LADDERS`.
 *
 * 07 §6.1's ladder as rows, per security kind, because the user is meant to be
 * able to reorder it — a ladder that only exists in code is not a setting.
 * Called from `bootstrap-seed.ts`'s `seedUserState`, in the same pass that
 * seeds the taxonomy and the advisor catalogue, so a user created *after* boot
 * has it with no restart (condition C-1's whole lesson).
 *
 * `onConflictDoNothing`, not `DoUpdate`: this runs on every boot as an
 * idempotent repair for installs that predate it, and a restart must not
 * silently undo a user's reordering — the same reasoning `upsertSchedule`
 * gives for never overwriting `enabled` on conflict. The consequence, stated
 * rather than discovered: a *new* rung added to `DEFAULT_LADDERS` in a later
 * release does reach an existing user (it is a new row, so there is no
 * conflict), but a *changed* rung number for a source they already have does
 * not. That is the right way round.
 */
export async function seedPriceSourcePriority(database: Database, userId: string): Promise<number> {
  const rows = Object.entries(DEFAULT_LADDERS).flatMap(([kind, ladder]) =>
    ladderRows(userId, kind, ladder).map((row) => ({
      id: newId(),
      userId: row.userId,
      securityKind: row.securityKind,
      rung: row.rung,
      source: row.source,
    })),
  );
  if (rows.length === 0) return 0;
  await database.insert(priceSourcePriority).values(rows).onConflictDoNothing();
  return rows.length;
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
  /**
   * `config.coinbase` — `null` when neither `coinbase_key_name` nor
   * `coinbase_private_key` is present. The same and only gate as Plaid's: no
   * `NODE_ENV` check, no feature flag.
   *
   * Unlike `plaid`, this object carries **no credential** (`CoinbaseConfig` is
   * `{ configured: true }`), because the connector signs each request from the
   * pair sealed into the `ConnectionHandle` rather than from a process-wide
   * copy (wp3.5-coinbase.md §8.3). This decides only *whether* to register.
   */
  readonly coinbase?: CoinbaseConfig | null;
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

  // WP 3.5, the same feature-detection shape as the Plaid block above. The
  // credentials are deliberately not passed to the constructor: every Coinbase
  // request reads the sealed pair back out of the `ConnectionHandle`, so there
  // is no CDP private key held in this registry for the life of the process.
  // `fetchTransport()` is `@connector/coinbase`'s own transport and is **not**
  // interchangeable with `@core/platform`'s `HttpTransport` — the market-data
  // adapters above use the latter; these are two different seams with two
  // different policies and crossing them would silently drop one.
  const coinbase = options.coinbase ?? null;
  if (coinbase === null) {
    logger?.info(
      { provider: COINBASE_PROVIDER },
      'coinbase not configured; connector not registered',
    );
  } else {
    registry.register({
      connector: new CoinbaseConnector({
        transport: fetchTransport(),
        clock: options.clock ?? systemClock,
        ...(logger === undefined ? {} : { logger }),
      }),
      manifest: COINBASE_MANIFEST,
    });
    // The key's `view`-only permission is asserted by the connector at link
    // time against `key_permissions`, not here: this line records that an
    // adapter exists, and says nothing about what the key may do.
    logger?.info({ provider: COINBASE_PROVIDER }, 'coinbase configured; connector registered');
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
