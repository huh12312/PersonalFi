// SPDX-License-Identifier: MIT
/**
 * The v0.5 rung: **crypto on-ramps classified as transfers.**
 *
 * > "a USD deposit into Coinbase followed by a BTC buy is **one transfer plus
 * > one trade**, never $5,000 of spending in a 'Crypto' category. A WP 3.5 exit
 * > test and a gate walk item, not a nicety." — `03-phase-3-dispatch.md` §1
 *
 * The arithmetic, reproduced so the numbers below can be checked by hand rather
 * than trusted:
 *
 * ```
 *   watermark  2026-09-01  USD wallet    0.00
 *   deposit                              +5,000.00   (no v3 endpoint reports it)
 *   BTC buy    2026-09-10  0.1 @ 40,000  −4,000.00
 *                          commission    −    20.00
 *   observed   2026-09-22  USD wallet     980.00
 *
 *   delta     =   980.00 −     0.00 = +  980.00
 *   traded    = −4,000.00 −    20.00 = −4,020.00
 *   residual  =   980.00 − (−4,020.00) = +5,000.00   ← the transfer
 * ```
 */
import { describe, expect, it } from 'vitest';
import { Money } from '@core/kernel';
import { COINBASE_TRANSFER_IN_PFC, COINBASE_TRANSFER_OUT_PFC } from '../src/ledger.ts';
import { encodeWatermark } from '../src/cursor.ts';
import { securityFactOf } from '../src/map.ts';
import {
  BTC_WALLET,
  USD_WALLET,
  cursorBeforeTheDeposit,
  harness,
  watermarkBeforeTheDeposit,
} from './harness.ts';

