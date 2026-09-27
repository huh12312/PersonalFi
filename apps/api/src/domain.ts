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
import {
  DateOnly,
  Money,
  Quantity,
  currency as toCurrency,
  isUuid,
  minorUnitScale,
  newId,
  systemClock,
  type Clock,
  type Money as MoneyType,
  type Quantity as QuantityType,
} from '@core/kernel';
import {
  appendEvent,
  classifyStatus,
  createEgressPolicy,
  createNodeTransport,
  guardUrl,
  systemResolver,
  type EgressPolicy,
  type Executor,
  type HttpTransport,
  type PlatformLogger,
  type TransactionalExecutor,
} from '@core/platform';
import type { SecretBox } from '@core/secretbox';
import {
  ConnectorRegistry,
  SyncOrchestrator,
  createCsvStagingStore,
  createManualStagingStore,
  investmentFactsForRun,
  liabilityTermsFor,
  type LedgerWriter,
  type RegisteredConnector,
  type RunInvestmentFacts,
} from '@ctx/connections';
import { listCategories, type LedgerPort } from '@ctx/categorization';
import {
  getPeriod,
  listBudgets,
  listPeriods,
  type BudgetingDatabase,
  type LedgerPort as BudgetingLedgerPort,
} from '@ctx/budgeting';
import { PERCENT_PER_ANNUM, percentStringToRatio } from '@ctx/insights';
import type {
  AccountTaxTreatment,
  BudgetPort as InsightsBudgetPort,
  CashAccountType,
  InsightsAccount,
  InsightsBudgetLine,
  InsightsBudgetPeriod,
  InsightsLiability,
  InsightsMarketRateObservation,
  InsightsPosition,
  InsightsRecurringStream,
  InsightsTransaction,
  InvestmentsPort as InsightsInvestmentsPort,
  LedgerPort as InsightsLedgerPort,
  LiabilityKind,
  MarketDataPort as InsightsMarketDataPort,
  MarketRateKind,
  MonthlyCashflowRow,
  RecurringPort as InsightsRecurringPort,
  SnapshotPorts as InsightsSnapshotPorts,
} from '@ctx/insights';
import { createNtfyChannel, createSmtpChannel, type ChannelRegistry } from '@ctx/notifications';
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
  ESPLORA_HOST,
  ETHERSCAN_HOST,
  WALLETRPC_MANIFEST,
  WALLETRPC_PROVIDER,
  WalletRpcConnector,
  etherscanApiKeyOf,
  missingEtherscanApiKey,
  type EsploraTransport,
  type EtherscanApiKey,
  type EtherscanTransport,
  type WalletAddressRecord,
  type WalletAddressStore,
} from '@connector/walletrpc';
import {
  DEFAULT_SUCCESS_TARGET,
  ENGINE_VERSION,
  GUYTON_KLINGER,
  MONTE_CARLO_VERSION,
  PROJECTION_BUCKETS,
  ReturnSeriesRefused,
  ageOn,
  assembleBaselinePlan,
  createProjectionInputsReader,
  currentRiskProfile,
  defaultFlagsFor,
  defaultTaxBucketFor,
  evaluateGoalPace,
  getBaseline,
  goalEvaluationStoreOf,
  isAssumptionsRefusal,
  isProjectionInputRefused,
  isProjectionRefused,
  liveEarmarksByAccount,
  loadReturnSeries,
  projectDeterministic,
  readProjection,
  resolveForUser,
  runMonteCarloInWorker,
  taxYear,
  type BaselineProfile,
  type DerivedInputs,
  type ProjectionPlan,
  type ResolvedAssumptions,
  type AccountKind as PlanningAccountKind,
  type BalanceObservation as PlanningBalanceObservation,
  type BalancesReader as PlanningBalancesReader,
  type CashflowAccount as PlanningCashflowAccount,
  type CashflowInflow as PlanningCashflowInflow,
  type CashflowReader as PlanningCashflowReader,
  type HoldingObservation as PlanningHoldingObservation,
  type HoldingsReader as PlanningHoldingsReader,
  type MonteCarloHostOptions,
  type MonteCarloRunner,
  type PlanningAccount,
  type PlanningExecutor,
  type ReturnSeries,
  type RevealedPorts as PlanningRevealedPorts,
  type SnapshotPorts,
  type SpendingReader as PlanningSpendingReader,
} from '@ctx/planning';
import {
  DEFAULT_LADDERS,
  LONG_TERM_HOLDING_DAYS,
  allocationOf,
  cashByAccount,
  cashPositionFor,
  cashSnapshotHistory,
  concentrationOf,
  createFxReader,
  createPriceReader,
  createSecurityResolver,
  drizzleAllocationTargetsStore,
  drizzleFxStore,
  drizzleLotStore,
  drizzlePriceStore,
  drizzleSecurityStore,
  drizzleSecurityTagsStore,
  feeDragOf,
  idleCash,
  marketValueOf,
  ratioOfMoney,
  valueByAccount,
  valueHoldings,
  ladderRows,
  outboxOf as investmentsOutboxOf,
  type CashPosition,
  type FigiMapper,
  type InvestmentSyncPort,
  type InvestmentsExecutor,
  type ResolvedHoldingFact,
  type ResolvedTransactionFact,
  type SecurityResolver,
  type ValuationOptions,
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
  ATTRIBUTIONS,
  COINGECKO_WINDOWS,
  FRED_MACRO_SERIES,
  FRED_WINDOWS,
  OPENFIGI_WINDOWS,
  TIINGO_WINDOWS,
  USER_AGENT,
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
  type FredSource,
  type MarketDataProvider,
  type MarketDataRunRecorder,
  type MarketDataWriter,
  type PriceSource,
  type RateBudget,
} from '@ctx/integrations';
import { marketDataRuns } from '@ctx/integrations/schema';
import { netWorthDaily, projectionRuns } from '@ctx/planning/schema';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
// The readers WP 3.9's routes use, imported rather than re-implemented: see the
// header over `createInsightsInvestmentsPort`. Type-only in the other
// direction (`routes/investments.ts` imports only `type RouteDeps` from
// `routes/deps.ts`, which is erased), so this adds no runtime cycle.
import {
  BASE_CURRENCY,
  priceHoldings,
  priceReaderFor,
  readHoldings,
  type HoldingRead,
} from './routes/investments.ts';

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
// WP 3.10a — the two Phase 3 insights ports
// ---------------------------------------------------------------------------
//
// `wp3.10-advisor-catalog-v2.md` §7.1 specified these and neither WP 3.9 nor
// WP 3.10 could own them: the port interfaces are `@ctx/insights`' and the
// readers are `@ctx/investments`', `@ctx/ledger`'s, `@ctx/connections`' and
// `@ctx/integrations`'. This file is the only place all five are in scope at
// once, which is the whole reason a composition root exists.
//
// **They read exactly what WP 3.9's routes read.** `readHoldings`,
// `priceReaderFor` and `priceHoldings` are imported from `routes/investments.ts`
// rather than re-implemented, so `GET /investments/holdings` and
// `holdings.aggregate` cannot disagree about what the account holder owns. A
// second valuation path is the failure wp3.9-routes.md's own header warns
// about — "a valuation engine that agreed with the first one right up until it
// did not".

/**
 * The stablecoin tickers X3 reasons about.
 *
 * A reviewed list rather than an inference: "is this a dollar-pegged token?" is
 * a *classification*, and the honest home for it is `@ctx/investments`'
 * `classify.ts` beside `is_cash_equivalent`. It is here because that context is
 * not this work package's, and it is a list of tickers rather than a heuristic
 * on the name because `USDC.e` and `USD Coin` and a fund called "Dollar Income"
 * are three different things and only an enumeration tells them apart.
 *
 * **Carried for the orchestrator:** move this to `classify.ts` and give
 * `securities` an `is_stablecoin` column derived the same way `is_cash_equivalent`
 * is, so a user override can reach it.
 */
export const STABLECOIN_SYMBOLS: ReadonlySet<string> = new Set([
  'USDC',
  'USDT',
  'DAI',
  'PYUSD',
  'BUSD',
  'TUSD',
  'USDP',
  'GUSD',
  'FDUSD',
  'USDE',
  'LUSD',
  'FRAX',
]);

/**
 * An account's tax treatment, from `@ctx/ledger`'s provider `subtype` string.
 *
 * The same best-effort text match `cashAccountTypeOf` above does, and for the
 * same reason: `@ctx/ledger` has no closed enum for `subtype` because it is
 * long, provider-specific and changes without notice. What is different is the
 * **direction of the default**: anything unrecognised is `'unknown'`, never
 * `'taxable'`. I6 only proposes harvesting a loss in a taxable account, and a
 * mis-defaulted IRA would make it propose a trade with no tax effect at all —
 * so the guess that costs nothing is the one this returns.
 */
function accountTaxTreatmentOf(account: AccountSummary): AccountTaxTreatment {
  const subtype = (account.subtype ?? '').toLowerCase().replaceAll(/[^a-z0-9]/gu, '');
  if (subtype.includes('roth') || subtype.includes('hsa') || subtype.includes('529')) {
    return 'tax_free';
  }
  if (
    subtype.includes('401k') ||
    subtype.includes('403b') ||
    subtype.includes('457b') ||
    subtype.includes('ira') ||
    subtype.includes('sep') ||
    subtype.includes('simple') ||
    subtype.includes('pension') ||
    subtype.includes('retirement')
  ) {
    return 'tax_deferred';
  }
  if (subtype.includes('brokerage') || subtype.includes('taxable')) return 'taxable';
  // A crypto account is taxable by default: there is no tax-advantaged wrapper
  // for a self-custody wallet, and treating one as `unknown` would silence X5.
  if (account.type === 'crypto') return 'taxable';
  return 'unknown';
}

