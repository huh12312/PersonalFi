// SPDX-License-Identifier: MIT
/**
 * Persistence for holdings, investment transactions, lots and method
 * elections, behind one narrow interface — the same split `src/store.ts` uses
 * for the securities master, and for the same reason: the interesting code in
 * this work package is arithmetic, and arithmetic has no business knowing about
 * Postgres.
 *
 * Two implementations:
 *
 *   * `drizzleLotStore(db)` — the real one, over `0014_lots.sql`;
 *   * `inMemoryLotStore()` — for the engine proofs in `src/*.test.ts`.
 *
 * **The fake enforces the same invariants the schema does**, which is the only
 * reason it is allowed to exist (0013's header makes the same argument):
 *
 *   * an unknown basis is `null` and its source is `ESTIMATED` with a non-empty
 *     warning (`cost_basis_lots_unknown_basis_is_declared_estimated` and
 *     `cost_basis_lots_estimated_basis_carries_a_warning`);
 *   * `0 <= quantity_remaining <= quantity`;
 *   * `holding_period_start_date <= open_date`;
 *   * an `AVERAGE_COST` election cannot be switched away from
 *     (`basis_method_elections_average_cost_is_sticky`, a trigger).
 *
 * A fake that relaxed any of them would make every unit test in this package a
 * statement about the fake. It lives in `src/` rather than `test/` so a
 * reviewer re-running these proofs cannot substitute a friendlier one. What the
 * fake cannot prove — that Postgres agrees — is what `test/db/lots.test.ts`
 * does, and each of the four invariants is asserted there against the real
 * constraint name.
 */
import type { Database } from '@core/db';
import {
  DateOnly,
  Money,
  Quantity,
  currency as toCurrency,
  newId,
  type Clock,
  type DateOnly as DateOnlyType,
} from '@core/kernel';
import { and, eq, sql } from 'drizzle-orm';
import {
  basisMethodElections,
  costBasisLots,
  holdings,
  holdingsSnapshots,
  investmentTransactions,
  type BasisMethod,
  type CostBasisLotRow,
} from '../schema/index.ts';
import type { Holding, InvestmentTransaction } from './holdings.ts';
import { DEFAULT_BASIS_METHOD, type Lot } from './lots.ts';

export class LotConstraintError extends Error {
  constructor(
    readonly constraint: string,
    message: string,
  ) {
    super(message);
    this.name = 'LotConstraintError';
  }
}

export interface UpsertResult {
  readonly id: string;
  readonly inserted: boolean;
}

export interface LotStore {
  /** Current position, per account × security. Idempotent on that key. */
  upsertHolding(userId: string, holding: Holding, options: UpsertHoldingOptions): Promise<void>;
  /** One row per calendar day, so a past allocation is a read. */
  recordHoldingSnapshot(userId: string, holding: Holding): Promise<void>;
  /** Idempotent on the provider natural key. 01 §5.5: a window and an upsert, no cursor. */
  upsertInvestmentTransaction(
    userId: string,
    transaction: InvestmentTransaction,
  ): Promise<UpsertResult>;
  /** Open lots for one basis scope. The matcher's read. */
  listOpenLots(userId: string, accountId: string, securityId: string): Promise<readonly Lot[]>;
  /**
   * Every lot in one security, **across every account**. The wash-sale scan's
   * read, and deliberately not account-scoped — 07 §4.4's "trap most software
   * misses".
   */
  listLotsForSecurity(userId: string, securityId: string): Promise<readonly Lot[]>;
  saveLots(userId: string, lots: readonly Lot[]): Promise<void>;
  /** The elected method, or FIFO — which is the IRS default, not a fallback. */
  basisMethodFor(userId: string, accountId: string, securityId: string): Promise<BasisMethod>;
  electBasisMethod(input: ElectionInput): Promise<void>;
}