describe('the fiat on-ramp', () => {
  it('a USD deposit followed by a BTC buy yields one transfer, one trade and zero spending', async () => {
    const { connector, handle, options } = harness();

    const page = await connector.syncTransactions(handle, cursorBeforeTheDeposit(), options);
    const investments = await connector.syncInvestmentTransactions(handle, options);

    // ---- one transfer ----------------------------------------------------
    expect(page.added).toHaveLength(1);
    const transfer = page.added[0];
    expect(transfer?.providerAccountId).toBe(USD_WALLET);
    expect(transfer?.amount).toEqual(Money.of(500_000n, 'USD'));
    expect(transfer?.isoCurrency).toBe('USD');
    // Positive: money came in. The port's convention is negative = outflow.
    expect(Money.isNegative(transfer?.amount ?? Money.zero('USD'))).toBe(false);
    expect(transfer?.providerCategory).toEqual(COINBASE_TRANSFER_IN_PFC);

    // ---- one trade -------------------------------------------------------
    // The BTC buy is an investment transaction. It is *not* in `page.added`,
    // which is the whole point: a fill expressed as a ledger transaction is
    // $4,020 of spending that no later re-categorisation can turn back into a
    // quantity, a unit price and a fee.
    // The 730-day window also returns June's ETH buy; this assertion is about
    // the BTC leg of the on-ramp, and the count below proves the window was not
    // silently emptied.
    expect(investments).toHaveLength(2);
    const buys = investments.filter((fact) => fact.providerAccountId === BTC_WALLET);
    expect(buys).toHaveLength(1);
    expect(buys[0]).toMatchObject({
      providerAccountId: BTC_WALLET,
      quantity: '0.1',
      price: '40000',
      type: 'buy',
      subtype: 'crypto_trade',
    });
    expect(buys[0]?.amount).toEqual(Money.of(-402_000n, 'USD'));
    // A positive magnitude, like the port's `limit`: the fee is already inside
    // `amount`, and a second signed copy of it is how a fee gets counted twice.
    expect(buys[0]?.fees).toEqual(Money.of(2_000n, 'USD'));
    // WP 3.14a: the whole fact, not the ticker alone.
    expect(buys[0]?.security).toEqual(securityFactOf('BTC', '40000'));

    // ---- zero spending ---------------------------------------------------
    // Every ledger transaction this adapter emitted is a transfer. Nothing it
    // emitted can reach a spending total, because `TRANSFER_IN_ACCOUNT_TRANSFER`
    // and `TRANSFER_OUT_ACCOUNT_TRANSFER` both map to `transfers.between_accounts`
    // in `@ctx/categorization`'s provider tier.
    for (const fact of [...page.added, ...page.modified]) {
      expect(String((fact.providerCategory as { primary: string }).primary)).toMatch(
        /^TRANSFER_(IN|OUT)$/,
      );
    }
  });

  it('a fiat deposit is a transfer, never income', async () => {
    const { connector, handle, options } = harness();
    const page = await connector.syncTransactions(handle, cursorBeforeTheDeposit(), options);
    const transfer = page.added[0];

    // An inflow is the case where "income" is the tempting misfiling: money
    // arrived and the account is not a salary account. `TRANSFER_IN` is a PFC
    // *primary* and `INCOME` is a different one; the detailed code resolves to
    // `transfers.between_accounts`, which is excluded from income and from
    // spend alike.
    expect(transfer?.providerCategory).toEqual({
      primary: 'TRANSFER_IN',
      detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER',
      confidence_level: 'LOW',
    });
    expect(JSON.stringify(transfer?.providerCategory)).not.toMatch(/INCOME/);
    expect(transfer?.name).toBe('Transfer in to Coinbase USD Wallet');
    expect(transfer?.merchantName).toBeNull();
    expect(transfer?.pending).toBe(false);
  });

  it('labels the transfer as inferred and shows its working', async () => {
    const { connector, handle, options } = harness();
    const page = await connector.syncTransactions(handle, cursorBeforeTheDeposit(), options);
    // Nothing downstream may mistake a derived observation for something
    // Coinbase said, so the derivation travels with it.
    expect(page.added[0]?.raw).toMatchObject({
      inferred: 'balance_delta',
      windowStart: '2026-09-01T00:00:00.000Z',
      windowEnd: '2026-09-22T12:00:00.000Z',
      balanceBefore: '0',
      balanceAfter: '980',
      tradedInWindow: '-4020',
      residual: '5000',
      fills: ['5a1f0d3c8b2e4f6a9c0d1e2f3a4b5c6d'],
    });
  });

  /**
   * The inverse failure, which is just as wrong and easier to ship: subtracting
   * nothing would make the $4,020 buy look like a $4,020 withdrawal.
   */
  it('does not mistake the trade itself for a withdrawal', async () => {
    const { connector, handle, options } = harness();
    // A watermark where the wallet already held the deposit: the only thing
    // that happened since is the buy, and it is fully explained by the fill.
    const page = await connector.syncTransactions(
      handle,
      encodeWatermark({ at: '2026-09-01T00:00:00.000Z', fiat: { [USD_WALLET]: '5000' } }),
      options,
    );
    expect(page.added).toEqual([]);
  });

  it('reports a genuine withdrawal as a transfer out', async () => {
    const { connector, handle, options } = harness();
    const page = await connector.syncTransactions(
      handle,
      encodeWatermark({ at: '2026-09-01T00:00:00.000Z', fiat: { [USD_WALLET]: '6000' } }),
      options,
    );
    expect(page.added).toHaveLength(1);
    // 980 − 6,000 = −5,020, of which −4,020 was the trade: −1,000 left the
    // wallet by a route v3 does not report.
    expect(page.added[0]?.amount).toEqual(Money.of(-100_000n, 'USD'));
    expect(page.added[0]?.providerCategory).toEqual(COINBASE_TRANSFER_OUT_PFC);
    expect(page.added[0]?.name).toBe('Transfer out of Coinbase USD Wallet');
  });

  /**
   * The honest limit of a balance-delta inference, asserted rather than left
   * implicit: two deposits between two syncs are one transfer for their sum.
   * v3 cannot separate them and neither can we; splitting them by guesswork
   * would be worse than saying so.
   */
  it('reports two deposits between syncs as one transfer for their sum', async () => {
    const { connector, handle, options } = harness();
    const page = await connector.syncTransactions(handle, cursorBeforeTheDeposit(), options);
    expect(page.added).toHaveLength(1);
    expect(page.added[0]?.amount.minor).toBe(500_000n);
  });

  it('emits nothing on the first sync, because an opening balance is not a deposit', async () => {
    const { connector, handle, options } = harness();
    const first = await connector.syncTransactions(handle, null, options);
    expect(first.added).toEqual([]);
    expect(first.hasMore).toBe(false);
    // …and it establishes the watermark the next sync measures from.
    expect(first.nextCursor).toBe(
      encodeWatermark({ at: '2026-09-22T12:00:00.000Z', fiat: { [USD_WALLET]: '980' } }),
    );
  });

  it('gives the same transfer the same id on a replay, so the ledger upserts it', async () => {
    const { connector, handle, options } = harness();
    const first = await connector.syncTransactions(handle, cursorBeforeTheDeposit(), options);
    const second = await connector.syncTransactions(handle, cursorBeforeTheDeposit(), options);
    expect(first.added[0]?.providerTransactionId).toBe(second.added[0]?.providerTransactionId);
    expect(first.added[0]?.fingerprint).toBe(second.added[0]?.fingerprint);
    expect(first.added[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a wallet that did not exist at the watermark contributes no phantom deposit', async () => {
    const { connector, handle, options } = harness();
    // The watermark names no USD wallet at all — a wallet opened since. Its
    // opening balance is not a deposit, for the same reason the first sync's is
    // not.
    const page = await connector.syncTransactions(
      handle,
      encodeWatermark({ ...watermarkBeforeTheDeposit(), fiat: {} }),
      options,
    );
    expect(page.added).toEqual([]);
  });
});
