// SPDX-License-Identifier: MIT
import type { SeedDataset, TransactionKind, TransactionStatus } from './types.ts';

export interface SeedStats {
  readonly seed: number;
  readonly window: {
    readonly startMonth: string;
    readonly monthCount: number;
    readonly today: string;
  };
  readonly accounts: number;
  readonly merchants: number;
  readonly transactions: {
    readonly total: number;
    readonly byKind: Readonly<Record<TransactionKind, number>>;
    readonly byStatus: Readonly<Record<TransactionStatus, number>>;
  };
  readonly recurringSeries: number;
  readonly transfers: number;
  readonly refunds: number;
  readonly holdings: number;
  readonly prices: number;
}

const KINDS: readonly TransactionKind[] = [
  'purchase',
  'payment',
  'transfer',
  'refund',
  'interest',
  'fee',
  'deposit',
];
const STATUSES: readonly TransactionStatus[] = ['pending', 'posted'];

function countBy<T extends string>(values: readonly T[], all: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(all.map((key) => [key, 0])) as Record<T, number>;
  for (const value of values) counts[value] += 1;
  return counts;
}

export function computeStats(dataset: SeedDataset): SeedStats {
  return {
    seed: dataset.seed,
    window: {
      startMonth: dataset.startMonth,
      monthCount: dataset.monthCount,
      today: dataset.transactions.at(-1)?.postedOn ?? dataset.startMonth,
    },
    accounts: dataset.accounts.length,
    merchants: dataset.merchants.length,
    transactions: {
      total: dataset.transactions.length,
      byKind: countBy(
        dataset.transactions.map((t) => t.kind),
        KINDS,
      ),
      byStatus: countBy(
        dataset.transactions.map((t) => t.status),
        STATUSES,
      ),
    },
    recurringSeries: dataset.labels.recurringSeries.length,
    transfers: dataset.labels.transfers.length,
    refunds: dataset.labels.refunds.length,
    holdings: dataset.holdings.length,
    prices: dataset.prices.length,
  };
}

/** Human-readable rendering for the `--stats` CLI flag. */
export function formatStats(stats: SeedStats): string {
  const lines = [
    `seed ${stats.seed} — ${stats.window.startMonth} .. ${stats.window.today} (${stats.window.monthCount} months)`,
    `accounts:         ${stats.accounts}`,
    `merchants:        ${stats.merchants}`,
    `transactions:     ${stats.transactions.total}`,
    ...KINDS.filter((k) => stats.transactions.byKind[k] > 0).map(
      (k) => `  ${k.padEnd(16)}${stats.transactions.byKind[k]}`,
    ),
    `  pending:        ${stats.transactions.byStatus.pending}`,
    `  posted:         ${stats.transactions.byStatus.posted}`,
    `recurring series: ${stats.recurringSeries}`,
    `transfers:        ${stats.transfers}`,
    `refunds:          ${stats.refunds}`,
    `holdings:         ${stats.holdings}`,
    `price points:     ${stats.prices}`,
  ];
  return lines.join('\n');
}