export interface UpsertHoldingOptions {
  readonly id: string;
  /** 04 §5.5: a sync may never overwrite a basis the user corrected. */
  readonly preserveUserSuppliedBasis?: boolean;
  readonly costBasisSource?: 'BROKER' | 'IMPORTED' | 'USER' | 'ESTIMATED' | 'SAFE_HARBOR_ALLOC';
}

export interface ElectionInput {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  readonly securityId: string;
  readonly method: BasisMethod;
  readonly electedOn: DateOnlyType;
}

// ---------------------------------------------------------------------------
// Row <-> domain
// ---------------------------------------------------------------------------

export function lotFromRow(row: CostBasisLotRow): Lot {
  const code = toCurrency(row.currency.trim());
  return {
    id: row.id,
    accountId: row.accountId,
    securityId: row.securityId,
    openDate: DateOnly.parse(row.openDate),
    holdingPeriodStartDate: DateOnly.parse(row.holdingPeriodStartDate),
    quantity: Quantity.fromDatabaseString(row.quantity),
    quantityRemaining: Quantity.fromDatabaseString(row.quantityRemaining),
    basis: row.basisMinor === null ? null : Money.of(row.basisMinor, code),
    basisConsumed: Money.of(row.basisConsumedMinor, code),
    currency: code,
    basisSource: row.basisSource,
    acquisitionType: row.acquisitionType,
    basisWarning: row.basisWarning,
    washSaleAdjustment: Money.of(row.washSaleAdjustmentMinor, code),
    openedByTransactionId: row.openedByTransactionId,
    sourceTxnHash: row.sourceTxnHash,
  };
}

/**
 * The four invariants, checked before a write.
 *
 * Duplicated from the migration on purpose: the database is the enforcement and
 * this is the *error message*. A 23514 with a constraint name is correct and
 * unreadable; this turns it into a sentence at the point the mistake was made,
 * and `test/db/lots.test.ts` asserts the constraint fires even when this
 * function is bypassed.
 */
