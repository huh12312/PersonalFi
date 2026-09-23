// SPDX-License-Identifier: MIT
/**
 * `cost_basis_lots` and `basis_method_elections` — migration `0014_lots.sql`.
 *
 * Two shapes, and the pair is the whole tax model:
 *
 *   * a **lot** is a quantity acquired at one moment for one basis, with a
 *     remaining quantity and *two* dates;
 *   * an **election** says which lot a sale consumes.
 *
 * Three things in here are load-bearing and each has a CHECK in the migration
 * rather than only a rule in TypeScript.
 *
 * **`basisMinor` is nullable, and a NULL is not a zero.** 04 §5.5 and 07 §6.2.
 * An unknown basis must read `unavailable`; a zero there is a fabricated 100%
 * gain that flows into allocation, into the tax estimate and onto the screen.
 * So a lot with no number must declare `basisSource = 'ESTIMATED'` and carry a
 * non-empty `basisWarning` — the string the UI is obliged to show. A
 * genuinely-free lot (an airdrop whose FMV at receipt was $0.00) is a
 * *different* row: `basisMinor = 0n`, `basisSource = 'BROKER'` or `'IMPORTED'`,
 * no warning. Telling those two apart is the entire point of the nullability.
 *
 * **`holdingPeriodStartDate` is not `openDate`.** 07 §4.4, verbatim: "separate
 * from open_date: wash sales tack on the prior holding period". A lot opened
 * yesterday can be long-term today, and the migration's
 * `cost_basis_lots_holding_period_starts_no_later_than_open` states the only
 * direction tacking can move it.
 *
 * **`accountId` is the Rev. Proc. 2024-28 basis boundary.** Since 2025-01-01
 * digital-asset basis is per wallet or account, never universal. FIFO across
 * two wallets is the wrong answer, not a rounding difference. There is no
 * second `walletId` column: a watch-only wallet (0016) is an account, and two
 * columns meaning "the basis scope" is how half the queries end up using the
 * wrong one.
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  dateColumn,
  idColumn,
  instantColumn,
  quantityColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { BASIS_SOURCES, type BasisSource } from './holdings.ts';

export { BASIS_SOURCES, type BasisSource };

/**
 * How a lot came into existence.
 *
 * `STAKING`, `AIRDROP`, `MINING` and `FORK` are separate members rather than
 * one `INCOME` because Rev. Rul. 2023-14 gives them different dominion-and-
 * control moments and 07 §6.5 flags liquid-staking and rebasing tokens as
 * genuinely unsettled. `TRANSFER_IN` is the one that must never be treated as
 * an acquisition for gain purposes: a self-transfer carries its lots, keeping
 * the original `openDate`, `holdingPeriodStartDate` and basis (07 §6.2).
 * `SPLIT` marks a lot rewritten by a corporate action — quantity and per-unit
 * basis move, total basis does not.
 */
export const ACQUISITION_TYPES = [
  'BUY',
  'REINVESTED_DIVIDEND',
  'TRANSFER_IN',
  'STAKING',
  'AIRDROP',
  'MINING',
  'FORK',
  'GIFT',
  'SPLIT',
] as const;
export type AcquisitionType = (typeof ACQUISITION_TYPES)[number];

/**
 * 07 §4.4's five methods.
 *
 * FIFO is the default *and* the IRS default, which is why an absent election
 * row means FIFO rather than "unset". `AVERAGE_COST` is mutual-funds-only and
 * sticky once elected — enforced by a trigger in the migration, not by a
 * dropdown.
 */
export const BASIS_METHODS = ['FIFO', 'LIFO', 'HIFO', 'SPECIFIC_ID', 'AVERAGE_COST'] as const;
export type BasisMethod = (typeof BASIS_METHODS)[number];

export const costBasisLots = pgTable('cost_basis_lots', {
  id: idColumn(),
  userId: userIdColumn(),
  /** The basis scope: one wallet or one account. Opaque; never a join. */
  accountId: uuid('account_id').notNull(),
  securityId: uuid('security_id').notNull(),

  openDate: dateColumn('open_date').notNull(),
  /** Earlier than `openDate` when a wash sale tacked a period on. Never later. */
  holdingPeriodStartDate: dateColumn('holding_period_start_date').notNull(),

  quantity: quantityColumn('quantity').notNull(),
  quantityRemaining: quantityColumn('quantity_remaining').notNull(),

  /** NULL = unknown. See the file header. */
  basisMinor: amountMinorColumn('basis_minor'),
  /** What disposals have already taken, so consumed + remaining = basisMinor exactly. */
  basisConsumedMinor: amountMinorColumn('basis_consumed_minor').notNull(),
  currency: currencyColumn().notNull(),

  basisSource: text('basis_source').$type<BasisSource>().notNull(),
  acquisitionType: text('acquisition_type').$type<AcquisitionType>().notNull(),
  /** Mandatory on an ESTIMATED lot. 07 §6.2's "visible warning". */
  basisWarning: text('basis_warning'),

  /** The §1091 loss folded into `basisMinor`, kept separately so it is auditable. */
  washSaleAdjustmentMinor: amountMinorColumn('wash_sale_adjustment_minor').notNull(),

  openedByTransactionId: uuid('opened_by_transaction_id'),
  sourceTxnHash: text('source_txn_hash'),

  createdAt: createdAtColumn(),
  updatedAt: updatedAtColumn(),
});

export const basisMethodElections = pgTable(
  'basis_method_elections',
  {
    id: idColumn(),
    userId: userIdColumn(),
    accountId: uuid('account_id').notNull(),
    securityId: uuid('security_id').notNull(),

    method: text('method').$type<BasisMethod>().notNull(),
    electedOn: dateColumn('elected_on').notNull(),
    electedAt: instantColumn('elected_at').notNull(),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    unique('basis_method_elections_scope_uniq').on(
      table.userId,
      table.accountId,
      table.securityId,
    ),
  ],
);

export type CostBasisLotRow = typeof costBasisLots.$inferSelect;
export type NewCostBasisLotRow = typeof costBasisLots.$inferInsert;
export type BasisMethodElectionRow = typeof basisMethodElections.$inferSelect;
export type NewBasisMethodElectionRow = typeof basisMethodElections.$inferInsert;
