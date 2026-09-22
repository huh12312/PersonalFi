// SPDX-License-Identifier: MIT
/**
 * The v0.5 rung, in one file: **a fiat on-ramp is a transfer, never spending.**
 *
 * > "a USD deposit into Coinbase followed by a BTC buy is **one transfer plus
 * > one trade**, never $5,000 of spending in a 'Crypto' category."
 * > — `docs/plan/03-phase-3-dispatch.md` §1
 *
 * ## How the transfer is found when v3 has no deposit endpoint
 *
 * It is inferred, from arithmetic that is stated rather than guessed:
 *
 * ```
 *   observed  = fiat balance now
 *   watermark = fiat balance at the previous sync            (cursor.ts)
 *   traded    = Σ quote effect of every fill since then      (map.ts, one sign convention)
 *   residual  = (observed − watermark) − traded
 * ```
 *
 * `traded` is subtracted so that a **trade is never mistaken for a deposit**.
 * Without it, buying $4,020 of BTC would look like a $4,020 withdrawal, which is
 * the same bug as the one this file exists to prevent, pointed the other way.
 * Worked through on the fixture, whose numbers are reproduced in the evidence
 * doc: `(980.00 − 0.00) − (−4,020.00) = +5,000.00`, which is exactly the deposit
 * that funded the buy.
 *
 * ## What the residual is labelled, and why that is the whole point
 *
 * `providerCategory` carries a Plaid **PFC v2** hint — `TRANSFER_IN_ACCOUNT_TRANSFER`
 * or `TRANSFER_OUT_ACCOUNT_TRANSFER`. Not because Coinbase speaks PFC, but
 * because `@ctx/categorization`'s provider tier is keyed on those strings
 * (`packages/contexts/categorization/src/pfc-map.ts`) and both of them resolve
 * to `transfers.between_accounts`. A category under `transfers.*` is excluded
 * from spend totals, which is what makes "zero spending" a property of the
 * system rather than a promise in a comment. The boundary lint denies
 * `packages/connectors/*` → `@ctx/*`, so the two codes are pinned here as
 * literals and `onramp.test.ts` asserts them by name; if 2.x ever renames them,
 * that test is what goes red.
 *
 * ## Why this is honest rather than clever
 *
 * Every inferred fact carries its own working in `raw` — the two balances, the
 * traded total, the fills it considered and the window. It is labelled
 * `inferred: 'balance_delta'`, so nothing downstream can mistake it for
 * something Coinbase said. And it is only ever emitted when a **previous
 * watermark exists**: the first sync establishes one and emits nothing, because
 * an opening balance is not a deposit.
 */
import {
  fingerprintOf,
  importedTransactionIdOf,
  type ProviderTransactionFact,
} from '@connector/port';
import { DateOnly, Money, type Clock } from '@core/kernel';
import { fiatCurrencyOf, fiatMoneyOf, negatedDecimal, sumDecimals } from './amount.ts';
import type { CoinbaseAccount, CoinbaseFill } from './api.ts';
import { isFiatAccount, quoteEffectOf, totalBalanceOf, instantOf, fillIdOf } from './map.ts';
import { COINBASE_PROVIDER } from './provider.ts';
import type { CoinbaseWatermark } from './cursor.ts';

/**
 * The two PFC v2 codes, pinned. See the file comment for why they are literals.
 *
 * `…_ACCOUNT_TRANSFER` rather than `…_DEPOSIT`: money moving between two
 * accounts the same person owns is what this is, and it is what
 * `POST /transfers/pair` exists to match against the bank-side leg.
 */
export const COINBASE_TRANSFER_IN_PFC = Object.freeze({
  primary: 'TRANSFER_IN',
  detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER',
  confidence_level: 'LOW',
});

export const COINBASE_TRANSFER_OUT_PFC = Object.freeze({
  primary: 'TRANSFER_OUT',
  detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER',
  confidence_level: 'LOW',
});

export interface OnRampInferenceOptions {
  /** `null` on the first sync. Nothing is emitted then, deliberately. */
  readonly previous: CoinbaseWatermark | null;
  readonly accounts: readonly CoinbaseAccount[];
  /** Every fill the window returned, in any order. */
  readonly fills: readonly CoinbaseFill[];
  readonly clock: Clock;
}

