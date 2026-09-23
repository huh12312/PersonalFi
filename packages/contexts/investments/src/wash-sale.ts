// SPDX-License-Identifier: MIT
/**
 * §1091 wash sales — detected, labelled `POSSIBLE_WASH_SALE`, and never
 * asserted as fact.
 *
 * 07 §4.4 states the rule and three implementation notes, and all three are
 * load-bearing here:
 *
 *   * **61 days, including the sale date.** A loss is disallowed if
 *     substantially identical securities are bought within 30 days *before or
 *     after* the sale. 30 + 1 + 30 = 61. Day 30 is inside the window and day 31
 *     is outside it, which is the boundary
 *     `'a repurchase on day 30 after a loss is flagged POSSIBLE_WASH_SALE and
 *     one on day 31 is not'` pins on both sides.
 *   * **Scan across all accounts, including IRAs** — "that's the trap most
 *     software misses". A loss in a taxable account replaced inside an IRA is
 *     not merely disallowed, it is disallowed *permanently* (Rev. Rul. 2008-5):
 *     the basis cannot be added to an IRA lot, so it is simply lost. Scoping
 *     the scan to one account would miss the worst case in the whole rule. So
 *     `scanForPossibleWashSales` takes every lot and every disposal the user
 *     has, and the account is an output, never an input filter.
 *   * **We can only warn.** "Substantially identical" is facts-and-
 *     circumstances — different share classes, options, similar-but-not-
 *     identical index funds. So the label is `POSSIBLE_WASH_SALE`, never
 *     `WASH_SALE`, and it is a constant in this file so that a grep finds every
 *     producer of it. `'a wash sale is labelled POSSIBLE_WASH_SALE and adjusts
 *     the replacement lot'` asserts the string.
 *
 * ## The digital-asset exclusion is a dated config flag, not a branch
 *
 * §1091 currently does not reach digital assets, because they are property
 * rather than securities — and bills to change that recur every session. 07
 * §4.4 is explicit that this must be "a dated config flag
 * (`wash_sale_applies_to_digital_assets: false  # as of 2026-09`), not a
 * hardcoded branch", and the reason is maintenance rather than style: when
 * Congress moves, a flag is a one-line change with a date beside it, whereas an
 * `if (security.type === 'crypto') return` is a code change somebody has to
 * find. `'the digital-asset exclusion is read from config, not hardcoded'`
 * flips the flag and asserts the scan's answer changes — which it cannot do if
 * the rule is compiled in.
 *
 * ## What an adjustment actually does
 *
 * Two things, and software that does only the first is the common bug:
 *
 *   1. the disallowed loss is **added to the replacement lot's basis**, so it
 *      is deferred rather than destroyed;
 *   2. the sold lot's **holding period is tacked onto the replacement**, so a
 *      lot bought yesterday can be long-term today.
 *
 * `holding_period_start_date` exists as a separate column for exactly (2), and
 * `wash_sale_adjustment_minor` records (1) as a delta so a human can check it
 * rather than having to reverse-engineer it out of `basis_minor`.
 *
 * Partial replacement is prorated: buying back 50 of 100 shares disallows half
 * the loss. The IRS applies the rule share-for-share, and `Money.allocate`
 * makes the split exact.
 */
import {
  DateOnly,
  Money,
  Quantity,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
  type Quantity as QuantityType,
} from '@core/kernel';
import { quantityWeight, type Lot } from './lots.ts';

/**
 * The label, as a value.
 *
 * `POSSIBLE_WASH_SALE`, never `WASH_SALE`. Exported so every producer uses the
 * same string and a reviewer can grep for the bare form and find nothing.
 */
export const POSSIBLE_WASH_SALE = 'POSSIBLE_WASH_SALE' as const;
export type WashSaleLabel = typeof POSSIBLE_WASH_SALE;

