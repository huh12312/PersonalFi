// SPDX-License-Identifier: MIT
/**
 * The adapter boundary: provider facts in, house shapes out.
 *
 * `@connector/port` gives two facts — `ProviderHoldingFact` (a position, as the
 * institution asserts it) and `ProviderInvestmentTransactionFact` (a movement).
 * Everything downstream of this file speaks the house vocabulary, which is what
 * lets one lot engine serve Plaid, Coinbase, a CSV import and a hand entry.
 *
 * ## Why the normalisation lives here and not in each connector
 *
 * Because the *decision* is a domain decision, not a provider one. Whether a
 * Coinbase CSV row spelled `Staking Income` opens a lot at FMV or is income
 * with no lot at all is a tax question (Rev. Rul. 2023-14, 07 §6.5), and the
 * connector has no business answering it. What the connector owns is the house
 * *sign convention* and the fact shape; what this file owns is the mapping from
 * that shape to a lot effect.
 *
 * ## The R6 verdict, encoded
 *
 * docs/evidence/phase-3/wp3.5-coinbase.md §1 measured that Coinbase v3
 * reconstructs trades and nothing else: no deposit, no withdrawal, no staking
 * reward, no transfer. Those arrive from the CSV export, or not at all. So the
 * two legs are both first class here:
 *
 *   * a `BROKER` leg — an Advanced Trade fill, exact quantity, unit price, fee
 *     and instant → a lot with `basisSource: 'BROKER'` and a real number;
 *   * an `IMPORTED` leg — a CSV row → a lot with `basisSource: 'IMPORTED'`
 *     when the row carries a cost, and `'ESTIMATED'` with a warning when it
 *     does not.
 *
 * And a third case that is not a leg at all: a movement with no price and no
 * amount. `basisForAcquisition` returns `null` for it, `openLot` refuses to
 * call that anything but `ESTIMATED`, and nothing anywhere turns it into a
 * zero.
 */
import {
  Money,
  Quantity,
  currency,
  type CurrencyCode,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
  type Quantity as QuantityType,
} from '@core/kernel';
import type { ProviderHoldingFact, ProviderInvestmentTransactionFact } from '@connector/port';
import type {
  AcquisitionType,
  BasisSource,
  InvestmentTransactionType,
  TransactionSource,
} from '../schema/index.ts';
import { UNKNOWN_BASIS_WARNING } from './lots.ts';

/**
 * What a movement does to the lot ledger.
 *
 * `CARRY_IN`/`CARRY_OUT` are the self-transfer pair and the reason this is an
 * enum rather than a boolean: 07 §6.2 calls a mishandled self-transfer "the
 * single most common source of wrong crypto tax numbers", and the failure is
 * always that a transfer was classified as one of the other two.
 */
export const LOT_EFFECTS = ['OPEN', 'CLOSE', 'CARRY_IN', 'CARRY_OUT', 'NONE'] as const;
export type LotEffect = (typeof LOT_EFFECTS)[number];

const EFFECT_BY_TYPE: Readonly<Record<InvestmentTransactionType, LotEffect>> = Object.freeze({
  BUY: 'OPEN',
  REINVESTED_DIVIDEND: 'OPEN',
  // Income at FMV on receipt opens a lot whose basis *is* the income.
  STAKING_REWARD: 'OPEN',
  AIRDROP: 'OPEN',
  MINING: 'OPEN',
  FORK: 'OPEN',
  GIFT_IN: 'OPEN',
  SELL: 'CLOSE',
  TRANSFER_IN: 'CARRY_IN',
  TRANSFER_OUT: 'CARRY_OUT',
  // None of these is about a quantity of a security.
  DIVIDEND: 'NONE',
  INTEREST: 'NONE',
  FEE: 'NONE',
  CASH: 'NONE',
  // A split rewrites existing lots; it does not open or close one.
  SPLIT: 'NONE',
  OTHER: 'NONE',
});