/** `'0.0003'` (a decimal string) → `0.0003`. `null` stays `null`. */
function ratioNumberOrNull(text: string | null): number | null {
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** Which custody class an account's crypto sits in. X2's three-way split. */
type CustodyClass = 'exchange' | 'self_custody' | 'unknown';

/**
 * `@ctx/insights`' read-only view of the portfolio and its liabilities.
 *
 * Both methods answer `null` rather than an empty block when there is nothing
 * to say, because the builder turns `null` into **no key** and an advisor
 * cannot tell an empty portfolio from no portfolio.
 *
 * Three figures used to be unconditional stand-ins — `targets: []`,
 * `idleCash: null`, `employerStock: false` — each with its own reason (no
 * `allocation_targets` table, no dwell history, no employer-tag column;
 * `wp3.9-routes.md` §8, `wp3.10a-snapshot-readers.md` §7.2). WP 4.7
 * (`@ctx/investments`' `targets.ts`, `tags.ts`, `dwell.ts`, migration 0026) gave
 * all three a real source, and this function composes them
 * (docs/evidence/phase-4/wp4.7-gap-fields.md §7.1):
 *
 *   * **`targets`** reads `allocation_targets` through
 *     `drizzleAllocationTargetsStore` — empty when the holder has set none,
 *     never a default 60/40 (§8 Q9 still forbids implying one).
 *   * **`employerStock`** reads `security_tags` through
 *     `drizzleSecurityTagsStore` — set explicitly by the holder, never
 *     inferred from a ticker or a name (07 I5's own rule, unchanged; only the
 *     source of the flag moved from "no column" to "a column nothing writes
 *     without being asked").
 *   * **`idleCash`** composes this context's own `cashSnapshotHistory` /
 *     `cashPositionFor` (the dwell history `idleCash(...)`'s own doc says it
 *     cannot derive itself) with `@ctx/planning`'s `liveEarmarksByAccount` —
 *     read here, at the one place both contexts are in scope, and nowhere
 *     inside either context.
 */
export function createInsightsInvestmentsPort(
  database: Database,
  clock: Clock,
): InsightsInvestmentsPort {
  const lotStore = drizzleLotStore(database, clock);
  // WP 4.7's two gap-field stores, over `allocation_targets` and
  // `security_tags` (migration 0026) — see this function's header and
  // docs/evidence/phase-4/wp4.7-gap-fields.md §7.1.
  const targetsStore = drizzleAllocationTargetsStore(database, clock);
  const tagsStore = drizzleSecurityTagsStore(database, clock);

  /**
   * `last_known`, not `as_of_now`.
   *
   * `as_of_now` *excludes* a stale-priced holding from the valuation, which is
   * right for a delta and wrong for a snapshot: an advisor would see a
   * portfolio silently missing whichever positions had not refreshed, and
   * reason about the concentration of what remained. 07 §6.1 bars a stale price
   * from a delta, not from a level, and WP 3.8's net-worth snapshot seals with
   * the same choice.
   */
  const options = (): ValuationOptions => ({
    currency: BASE_CURRENCY,
    scale: minorUnitScale(BASE_CURRENCY),
    basis: 'last_known',
  });

  /** Account id → its tax treatment and custody class, in one read. */
  const accountFacts = async (
    userId: string,
  ): Promise<
    ReadonlyMap<string, { readonly treatment: AccountTaxTreatment; readonly custody: CustodyClass }>
  > => {
    const accounts = await listAccounts(database, { userId, includeClosed: true });
    // Which connections hold a watch-only wallet address. A connection with one
    // is self-custody by construction: we hold an address and no keys, which is
    // the definition of the holder keeping custody. Everything else that came
    // from a provider is an exchange or a broker, and a manual account is
    // `unknown` because the holder never told us either way.
    const selfCustodied = await database.execute<{ connection_id: string }>(sql`
      SELECT DISTINCT w.connection_id
        FROM wallet_addresses w
       WHERE w.user_id = ${userId}::uuid
    `);
    const wallets = new Set(selfCustodied.rows.map((row) => row.connection_id));
    return new Map(
      accounts.map((account) => [
        account.id,
        {
          treatment: accountTaxTreatmentOf(account),
          custody:
            account.connectionId === null
              ? ('unknown' as const)
              : wallets.has(account.connectionId)
                ? ('self_custody' as const)
                : ('exchange' as const),
        },
      ]),
    );
  };

  return {
    async holdings(input) {
      const reads = await readHoldings(database, input.userId, null);
      if (reads.length === 0) return null;

      const kinds = new Map<string, string>(
        reads.map((read) => [read.securityId, read.securityType]),
      );
      const portfolio = await priceHoldings(
        reads,
        priceReaderFor(database, input.userId, clock, kinds),
        input.asOf,
      );
      const valuation = options();
      const set = valueHoldings(portfolio.holdings, valuation);
      if (set.valued.length === 0) return null;

      const allocation = allocationOf('asset_class', set, valuation);
      const concentration = concentrationOf(set, valuation);
      const fees = feeDragOf(set, valuation);
      const facts = await accountFacts(input.userId);
      const readById = new Map(reads.map((read) => [read.holdingId, read]));
      const asOf = DateOnly.parse(input.asOf);

      // --- WP 4.7's gap-field sources: targets, employer tags, idle cash -----
      //
      // `targets` and `employerStock` read `@ctx/investments`' own new stores
      // (`allocation_targets`, `security_tags`); idle cash composes this
      // context's own dwell history (`cashSnapshotHistory` + `cashPositionFor`)
      // with `@ctx/planning`'s earmark reader (`liveEarmarksByAccount`) — this
      // file is the composition root, so it may read both contexts even though
      // neither of them reads the other. Exact composition:
      // docs/evidence/phase-4/wp4.7-gap-fields.md §7.1.
      const targets = await targetsStore.listAll(input.userId);
      const securityIds = [...new Set(reads.map((read) => read.securityId))];
      const tagsBySecurity = await tagsStore.listForMany(input.userId, securityIds);
      const employerStockOf = (securityId: string): boolean =>
        tagsBySecurity.get(securityId)?.has('employer_stock') ?? false;

      const earmarksByAccount = await liveEarmarksByAccount(database, input.userId);
      const cashPositions: CashPosition[] = await Promise.all(
        [...cashByAccount(set).entries()].map(async ([accountId, cash]) => {
          const history = await cashSnapshotHistory(database, {
            userId: input.userId,
            accountId,
            asOfDate: asOf,
            currency: BASE_CURRENCY,
          });
          return cashPositionFor(
            {
              accountId,
              asOfDate: asOf,
              cash,
              accountValue: valueByAccount(set).get(accountId) ?? cash,
              earmarkedAmount: earmarksByAccount.get(accountId) ?? Money.zero(BASE_CURRENCY),
            },
            history,
          );
        }),
      );
      const idle =
        cashPositions.length === 0 ? null : idleCash(cashPositions, { currency: BASE_CURRENCY });

      // --- account_type_mix: value by tax treatment ÷ total ------------------
      const byTreatment = new Map<string, MoneyType>();
      for (const entry of set.valued) {
        const treatment = facts.get(entry.holding.accountId)?.treatment ?? 'unknown';
        byTreatment.set(
          treatment,
          Money.add(byTreatment.get(treatment) ?? Money.zero(BASE_CURRENCY), entry.marketValue),
        );
      }
      const accountTypeMix: Record<string, number> = {};
      if (!Money.isZero(set.total)) {
        for (const [treatment, value] of byTreatment) {
          accountTypeMix[treatment] = Number(ratioOfMoney(value, set.total));
        }
      }

      // --- crypto_custody: CRYPTO value by custody class ---------------------
      const custody: Record<CustodyClass, MoneyType> = {
        exchange: Money.zero(BASE_CURRENCY),
        self_custody: Money.zero(BASE_CURRENCY),
        unknown: Money.zero(BASE_CURRENCY),
      };
      let anyCrypto = false;
      for (const entry of set.valued) {
        if (entry.holding.assetClass !== 'CRYPTO') continue;
        anyCrypto = true;
        const key = facts.get(entry.holding.accountId)?.custody ?? 'unknown';
        custody[key] = Money.add(custody[key], entry.marketValue);
      }

      // --- holdings.detail: one row per (security, tax treatment) ------------
      //
      // Not per security alone. The same ETF in a taxable account and in an IRA
      // is two positions, because I6 only proposes harvesting a *taxable* loss
      // and a merged row would make a tax-deferred one look harvestable.
      interface Group {
        readonly read: HoldingRead;
        readonly treatment: AccountTaxTreatment;
        readonly accountIds: Set<string>;
        quantity: QuantityType;
        marketValue: MoneyType;
        costBasis: MoneyType;
        basisUnknown: boolean;
        annualFeeCost: MoneyType | null;
        highFee: boolean;
      }
      const feeByHolding = new Map(fees.rows.map((row) => [row.holdingId, row]));
      const groups = new Map<string, Group>();
      for (const entry of set.valued) {
        const read = readById.get(entry.holding.holdingId);
        if (read === undefined) continue;
        const treatment = facts.get(entry.holding.accountId)?.treatment ?? 'unknown';
        const key = `${read.securityId}|${treatment}`;
        const group = groups.get(key) ?? {
          read,
          treatment,
          accountIds: new Set<string>(),
          quantity: Quantity.zero,
          marketValue: Money.zero(BASE_CURRENCY),
          costBasis: Money.zero(BASE_CURRENCY),
          basisUnknown: false,
          annualFeeCost: null,
          highFee: false,
        };
        group.accountIds.add(entry.holding.accountId);
        group.quantity = Quantity.add(group.quantity, entry.holding.quantity);
        group.marketValue = Money.add(group.marketValue, entry.marketValue);
        // One unknown basis poisons the sum. 04 §5.5: an unknown basis is not a
        // zero one, and a partial total is a number that looks whole.
        if (read.costBasis === null) group.basisUnknown = true;
        else group.costBasis = Money.add(group.costBasis, read.costBasis);
        const fee = feeByHolding.get(entry.holding.holdingId);
        if (fee !== undefined) {
          group.annualFeeCost = Money.add(
            group.annualFeeCost ?? Money.zero(BASE_CURRENCY),
            fee.annualCost,
          );
          group.highFee = group.highFee || fee.high;
        }
        groups.set(key, group);
      }

      const positions: InsightsPosition[] = [];
      for (const group of groups.values()) {
        const point = portfolio.points.get(
          [...set.valued].find((entry) => entry.holding.securityId === group.read.securityId)
            ?.holding.holdingId ?? '',
        );
        const lots = (await lotStore.listLotsForSecurity(input.userId, group.read.securityId))
          .filter((lot) => group.accountIds.has(lot.accountId))
          .filter((lot) => !Quantity.isZero(lot.quantityRemaining));
        const basisKnown = !group.basisUnknown;
        const costBasis = basisKnown ? group.costBasis : null;
        positions.push({
          securityId: group.read.securityId,
          symbol: group.read.symbol,
          assetClass: group.read.assetClass,
          accountType: group.treatment,
          quantity: Quantity.toDatabaseString(group.quantity),
          costBasis,
          marketValue: group.marketValue,
          unrealized: costBasis === null ? null : Money.subtract(group.marketValue, costBasis),
          oldestLotDays: lots.reduce(
            (oldest, lot) => Math.max(oldest, DateOnly.differenceInDays(lot.openDate, asOf)),
            0,
          ),
          isCrypto: group.read.assetClass === 'CRYPTO',
          isStablecoin:
            group.read.symbol !== null && STABLECOIN_SYMBOLS.has(group.read.symbol.toUpperCase()),
          // 07 I5: the holder's own tag, over `security_tags` (WP 4.7,
          // migration 0026) — set explicitly, never inferred.
          employerStock: employerStockOf(group.read.securityId),
          expenseRatio: ratioNumberOrNull(group.read.expenseRatio),
          // No comparable-fund table exists in any Phase 3 source, so I2 fires
          // on the absolute `high_fee` trigger and never on the relative one.
          peerExpenseRatio: null,
          annualFeeCost: group.annualFeeCost,
          highFee: group.highFee,
          lots: lots.map((lot) => {
            const remainingBasis =
              lot.basis === null ? null : Money.subtract(lot.basis, lot.basisConsumed);
            const marketValue =
              point === null || point === undefined
                ? Money.zero(BASE_CURRENCY)
                : marketValueOf(
                    lot.quantityRemaining,
                    { amount: Quantity.of(point.close), currency: toCurrency(point.currency) },
                    minorUnitScale(BASE_CURRENCY),
                  );
            return {
              // An age, never the date. The subtraction happens here because it
              // needs the date, and the date stops here.
              openedDays: DateOnly.differenceInDays(lot.openDate, asOf),
              quantity: Quantity.toDatabaseString(lot.quantityRemaining),
              costBasis: remainingBasis,
              marketValue,
              unrealized:
                remainingBasis === null ? null : Money.subtract(marketValue, remainingBasis),
              longTerm:
                DateOnly.differenceInDays(lot.holdingPeriodStartDate, asOf) >=
                LONG_TERM_HOLDING_DAYS,
            };
          }),
        });
      }

      return {
        currency: BASE_CURRENCY,
        aggregate: {
          investableTotal: concentration.investableTotal,
          unclassifiedPct: Number(allocation.unclassifiedPct),
          byAssetClass: allocation.slices.map((slice) => ({
            assetClass: slice.key,
            value: slice.value,
            weight: Number(slice.weight),
          })),
          positions: concentration.positions.map((position) => ({
            securityId: position.securityId,
            symbol: position.symbol,
            value: position.value,
            weight: Number(position.weight),
            assetClass:
              readById.get(
                set.valued.find((entry) => entry.holding.securityId === position.securityId)
                  ?.holding.holdingId ?? '',
              )?.assetClass ?? 'UNCLASSIFIED',
            employerStock: employerStockOf(position.securityId),
            isCrypto:
              set.valued.find((entry) => entry.holding.securityId === position.securityId)?.holding
                .assetClass === 'CRYPTO',
          })),
          targets: targets.map((target) => ({
            assetClass: target.assetClass,
            weight: Number(target.targetWeight),
          })),
          accountTypeMix,
          idleCash:
            idle === null
              ? null
              : {
                  total: idle.idleTotal,
                  floor: idle.floor,
                  minDays: idle.minDays,
                  longestIdleDays: idle.rows.reduce((max, row) => Math.max(max, row.idleDays), 0),
                },
          cryptoCustody: anyCrypto
            ? {
                exchangeValue: custody.exchange,
                selfCustodyValue: custody.self_custody,
                unknownValue: custody.unknown,
              }
            : null,
        },
        positions,
      };
    },

    async liabilities(input) {
      const accounts = (await listAccounts(database, { userId: input.userId })).filter(
        (account) => account.classification === 'liability' && account.closedAt === null,
      );
      if (accounts.length === 0) return null;

      // WP 3.7's published reader (migration 0018). **Read what it lands, never
      // a fake**: an account with no terms row is still a liability — it has a
      // balance — and it crosses with every term `null`, which is the state D2
      // and D4 gate on. A fabricated APR would be the one number in this block
      // nobody could trace.
      const terms = new Map(
        (await liabilityTermsFor(database, input.userId)).map((row) => [row.accountId, row]),
      );

      const rows: InsightsLiability[] = accounts.map((account) => {
        const term = terms.get(account.id) ?? null;
        const balance = account.balance?.current ?? Money.zero(account.currency);
        return {
          id: account.id,
          kind: liabilityKindOf(account),
          // `connection_sync_facts.apr` is a percentage as an exact decimal
          // (`NUMERIC(9,6)`; "4.25% is not $4.25", says 0018). The snapshot
          // carries a ratio, and `percentStringToRatio` is the same conversion
          // `market.rates` uses — one implementation, one place to get it wrong.
          apr:
            term?.apr === null || term?.apr === undefined ? null : percentStringToRatio(term.apr),
          // Not persisted by any leg. WP 3.7's `LiabilityTerms` carries an APR,
          // a statement balance, a minimum payment and a due date, and nothing
          // else; D4 and D6 therefore ship off with the field named.
          promoApr: null,
          promoAprEndDate: null,
          creditLimit: null,
          statementBalance: term?.statementBalance ?? null,
          // A liability's balance is negative in the ledger's sign convention
          // (it counts against net worth). The block states what is *owed*, as
          // a positive figure, because every rule that reads it multiplies by a
          // rate and a negative would flip the sign of the cost.
          currentBalance: Money.absolute(balance),
          minimumPayment: term?.minimumPayment ?? null,
          paymentDueDate: term?.nextPaymentDue ?? null,
          lastPaymentDate: null,
          lastPaymentAmount: null,
          minimumOnlyMonths: null,
        };
      });
      return { currency: BASE_CURRENCY, liabilities: rows };
    },
  };
}

/**
 * `@ctx/ledger`'s account type and subtype, as one of the seven liability kinds.
 *
 * `type` first because it is a closed CHECK and `subtype` is provider free
 * text: a `credit` account is a card whatever the provider called the subtype,
 * and only a `loan` needs the text to say which kind of loan it is.
 */
function liabilityKindOf(account: AccountSummary): LiabilityKind {
  const subtype = (account.subtype ?? '').toLowerCase();
  if (account.type === 'credit') {
    return subtype.includes('line of credit') || subtype.includes('heloc')
      ? 'line_of_credit'
      : 'credit_card';
  }
  if (subtype.includes('student')) return 'student_loan';
  if (subtype.includes('mortgage') || subtype.includes('home')) return 'mortgage';
  if (subtype.includes('auto') || subtype.includes('car')) return 'auto_loan';
  if (subtype.includes('line of credit') || subtype.includes('heloc')) return 'line_of_credit';
  if (account.type === 'loan') return 'personal_loan';
  return 'other';
}

/**
 * The FRED series this deployment tracks, and what each one *is*.
 *
 * Three columns and every one of them load-bearing:
 *
 *   * **`kind` is the join key.** A rule selects `short_term_risk_free`, never
 *     `'DGS3MO'`. WP 3.10's schema comment says why: a rule naming the series
 *     would break the day a deployment tracked `TB3MS` instead, and would also
 *     be a series id hardcoded in a rule — the cousin of the hardcoded 4%.
 *   * **`units` is declared, not fetched.** FRED's `/series/observations`
 *     endpoint returns a value and a date and no units at all; the units are a
 *     property of the *series*, which is a fact about the world that belongs in
 *     a reviewed table rather than in a second API call whose answer would be
 *     cached anyway.
 *   * **A non-percent series is allowed in this table on purpose.** `CPIAUCSL`
 *     is an index and `SnapshotBuilder` refuses it (§7.1 duty 1). Listing it
 *     here is what keeps that refusal exercised against a real series id rather
 *     than only against a test fixture.
 */
export const TRACKED_MACRO_SERIES: readonly {
  readonly seriesId: string;
  readonly kind: MarketRateKind;
  readonly units: string;
}[] = Object.freeze([
  Object.freeze({
    seriesId: FRED_MACRO_SERIES.treasury3m,
    kind: 'short_term_risk_free' as const,
    units: PERCENT_PER_ANNUM,
  }),
  Object.freeze({
    seriesId: FRED_MACRO_SERIES.treasury10y,
    kind: 'ten_year_treasury' as const,
    units: PERCENT_PER_ANNUM,
  }),
  // National rate on savings deposits. C1 and C2's "what could this cash earn?"
  Object.freeze({ seriesId: 'SNDR', kind: 'savings_apy' as const, units: PERCENT_PER_ANNUM }),
  // Commercial bank interest rate on credit card plans, all accounts. D2's card half.
  Object.freeze({
    seriesId: 'TERMCBCCALLNS',
    kind: 'credit_card_apr' as const,
    units: PERCENT_PER_ANNUM,
  }),
  Object.freeze({
    seriesId: 'MORTGAGE30US',
    kind: 'mortgage_30y' as const,
    units: PERCENT_PER_ANNUM,
  }),
]);

/** How far back `macro()` will walk for an observation. See the port below. */
const MACRO_LOOKBACK_DAYS = 10;

/**
 * `@ctx/insights`' read-only view of the published market rates.
 *
 * `source` is `undefined` whenever no FRED key is configured — **feature
 * detection, never a fallback figure**. WP 2.7 is explicit that "a hardcoded 4%
 * would be a numeral nothing could account for", so no key means no block, and
 * C1, C2 and X3 fall back to the best rate the account holder already holds,
 * byte-identically to Phase 2. D2 simply withholds.
 *
 * **Why this walks back a few days.** FRED publishes daily series on business
 * days only, and `/series/observations` windowed to a single date answers
 * `no_data` for a Sunday. Asking only for `asOf` would leave the whole block
 * absent every weekend. So it walks back up to ten days for the most recent
 * observation, reports **that** observation's own date in `observation_date`,
 * and lets `SnapshotBuilder` decide staleness from when the provider *answered*
 * rather than from when the market last printed — a Treasury series is not
 * stale on a Monday morning.
 */
export function createInsightsMarketDataPort(options: {
  /** `createMarketDataRuntime(...)`'s FRED source, or `undefined` with no key. */
  readonly source: FredSource | undefined;
  readonly series?: readonly {
    readonly seriesId: string;
    readonly kind: MarketRateKind;
    readonly units: string;
  }[];
}): InsightsMarketDataPort {
  const source = options.source;
  const series = options.series ?? TRACKED_MACRO_SERIES;
  return {
    async rates(input) {
      if (source === undefined || !source.hasKey) return null;

      const observations: InsightsMarketRateObservation[] = [];
      for (const tracked of series) {
        let observation: InsightsMarketRateObservation | null = null;
        for (let back = 0; back <= MACRO_LOOKBACK_DAYS; back += 1) {
          const date = DateOnly.addDays(input.asOf, -back);
          const outcome = await source.macro(tracked.seriesId, date);
          if (outcome.kind !== 'ok') continue;
          observation = {
            seriesId: tracked.seriesId,
            kind: tracked.kind,
            observationDate: DateOnly.parse(outcome.value.date),
            value: outcome.value.value,
            units: tracked.units,
            // When the provider answered, which for a live call is now — and
            // `asOf` is the holder's own today, already resolved into their
            // zone by the caller. `SnapshotBuilder` compares the two.
            observedOn: input.asOf,
          };
          break;
        }
        if (observation !== null) observations.push(observation);
      }
      if (observations.length === 0) return null;

      // Verbatim, ® included. 01 §4.3 makes the sentence a licence condition
      // and a paraphrase of a licence condition is a new licence condition, so
      // this is the context's own constant and never a string literal here.
      return {
        attribution: ATTRIBUTIONS.fred.text,
        attributionUrl: ATTRIBUTIONS.fred.linkUrl,
        observations,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// WP 4.9 — the insights planning port (`goals.list`, `risk.profile`,
// `plan.projection`)
// ---------------------------------------------------------------------------
//
// The same arrangement as `createInsightsInvestmentsPort` above, one context
// over: `@ctx/insights` declares `PlanningPort` and may not import
// `@ctx/planning`; this file is where both are in scope, so the reduction —
// goal facts to a pace verdict, a birth date to an age, a run date to a year,
// two balances to a share — happens here and nowhere else.
//
// **It reads; it never runs anything.** `readProjection` and the newest-run
// lookup below read stored rows. The deterministic engine *is* called — for
// the Social Security factors and this year's withdrawal rate — but it is a
// pure function over the baseline's own profile and the run's own
// starting-balance day, and it writes nothing: no `projection_runs` row, no
// `ProjectionCompleted`. A snapshot that caused a stored run would be a read
// with a side effect no advisor asked for.

/** `@ctx/insights`' `PlanningPort`, named through the exported `SnapshotPorts`. */
type InsightsPlanningPort = NonNullable<InsightsSnapshotPorts['planning']>;
type InsightsGoalRow = NonNullable<Awaited<ReturnType<InsightsPlanningPort['goals']>>>[number];
type InsightsPlanProjection = NonNullable<Awaited<ReturnType<InsightsPlanningPort['projection']>>>;

/**
 * 07 §5.6's `initial_wr = 0.045 # user-settable`: the rate the guardrail band
 * is drawn around for R7. The multiples are WP 4.4's `GUYTON_KLINGER`; this is
 * the one number the band needs that WP 4.2's assumptions file does not carry.
 * **Carried:** 07 marks it user-settable, so it belongs in the assumptions file
 * as an overridable, cited value — recorded in `wp4.9-advisor-catalog-v3.md`.
 */
const GUARDRAIL_REFERENCE_RATE = '0.045';

/** Six-place fixed point for the ratios below. Never a float. */
const MICRO = 1_000_000n;

/** A non-negative decimal (`'0.045'`, `'1.2'`, `0.8`) → micro-units. */
function toMicros(decimal: string | number): bigint {
  const text = String(decimal);
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}

/** Micro-units → the shortest decimal string (`36000n` → `'0.036'`). */
function fromMicros(micros: bigint): string {
  const whole = micros / MICRO;
  const fraction = (micros % MICRO).toString().padStart(6, '0').replace(/0+$/u, '');
  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** `numerator ÷ denominator` to `places` decimals, half-even, as a string. */
function ratioText(numerator: bigint, denominator: bigint, places: number): string {
  const scale = 10n ** BigInt(places);
  const scaled = numerator * scale;
  let quotient = scaled / denominator;
  const twice = (scaled % denominator) * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
  const text = quotient.toString().padStart(places + 1, '0');
  const fraction = text.slice(-places).replace(/0+$/u, '');
  const whole = text.slice(0, -places);
  return fraction === '' ? whole : `${whole}.${fraction}`;
}

/**
 * The newest `net_worth_daily` date on or before `asOf` — the day goal pace
 * reads balances from when today has no row yet (the 04:00 snapshotter has not
 * run, or a holder's first day). Without it a goal funded from its accounts
 * would read as funded by nothing and be reported off track. One scoping
 * predicate, `user_id`, and the S1 sabotage matrix in `phase4-advisors.test.ts`
 * drops it.
 */
async function newestNetWorthDay(
  database: Database,
  userId: string,
  asOf: DateOnly,
): Promise<DateOnly | null> {
  const rows = await database
    .select({ asOfDate: netWorthDaily.asOfDate })
    .from(netWorthDaily)
    .where(and(eq(netWorthDaily.userId, userId), lte(netWorthDaily.asOfDate, asOf)))
    .orderBy(desc(netWorthDaily.asOfDate))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : DateOnly.parse(String(row.asOfDate).slice(0, 10));
}

/**
 * The newest run of the holder's **baseline**. Two scoping predicates — the
 * holder and the baseline scenario — and `readProjection` then re-reads the run
 * by `(user_id, id)`, a third. A fork's run is a what-if and never the plan
 * R2 speaks about.
 */
async function newestBaselineRunId(
  database: Database,
  userId: string,
  baselineId: string,
): Promise<string | null> {
  const rows = await database
    .select({ id: projectionRuns.id })
    .from(projectionRuns)
    .where(and(eq(projectionRuns.userId, userId), eq(projectionRuns.scenarioId, baselineId)))
    .orderBy(desc(projectionRuns.createdAt), desc(projectionRuns.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** An expected refusal from `@ctx/planning` — the sub-block is absent, never invented. */
function isPlanningRefusal(error: unknown): boolean {
  return (
    isProjectionRefused(error) || isProjectionInputRefused(error) || isAssumptionsRefusal(error)
  );
}

async function orNull<T>(work: () => Promise<T> | T): Promise<T | null> {
  try {
    return await work();
  } catch (error) {
    if (isPlanningRefusal(error)) return null;
    throw error;
  }
}

/**
 * R1's two rates over one income. `plan` is what the baseline's contributions
 * come to — stated where the holder stated them, WP 4.3's derived figure where
 * not — and `observed` is the derived figure alone. Same denominator, same
 * derivation, so a plan with nothing stated agrees with itself exactly.
 */
function savingsRateOf(
  profile: BaselineProfile,
  derived: DerivedInputs,
): InsightsPlanProjection['savingsRate'] {
  const income = derived.annualIncome;
  if (income === null || income.minor <= 0n) return null;
  let planned = 0n;
  let observed = 0n;
  let stated = false;
  for (const bucket of PROJECTION_BUCKETS) {
    const fromProfile = profile.contributions?.[bucket];
    const fromData = derived.contributions[bucket];
    if (fromProfile !== undefined) stated = true;
    planned += (fromProfile ?? fromData)?.minor ?? 0n;
    observed += fromData?.minor ?? 0n;
  }
  if (planned < 0n || observed < 0n) return null;
  return {
    plan: ratioText(planned, income.minor, 4),
    observed: ratioText(observed, income.minor, 4),
    planSource: stated ? 'stated' : 'derived',
  };
}

/**
 * R3: SECURE 2.0's start age for the birth year — from the run year's table in
 * WP 4.2's file, never a constant here — and the tax-deferred share. A year the
 * file does not cover throws `AssumptionsYearUnavailable`, which the caller
 * turns into an absent sub-block.
 */
function rmdOf(
  profile: BaselineProfile,
  resolved: ResolvedAssumptions,
  derived: DerivedInputs,
  year: number,
): InsightsPlanProjection['rmd'] {
  const birthYear = BigInt(DateOnly.year(profile.birthDate));
  const cohort = taxYear(resolved, year).rmd.startAge.value.find(
    (row) =>
      BigInt(row.bornFrom) <= birthYear &&
      (row.bornThrough === null || birthYear <= BigInt(row.bornThrough)),
  );
  if (cohort === undefined) return null;
  const buckets = derived.balances.byBucket;
  let total = 0n;
  for (const bucket of PROJECTION_BUCKETS) total += buckets[bucket].minor;
  if (total <= 0n) return null;
  const startAge = Number.parseInt(cohort.age, 10);
  return {
    startAge,
    startYear: Number(birthYear) + startAge,
    taxDeferredShare: ratioText(buckets.TAX_DEFERRED.minor, total, 4),
  };
}

/** R4: the statutory claim factor at the plan's age and at seventy, from the engine itself. */
function socialSecurityOf(
  plan: ProjectionPlan,
  resolved: ResolvedAssumptions,
  currentAge: number,
): InsightsPlanProjection['socialSecurity'] {
  const social = plan.socialSecurity;
  // At seventy or past it there is no later age to compare; the block is
  // absent rather than carrying a comparison with nothing on one side.
  if (social === null || currentAge >= 70) return null;
  const asPlanned = projectDeterministic(plan, resolved).socialSecurity;
  const atSeventy = projectDeterministic(
    { ...plan, socialSecurity: { ...social, claimAge: { years: 70, months: 0 } } },
    resolved,
  ).socialSecurity;
  if (asPlanned === null || atSeventy === null) return null;
  return {
    claimAgeYears: asPlanned.claimAge.years,
    claimAgeMonths: asPlanned.claimAge.months,
    claimFactor: asPlanned.claimFactor,
    factorAt70: atSeventy.claimFactor,
  };
}

/**
 * R7: this year's portfolio withdrawal rate — `(spending − income) ÷ portfolio`,
 * G-K's own definition (`guardrails.ts`' header) — off the engine's first year,
 * and the band around 07 §5.6's reference rate. Present only in decumulation
 * and only when the portfolio funds something.
 */
function guardrailOf(
  plan: ProjectionPlan,
  resolved: ResolvedAssumptions,
): InsightsPlanProjection['guardrail'] {
  const first = projectDeterministic(plan, resolved).years[0];
  if (first?.phase !== 'retirement') return null;
  const income = Money.add(Money.add(first.socialSecurity, first.pension), first.otherIncome);
  const drawn = Money.subtract(first.spending, income);
  if (drawn.minor <= 0n || first.startWealth.minor <= 0n) return null;
  const withdrawalRate = ratioText(drawn.minor, first.startWealth.minor, 4);
  const reference = toMicros(GUARDRAIL_REFERENCE_RATE);
  const lower = (reference * toMicros(GUYTON_KLINGER.lowerMultiple)) / MICRO;
  const upper = (reference * toMicros(GUYTON_KLINGER.upperMultiple)) / MICRO;
  const rate = toMicros(withdrawalRate);
  return {
    withdrawalRate,
    referenceRate: GUARDRAIL_REFERENCE_RATE,
    lower: fromMicros(lower),
    upper: fromMicros(upper),
    position: rate > upper ? 'above' : rate < lower ? 'below' : 'within',
  };
}

/**
 * `@ctx/insights`' read-only view of Planning.
 *
 *   * **`goals`** is WP 4.6's `evaluateGoalPace` over `goalEvaluationStoreOf`'s
 *     facts — the same verdict the goal-pace consumer emits `GoalOffTrack`
 *     from, so the insight and the event cannot disagree about a goal. Months
 *     are counted from `asOf`; balances come from `asOf`'s net-worth row, or
 *     the newest before it.
 *   * **`riskProfile`** is WP 4.1's `currentRiskProfile`, minus the answers
 *     and the penalty.
 *   * **`projection`** is the newest stored baseline run through
 *     `readProjection` (staleness included), reduced to ratios, ages and years,
 *     with the optional sub-blocks computed from the run's own starting day.
 *
 * `timeZone` dates an assumption override the way every planning read does
 * (`resolveForUser`); the builder itself never reads a clock.
 */
export function createInsightsPlanningPort(
  database: Database,
  clock: Clock,
  options: { readonly timeZone: string },
): InsightsPlanningPort {
  const revealed = (userId: string) =>
    planningRevealedPortsFor(database, { userId, timeZone: options.timeZone, clock });

  return {
    async goals(input) {
      const balancesOn =
        (await newestNetWorthDay(database, input.userId, input.asOf)) ?? input.asOf;
      const facts = await goalEvaluationStoreOf(database, clock).facts(input.userId, balancesOn);
      const byId = new Map(facts.goals.map((goal) => [goal.id, goal]));
      const rows: InsightsGoalRow[] = [];
      for (const verdict of evaluateGoalPace(facts, input.asOf)) {
        if (verdict.status === 'not_evaluable') continue;
        const goal = byId.get(verdict.goalId);
        if (goal === undefined) continue;
        rows.push({
          id: goal.id,
          name: goal.name,
          target: verdict.target,
          monthsRemaining: verdict.monthsRemaining,
          fundedRatio: verdict.fundedRatio,
          status: verdict.status,
          requiredMonthly: verdict.requiredMonthly,
          plannedMonthly: verdict.plannedMonthly,
        });
      }
      return rows.length === 0 ? null : rows;
    },

    async riskProfile(input) {
      const profile = await currentRiskProfile(database, input.userId);
      if (profile === null) return null;
      return {
        tolerance: profile.tolerance,
        horizonYears: profile.horizonYears,
        taxBracketBand: profile.taxBracketBand,
        liquidityNeed: profile.liquidityNeed,
      };
    },

    async projection(input) {
      const baseline = await getBaseline(database, input.userId);
      if (baseline === null) return null;
      const runId = await newestBaselineRunId(database, input.userId, baseline.id);
      if (runId === null) return null;
      const read = await orNull(() =>
        readProjection(database, { userId: input.userId, runId, timeZone: options.timeZone }),
      );
      if (read === null) return null;
      const { run, percentiles, staleness } = read;
      const last = percentiles.reduce<(typeof percentiles)[number] | undefined>(
        (latest, row) => (latest === undefined || row.index > latest.index ? row : latest),
        undefined,
      );
      if (last === undefined) return null;

      const profile = baseline.profile;
      const currentAge = ageOn(profile.birthDate, input.asOf);
      const derived = await orNull(() =>
        createProjectionInputsReader(database, revealed(input.userId)).derivedInputs({
          userId: input.userId,
          asOf: run.asOfDate,
          allowOpenDay: !run.balancesSealed,
        }),
      );
      const resolved = await orNull(() =>
        resolveForUser(database, { userId: input.userId, timeZone: options.timeZone }),
      );
      const plan =
        derived === null ? null : await orNull(() => assembleBaselinePlan(profile, derived).plan);

      return {
        asOfYear: DateOnly.year(run.asOfDate),
        currency: run.currency,
        method: run.method === 'monte_carlo' ? 'monte_carlo' : 'deterministic',
        paths: run.paths,
        assumptionsVersion: run.assumptionsVersion,
        stale: staleness !== null,
        successProbability: run.successProbability,
        successTarget: DEFAULT_SUCCESS_TARGET,
        terminal: {
          age: last.age,
          calendarYear: last.calendarYear,
          p5: last.p5,
          p50: last.p50,
          p95: last.p95,
        },
        ages: {
          current: currentAge,
          retirement: profile.retirementAge,
          planEnd: profile.planEndAge,
        },
        savingsRate: derived === null ? null : savingsRateOf(profile, derived),
        rmd:
          derived === null || resolved === null
            ? null
            : await orNull(() => rmdOf(profile, resolved, derived, DateOnly.year(run.asOfDate))),
        socialSecurity:
          plan === null || resolved === null
            ? null
            : await orNull(() => socialSecurityOf(plan, resolved, currentAge)),
        guardrail:
          plan === null || resolved === null || currentAge < profile.retirementAge
            ? null
            : await orNull(() => guardrailOf(plan, resolved)),
      };
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
 * ## `factsForRun` — WP 3.7, and the shape WP 3.w predicted
 *
 * The port's contract is "the holdings and investment-transaction facts this
 * sync run produced, each already resolved to a `security_id`". Through the
 * Phase 3 wiring wave this returned two empty arrays because no provider leg
 * persisted such a fact. WP 3.7's `holdings` and `investment_txns` legs now
 * write them to `connection_sync_facts` (migration 0018) inside the same
 * transaction that settles the leg's `sync_runs` row, so the three steps this
 * comment promised are the three steps below:
 *
 *   1. read the run's facts, already joined to the ledger account they belong
 *      to, through `@ctx/connections`' published `investmentFactsForRun` —
 *      this file never writes the join itself, because the SQL that names
 *      another context's tables belongs inside that context;
 *   2. put **every** identifier the run mentioned through *one*
 *      `resolveAll(...)` — one batched OpenFIGI pass for a 120-position
 *      brokerage rather than 120 (`wp3.1-securities.md`, `openfigi.test.ts`);
 *   3. drop every *holding* the resolver abstained on. A fact with a null
 *      `security_id` must never be returned, and `SecurityResolutionFailed` is
 *      the record that the position existed. A **transaction** with no
 *      security at all is different and is kept: a cash sweep, a fee and a
 *      deposit are real investment transactions, `ResolvedTransactionFact`
 *      types `securityId` as nullable for exactly them, and `lotEffectOf`
 *      already returns `NONE`.
 *
 * Every transaction carries `source: 'BROKER'`. That is the truthful label for
 * a fact a provider stated exactly — it is what tells the lot engine the basis
 * it derives is exact rather than reconstructed, and it is the same seam the
 * R6 verdict needs so a CSV leg can hand the same engine `IMPORTED` facts
 * without the engine knowing which it is looking at.
 *
 * ## Why the resolution runs in its own transaction, and what that costs
 *
 * `securityResolverFor` is built per-transaction *for the sync path*, where a
 * rolled-back sync must not leave behind a durable record of a resolution that
 * happened during work that never happened. Here the caller is the lot
 * consumer, and the pump hands it a transaction this port never sees:
 * `createInvestmentSyncPort(database)` is constructed once, in `worker.ts`,
 * over the pool. So the resolution gets a transaction of its own.
 *
 * That is defensible and it is not free, so both halves are written down.
 * Securities are **master data**: minting one is a statement about an asset,
 * not about a run, it is idempotent on the identifier, and a derivation that
 * fails for an unrelated reason should not have to re-mint it on every retry.
 * The cost was that a retried delivery re-ran an abstention and appended a
 * second `SecurityResolutionFailed` for the same unresolvable position —
 * duplicated *reporting*, never a duplicated row, because the resolver mints
 * nothing when it abstains. `wp3.7-plaid-investments.md` §11 item 3 carried it;
 * WP 3.7a closes it in `runFactsResolverFor` below, by making the append
 * idempotent on `(syncRunId, provider, providerSecurityId)` rather than by
 * moving the transaction. Moving it would have traded a duplicated log line for
 * a lost security row, which is the worse half of the trade.
 */
export function createInvestmentSyncPort(
  database: Database,
  clock: Clock = systemClock,
): InvestmentSyncPort {
  return {
    async factsForRun(userId, syncRunId) {
      const observed = await investmentFactsForRun(database, userId, syncRunId);
      // No such run for this user — including another user's run id, because
      // the reader puts `user_id` in the `WHERE` rather than in a branch. The
      // consumer's contract wants a shape either way, so it gets an empty one.
      if (observed === null) {
        return {
          provider: 'unknown',
          asOfDate: dateOnlyOfInstant(clock.now()),
          holdings: [],
          transactions: [],
        };
      }
      // A balances or a plain transactions run: the legs that write facts are
      // the only ones that write any, and returning early keeps the common
      // case (every nightly bank sync) one query rather than a transaction.
      if (observed.holdings.length === 0 && observed.transactions.length === 0) {
        return {
          provider: observed.provider,
          asOfDate: dateOnlyOfInstant(observed.startedAt),
          holdings: [],
          transactions: [],
        };
      }
      return database.transaction((tx) => resolveRunFacts(tx, clock, userId, syncRunId, observed));
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
 * `securityResolverFor`, with the one thing this caller needs that the sync
 * path does not: an append that a retry cannot double.
 *
 * WP 3.7 §11 item 3. The lot consumer's resolution runs in a transaction of its
 * own (see `createInvestmentSyncPort`'s comment for why that is the right
 * trade), so the pump retrying a delivery re-runs every abstention in the run
 * and, before this, appended a second `SecurityResolutionFailed` for each one.
 * The duplicate is not a duplicated row — nothing is minted on an abstention —
 * but it is a duplicated *report*, and a notification or a support answer built
 * on "how many times did this fail" would have counted retries as failures.
 *
 * **The dedupe is a check inside the same transaction, not an outbox feature.**
 * `appendEvent` takes an `Executor` and an envelope and has no idempotency key
 * (`packages/platform/src/events/outbox.ts`); the two dedupe mechanisms this
 * codebase does have are elsewhere and are not reusable here —
 * `notification_outbox.dedupe_key` is a notification's, and `ledger_dedup_keys`
 * is the ledger's same-transaction-seen-twice table. So the key is stated where
 * it is checked: `(syncRunId, provider, providerSecurityId)`, read out of
 * `domain_events`' own payload.
 *
 * Scoped to the **run**, deliberately, and that is the whole reason the key
 * needed a `syncRunId` in the payload at all. `SecurityResolutionFailed`'s
 * registry description says a later sync that fails the same way must emit
 * again — "the second failure is a second observation and suppressing it would
 * make a permanent gap look like a transient one" — and a key without the run
 * in it would have silently turned that into "report it once, ever". A retried
 * delivery of the *same* run is not a second observation, and that is exactly
 * the line this draws.
 *
 * The `SELECT` sees this transaction's own earlier appends as well as committed
 * ones, so it also collapses the case where one run stages two unresolvable
 * positions in two accounts that are the same provider security.
 */
function runFactsResolverFor(
  executor: InvestmentsExecutor,
  clock: Clock,
  userId: string,
  syncRunId: string,
): SecurityResolver {
  return createSecurityResolver({
    store: drizzleSecurityStore(executor, clock),
    clock,
    events: {
      append: async (event) => {
        const payload = (event.payload ?? {}) as {
          readonly provider?: string;
          readonly providerSecurityId?: string | null;
        };
        const already = await executor.execute<{ one: number }>(sql`
          SELECT 1 AS one
            FROM domain_events
           WHERE user_id = ${userId}::uuid
             AND event_type = ${event.eventType}
             AND payload->>'syncRunId' = ${syncRunId}
             AND payload->>'provider' = ${payload.provider ?? null}
             AND payload->>'providerSecurityId' IS NOT DISTINCT FROM ${payload.providerSecurityId ?? null}
           LIMIT 1
        `);
        if (already.rows.length > 0) return;
        await appendEvent(investmentsOutboxOf(executor), event);
      },
    },
  });
}

/**
 * A `DateOnly` from an instant, in UTC.
 *
 * UTC deliberately, and the reasoning is the Plaid adapter's own: this dates a
 * *provider observation*, not a user-facing period boundary. `todayIn(clock,
 * zone)` is for budget months and the daily seal; pretending to know the
 * user's zone down here would be a guess dressed as precision.
 */
function dateOnlyOfInstant(instant: Date): DateOnly {
  return DateOnly.parse(instant.toISOString().slice(0, 10));
}

/**
 * Turn one run's raw provider facts into the port's resolved shape.
 *
 * Separated from `factsForRun` so the transaction boundary is one line at the
 * call site and this function is a pure-ish mapping over an executor. See
 * `createInvestmentSyncPort`'s comment for the three steps and for why the
 * transaction is this port's own.
 */
async function resolveRunFacts(
  executor: InvestmentsExecutor,
  clock: Clock,
  userId: string,
  syncRunId: string,
  observed: RunInvestmentFacts,
): Promise<{
  readonly provider: string;
  readonly asOfDate: DateOnly;
  readonly holdings: readonly ResolvedHoldingFact[];
  readonly transactions: readonly ResolvedTransactionFact[];
}> {
  const resolver = runFactsResolverFor(executor, clock, userId, syncRunId);
  const context = { userId, provider: observed.provider, syncRunId };

  // One list, one call. `resolveAll` exists so a 120-position brokerage is two
  // OpenFIGI requests rather than a hundred and twenty, and splitting holdings
  // from transactions into two calls would halve that saving for no reason —
  // they name the same securities.
  const withSecurity = [
    // The **whole** `ProviderSecurityFact`, every name the provider gave at
    // once, for both legs. This line used to build
    // `{ identifiers: [holding.fact.security] }` out of the single identifier
    // the port carried, which is how a security Plaid named with a FIGI, an
    // ISIN, a CUSIP *and* a MIC-qualified ticker reached a resolver that tiers
    // over the set having been told one of the four. WP 3.7a fixed it for
    // holdings; WP 3.7a §7 carried the identical fix for
    // `ProviderInvestmentTransactionFact.security`, closed here by WP 3.14a —
    // a run with an investment transaction and no holding for the same
    // security used to split it exactly as holdings once did, because nothing
    // forced the two legs through the same resolver input shape. See
    // `docs/evidence/phase-3/wp3.7a-holding-identifiers.md` and
    // `docs/evidence/phase-3/wp3.14a-port-and-scope.md`.
    ...observed.holdings.map((holding) => holding.fact.security),
    ...observed.transactions.flatMap((transaction) =>
      transaction.fact.security === null ? [] : [transaction.fact.security],
    ),
  ];
  const resolutions = await resolver.resolveAll(withSecurity, context);

  const holdings: ResolvedHoldingFact[] = [];
  let cursor = 0;
  for (const holding of observed.holdings) {
    const resolution = resolutions[cursor];
    cursor += 1;
    // 07's rule: an unresolved thing fails loudly rather than minting a row,
    // and the `SecurityResolutionFailed` the resolver just appended is the
    // record that this position existed. A holding with a null security is not
    // a holding in anything.
    if (resolution?.outcome !== 'resolved') continue;
    holdings.push({
      fact: holding.fact,
      accountId: holding.accountId,
      securityId: resolution.securityId,
    });
  }

  const transactions: ResolvedTransactionFact[] = [];
  for (const transaction of observed.transactions) {
    let securityId: string | null = null;
    if (transaction.fact.security !== null) {
      const resolution = resolutions[cursor];
      cursor += 1;
      // Same rule, different consequence: a *buy* whose security nobody can
      // name cannot open a lot, so it is dropped exactly as a holding is. A
      // transaction that named no security at all never entered `withSecurity`
      // and never reaches this branch — it is kept below with a null id.
      if (resolution?.outcome !== 'resolved') continue;
      securityId = resolution.securityId;
    }
    transactions.push({
      fact: transaction.fact,
      accountId: transaction.accountId,
      securityId,
      // Exact, as the provider stated it. `IMPORTED` is the CSV leg's label
      // and `USER` is hand entry; neither is reachable from here.
      source: 'BROKER',
    });
  }

  return {
    provider: observed.provider,
    asOfDate: dateOnlyOfInstant(observed.startedAt),
    holdings,
    transactions,
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

// ---------------------------------------------------------------------------
// WP 3.8 — `@ctx/planning`'s four snapshot ports
// ---------------------------------------------------------------------------
//
// `docs/evidence/phase-3/wp3.8-net-worth.md` §8 names this as the one new
// `domain.ts` export, and the reason it belongs here rather than anywhere else
// is the whole point of the port: `net_worth_daily` lives in `@ctx/planning`
// and **every one of its inputs belongs to somebody else** — the account
// roster and its balances are `@ctx/ledger`'s, holdings and prices and FX
// rates are `@ctx/investments`'. `pnpm lint:schema-ownership` refuses any SQL
// in `packages/contexts/planning` that names `accounts`, `holdings`, `prices`
// or `fx_rates`, so this file is the only place the four can be satisfied.

/** What `planningPortsFor` needs that an executor cannot carry. */
export interface PlanningPortOptions {
  /**
   * The account holder. Bound here rather than passed per call because two of
   * the four ports — `PriceReader.price` and `FxReader.rate` — take no
   * `userId` argument at all (they are `@ctx/investments`' readers, assigned
   * straight through with no adapter), so the id has to be closed over
   * somewhere and this is the only place that knows it.
   */
  readonly userId: string;
  /**
   * The holder's IANA zone. `account_balances.as_of` is a `timestamptz`, and
   * "the freshest observation on or before 2026-06-15" is a question about a
   * **local calendar day** (08 §3.5) — the same reason every schedule in this
   * application is registered with a timezone rather than in UTC. A reader
   * that truncated `as_of` in UTC would put a 21:00-local observation on the
   * next day for every holder west of Greenwich.
   */
  readonly timeZone: string;
  readonly clock?: Clock;
}

/**
 * 07 §4.1's class table, as the mapping from `@ctx/ledger`'s `AccountType` to
 * `@ctx/planning`'s `AccountKind`.
 *
 * Two mappings here are decisions rather than transcription and are stated
 * rather than left to be discovered:
 *
 *   * **`crypto` → `investment`.** 07 §4.1's `isInvestable` is what separates
 *     "money I could spend this week" from "a position I would have to sell",
 *     and selling BTC to buy groceries is the same operation as selling VTI to
 *     buy groceries. Mapping it to `cash` would count a volatile position in
 *     the liquid total, which is the number the emergency-fund rules divide by.
 *   * **`manual` splits on `classification`.** A manual *asset* (a paid-off
 *     car, a savings bond) is `manual_asset`; a manual *liability* (a loan
 *     from a relative) is `loan`. Both are in net worth and neither is
 *     on-budget, so the two arms produce identical flags today — the split is
 *     there so that the day `@ctx/ledger` grows real `is_liquid` /
 *     `is_investable` columns, the thing being replaced is a classification
 *     and not a coin flip.
 */
function planningKindOf(account: AccountSummary): PlanningAccountKind {
  switch (account.type) {
    case 'depository':
      return 'cash';
    case 'credit':
      return 'credit';
    case 'loan':
      return 'loan';
    case 'investment':
      return 'investment';
    case 'crypto':
      return 'investment';
    case 'manual':
      return account.classification === 'liability' ? 'loan' : 'manual_asset';
  }
}

/**
 * The set of accounts `@ctx/budgeting` has been told to leave out of the
 * budget — `budgets.off_budget_account_ids` (0009_budgeting.sql), which says in
 * as many words that adding an `on_budget` column to `accounts` would be
 * Budgeting writing Ledger's table.
 *
 * The union across every budget, not the first one's: an account that any
 * budget excludes is not on-budget, and taking `budgets[0]` would make the
 * answer depend on `created_at` ordering the day a second budget exists.
 */
async function offBudgetAccountIds(
  executor: PlanningExecutor,
  userId: string,
): Promise<ReadonlySet<string>> {
  const rows = await listBudgets(executor, { userId });
  const ids = new Set<string>();
  for (const budget of rows) {
    for (const accountId of budget.offBudgetAccountIds) ids.add(accountId);
  }
  return ids;
}

/**
 * `@ctx/planning`'s `BalancesReader`, over `@ctx/ledger`.
 *
 * `accounts()` deliberately ignores its `asOf` argument for the roster and
 * carries `closedAt` instead: `accounts` is not a versioned table, so there is
 * no honest way to answer "which accounts existed on 2025-03-04" — and
 * `@ctx/planning`'s `computeNetWorth` already refuses to count an account from
 * the day it closed, which is the only time-dependence the snapshot needs. An
 * adapter that filtered here *and* let the aggregate filter would be two
 * copies of one rule.
 */
function createPlanningBalancesReader(
  executor: PlanningExecutor,
  options: PlanningPortOptions,
): PlanningBalancesReader {
  const zone = options.timeZone;
  return {
    async accounts(userId: string, _asOf: string): Promise<readonly PlanningAccount[]> {
      const [rows, offBudget] = await Promise.all([
        listAccounts(executor, { userId, includeClosed: true }),
        offBudgetAccountIds(executor, userId),
      ]);
      return rows.map((account) => {
        const kind = planningKindOf(account);
        const flags = defaultFlagsFor(kind, account.includeInNetWorth);
        return {
          accountId: account.id,
          name: account.name,
          kind,
          // Never inferred from the sign of a balance (`AccountSide`'s own
          // doc): an overpaid credit card is still a liability account.
          side: account.classification,
          currency: account.currency,
          flags: {
            ...flags,
            // The one flag with a real source of truth. `defaultFlagsFor` says
            // what 07 §4.1's class table implies; the user's own exclusion list
            // outranks it, and only ever in the `false` direction.
            onBudget: flags.onBudget && !offBudget.has(account.id),
          },
          closedAt: account.closedAt,
        };
      });
    },

    async balanceOnOrBefore(
      userId: string,
      accountId: string,
      date: string,
    ): Promise<PlanningBalanceObservation | null> {
      const result = await executor.execute<{
        current_minor: bigint | string;
        currency: string;
        source: 'provider' | 'manual' | 'derived';
        local_date: string;
      }>(sql`
        SELECT current_minor,
               currency,
               source,
               to_char((as_of AT TIME ZONE ${zone})::date, 'YYYY-MM-DD') AS local_date
          FROM account_balances
         WHERE user_id = ${userId}::uuid
           AND account_id = ${accountId}::uuid
           AND (as_of AT TIME ZONE ${zone})::date <= ${date}::date
         ORDER BY as_of DESC
         LIMIT 1
      `);
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        accountId,
        date: row.local_date,
        currentMinor: BigInt(row.current_minor),
        currency: row.currency,
        source: row.source,
      };
    },

    async transactionsTotalOn(userId: string, accountId: string, date: string): Promise<bigint> {
      // 04 §5.4's `balance(d-1) = balance(d) - Σ txns(d)`, and therefore the
      // sum of what *actually moved*, not of what a report would count:
      //
      //   * `user_excluded` rows are **included**. Excluding a transaction from
      //     the budget does not un-spend the money, and subtracting a smaller
      //     sum would reconstruct a balance the bank never held.
      //   * transfers are **included**, for the same reason: a transfer leaves
      //     one account and lands in another, and both balances moved.
      //   * superseded and provider-removed rows are **excluded**: a duplicate
      //     that `@ctx/ledger` marked superseded never moved money twice, and a
      //     `removed_at` row is a provider tombstone.
      //
      // The sign convention is the ledger's house one (negative = outflow),
      // which is already what this port's contract asks for.
      const result = await executor.execute<{ total: string }>(sql`
        SELECT COALESCE(SUM(effective_amount_minor), 0)::text AS total
          FROM transactions
         WHERE user_id = ${userId}::uuid
           AND account_id = ${accountId}::uuid
           AND effective_date = ${date}::date
           AND superseded_by_id IS NULL
           AND removed_at IS NULL
      `);
      return BigInt(result.rows[0]?.total ?? '0');
    },
  };
}

/**
 * `@ctx/planning`'s `HoldingsReader`, over `@ctx/investments`.
 *
 * Both methods read the **union** of `holdings` (the current position, one row
 * per account/security) and `holdings_snapshots` (the per-day history). Reading
 * only the snapshots would leave today unanswerable on an install whose first
 * sync has landed but whose first snapshot has not; reading only `holdings`
 * would make `bracketingObservations` structurally impossible, and a reader
 * that can only answer "the latest on or before" is exactly the one 04 §5.4
 * warns about — it carries a stale share count forward through a month of
 * contributions and calls the result observed.
 */
function createPlanningHoldingsReader(executor: PlanningExecutor): PlanningHoldingsReader {
  const observations = (userId: string, accountId: string): SQL => sql`
    SELECT security_id, quantity, as_of_date
      FROM holdings_snapshots
     WHERE user_id = ${userId}::uuid AND account_id = ${accountId}::uuid
    UNION ALL
    SELECT security_id, quantity, as_of_date
      FROM holdings
     WHERE user_id = ${userId}::uuid AND account_id = ${accountId}::uuid
  `;

  const rowOf = (
    accountId: string,
    row: { security_id: string; quantity: string; as_of_date: string },
  ): PlanningHoldingObservation => ({
    accountId,
    securityId: row.security_id,
    // An exact decimal string, never a `number` (D3): a share count is not an
    // integer and 0.1 + 0.2 is not 0.3.
    quantity: String(row.quantity),
    asOfDate: row.as_of_date,
  });

  return {
    async positionsOnOrBefore(userId, accountId, date) {
      const result = await executor.execute<{
        security_id: string;
        quantity: string;
        as_of_date: string;
      }>(sql`
        SELECT DISTINCT ON (security_id) security_id, quantity, as_of_date
          FROM (${observations(userId, accountId)}) AS o
         WHERE as_of_date <= ${date}::date
         ORDER BY security_id, as_of_date DESC
      `);
      return result.rows.map((row) => rowOf(accountId, row));
    },

    async bracketingObservations(userId, accountId, securityId, date) {
      const result = await executor.execute<{
        security_id: string;
        quantity: string;
        as_of_date: string;
        side: 'before' | 'after';
      }>(sql`
        WITH o AS (${observations(userId, accountId)})
        (SELECT security_id, quantity, as_of_date, 'before' AS side
           FROM o
          WHERE security_id = ${securityId}::uuid AND as_of_date <= ${date}::date
          ORDER BY as_of_date DESC
          LIMIT 1)
        UNION ALL
        (SELECT security_id, quantity, as_of_date, 'after' AS side
           FROM o
          WHERE security_id = ${securityId}::uuid AND as_of_date > ${date}::date
          ORDER BY as_of_date ASC
          LIMIT 1)
      `);
      const before = result.rows.find((row) => row.side === 'before');
      const after = result.rows.find((row) => row.side === 'after');
      return {
        before: before === undefined ? null : rowOf(accountId, before),
        after: after === undefined ? null : rowOf(accountId, after),
      };
    },
  };
}

/**
 * The four ports the net-worth snapshotter reads its world through.
 *
 * Built **per transaction**, not once per process: `SnapshotJobDependencies.
 * portsFor` receives the job's own Drizzle transaction and `runSnapshot` is
 * wrapped in `database.transaction(...)` inside `netWorthSnapshotJobHandler`,
 * so the seals, the open day's row, every read they were computed from and
 * `planning.NetWorthSnapshotTaken` are one atomic fact. Same shape, and the
 * same reason, as `securityResolverFor` above.
 *
 * `prices` and `fx` are `@ctx/investments`' own readers **assigned straight
 * through with no adapter**. `@ctx/planning` declares `PriceReader` and
 * `FxReader` as deliberate structural mirrors (`ports.ts`'s own doc), and this
 * assignment is where TypeScript checks the two halves still fit — the same
 * build-time check `createMarketDataRuntime`'s `FigiMapper` assignment is.
 */
export function planningPortsFor(
  executor: PlanningExecutor,
  options: PlanningPortOptions,
): SnapshotPorts {
  const clock = options.clock ?? systemClock;
  return {
    balances: createPlanningBalancesReader(executor, options),
    holdings: createPlanningHoldingsReader(executor),
    prices: createPriceReader({
      store: drizzlePriceStore(executor),
      userId: options.userId,
      // Which ladder answers is chosen by the security's own classification.
      // `other` for a security that has vanished is the honest default:
      // `DEFAULT_LADDERS['other']` still tries `user_override` and
      // `last_known`, so a missing row degrades to "no price", never to a
      // wrong one.
      kindOf: async (securityId: string): Promise<string> => {
        const rows = await executor
          .select({ type: securities.type })
          .from(securities)
          .where(eq(securities.id, securityId))
          .limit(1);
        return rows[0]?.type ?? 'other';
      },
      clock,
    }),
    fx: createFxReader({ store: drizzleFxStore(executor), userId: options.userId, clock }),
  };
}

// ---------------------------------------------------------------------------
// WP 4.3 — `@ctx/planning`'s two revealed-behaviour ports
// ---------------------------------------------------------------------------
//
// `docs/evidence/phase-4/wp4.3-revealed.md` §8. `CashflowReader` respects
// 08 §1.6's plan → ledger arrow; `SpendingReader` exists because there is **no**
// plan → budg arrow, so budgeting's NEED-class answer arrives here, at the one
// place both contexts are in scope.

/**
 * One bound `uuid[]` parameter, as a Postgres array literal. Drizzle's `sql`
 * template expands an interpolated JavaScript array into a row constructor, not
 * an array parameter (`packages/contexts/categorization/src/seed-taxonomy.ts`
 * found this the hard way), so the ids travel as one text parameter and are
 * checked to be UUIDs first.
 */
function uuidArrayParameter(ids: readonly string[]): string {
  for (const id of ids) {
    if (!isUuid(id)) throw new Error(`not a UUID: ${JSON.stringify(id)}`);
  }
  return `{${ids.join(',')}}`;
}

/**
 * `@ctx/planning`'s `CashflowReader`, over `@ctx/ledger`.
 *
 * The roster **is** WP 3.8's `BalancesReader.accounts()` — the same
 * `planningKindOf` mapping, the same `defaultFlagsFor` narrowed by budgeting's
 * off-budget list — plus the tax bucket, derived by `@ctx/planning`'s own
 * `defaultTaxBucketFor` from the provider subtype. Two derivations of
 * `onBudget` would be two answers to one question.
 *
 * Both queries drop what never moved money — pending rows, superseded
 * duplicates, provider tombstones — and keep what the user excluded and what
 * the pairing matched, because the derivation must *name* those and cannot name
 * what it never saw. The counterpart account is the other leg of the row's own
 * `transfer_link_id`, read through `transfer_links` exactly as Phase 1 wrote it.
 */
export function planningCashflowReaderFor(
  executor: PlanningExecutor,
  options: PlanningPortOptions,
): PlanningCashflowReader {
  const roster = planningPortsFor(executor, options).balances;
  return {
    async accounts(userId: string, asOf: string): Promise<readonly PlanningCashflowAccount[]> {
      const [accounts, rows] = await Promise.all([
        roster.accounts(userId, asOf),
        listAccounts(executor, { userId, includeClosed: true }),
      ]);
      const subtypeOf = new Map(rows.map((row) => [row.id, row.subtype] as const));
      return accounts.map((account) => ({
        ...account,
        taxBucket: defaultTaxBucketFor(account.kind, subtypeOf.get(account.accountId) ?? null),
      }));
    },

    async historyStarts(userId, accountIds) {
      if (accountIds.length === 0) return new Map();
      const result = await executor.execute<{ account_id: string; first_date: string }>(sql`
        SELECT account_id::text AS account_id,
               to_char(MIN(effective_date), 'YYYY-MM-DD') AS first_date
          FROM transactions
         WHERE user_id = ${userId}::uuid
           AND account_id = ANY(${uuidArrayParameter(accountIds)}::uuid[])
           AND pending = false
           AND superseded_by_id IS NULL
           AND removed_at IS NULL
         GROUP BY account_id
      `);
      return new Map(
        result.rows.map((row) => [row.account_id, DateOnly.parse(row.first_date)] as const),
      );
    },

    async inflows(userId, accountIds, from, to): Promise<readonly PlanningCashflowInflow[]> {
      if (accountIds.length === 0) return [];
      const result = await executor.execute<{
        id: string;
        account_id: string;
        effective_date: string;
        amount_minor: string;
        currency: string;
        label: string;
        user_excluded: boolean;
        is_refund: boolean;
        counterpart_account_id: string | null;
      }>(sql`
        SELECT t.id::text AS id,
               t.account_id::text AS account_id,
               to_char(t.effective_date, 'YYYY-MM-DD') AS effective_date,
               t.effective_amount_minor::text AS amount_minor,
               t.effective_currency AS currency,
               t.effective_name AS label,
               t.user_excluded,
               (t.refund_of_id IS NOT NULL) AS is_refund,
               other.account_id::text AS counterpart_account_id
          FROM transactions t
          LEFT JOIN transfer_links l
                 ON l.id = t.transfer_link_id
                AND l.user_id = t.user_id
          LEFT JOIN transactions other
                 ON other.user_id = t.user_id
                AND other.id = CASE WHEN l.inflow_transaction_id = t.id
                                    THEN l.outflow_transaction_id
                                    ELSE l.inflow_transaction_id END
         WHERE t.user_id = ${userId}::uuid
           AND t.account_id = ANY(${uuidArrayParameter(accountIds)}::uuid[])
           AND t.effective_date BETWEEN ${from}::date AND ${to}::date
           AND t.effective_amount_minor > 0
           AND t.pending = false
           AND t.superseded_by_id IS NULL
           AND t.removed_at IS NULL
         ORDER BY t.effective_date, t.id
      `);
      return result.rows.map((row) => ({
        transactionId: row.id,
        accountId: row.account_id,
        date: DateOnly.parse(row.effective_date),
        amount: Money.of(BigInt(row.amount_minor), row.currency),
        label: row.label,
        userExcluded: row.user_excluded,
        isRefund: row.is_refund,
        transferCounterpartAccountId: row.counterpart_account_id,
      }));
    },
  };
}

/**
 * `@ctx/planning`'s `SpendingReader`, over `@ctx/budgeting` — the executor
 * closed over and **no field mapped**. `packages/contexts/planning/test/ports.test.ts`
 * type-checks this exact shape against both packages on every run.
 */
export function planningSpendingReaderFor(executor: PlanningExecutor): PlanningSpendingReader {
  return {
    listBudgets: (input) => listBudgets(executor, input),
    listPeriods: (input) => listPeriods(executor, input),
    getPeriod: (input) => getPeriod(executor, input),
  };
}

/** Both revealed-behaviour ports, per transaction — `planningPortsFor`'s shape and reason. */
export function planningRevealedPortsFor(
  executor: PlanningExecutor,
  options: PlanningPortOptions,
): PlanningRevealedPorts {
  return {
    cashflow: planningCashflowReaderFor(executor, options),
    spending: planningSpendingReaderFor(executor),
  };
}

// ---------------------------------------------------------------------------
// WP 4.5/4.6 — binding `MonteCarloRunner` to WP 4.5's worker host
// ---------------------------------------------------------------------------
//
// `@ctx/planning`'s projection service is written against `MonteCarloRunner`
// (`ports.ts`) and is handed `null` until this file binds it —
// `docs/evidence/phase-4/wp4.6-projection-service.md` §10.2 and
// `wp4.5-montecarlo.md` §10.2 describe the adapter; this is it, corrected
// against WP 4.5's *landed* surface rather than the draft the first evidence
// wrote against.

/**
 * A small counting semaphore: `acquire()` resolves once fewer than `limit`
 * holders are inside; `release()` wakes the oldest waiter (or, with nobody
 * waiting, frees the slot). No timeout and no separate queue cap — the caller
 * (`createMonteCarloRunner`) already refused anything outside
 * `MONTE_CARLO_ENVELOPE` before a request reaches here, so a queued run is
 * always one this process has already agreed to do; only *concurrency* is
 * bounded, never admission.
 */
function createSemaphore(limit: number): { acquire(): Promise<void>; release(): void } {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    acquire(): Promise<void> {
      if (active < limit) {
        active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
    release(): void {
      const next = waiting.shift();
      if (next !== undefined) next();
      else active -= 1;
    },
  };
}

/**
 * WP 4.5 measured ~30–45 MB per concurrent Monte Carlo worker (10k–20k paths)
 * against a 512 MB container (`wp4.5-montecarlo.md` §4.5, §10 open items): ten
 * at once exhausts it. Eight is comfortably under that (~360 MB at the high
 * end) while still letting more than one request run at a time. **Not a
 * config value yet** — `packages/config` is outside this WP's ownership; see
 * this WP's evidence for the key an operator would tune this with.
 */
const MAX_CONCURRENT_MONTE_CARLO_RUNS = 8;

/**
 * WP 4.5's `MonteCarloRunner`, over a loaded return series.
 *
 * Three things this adapter must not get wrong, each because a WP 4.5/4.6
 * evidence note names the exact failure:
 *
 *   1. **The seed travels unchanged, in both directions.**
 *      `runMonteCarloInWorker` already treats the seed as a 64-bit pattern —
 *      `toMonteCarloJob` canonicalises it to unsigned before it reaches the
 *      worker, and the summary echoes it unsigned. WP 4.6's original adapter
 *      draft called for `BigInt.asIntN`/`asUintN` conversions that WP 4.5's
 *      finished surface made unnecessary (`wp4.5-montecarlo.md` §10 item 8:
 *      "harmless if kept"). They are not harmless on the way *out*:
 *      `BigInt.asIntN(64, summary.seed)` would turn every echoed seed ≥ 2^63
 *      negative, which the service's own echo check (`checkedOutcome`) would
 *      then see as a seed mismatch and refuse
 *      `planning.monte_carlo_outcome_mismatch` — silently, for roughly half
 *      of all baselines. This adapter passes `request.seed` and
 *      `summary.seed` through untouched.
 *   2. **`engineVersion` is a property of the runner, known before any run**,
 *      because it is part of the projection service's cache key. It folds the
 *      Monte Carlo version, the deterministic engine it shares a `stepYear`
 *      with, the engine kind, and the return series' own checksum, so a
 *      different series is a different cache key rather than a silently
 *      different distribution served under an old one.
 *   3. **The seven bands are per level, not per period**
 *      (`summary.bands` is `PERCENTILE_LEVELS` order: p5, p10, p25, p50, p75,
 *      p90, p95), and this adapter regroups them into one `MonteCarloPeriod`
 *      per year, index `t` ↦ `{ age: startAge + t, calendarYear: startYear +
 *      t }`. Swapping two levels here (e.g. p75 for p90) would produce a
 *      plausible-looking band set with the wrong numbers in it and no type
 *      error anywhere.
 */
export function createMonteCarloRunner(options: {
  readonly series: ReturnSeries;
  readonly deadlineMs?: number;
  readonly maxConcurrent?: number;
  /**
   * Injectable, for the same reason WP 4.5's own tests inject it
   * (`worker-limits.test.ts`): a test that wants to *prove* the envelope
   * refuses before a worker exists needs a spawn it can count. Never set in
   * production.
   */
  readonly spawn?: MonteCarloHostOptions['spawn'];
}): MonteCarloRunner {
  const det = ENGINE_VERSION.slice(ENGINE_VERSION.lastIndexOf('/') + 1);
  // e.g. 'personalfi.montecarlo/1;det/1;bootstrap;cbdefda1752e' — well under
  // `projection_runs.engine_version`'s 64 characters.
  const engineVersion =
    `${MONTE_CARLO_VERSION};det/${det};bootstrap;` + `${options.series.sha256.slice(0, 12)}`;
  if (engineVersion.length > 64) {
    throw new Error(
      `Monte Carlo engineVersion "${engineVersion}" exceeds the column's 64 characters`,
    );
  }
  const semaphore = createSemaphore(options.maxConcurrent ?? MAX_CONCURRENT_MONTE_CARLO_RUNS);

  return {
    engineVersion,
    async run(request) {
      await semaphore.acquire();
      try {
        const { summary } = await runMonteCarloInWorker(
          {
            plan: request.plan,
            assumptions: request.assumptions,
            // A 64-bit pattern already (0022 stores it unsigned) — no
            // asIntN/asUintN conversion; see this function's header, item 1.
            seed: request.seed,
            paths: request.paths,
            engine: 'bootstrap',
            series: options.series,
          },
          {
            ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
            ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
          },
        );
        const [p5, p10, p25, p50, p75, p90, p95] = summary.bands; // PERCENTILE_LEVELS order
        if (summary.bands.length !== 7 || p50 === undefined) {
          throw new Error(
            `Monte Carlo worker returned ${String(summary.bands.length)} bands, expected p5..p95`,
          );
        }
        return {
          engineVersion,
          seed: summary.seed,
          paths: summary.paths,
          successProbability: summary.successProbability,
          periods: p50.byYear.map((median, t) => ({
            index: t,
            age: summary.startAge + t,
            calendarYear: summary.startYear + t,
            p5: p5!.byYear[t]!,
            p10: p10!.byYear[t]!,
            p25: p25!.byYear[t]!,
            p50: median,
            p75: p75!.byYear[t]!,
            p90: p90!.byYear[t]!,
            p95: p95!.byYear[t]!,
          })),
        };
      } finally {
        semaphore.release();
      }
    },
  };
}

/**
 * Load WP 4.5's pinned return series and bind it, or answer `null` and log
 * exactly why — **never** a silent fallback to the lognormal engine, which the
 * projection service would have no way to tell apart from an honest Monte
 * Carlo run of the real thing (`wp4.6-projection-service.md` §10.2,
 * `wp4.5-montecarlo.md` §10 item 4).
 *
 * Called once at worker boot (`worker.ts` — see this WP's evidence for the
 * exact line; not this file's to add) and handed to `appModules` as
 * `ModuleWiringOptions.monteCarlo`. Uses `loadReturnSeries` rather than
 * `ensureReturnSeries`: this process never downloads Shiller's workbook on the
 * holder's behalf — that is `data/returns/fetch.ts`, an operator command run
 * once and reviewed (`wp4.5-montecarlo.md` §6's licence verdict) — it only
 * reads whatever an operator has already fetched onto the cache volume.
 */
export function createMonteCarloRunnerFromCache(options: {
  readonly cacheDir?: string;
  readonly logger: PlatformLogger;
}): MonteCarloRunner | null {
  try {
    const series = loadReturnSeries(options.cacheDir);
    return createMonteCarloRunner({ series });
  } catch (error) {
    if (error instanceof ReturnSeriesRefused) {
      options.logger.warn(
        { err: error, code: error.code },
        'planning.returns_series_unavailable: Monte Carlo is bound to null; ' +
          'the nightly baseline runs deterministic and records that it did',
      );
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// WP 3.6 — `@connector/walletrpc`'s store and its two egress transports
// ---------------------------------------------------------------------------

/**
 * `@connector/walletrpc`'s `WalletAddressStore`, over `wallet_addresses`
 * (migration 0016) — the injected seam `docs/evidence/phase-3/wp3.6-walletrpc.md`
 * §8 item 4 asks the composition root for, bound exactly as `@connector/csv`'s
 * `DurableStore` is bound by `attachDurableStaging`.
 *
 * ## Why every method resolves through `connections`
 *
 * The interface is keyed by `providerConnectionId` — the connector's own id,
 * which for this adapter is a `newId()` minted inside `connect()`. The table is
 * keyed by `connection_id`, a foreign key into **our** `connections.id`. The
 * join between the two is `connections.(provider, provider_connection_id)`,
 * which is exactly the natural key `createConnection` writes and
 * `findByProviderKey` already reads, so resolving through it here means the
 * row is findable from **any** process — which is the whole property D-5 bought
 * for CSV and Manual, and the one this connector needs more than either of
 * them, because `wallet_rpc` is not in `PROCESS_LOCAL_PROVIDERS`: the api links
 * the wallet and the *worker* syncs it.
 *
 * ## The ordering defect this binding surfaced, and what is done about it
 *
 * `createConnection` (`@ctx/connections`) calls `connector.connect()` **before**
 * it inserts the `connections` row, and does both inside one transaction. So at
 * the moment `WalletRpcConnector.connect()` calls `put()`, there is no
 * `connections.id` to reference and no row this store (which holds a
 * pool-backed handle, not that transaction) could see even if there were. `put`
 * therefore cannot be the durable write on a **first** link, and pretending
 * otherwise would produce a connection whose first sync answers "this
 * connection has no wallet on record" from the worker — N-7's shape exactly.
 *
 * What this store does instead is state the two halves honestly:
 *
 *   * `put` upserts when the connection resolves — which is the **re-link**
 *     path, where the row already exists and a changed descriptor or label must
 *     land — and otherwise records the descriptor in a request-scoped pending
 *     map and returns.
 *   * `persistPending(providerConnectionId, { connectionId, userId })` is what
 *     the link route calls once `createConnection` has returned an id, in the
 *     same process and the same request that staged it. That is the durable
 *     write on a first link.
 *
 * Named in `docs/evidence/phase-3/wp3.w-wiring.md` §10 as owed to WP 3.6: the
 * clean fix is for `WalletAddressStore.put` to carry the connection identity
 * (or for the connector to flush from a `ConnectionHandle` the way
 * `CsvImportConnector` does), which is a `packages/connectors/**` change this
 * batch may not make.
 */
export interface DurableWalletAddressStore extends WalletAddressStore {
  /**
   * Write the descriptor staged by `connect()` now that the connection has an
   * id. Idempotent: calling it for a `providerConnectionId` with nothing
   * pending is a no-op, which is what a re-link (already written by `put`)
   * produces.
   */
  persistPending(
    providerConnectionId: string,
    input: { readonly connectionId: string; readonly userId: string },
  ): Promise<boolean>;
}

interface WalletConnectionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
}

export function createWalletAddressStore(database: Database): DurableWalletAddressStore {
  /** Staged by `connect()`, drained by `persistPending`. Never a cache: `get` does not read it. */
  const pending = new Map<string, WalletAddressRecord>();

  const connectionFor = async (
    providerConnectionId: string,
  ): Promise<WalletConnectionRow | null> => {
    const result = await database.execute<WalletConnectionRow>(sql`
      SELECT id, user_id
        FROM connections
       WHERE provider = ${WALLETRPC_PROVIDER}
         AND provider_connection_id = ${providerConnectionId}
       LIMIT 1
    `);
    return result.rows[0] ?? null;
  };

  const write = async (
    connectionId: string,
    userId: string,
    record: WalletAddressRecord,
  ): Promise<void> => {
    await database.execute(sql`
      INSERT INTO wallet_addresses (
        id, user_id, connection_id, chain, descriptor, derivation_scheme, label,
        external_highest_used_index, internal_highest_used_index
      ) VALUES (
        ${newId()}::uuid, ${userId}::uuid, ${connectionId}::uuid, ${record.chain},
        ${record.descriptor}, ${record.derivationScheme}, ${record.label},
        ${record.scanState.externalHighestUsedIndex}, ${record.scanState.internalHighestUsedIndex}
      )
      ON CONFLICT (connection_id) DO UPDATE SET
        chain = excluded.chain,
        descriptor = excluded.descriptor,
        derivation_scheme = excluded.derivation_scheme,
        label = excluded.label,
        updated_at = now()
    `);
  };

  return {
    async get(providerConnectionId: string): Promise<WalletAddressRecord | null> {
      const result = await database.execute<{
        chain: 'bitcoin' | 'ethereum';
        descriptor: string;
        derivation_scheme: 'bip44' | 'bip49' | 'bip84' | null;
        label: string;
        external_highest_used_index: number | null;
        internal_highest_used_index: number | null;
      }>(sql`
        SELECT w.chain,
               w.descriptor,
               w.derivation_scheme,
               w.label,
               w.external_highest_used_index,
               w.internal_highest_used_index
          FROM wallet_addresses w
          JOIN connections c ON c.id = w.connection_id
         WHERE c.provider = ${WALLETRPC_PROVIDER}
           AND c.provider_connection_id = ${providerConnectionId}
         LIMIT 1
      `);
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        providerConnectionId,
        chain: row.chain,
        descriptor: row.descriptor,
        derivationScheme: row.derivation_scheme,
        label: row.label,
        scanState: {
          externalHighestUsedIndex: row.external_highest_used_index,
          internalHighestUsedIndex: row.internal_highest_used_index,
        },
      };
    },

    async put(record: WalletAddressRecord): Promise<void> {
      const connection = await connectionFor(record.providerConnectionId);
      if (connection === null) {
        // First link: `createConnection` has not inserted the row yet. See this
        // function's header.
        pending.set(record.providerConnectionId, record);
        return;
      }
      await write(connection.id, connection.user_id, record);
    },

    async persistPending(providerConnectionId, input): Promise<boolean> {
      const record = pending.get(providerConnectionId);
      if (record === undefined) return false;
      pending.delete(providerConnectionId);
      await write(input.connectionId, input.userId, record);
      return true;
    },

    async updateScanState(providerConnectionId: string, scanState): Promise<void> {
      // Scan state only, never the descriptor: a gap-limit horizon moves every
      // sync and the descriptor is the thing the user actually linked.
      await database.execute(sql`
        UPDATE wallet_addresses AS w
           SET external_highest_used_index = ${scanState.externalHighestUsedIndex},
               internal_highest_used_index = ${scanState.internalHighestUsedIndex},
               updated_at = now()
          FROM connections c
         WHERE c.id = w.connection_id
           AND c.provider = ${WALLETRPC_PROVIDER}
           AND c.provider_connection_id = ${providerConnectionId}
      `);
    },

    async delete(providerConnectionId: string): Promise<void> {
      pending.delete(providerConnectionId);
      await database.execute(sql`
        DELETE FROM wallet_addresses AS w
         USING connections c
         WHERE c.id = w.connection_id
           AND c.provider = ${WALLETRPC_PROVIDER}
           AND c.provider_connection_id = ${providerConnectionId}
      `);
    },
  };
}

/**
 * The two crypto hosts, and the policy each adapter is allowed.
 *
 * One host per transport, exactly as `policyFor(provider)` gives the market-data
 * adapters one host each: a bug in the Esplora leg cannot reach
 * `api.etherscan.io`, let alone `db:5432`. `CRYPTO_ALLOWED_HOSTS` can only
 * **narrow** this — it is intersected, never substituted — for the reason
 * `.env.example` spells out: an environment variable that could widen an egress
 * allow-list is a way to repoint a balance fetcher by editing a file.
 *
 * `@connector/walletrpc` deliberately does not import `@core/platform` (its
 * boundary layer forbids it), which is why the guard lives here and the
 * connector takes a function. Its own contribution is narrower and just as
 * load-bearing: `ESPLORA_HOST` and `ETHERSCAN_HOST` are source-code constants,
 * never parameters, so no xpub, address or label a user types can become the
 * destination host.
 */
function cryptoPolicyFor(host: string, narrowing: readonly string[]): EgressPolicy {
  const allowedHosts = narrowing.length === 0 || narrowing.includes(host) ? [host] : [];
  return createEgressPolicy({
    allowedHosts,
    allowedSchemes: ['https'],
    allowedPorts: [443],
    timeoutMs: 15_000,
    maxResponseBytes: 256 * 1024,
  });
}

/**
 * Run one guarded GET and hand back a parsed body.
 *
 * The same four properties `@ctx/integrations`' `createProviderClient` composes,
 * because they are what make the egress claim mean anything: `guardUrl` before
 * the connect, the transport connecting to the address the guard validated
 * rather than re-resolving the name, `classifyStatus` turning a 3xx into a
 * refusal we never follow, and a closed header vocabulary.
 */
async function cryptoGet(
  transport: HttpTransport,
  policy: EgressPolicy,
  url: string,
): Promise<{ status: number; body: unknown }> {
  const decision = await guardUrl(url, policy, systemResolver);
  if (!decision.ok) {
    throw new Error(`crypto egress refused: ${decision.code} (${decision.detail})`);
  }
  const response = await transport({
    destination: decision.destination,
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': CRYPTO_USER_AGENT },
    timeoutMs: policy.timeoutMs,
    maxResponseBytes: policy.maxResponseBytes,
    secure: true,
  });
  const verdict = classifyStatus(response.status);
  if (verdict.kind === 'refused') {
    // A 3xx. Recorded, never followed: an allow-listed host must not be able to
    // launder a request to an internal one.
    throw new Error(`crypto egress refused: ${verdict.code}`);
  }
  let body: unknown = null;
  try {
    body = JSON.parse(response.body);
  } catch {
    // Left `null`. Both clients check `status` first and then refuse a body
    // that is not an object by name (`MALFORMED_RESPONSE`), which is a better
    // message than a JSON parse error would be.
  }
  return { status: response.status, body };
}

/** Same identifier the market-data client sends; contains no user or host data. */
const CRYPTO_USER_AGENT = USER_AGENT;

/** Everything `@connector/walletrpc` needs from this process, built once. */
export interface WalletRpcRuntime {
  readonly store: DurableWalletAddressStore;
  readonly esploraTransport: EsploraTransport;
  readonly etherscanTransport: EtherscanTransport;
  readonly etherscanApiKey: EtherscanApiKey;
}

export function createWalletRpcRuntime(options: {
  readonly database: Database;
  /** `config.crypto.allowedHosts`. Empty ⇒ no narrowing of the code's own two. */
  readonly allowedHosts: readonly string[];
  /** `config.secrets.etherscan_api_key`. Absent is an ordinary install (BTC-only). */
  readonly etherscanApiKey?: Redacted<string> | undefined;
}): WalletRpcRuntime {
  const transport = createNodeTransport();
  const esploraPolicy = cryptoPolicyFor(ESPLORA_HOST, options.allowedHosts);
  const etherscanPolicy = cryptoPolicyFor(ETHERSCAN_HOST, options.allowedHosts);

  return {
    store: createWalletAddressStore(options.database),
    esploraTransport: async (request) => {
      const url = `https://${ESPLORA_HOST}${request.path}`;
      return cryptoGet(transport, esploraPolicy, url);
    },
    etherscanTransport: async (request) => {
      const search = new URLSearchParams(request.query).toString();
      const url = `https://${ETHERSCAN_HOST}${request.path}?${search}`;
      return cryptoGet(transport, etherscanPolicy, url);
    },
    etherscanApiKey:
      options.etherscanApiKey === undefined
        ? missingEtherscanApiKey()
        : etherscanApiKeyOf(options.etherscanApiKey.reveal()),
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
  /**
   * WP 3.6's watch-only wallet adapter, built by `createWalletRpcRuntime`.
   *
   * **Unlike Plaid and Coinbase there is nothing to feature-detect**, and the
   * asymmetry is the point: this connector needs no credential at all to be
   * useful. Its Bitcoin leg derives addresses locally from an xpub/ypub/zpub
   * and reads a public block explorer; only the Ethereum leg needs
   * `etherscan_api_key`, and it refuses **by name** at the moment a balance is
   * asked for rather than being withheld from the registry. So absence here
   * means only "this caller has no database handle to bind the store to" — the
   * shape `app.ts` was in before it had one — never "the operator has not
   * configured it".
   */
  readonly walletRpc?: WalletRpcRuntime | null;
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

  // WP 3.6. Registered whenever a runtime is supplied — see
  // `ConnectorRegistryOptions.walletRpc` for why this is not a credential
  // feature-detection like the two blocks above. The two transports are
  // `@core/platform`'s egress guard with one host each; the connector
  // deliberately imports none of that (its boundary layer forbids it) and takes
  // a function instead.
  const walletRpc = options.walletRpc ?? null;
  if (walletRpc === null) {
    logger?.info(
      { provider: WALLETRPC_PROVIDER },
      'walletrpc runtime not supplied; connector not registered',
    );
  } else {
    registry.register({
      connector: new WalletRpcConnector({
        store: walletRpc.store,
        esploraTransport: walletRpc.esploraTransport,
        etherscanTransport: walletRpc.etherscanTransport,
        etherscanApiKey: walletRpc.etherscanApiKey,
        clock: options.clock ?? systemClock,
        ...(logger === undefined ? {} : { logger }),
      }),
      manifest: WALLETRPC_MANIFEST,
    });
    logger?.info(
      {
        provider: WALLETRPC_PROVIDER,
        hosts: [ESPLORA_HOST, ETHERSCAN_HOST],
        // The fact of presence, never the key. An install with no key still
        // gets the connector; only its ETH leg refuses.
        etherscanKey: walletRpc.etherscanApiKey.present ? 'present' : 'absent',
      },
      'walletrpc connector registered',
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