/** 30 days either side of the sale. */
export const WASH_SALE_WINDOW_DAYS = 30;
/** 30 before + the sale date + 30 after. The number 07 §4.4 names. */
export const WASH_SALE_WINDOW_SPAN_DAYS = WASH_SALE_WINDOW_DAYS * 2 + 1;

/**
 * The dated policy flags 07 §4.4 asks for.
 *
 * `asOf` is part of the value, not a comment, so a stale default is visible in
 * an API response and in a config snapshot rather than only in this file's
 * history. When §1091 is extended to digital assets, the change is
 * `appliesToDigitalAssets: true` and a new `asOf` — and every test that
 * exercises the flag keeps working, because none of them hardcodes the answer.
 */
export interface WashSaleConfig {
  readonly appliesToDigitalAssets: boolean;
  /** `YYYY-MM` of the last time this was checked against the law. */
  readonly asOf: string;
}

export const DEFAULT_WASH_SALE_CONFIG: WashSaleConfig = Object.freeze({
  // §1091 reaches "stocks or securities". Digital assets are property, so it
  // does not reach them — as of the date below. CRYPTO_WASH_SALE_WATCH.
  appliesToDigitalAssets: false,
  asOf: '2026-09',
});

/** A closed position that produced a loss. The thing a wash sale is *about*. */
export interface DisposalForScan {
  readonly id: string;
  readonly accountId: string;
  readonly securityId: string;
  readonly date: DateOnlyType;
  readonly quantity: QuantityType;
  /**
   * Negative when the disposal lost money — house sign convention. A gain is
   * simply not a wash sale, and the scan says so by skipping it.
   */
  readonly gain: MoneyType | null;
}

/** An acquisition that might be the replacement. Any account, deliberately. */
export interface AcquisitionForScan {
  readonly lotId: string;
  readonly accountId: string;
  readonly securityId: string;
  readonly openDate: DateOnlyType;
  readonly quantity: QuantityType;
  /** True when the account is tax-advantaged; a Rev. Rul. 2008-5 replacement. */
  readonly isRetirementAccount?: boolean;
}

export interface PossibleWashSale {
  readonly label: WashSaleLabel;
  readonly disposalId: string;
  readonly disposalAccountId: string;
  readonly securityId: string;
  readonly saleDate: DateOnlyType;
  readonly replacementLotId: string;
  readonly replacementAccountId: string;
  readonly replacementDate: DateOnlyType;
  /** Signed days from the sale to the replacement. Negative = bought before. */
  readonly offsetDays: number;
  /** How much of the sold quantity this replacement covers. */
  readonly matchedQuantity: QuantityType;
  /** The loss deferred onto the replacement lot. Always positive. */
  readonly disallowedLoss: MoneyType;
  /** The holding period the replacement inherits. */
  readonly tackedHoldingPeriodStartDate: DateOnlyType;
  /**
   * Rev. Rul. 2008-5: a replacement inside an IRA disallows the loss *and*
   * gives it nowhere to go. Surfaced rather than silently handled, because the
   * right response is to tell the user, not to adjust a basis we cannot write.
   */
  readonly basisAdjustmentIsPermanentlyLost: boolean;
}

export interface ScanInput {
  readonly disposals: readonly DisposalForScan[];
  readonly acquisitions: readonly AcquisitionForScan[];
  /** The holding-period start of each sold lot, for tacking. Keyed by disposal id. */
  readonly soldHoldingPeriodStart: ReadonlyMap<string, DateOnlyType>;
  readonly config?: WashSaleConfig;
  /**
   * Whether a security is a digital asset. A predicate rather than a field on
   * the disposal so the caller reads it from `securities.type` once.
   */
  readonly isDigitalAsset?: (securityId: string) => boolean;
}

/**
 * Whether `replacement` falls inside the 61-day window around `sale`.
 *
 * Exported because the boundary is the thing worth testing directly, and a test
 * that had to construct a whole scan to check day 31 would be testing five
 * things at once.
 */