export function assertLotIsWellFormed(lot: Lot): void {
  if (Quantity.compare(lot.quantity, Quantity.zero) <= 0) {
    throw new LotConstraintError('cost_basis_lots_quantity_check', 'a lot needs a positive quantity');
  }
  if (Quantity.compare(lot.quantityRemaining, Quantity.zero) < 0) {
    throw new LotConstraintError(
      'cost_basis_lots_quantity_remaining_check',
      'quantity_remaining is never negative',
    );
  }
  if (Quantity.compare(lot.quantityRemaining, lot.quantity) > 0) {
    throw new LotConstraintError(
      'cost_basis_lots_remaining_within_quantity',
      'quantity_remaining never exceeds the quantity acquired',
    );
  }
  if (DateOnly.isAfter(lot.holdingPeriodStartDate, lot.openDate)) {
    throw new LotConstraintError(
      'cost_basis_lots_holding_period_starts_no_later_than_open',
      'a holding period starts no later than the lot opens',
    );
  }
  if (lot.basis === null && lot.basisSource !== 'ESTIMATED') {
    throw new LotConstraintError(
      'cost_basis_lots_unknown_basis_is_declared_estimated',
      'a lot with no basis must declare basis_source ESTIMATED — a zero is not an unknown',
    );
  }
  if (lot.basisSource === 'ESTIMATED' && (lot.basisWarning ?? '').trim() === '') {
    throw new LotConstraintError(
      'cost_basis_lots_estimated_basis_carries_a_warning',
      'an ESTIMATED basis must carry the warning the UI is obliged to show',
    );
  }
  if (lot.basis !== null && Money.isNegative(lot.basis)) {
    throw new LotConstraintError('cost_basis_lots_basis_minor_check', 'a basis is never negative');
  }
  if (Money.isNegative(lot.washSaleAdjustment)) {
    throw new LotConstraintError(
      'cost_basis_lots_wash_sale_adjustment_minor_check',
      'a wash-sale adjustment only ever raises a basis',
    );
  }
  if (!Money.isZero(lot.washSaleAdjustment) && lot.basis === null) {
    throw new LotConstraintError(
      'cost_basis_lots_wash_adjustment_needs_a_basis',
      'there is no basis to add a disallowed loss to',
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory
// ---------------------------------------------------------------------------

export interface InMemoryLotStore extends LotStore {
  readonly lots: Map<string, Lot>;
  readonly holdings: Map<string, Holding>;
  readonly snapshots: Map<string, Holding>;
  readonly transactions: Map<string, InvestmentTransaction>;
  readonly elections: Map<string, BasisMethod>;
}

const scopeKey = (userId: string, accountId: string, securityId: string): string =>
  `${userId}${accountId}${securityId}`;

export function inMemoryLotStore(): InMemoryLotStore {
  const lots = new Map<string, Lot>();
  const holdingRows = new Map<string, Holding>();
  const snapshots = new Map<string, Holding>();
  const transactions = new Map<string, InvestmentTransaction>();
  const elections = new Map<string, BasisMethod>();

  return {
    lots,
    holdings: holdingRows,
    snapshots,
    transactions,
    elections,

    async upsertHolding(userId, holding) {
      holdingRows.set(scopeKey(userId, holding.accountId, holding.securityId), holding);
    },
    async recordHoldingSnapshot(userId, holding) {
      snapshots.set(
        `${scopeKey(userId, holding.accountId, holding.securityId)}${holding.asOfDate}`,
        holding,
      );
    },
    async upsertInvestmentTransaction(userId, transaction) {
      const key = `${userId}${transaction.accountId}${transaction.provider}${transaction.providerTransactionId}`;
      const existing = transactions.get(key);
      transactions.set(key, existing === undefined ? transaction : { ...transaction, id: existing.id });
      return { id: existing?.id ?? transaction.id, inserted: existing === undefined };
    },
    async listOpenLots(userId, accountId, securityId) {
      void userId;
      return [...lots.values()].filter(
        (lot) =>
          lot.accountId === accountId &&
          lot.securityId === securityId &&
          Quantity.compare(lot.quantityRemaining, Quantity.zero) > 0,
      );
    },
    async listLotsForSecurity(userId, securityId) {
      void userId;
      return [...lots.values()].filter((lot) => lot.securityId === securityId);
    },
    async saveLots(userId, incoming) {
      void userId;
      for (const lot of incoming) {
        assertLotIsWellFormed(lot);
        lots.set(lot.id, lot);
      }
    },
    async basisMethodFor(userId, accountId, securityId) {
      return elections.get(scopeKey(userId, accountId, securityId)) ?? DEFAULT_BASIS_METHOD;
    },
    async electBasisMethod(input) {
      const key = scopeKey(input.userId, input.accountId, input.securityId);
      const current = elections.get(key);
      // The trigger, in TypeScript. See the file header.
      if (current === 'AVERAGE_COST' && input.method !== 'AVERAGE_COST') {
        throw new LotConstraintError(
          'basis_method_elections_average_cost_is_sticky',
          'AVERAGE_COST is sticky for this account and security once elected (07 §4.4)',
        );
      }
      elections.set(key, input.method);
    },
  };
}

// ---------------------------------------------------------------------------
// Drizzle
// ---------------------------------------------------------------------------

export function drizzleLotStore(db: Database, clock: Clock): LotStore {
  const now = (): Date => clock.now();

  return {
    async upsertHolding(userId, holding, options) {
      const perUnit =
        holding.costBasis === null || Quantity.compare(holding.quantity, Quantity.zero) === 0
          ? null
          : Quantity.toDatabaseString(
              Quantity.divide(
                Quantity.of(holding.costBasis.minor.toString()),
                Quantity.toDatabaseString(holding.quantity),
              ),
            );
      await db
        .insert(holdings)
        .values({
          id: options.id,
          userId,
          accountId: holding.accountId,
          securityId: holding.securityId,
          quantity: Quantity.toDatabaseString(holding.quantity),
          institutionValueMinor: holding.institutionValue.minor,
          currency: holding.institutionValue.currency,
          costBasisMinor: holding.costBasis?.minor ?? null,
          costBasisPerUnit: perUnit,
          costBasisIsUserSupplied: false,
          costBasisSource: options.costBasisSource ?? (holding.costBasis === null ? null : 'BROKER'),
          asOfDate: holding.asOfDate,
          createdAt: now(),
          updatedAt: now(),
        })
        .onConflictDoUpdate({
          target: [holdings.userId, holdings.accountId, holdings.securityId],
          set: {
            quantity: Quantity.toDatabaseString(holding.quantity),
            institutionValueMinor: holding.institutionValue.minor,
            currency: holding.institutionValue.currency,
            // 04 §5.5, as SQL rather than as a habit: when the user supplied
            // the basis, the sync's value is discarded and the stored one kept.
            costBasisMinor: sql`CASE WHEN ${holdings.costBasisIsUserSupplied}
              THEN ${holdings.costBasisMinor} ELSE ${holding.costBasis?.minor ?? null} END`,
            costBasisPerUnit: sql`CASE WHEN ${holdings.costBasisIsUserSupplied}
              THEN ${holdings.costBasisPerUnit} ELSE ${perUnit} END`,
            asOfDate: holding.asOfDate,
            updatedAt: now(),
          },
        });
    },

    async recordHoldingSnapshot(userId, holding) {
      await db
        .insert(holdingsSnapshots)
        .values({
          // A snapshot row's id is never referenced; the day key is the
          // identity, and `onConflictDoUpdate` below is what makes a second
          // sync on the same day a revision rather than a duplicate.
          id: newId(),
          userId,
          accountId: holding.accountId,
          securityId: holding.securityId,
          asOfDate: holding.asOfDate,
          quantity: Quantity.toDatabaseString(holding.quantity),
          institutionValueMinor: holding.institutionValue.minor,
          currency: holding.institutionValue.currency,
          costBasisMinor: holding.costBasis?.minor ?? null,
          createdAt: now(),
        })
        .onConflictDoUpdate({
          target: [
            holdingsSnapshots.userId,
            holdingsSnapshots.accountId,
            holdingsSnapshots.securityId,
            holdingsSnapshots.asOfDate,
          ],
          set: {
            quantity: Quantity.toDatabaseString(holding.quantity),
            institutionValueMinor: holding.institutionValue.minor,
            costBasisMinor: holding.costBasis?.minor ?? null,
          },
        });
    },

    async upsertInvestmentTransaction(userId, transaction) {
      const rows = await db
        .insert(investmentTransactions)
        .values({
          id: transaction.id,
          userId,
          accountId: transaction.accountId,
          securityId: transaction.securityId,
          provider: transaction.provider,
          providerTransactionId: transaction.providerTransactionId,
          type: transaction.type,
          subtype: transaction.subtype,
          name: transaction.name,
          quantity: Quantity.toDatabaseString(transaction.quantity),
          price: transaction.price === null ? null : Quantity.toDatabaseString(transaction.price),
          amountMinor: transaction.amount.minor,
          feesMinor: transaction.fees.minor,
          currency: transaction.amount.currency,
          tradeDate: transaction.tradeDate,
          settleDate: transaction.settleDate,
          source: transaction.source,
          fingerprint: transaction.fingerprint,
          createdAt: now(),
          updatedAt: now(),
        })
        .onConflictDoUpdate({
          target: [
            investmentTransactions.userId,
            investmentTransactions.accountId,
            investmentTransactions.provider,
            investmentTransactions.providerTransactionId,
          ],
          set: {
            securityId: transaction.securityId,
            type: transaction.type,
            subtype: transaction.subtype,
            name: transaction.name,
            quantity: Quantity.toDatabaseString(transaction.quantity),
            price: transaction.price === null ? null : Quantity.toDatabaseString(transaction.price),
            amountMinor: transaction.amount.minor,
            feesMinor: transaction.fees.minor,
            tradeDate: transaction.tradeDate,
            settleDate: transaction.settleDate,
            updatedAt: now(),
          },
        })
        .returning({ id: investmentTransactions.id, createdAt: investmentTransactions.createdAt });
      const row = rows[0];
      return {
        id: row?.id ?? transaction.id,
        inserted: row?.id === transaction.id,
      };
    },

    async listOpenLots(userId, accountId, securityId) {
      const rows = await db
        .select()
        .from(costBasisLots)
        .where(
          and(
            eq(costBasisLots.userId, userId),
            eq(costBasisLots.accountId, accountId),
            eq(costBasisLots.securityId, securityId),
            sql`${costBasisLots.quantityRemaining} > 0`,
          ),
        );
      return rows.map(lotFromRow);
    },

    async listLotsForSecurity(userId, securityId) {
      const rows = await db
        .select()
        .from(costBasisLots)
        .where(and(eq(costBasisLots.userId, userId), eq(costBasisLots.securityId, securityId)));
      return rows.map(lotFromRow);
    },

    async saveLots(userId, incoming) {
      for (const lot of incoming) {
        assertLotIsWellFormed(lot);
        await db
          .insert(costBasisLots)
          .values({
            id: lot.id,
            userId,
            accountId: lot.accountId,
            securityId: lot.securityId,
            openDate: lot.openDate,
            holdingPeriodStartDate: lot.holdingPeriodStartDate,
            quantity: Quantity.toDatabaseString(lot.quantity),
            quantityRemaining: Quantity.toDatabaseString(lot.quantityRemaining),
            basisMinor: lot.basis?.minor ?? null,
            basisConsumedMinor: lot.basisConsumed.minor,
            currency: lot.currency,
            basisSource: lot.basisSource,
            acquisitionType: lot.acquisitionType,
            basisWarning: lot.basisWarning,
            washSaleAdjustmentMinor: lot.washSaleAdjustment.minor,
            openedByTransactionId: lot.openedByTransactionId,
            sourceTxnHash: lot.sourceTxnHash,
            createdAt: now(),
            updatedAt: now(),
          })
          .onConflictDoUpdate({
            target: costBasisLots.id,
            set: {
              quantityRemaining: Quantity.toDatabaseString(lot.quantityRemaining),
              basisMinor: lot.basis?.minor ?? null,
              basisConsumedMinor: lot.basisConsumed.minor,
              basisSource: lot.basisSource,
              basisWarning: lot.basisWarning,
              washSaleAdjustmentMinor: lot.washSaleAdjustment.minor,
              holdingPeriodStartDate: lot.holdingPeriodStartDate,
              updatedAt: now(),
            },
          });
      }
    },

    async basisMethodFor(userId, accountId, securityId) {
      const rows = await db
        .select({ method: basisMethodElections.method })
        .from(basisMethodElections)
        .where(
          and(
            eq(basisMethodElections.userId, userId),
            eq(basisMethodElections.accountId, accountId),
            eq(basisMethodElections.securityId, securityId),
          ),
        );
      // An absent row is FIFO, which is the IRS default. Not "unset".
      return rows[0]?.method ?? DEFAULT_BASIS_METHOD;
    },

    async electBasisMethod(input) {
      // The stickiness trigger is what actually refuses; this upsert simply
      // lets it fire. `test/db/lots.test.ts` reads the constraint name back.
      await db
        .insert(basisMethodElections)
        .values({
          id: input.id,
          userId: input.userId,
          accountId: input.accountId,
          securityId: input.securityId,
          method: input.method,
          electedOn: input.electedOn,
          electedAt: now(),
          createdAt: now(),
          updatedAt: now(),
        })
        .onConflictDoUpdate({
          target: [
            basisMethodElections.userId,
            basisMethodElections.accountId,
            basisMethodElections.securityId,
          ],
          set: { method: input.method, electedOn: input.electedOn, updatedAt: now() },
        });
    },
  };
}