export function lotEffectOf(type: InvestmentTransactionType): LotEffect {
  return EFFECT_BY_TYPE[type];
}

const ACQUISITION_BY_TYPE: Readonly<Partial<Record<InvestmentTransactionType, AcquisitionType>>> =
  Object.freeze({
    BUY: 'BUY',
    REINVESTED_DIVIDEND: 'REINVESTED_DIVIDEND',
    STAKING_REWARD: 'STAKING',
    AIRDROP: 'AIRDROP',
    MINING: 'MINING',
    FORK: 'FORK',
    GIFT_IN: 'GIFT',
    TRANSFER_IN: 'TRANSFER_IN',
  });

export function acquisitionTypeOf(type: InvestmentTransactionType): AcquisitionType | null {
  return ACQUISITION_BY_TYPE[type] ?? null;
}

/**
 * The provider's word → the house vocabulary.
 *
 * Plaid's `type`/`subtype` pairs, Coinbase's fill sides, and the CSV export's
 * `Transaction Type` column all land here. Unrecognised input becomes `OTHER`
 * rather than throwing: a provider that invents a subtype must not stop a sync,
 * and `OTHER` has a `NONE` lot effect, so the worst case is a stored row that
 * moves no lot — visible, inert, and fixable by adding one line here.
 */
export function normaliseTransactionType(
  type: string,
  subtype: string | null,
): InvestmentTransactionType {
  const key = `${type}/${subtype ?? ''}`.toLowerCase();
  if (/(^|\/)(buy|purchase)/.test(key)) {
    return /dividend|reinvest/.test(key) ? 'REINVESTED_DIVIDEND' : 'BUY';
  }
  if (/(^|\/)(sell|sale|dispose)/.test(key)) return 'SELL';
  if (/stak|reward/.test(key)) return 'STAKING_REWARD';
  if (/airdrop/.test(key)) return 'AIRDROP';
  if (/min(e|ing)/.test(key)) return 'MINING';
  if (/fork/.test(key)) return 'FORK';
  if (/dividend/.test(key)) return 'DIVIDEND';
  // WP 10.3: Plaid's `cash/long-term capital gain`, `cash/short-term capital
  // gain` and `cash/unqualified gain` are a fund's distributions — income, like
  // a dividend. Before this line they fell through to `cash` → `CASH`, which
  // `GET /investments/performance` counted as a contribution.
  if (/capital gain|unqualified gain/.test(key)) return 'DIVIDEND';
  if (/interest/.test(key)) return 'INTEREST';
  // `receive`/`send` are the CSV export's words for the two halves of a
  // self-transfer; `deposit`/`withdrawal` are its words for fiat.
  if (/receive|transfer.*in|deposit/.test(key)) return 'TRANSFER_IN';
  if (/send|transfer.*out|withdraw/.test(key)) return 'TRANSFER_OUT';
  // `cash/margin expense` is a cost, not a cash movement (WP 10.3, as above).
  if (/\bfee\b|margin expense/.test(key)) return 'FEE';
  if (/cash|sweep/.test(key)) return 'CASH';
  if (/split/.test(key)) return 'SPLIT';
  if (/transfer/.test(key)) return 'TRANSFER_IN';
  return 'OTHER';
}

/**
 * Which `basis_source` a lot opened by this transaction may claim.
 *
 * The table is short and the omissions are the content: a `BROKER` transaction
 * with no cost is **not** a `BROKER` lot with a zero basis, it is an
 * `ESTIMATED` lot with a warning. There is no path from "the provider said
 * nothing" to "the provider said zero".
 */
export function basisSourceFor(source: TransactionSource, basis: MoneyType | null): BasisSource {
  if (basis === null) return 'ESTIMATED';
  switch (source) {
    case 'BROKER':
      return 'BROKER';
    case 'IMPORTED':
      return 'IMPORTED';
    case 'USER':
      return 'USER';
  }
}