export function isInsideWashSaleWindow(sale: DateOnlyType, replacement: DateOnlyType): boolean {
  const offset = DateOnly.differenceInDays(sale, replacement);
  return Math.abs(offset) <= WASH_SALE_WINDOW_DAYS;
}

/**
 * Every possible wash sale across **every** account.
 *
 * Deterministic: disposals in date order, replacements in date-then-lot-id
 * order, so the same history scanned twice produces the same flags in the same
 * sequence. A tax warning that moved between runs would be worse than none.
 */
export function scanForPossibleWashSales(input: ScanInput): readonly PossibleWashSale[] {
  const config = input.config ?? DEFAULT_WASH_SALE_CONFIG;
  const isDigitalAsset = input.isDigitalAsset ?? (() => false);
  const flags: PossibleWashSale[] = [];

  const disposals = [...input.disposals].sort(
    (a, b) => DateOnly.compare(a.date, b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  for (const disposal of disposals) {
    // The flag is dated and read here, not compiled in. See the file header.
    if (!config.appliesToDigitalAssets && isDigitalAsset(disposal.securityId)) continue;
    // A gain is not a wash sale; an unknown gain is not one we can assert.
    if (disposal.gain === null || !Money.isNegative(disposal.gain)) continue;

    const loss = Money.absolute(disposal.gain);
    const candidates = input.acquisitions
      .filter(
        (acquisition) =>
          acquisition.securityId === disposal.securityId &&
          isInsideWashSaleWindow(disposal.date, acquisition.openDate),
      )
      .sort(
        (a, b) =>
          DateOnly.compare(a.openDate, b.openDate) ||
          (a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0),
      );
    if (candidates.length === 0) continue;

    // Share-for-share, up to the quantity actually sold. Replacements beyond
    // the sold quantity replace nothing.
    let unreplaced = disposal.quantity;
    const matched: { acquisition: AcquisitionForScan; quantity: QuantityType }[] = [];
    for (const acquisition of candidates) {
      if (Quantity.compare(unreplaced, Quantity.zero) <= 0) break;
      const take =
        Quantity.compare(acquisition.quantity, unreplaced) <= 0 ? acquisition.quantity : unreplaced;
      matched.push({ acquisition, quantity: take });
      unreplaced = Quantity.subtract(unreplaced, take);
    }
    if (matched.length === 0) continue;

    // Prorate the loss across the replacements by quantity, and across the
    // *sold* quantity so a partial replacement defers only its share.
    const weights = [
      ...matched.map((entry) => quantityWeight(entry.quantity)),
      quantityWeight(unreplaced),
    ];
    const shares = Money.allocate(loss, weights);
    const tacked = input.soldHoldingPeriodStart.get(disposal.id) ?? disposal.date;

    matched.forEach((entry, index) => {
      const disallowed = shares[index];
      if (disallowed === undefined || Money.isZero(disallowed)) return;
      flags.push({
        label: POSSIBLE_WASH_SALE,
        disposalId: disposal.id,
        disposalAccountId: disposal.accountId,
        securityId: disposal.securityId,
        saleDate: disposal.date,
        replacementLotId: entry.acquisition.lotId,
        replacementAccountId: entry.acquisition.accountId,
        replacementDate: entry.acquisition.openDate,
        offsetDays: DateOnly.differenceInDays(disposal.date, entry.acquisition.openDate),
        matchedQuantity: entry.quantity,
        disallowedLoss: disallowed,
        tackedHoldingPeriodStartDate: tacked,
        basisAdjustmentIsPermanentlyLost: entry.acquisition.isRetirementAccount === true,
      });
    });
  }

  return flags;
}

/**
 * Apply a flag to the replacement lot: basis up, holding period back.
 *
 * Both halves, always together. Software that adds the basis and forgets the
 * tacking reports a long-term gain as short-term for up to a year, which is the
 * more expensive of the two errors and the one nobody notices.
 *
 * A lot with an **unknown basis is left alone** and the flag is returned
 * unapplied: there is no number to add the disallowed loss to, and
 * manufacturing one would turn an `unavailable` into a figure — the exact
 * laundering 04 §5.5 forbids. The migration says the same thing with
 * `cost_basis_lots_wash_adjustment_needs_a_basis`.
 *
 * A Rev. Rul. 2008-5 replacement (an IRA) is also left alone: the basis
 * adjustment has nowhere to live, and the loss is permanently lost rather than
 * deferred. The flag carries `basisAdjustmentIsPermanentlyLost` so the UI can
 * say so.
 */
export function applyWashSaleToLot(lot: Lot, flag: PossibleWashSale): Lot {
  return applyWashSales([lot], [flag])[0] ?? lot;
}

/**
 * Apply every flag to whichever lot it names — **by setting, not by adding**.
 *
 * The distinction is the difference between a correct tax number and one that
 * grows every time a sync runs. The scan is a pure function of the stored
 * transaction history, so a re-delivered sync run regenerates exactly the same
 * flags; an implementation that did `basis = basis + disallowedLoss` would
 * therefore add the same disallowed loss again on every single sync, and the
 * replacement lot's basis would drift upward forever. Nothing would error, and
 * the only symptom would be a shrinking capital gain.
 *
 * So the adjustment is recomputed from scratch each time. `basis_minor` already
 * *includes* the adjustment and `wash_sale_adjustment_minor` records how much
 * of it is adjustment, which means the unadjusted basis is recoverable:
 *
 *     base      = basis − washSaleAdjustment
 *     adjustment = Σ disallowed losses this lot is named in
 *     basis'     = base + adjustment
 *
 * Running that twice with the same flags gives the same answer, which is what
 * makes the consumer idempotent. `test/db/consumer.test.ts` asserts it against
 * a real database by syncing the same run twice and comparing whole rows.
 *
 * Only lots that a flag actually names are touched. A lot the caller did not
 * pass a flag for keeps whatever adjustment it already had, so handing this
 * function a partial flag set cannot silently erase an unrelated lot's history.
 *
 * Two lots are still left alone entirely, for the reasons the single-flag
 * version documented: one with an unknown basis (there is no number to add a
 * disallowed loss to, and inventing one is the laundering 04 §5.5 forbids —
 * `cost_basis_lots_wash_adjustment_needs_a_basis` says the same in SQL), and a
 * Rev. Rul. 2008-5 replacement inside an IRA, where the loss is permanently
 * lost rather than deferred and the flag carries
 * `basisAdjustmentIsPermanentlyLost` so the UI can say so.
 */
export function applyWashSales(
  lots: readonly Lot[],
  flags: readonly PossibleWashSale[],
): readonly Lot[] {
  const byLot = new Map<string, PossibleWashSale[]>();
  for (const flag of flags) {
    if (flag.basisAdjustmentIsPermanentlyLost) continue;
    const existing = byLot.get(flag.replacementLotId);
    if (existing === undefined) byLot.set(flag.replacementLotId, [flag]);
    else existing.push(flag);
  }

  return lots.map((lot) => {
    const applicable = byLot.get(lot.id);
    if (applicable === undefined || applicable.length === 0) return lot;
    if (lot.basis === null) return lot;

    const adjustment = Money.sum(
      applicable.map((flag) => flag.disallowedLoss),
      lot.currency,
    );
    const base = Money.subtract(lot.basis, lot.washSaleAdjustment);
    // `min` over every tacked period: the holding period only ever moves
    // earlier, so this is idempotent on its own.
    let holdingPeriodStartDate = lot.holdingPeriodStartDate;
    for (const flag of applicable) {
      holdingPeriodStartDate = DateOnly.min(
        holdingPeriodStartDate,
        flag.tackedHoldingPeriodStartDate,
      );
    }

    return {
      ...lot,
      basis: Money.add(base, adjustment),
      washSaleAdjustment: adjustment,
      holdingPeriodStartDate,
    };
  });
}
