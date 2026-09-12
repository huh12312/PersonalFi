// SPDX-License-Identifier: MIT
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SeedDataset } from './types.ts';

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write a `SeedDataset` to `dir` as one JSON file per collection, plus
 * `meta.json` for the scalar fields. Split rather than one giant file so a
 * consumer that only wants `transactions.json` (Phase 1's fixture loader, a
 * spreadsheet check) does not have to parse holdings and prices to get it.
 */
export async function writeJson(dir: string, dataset: SeedDataset): Promise<void> {
  await mkdir(dir, { recursive: true });
  const { accounts, merchants, transactions, holdings, prices, labels, ...meta } = dataset;
  await Promise.all([
    writeFile(join(dir, 'meta.json'), pretty(meta)),
    writeFile(join(dir, 'accounts.json'), pretty(accounts)),
    writeFile(join(dir, 'merchants.json'), pretty(merchants)),
    writeFile(join(dir, 'transactions.json'), pretty(transactions)),
    writeFile(join(dir, 'holdings.json'), pretty(holdings)),
    writeFile(join(dir, 'prices.json'), pretty(prices)),
    writeFile(join(dir, 'labels.json'), pretty(labels)),
  ]);
}