/** One movement, in the house vocabulary. What the store writes and the engine reads. */
export interface InvestmentTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly securityId: string | null;
  readonly provider: string;
  readonly providerTransactionId: string;
  readonly type: InvestmentTransactionType;
  readonly subtype: string | null;
  readonly name: string | null;
  /** Signed as reported: negative on a disposal. */
  readonly quantity: QuantityType;
  readonly price: QuantityType | null;
  readonly amount: MoneyType;
  readonly fees: MoneyType;
  readonly tradeDate: DateOnlyType;
  readonly settleDate: DateOnlyType | null;
  readonly source: TransactionSource;
  readonly fingerprint: string | null;
}

export interface MapTransactionOptions {
  readonly id: string;
  readonly accountId: string;
  readonly securityId: string | null;
  readonly provider: string;
  readonly source: TransactionSource;
}

/**
 * `ProviderInvestmentTransactionFact` → `InvestmentTransaction`.
 *
 * `fact.quantity` and `fact.price` are decimal strings on the port precisely so
 * that this function is a parse and not a conversion: `Quantity.of` validates
 * and canonicalises, and a float never exists at any point in the chain. A
 * price the provider left blank arrives as `''` or `'0'` from some adapters;
 * `'0'` is kept (a genuinely free transfer prices at zero) and `''` becomes
 * `null`, because an empty string is an absence and not a number.
 */
export function investmentTransactionOf(
  fact: ProviderInvestmentTransactionFact,
  options: MapTransactionOptions,
): InvestmentTransaction {
  const type = normaliseTransactionType(fact.type, fact.subtype);
  const priceText = fact.price.trim();
  return {
    id: options.id,
    accountId: options.accountId,
    securityId: options.securityId,
    provider: options.provider,
    providerTransactionId: fact.providerTransactionId,
    type,
    subtype: fact.subtype === '' ? null : fact.subtype,
    name: fact.name === '' ? null : fact.name,
    quantity: Quantity.of(fact.quantity.trim() === '' ? '0' : fact.quantity.trim()),
    price: priceText === '' ? null : Quantity.of(priceText),
    amount: fact.amount,
    fees: fact.fees ?? Money.zero(fact.amount.currency),
    tradeDate: fact.date,
    settleDate: null,
    source: options.source,
    fingerprint: fact.fingerprint,
  };
}

/**
 * The basis a lot opened by this transaction starts with, or `null`.
 *
 * Three routes, in order of how much we actually know:
 *
 *   1. an explicit `amount` on a purchase — the exact consideration, fees
 *      included, which is what basis *is*;
 *   2. `quantity × price` when the amount is missing but both factors are
 *      present — the staking/airdrop case, where FMV at receipt is the income
 *      and therefore the basis (07 §6.5);
 *   3. `null`. Not zero. Every Coinbase movement that is not an Advanced Trade
 *      fill lands here when the CSV is absent, and 07 §6.2's rule is that it
 *      surfaces as `ESTIMATED` with a visible warning.
 */
export function basisForAcquisition(
  transaction: InvestmentTransaction,
  scale: number,
): MoneyType | null {
  const quantity = absoluteQuantity(transaction.quantity);
  if (Quantity.compare(quantity, Quantity.zero) <= 0) return null;

  if (!Money.isZero(transaction.amount)) {
    // House sign convention: money leaving the account is negative, and a
    // purchase's basis is what left, plus the fee that also left.
    return Money.add(Money.absolute(transaction.amount), Money.absolute(transaction.fees));
  }
  // A *zero* price is not a price. Providers report `0` for a movement they
  // have no price for at least as often as for one that was genuinely free, and
  // `quantity × 0` would hand back a confident $0.00 basis — the gain-from-zero
  // fabrication 04 §5.5 forbids, arriving through a multiplication instead of
  // through a coalesce. Falling through to `null` makes it an `ESTIMATED` lot
  // with a visible warning, which is the honest answer for both cases; a
  // genuinely worthless airdrop can still be pinned at $0 by a `USER` basis,
  // deliberately, by the one person entitled to assert it.
  if (transaction.price !== null && !Quantity.isZero(transaction.price)) {
    return valueOf(quantity, transaction.price, transaction.amount.currency, scale);
  }
  return null;
}