export interface OnRampInference {
  readonly transfers: readonly ProviderTransactionFact[];
  readonly watermark: CoinbaseWatermark;
}

/**
 * Take a watermark, and — if there was a previous one — say what moved.
 *
 * Returns at most one fact per fiat wallet. Two deposits between two syncs
 * appear as one transfer for their sum, which is the honest limit of a
 * balance-delta inference and is recorded as such in the evidence doc: v3 cannot
 * separate them, and splitting them by guesswork would be worse than saying so.
 */
export function inferOnRampTransfers(options: OnRampInferenceOptions): OnRampInference {
  const observedAt = options.clock.now();
  const fiatAccounts = options.accounts.filter((account) => isFiatAccount(account));

  const watermark: CoinbaseWatermark = {
    at: observedAt.toISOString(),
    fiat: Object.fromEntries(
      fiatAccounts.map((account) => [account.uuid, String(totalBalanceOf(account))]),
    ),
  };

  const previous = options.previous;
  if (previous === null) return { transfers: [], watermark };

  const since = new Date(previous.at);
  const transfers: ProviderTransactionFact[] = [];

  for (const account of fiatAccounts) {
    const before = previous.fiat[account.uuid];
    // A wallet that did not exist at the watermark has no delta to take. Its
    // opening balance is not a deposit, for the same reason the first sync's is
    // not; it joins the watermark now and is measured from the next sync.
    if (before === undefined) continue;

    const code = fiatCurrencyOf(account.currency, 'account.currency');
    const observed = totalBalanceOf(account);
    const delta = sumDecimals([observed, negatedDecimal(before, 'watermark.balance')], 'delta');

    const relevant = options.fills.filter(
      (fill) =>
        fill.product_id.endsWith(`-${code}`) &&
        instantOf(fill.trade_time, 'fill.trade_time') > since,
    );
    const traded = sumDecimals(
      relevant.map((fill) => String(quoteEffectOf(fill))),
      'traded',
    );
    const residual = sumDecimals([delta, negatedDecimal(traded, 'traded')], 'residual');
    const amount = fiatMoneyOf(residual, code, 'residual');
    if (Money.isZero(amount)) continue;

    const inflow = !Money.isNegative(amount);
    const postedDate = DateOnly.of(
      observedAt.getUTCFullYear(),
      observedAt.getUTCMonth() + 1,
      observedAt.getUTCDate(),
    );
    const description = inflow
      ? `Transfer in to Coinbase ${account.name}`
      : `Transfer out of Coinbase ${account.name}`;

    transfers.push({
      providerAccountId: account.uuid,
      // Deterministic and content-addressed, because there is no provider id to
      // be had: `importedTransactionIdOf` is the port's answer for "a source
      // that supplies none", and it makes a replay of the same cursor produce
      // the same id, which is what the ledger's natural-key upsert needs.
      providerTransactionId: importedTransactionIdOf({
        provider: COINBASE_PROVIDER,
        providerAccountId: account.uuid,
        postedDate,
        amount,
        description,
        occurrence: 1,
      }),
      pendingTransactionId: null,
      amount,
      isoCurrency: code,
      postedDate,
      authorizedDate: null,
      postedAt: observedAt,
      authorizedAt: null,
      name: description,
      merchantName: null,
      originalDescription: description,
      paymentChannel: 'other',
      providerCategory: inflow ? COINBASE_TRANSFER_IN_PFC : COINBASE_TRANSFER_OUT_PFC,
      pending: false,
      location: null,
      counterparties: null,
      // The inference's own working, kept so that "where did this $5,000 come
      // from?" has an answer that does not require re-deriving it.
      raw: {
        inferred: 'balance_delta',
        windowStart: previous.at,
        windowEnd: watermark.at,
        balanceBefore: before,
        balanceAfter: String(observed),
        tradedInWindow: String(traded),
        residual: String(residual),
        fills: relevant.map((fill) => fillIdOf(fill)),
      },
      fingerprint: fingerprintOf({
        providerAccountId: account.uuid,
        postedDate,
        amount,
        description,
      }),
    });
  }

  return { transfers, watermark };
}
