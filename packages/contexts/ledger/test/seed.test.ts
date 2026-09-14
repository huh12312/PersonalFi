// SPDX-License-Identifier: MIT
/**
 * The whole pipeline against 24 months of demo history, graded on the seed's own
 * ground-truth labels.
 *
 * This is the test that would have caught every heuristic regression the unit
 * tests cannot: it runs the real write path over a thousand transactions with
 * real statement-descriptor noise, then asks the labels how it did. The numbers
 * it prints are the ones quoted in `docs/evidence/phase-1/wp1.1-ledger.md`.
 *
 * The thresholds below are gates, not aspirations. Precision is set higher than
 * recall on purpose: a missed transfer leaves a visible pair of rows a user can
 * merge, while a false one silently deletes real spending from a budget total.
 *
 * **The second suite is the one that carries the evidence.** The seed's transfer
 * pairs are same-day and exactly equal, which is the easiest case there is, so a
 * perfect score against it proves only that the decoys in the dataset — payroll
 * deposits, mortgage payments, same-account refunds — do not trip the heuristic.
 * `degraded seed` deliberately breaks that symmetry (settlement lag, a wire fee
 * shaved off the receiving leg) and re-grades, because a gate that has never been
 * observed failing something is not evidence.
 */
import { DateOnly, Money } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAccounts, netWorthNow } from '../src/accounts.ts';
import { listTransactions, sumTransactions } from '../src/read.ts';
import { loadSeedDataset, type LoadSeedResult, type SeedDatasetLike } from '../src/seed-loader.ts';
import {
  NO_DATABASE,
  generateDemoData,
  ledgerDatabase,
  testClock,
  type TestDatabase,
} from './harness.ts';

describe.skipIf(NO_DATABASE)('loadSeedDataset', () => {
  let database: TestDatabase;
  let result: LoadSeedResult;
  let dataset: ReturnType<typeof generateDemoData>;

  beforeAll(async () => {
    database = await ledgerDatabase('seed');
    dataset = generateDemoData(1);
    const started = performance.now();
    result = await loadSeedDataset(database.db, database.userId, dataset, {
      clock: testClock(),
    });
    const elapsed = Math.round(performance.now() - started);
    process.stdout.write(
      `\n  seed(1): ${String(result.transactionCount)} transactions, ` +
        `${String(result.accountCount)} accounts, loaded and graded in ${String(elapsed)} ms\n` +
        `  transfers: P=${result.transfers.precision.toFixed(4)} ` +
        `R=${result.transfers.recall.toFixed(4)} ` +
        `(${String(result.transfers.truePositives)}/${String(result.transfers.actual)} found, ` +
        `${String(result.transfers.falsePositives)} false)\n` +
        `  refunds:   P=${result.refunds.precision.toFixed(4)} ` +
        `R=${result.refunds.recall.toFixed(4)} ` +
        `(${String(result.refunds.truePositives)}/${String(result.refunds.actual)} found, ` +
        `${String(result.refunds.falsePositives)} false)\n`,
    );
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  });

  it('loads every transaction the dataset contains', async () => {
    expect(result.transactionCount).toBe(dataset.transactions.length);
    expect(result.accountCount).toBe(dataset.accounts.length);

    let counted = 0;
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof listTransactions>> = await listTransactions(
        database.db,
        { userId: database.userId, limit: 200, cursor },
      );
      counted += page.items.length;
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(counted).toBe(dataset.transactions.length);
  });

  it('pairs internal transfers with high precision and high recall', () => {
    // A false positive here removes real spending from a budget total and the
    // user's only symptom is that the numbers look slightly too good.
    expect(result.transfers.falsePositivePairs).toEqual([]);
    expect(result.transfers.precision).toBeGreaterThanOrEqual(0.99);
    expect(result.transfers.recall).toBeGreaterThanOrEqual(0.95);
  });

  it('hints at refunds without ever claiming a purchase it did not reverse', () => {
    expect(result.refunds.precision).toBeGreaterThanOrEqual(0.9);
    expect(result.refunds.recall).toBeGreaterThanOrEqual(0.8);
  });

  it('leaves zero internal transfers in a spend total (the Phase 1 exit criterion)', async () => {
    const withTransfers = await sumTransactions(database.db, {
      userId: database.userId,
      filters: { transfers: 'include' },
    });
    const withoutTransfers = await sumTransactions(database.db, {
      userId: database.userId,
      filters: { transfers: 'exclude' },
    });

    const paired = result.transferLinkCount;
    expect(paired).toBeGreaterThan(0);
    // Both legs of every pair net to zero, so dropping them cannot change the
    // total — which is exactly why double-counting them is invisible until
    // someone looks at a category breakdown and finds "Transfers: $84,000".
    expect(withoutTransfers[0]?.total.minor).toBe(withTransfers[0]?.total.minor);
  });

  it('gives every account a balance and a net worth that adds up', async () => {
    const accounts = await listAccounts(database.db, { userId: database.userId });
    expect(accounts).toHaveLength(dataset.accounts.length);
    for (const account of accounts) expect(account.balance).not.toBeNull();

    const worth = await netWorthNow(database.db, { userId: database.userId });
    const total = worth.totals[0];
    if (total === undefined) throw new Error('expected one currency');
    expect(total.net.minor).toBe(total.assets.minor + total.liabilities.minor);
    expect(worth.inputs.every((input) => input.included)).toBe(true);
  });

  it('is idempotent: loading the dataset again changes nothing', async () => {
    const before = await snapshot();
    const second = await loadSeedDataset(database.db, database.userId, dataset, {
      clock: testClock(),
      detect: false,
    });
    expect(second.transactionCount).toBe(dataset.transactions.length);
    expect(await snapshot()).toEqual(before);
  }, 300_000);

  async function snapshot(): Promise<{ transactions: number; effectiveSum: bigint | undefined }> {
    const [total] = await sumTransactions(database.db, {
      userId: database.userId,
      filters: { transfers: 'include' },
    });
    const counted = await database.db.execute<{ count: string }>(
      sql`SELECT count(*) AS count FROM transactions`,
    );
    return {
      transactions: Number(counted.rows[0]?.count ?? 0),
      effectiveSum: total?.total.minor,
    };
  }
});