export function absoluteQuantity(value: QuantityType): QuantityType {
  return Quantity.isNegative(value) ? Quantity.negate(value) : value;
}

/** `quantity × price`, rounded once into minor units. No float, one rounding. */
function valueOf(
  quantity: QuantityType,
  price: QuantityType,
  currency: CurrencyCode,
  scale: number,
): MoneyType {
  const shifted = Quantity.multiply(Quantity.multiply(quantity, price), '1' + '0'.repeat(scale));
  const text = Quantity.toDatabaseString(shifted);
  const [whole = '0'] = text.split('.');
  return Money.of(BigInt(whole), currency);
}

/** The warning text an `ESTIMATED` lot must carry. One string, one grep. */
export function warningForEstimatedBasis(transaction: InvestmentTransaction): string {
  return (
    `${UNKNOWN_BASIS_WARNING} Source: ${transaction.source} ` +
    `${transaction.type} on ${transaction.tradeDate}.`
  );
}

/**
 * The currency written to `holdings.currency` / `holdings_snapshots.currency`
 * when `institutionValue` is `null` — the column stays `NOT NULL` (it also
 * carries `costBasis`'s currency when a basis exists with no institution
 * value asserted), and this is this app's own base currency, never a guessed
 * or provider-stated one. Inert whenever both `institutionValue` and
 * `costBasis` are null, which is `@connector/walletrpc`'s case (C-2): nothing
 * downstream reads this column for market value — `valueHoldings` prices
 * every holding from WP 3.4's ladder, keyed on `security_id`, never from this
 * column. See `docs/evidence/phase-4/wp4.12a-gate-conditions.md` C-2.
 */
export const DEFAULT_HOLDING_CURRENCY: CurrencyCode = currency('USD');

/** One position, in the house shape. */
export interface Holding {
  readonly accountId: string;
  readonly securityId: string;
  readonly quantity: QuantityType;
  /**
   * `null` = the provider itself has no fiat value for this position — an
   * assertion it never made, not a computation this package performs. See
   * `@connector/port`'s `ProviderHoldingFact.value` doc comment: a wallet's
   * on-chain quantity has no institution behind it to assert one. Never read
   * for market value; `valueHoldings` (`analytics/allocation.ts`) prices
   * every holding from WP 3.4's price ladder instead.
   */
  readonly institutionValue: MoneyType | null;
  /** `null` = the provider reported no basis. Never a zero standing in for one. */
  readonly costBasis: MoneyType | null;
  readonly asOfDate: DateOnlyType;
}

/**
 * `ProviderHoldingFact` → `Holding`.
 *
 * The one line that matters: `fact.costBasis` and, since the Phase 3 gate's
 * C-2 condition, `fact.value` are both `Money | null` on the port and both
 * `null`s are carried through unchanged. `@connector/coinbase`'s `map.test.ts`
 * already asserts it emits a `null` cost basis rather than `0` for a position
 * it cannot price; throwing either away here would undo the work at the last
 * step.
 */
export function holdingOf(
  fact: ProviderHoldingFact,
  options: {
    readonly accountId: string;
    readonly securityId: string;
    readonly asOfDate: DateOnlyType;
  },
): Holding {
  return {
    accountId: options.accountId,
    securityId: options.securityId,
    quantity: Quantity.of(fact.quantity.trim()),
    institutionValue: fact.value,
    costBasis: fact.costBasis,
    asOfDate: options.asOfDate,
  };
}