/**
 * The same dataset with the two properties that make pairing easy taken away.
 *
 * Real transfers do not settle on the same day and do not always arrive whole: an
 * ACH lands one to three business days later, and a wire arrives short by the
 * receiving bank's fee. If the heuristic only works when both legs are identical
 * and simultaneous, it works on the fixture and not on a bank statement.
 */
describe.skipIf(NO_DATABASE)('loadSeedDataset — degraded seed', () => {
  let database: TestDatabase;
  let result: LoadSeedResult;

  beforeAll(async () => {
    database = await ledgerDatabase('seed_degraded');
    const dataset = degrade(generateDemoData(1));
    result = await loadSeedDataset(database.db, database.userId, dataset, {
      clock: testClock(),
      // The slack the degradation needs, and no more: 5 days and 50 cents.
      pairing: { windowDays: 5, toleranceMinor: 50n },
    });
    process.stdout.write(
      `\n  degraded seed(1): transfers P=${result.transfers.precision.toFixed(4)} ` +
        `R=${result.transfers.recall.toFixed(4)} ` +
        `(${String(result.transfers.truePositives)}/${String(result.transfers.actual)} found, ` +
        `${String(result.transfers.falsePositives)} false)\n`,
    );
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  });

  it('still pairs transfers that lag and arrive short', () => {
    expect(result.transfers.recall).toBeGreaterThanOrEqual(0.9);
    expect(result.transfers.precision).toBeGreaterThanOrEqual(0.95);
  });

  it('reports which pairs it lost, so a regression is legible', () => {
    // Not an assertion of zero: the point of the degraded run is to see the
    // failures. It is an assertion that the failures are *named*, because a
    // precision number with no attached pairs is a number nobody can debug.
    expect(result.transfers.falseNegativePairs.length).toBe(result.transfers.falseNegatives);
    expect(result.transfers.falsePositivePairs.length).toBe(result.transfers.falsePositives);
  });
});

/**
 * The control for the suite above.
 *
 * A degradation that the *default* settings survive is not a degradation, and a
 * tolerance that has never been observed making a difference is not a control —
 * it is a parameter nobody has tested. This run loads the same damaged dataset
 * with the shipped defaults (exact amounts only) and asserts that recall drops by
 * exactly the pairs whose receiving leg is short a fee. If this suite ever goes
 * green at 1.0, the degradation has stopped biting and the suite above has
 * stopped proving anything.
 */
describe.skipIf(NO_DATABASE)('degraded seed — the control', () => {
  let database: TestDatabase;
  let result: LoadSeedResult;
  let shortPairs: number;

  beforeAll(async () => {
    database = await ledgerDatabase('seed_control');
    const source = generateDemoData(1);
    shortPairs = source.labels.transfers.filter((_pair, index) => index % 3 === 0).length;
    result = await loadSeedDataset(database.db, database.userId, degrade(source), {
      clock: testClock(),
      // No `pairing` override: the shipped defaults, which match amounts exactly.
    });
    process.stdout.write(
      `\n  control (defaults, no tolerance): transfers R=${result.transfers.recall.toFixed(4)} ` +
        `(${String(result.transfers.truePositives)}/${String(result.transfers.actual)} found, ` +
        `${String(shortPairs)} legs short a fee)\n`,
    );
  }, 300_000);

  afterAll(async () => {
    await database.drop();
  });

  it('misses exactly the pairs whose receiving leg arrived short', () => {
    expect(result.transfers.falseNegatives).toBe(shortPairs);
    expect(result.transfers.recall).toBeLessThan(0.9);
    // Precision stays perfect even as recall collapses: refusing to guess is the
    // designed behaviour, not a symptom.
    expect(result.transfers.precision).toBe(1);
  });
});

/**
 * Push the receiving leg of every labelled transfer later by one to three days,
 * and shave a 25-cent fee off every third one.
 */
function degrade(dataset: ReturnType<typeof generateDemoData>): SeedDatasetLike {
  const lag = new Map<string, number>();
  const fee = new Set<string>();
  dataset.labels.transfers.forEach((pair, index) => {
    lag.set(pair.toTransactionId, (index % 3) + 1);
    if (index % 3 === 0) fee.add(pair.toTransactionId);
  });

  return {
    ...dataset,
    transactions: dataset.transactions.map((transaction) => {
      const days = lag.get(transaction.id);
      if (days === undefined) return transaction;
      const amount = Money.fromJSON(transaction.amount);
      return {
        ...transaction,
        postedOn: DateOnly.addDays(transaction.postedOn, days),
        pendingOn: null,
        amount: fee.has(transaction.id)
          ? Money.toJSON(Money.of(amount.minor - 25n, amount.currency))
          : transaction.amount,
      };
    }),
  };
}
