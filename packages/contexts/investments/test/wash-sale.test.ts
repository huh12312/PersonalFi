// SPDX-License-Identifier: MIT
/**
 * The 61-day window, the label, and the dated exclusion flag.
 *
 * Three things are being defended here and each has its own failure mode:
 *
 *   1. **the boundary** — day 30 is inside the window and day 31 is outside,
 *      and an off-by-one in either direction is a tax figure that is wrong by
 *      the whole loss;
 *   2. **the label** — `POSSIBLE_WASH_SALE`, never `WASH_SALE`. The app is not
 *      a tax preparer and does not see the user's other brokerages; asserting a
 *      wash sale outright is a claim it cannot support. The test greps the
 *      value, so a rename to the bare form fails here rather than in review;
 *   3. **the exclusion** — the digital-asset carve-out is a dated config value,
 *      not a branch. §1091 reaches "stocks or securities" and digital assets are
 *      property *as of 2026-09*; when that changes, the fix must be a config
 *      edit, and the only way to know it is a config edit is to flip the flag in
 *      a test and watch the behaviour follow.
 *
 * The scan is deliberately across **every account, including IRAs** (07 §4.4's
 * "trap most software misses", Rev. Rul. 2008-5), which is why the fixtures
 * below use two accounts for what looks like one user's single decision.
 */
import { DateOnly, Money, Quantity, currency } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { openLot, termOf, type Lot } from '../src/lots.ts';
import {
  DEFAULT_WASH_SALE_CONFIG,
  POSSIBLE_WASH_SALE,
  WASH_SALE_WINDOW_DAYS,
  WASH_SALE_WINDOW_SPAN_DAYS,
  applyWashSaleToLot,
  applyWashSales,
  isInsideWashSaleWindow,
  scanForPossibleWashSales,
  type AcquisitionForScan,
  type DisposalForScan,
  type WashSaleConfig,
} from '../src/wash-sale.ts';

const USD = currency('USD');
const TAXABLE = 'acct-taxable';
const IRA = 'acct-ira';
const SECURITY = 'sec-vti';
const BTC = 'sec-btc';

const usd = (dollars: string): ReturnType<typeof Money.of> =>
  Money.of(BigInt(dollars.replace('.', '')), USD);

const SALE_DATE = DateOnly.parse('2026-03-15');

/** A $1,000 loss on 100 shares, sold on `SALE_DATE`. */
function lossOf(overrides: Partial<DisposalForScan> = {}): DisposalForScan {
  return {
    id: 'disposal-1',
    accountId: TAXABLE,
    securityId: SECURITY,
    date: SALE_DATE,
    quantity: Quantity.of('100'),
    gain: usd('-1000.00'),
    ...overrides,
  };
}

/** A replacement purchase `offset` days from the sale. Negative buys earlier. */
function replacementAt(
  offset: number,
  overrides: Partial<AcquisitionForScan> = {},
): AcquisitionForScan {
  return {
    lotId: `lot-replacement-${offset}`,
    accountId: TAXABLE,
    securityId: SECURITY,
    openDate: DateOnly.addDays(SALE_DATE, offset),
    quantity: Quantity.of('100'),
    ...overrides,
  };
}

/** The holding period of the lot that was sold, for tacking. */
const SOLD_PERIOD_START = DateOnly.parse('2024-01-10');
const soldPeriods = new Map([['disposal-1', SOLD_PERIOD_START]]);

describe('the 61-day window', () => {
  it('a repurchase on day 30 after a loss is flagged POSSIBLE_WASH_SALE and one on day 31 is not', () => {
    expect(WASH_SALE_WINDOW_DAYS).toBe(30);
    // 30 before + the sale date itself + 30 after. The sale date is *inside*
    // the window, which is the half of §1091 that a "30 days either side"
    // reading quietly drops.
    expect(WASH_SALE_WINDOW_SPAN_DAYS).toBe(61);

    const onDay30 = scanForPossibleWashSales({
      disposals: [lossOf()],
      acquisitions: [replacementAt(30)],
      soldHoldingPeriodStart: soldPeriods,
    });
    const onDay31 = scanForPossibleWashSales({
      disposals: [lossOf()],
      acquisitions: [replacementAt(31)],
      soldHoldingPeriodStart: soldPeriods,
    });

    expect(onDay30).toHaveLength(1);
    expect(onDay30[0]?.label).toBe(POSSIBLE_WASH_SALE);
    expect(onDay30[0]?.offsetDays).toBe(30);
    expect(onDay31).toEqual([]);

    // Both boundaries, on the predicate directly, in both directions: the
    // window is symmetric, so a purchase 30 days *before* the loss counts too.
    expect(isInsideWashSaleWindow(SALE_DATE, DateOnly.addDays(SALE_DATE, 30))).toBe(true);
    expect(isInsideWashSaleWindow(SALE_DATE, DateOnly.addDays(SALE_DATE, 31))).toBe(false);
    expect(isInsideWashSaleWindow(SALE_DATE, DateOnly.addDays(SALE_DATE, -30))).toBe(true);
    expect(isInsideWashSaleWindow(SALE_DATE, DateOnly.addDays(SALE_DATE, -31))).toBe(false);
    expect(isInsideWashSaleWindow(SALE_DATE, SALE_DATE)).toBe(true);
  });

  it('a purchase 30 days before the sale is caught too — the window is not forward-only', () => {
    const before = scanForPossibleWashSales({
      disposals: [lossOf()],
      acquisitions: [replacementAt(-30)],
      soldHoldingPeriodStart: soldPeriods,
    });
    expect(before).toHaveLength(1);
    expect(before[0]?.offsetDays).toBe(-30);
  });

  it('a gain is never a wash sale, and an unknown gain is not one we can assert', () => {
    const gain = scanForPossibleWashSales({
      disposals: [lossOf({ gain: usd('500.00') })],
      acquisitions: [replacementAt(5)],
      soldHoldingPeriodStart: soldPeriods,
    });
    const unknown = scanForPossibleWashSales({
      disposals: [lossOf({ gain: null })],
      acquisitions: [replacementAt(5)],
      soldHoldingPeriodStart: soldPeriods,
    });
    expect(gain).toEqual([]);
    // Not a flag, and *also* not a silent assumption that a disposal with an
    // unknown basis made money.
    expect(unknown).toEqual([]);
  });

  it('scans across all accounts, including an IRA — Rev. Rul. 2008-5', () => {
    // Selling at a loss in the taxable account and buying back inside the IRA
    // is the case 07 §4.4 calls the trap most software misses, because most
    // software scans one account at a time.
    const flags = scanForPossibleWashSales({
      disposals: [lossOf()],
      acquisitions: [replacementAt(3, { accountId: IRA, isRetirementAccount: true })],
      soldHoldingPeriodStart: soldPeriods,
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.disposalAccountId).toBe(TAXABLE);
    expect(flags[0]?.replacementAccountId).toBe(IRA);
    // And the loss is not merely deferred — it has nowhere to go at all, so
    // the flag says so rather than adjusting a basis that would never be used.
    expect(flags[0]?.basisAdjustmentIsPermanentlyLost).toBe(true);
  });

  it('a partial repurchase defers only its share of the loss', () => {
    // 100 shares sold at a $1,000 loss, 40 bought back: $400 disallowed, $600
    // deductible. Share-for-share, and the split is exact.
    const flags = scanForPossibleWashSales({
      disposals: [lossOf()],
      acquisitions: [replacementAt(7, { quantity: Quantity.of('40') })],
      soldHoldingPeriodStart: soldPeriods,
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.disallowedLoss).toEqual(usd('400.00'));
    expect(Quantity.toDatabaseString(flags[0]?.matchedQuantity ?? Quantity.zero)).toBe(
      '40.000000000000000000',
    );
  });

  it('the same history scanned twice produces the same flags in the same order', () => {
    const input = {
      disposals: [lossOf(), lossOf({ id: 'disposal-2', date: DateOnly.addDays(SALE_DATE, 1) })],
      acquisitions: [replacementAt(3), replacementAt(9)],
      soldHoldingPeriodStart: new Map([
        ['disposal-1', SOLD_PERIOD_START],
        ['disposal-2', SOLD_PERIOD_START],
      ]),
    };
    // A tax warning that moved between runs would be worse than none.
    expect(scanForPossibleWashSales(input)).toEqual(scanForPossibleWashSales(input));
  });
});

describe('the label', () => {
  it('is POSSIBLE_WASH_SALE and never the bare assertion', () => {
    // The app does not see the user's other brokerages, their spouse's
    // accounts or their IRA at another custodian, so it cannot assert §1091 —
    // only that the pattern is there.
    expect(POSSIBLE_WASH_SALE).toBe('POSSIBLE_WASH_SALE');
    const flags = scanForPossibleWashSales({
      disposals: [lossOf()],
      acquisitions: [replacementAt(10)],
      soldHoldingPeriodStart: soldPeriods,
    });
    for (const flag of flags) {
      expect(flag.label).toBe('POSSIBLE_WASH_SALE');
      expect(flag.label).not.toBe('WASH_SALE');
      // The word appears only inside the longer label, never alone.
      expect(flag.label.replace('POSSIBLE_WASH_SALE', '')).toBe('');
    }
  });
});

describe('the digital-asset exclusion', () => {
  it('the digital-asset exclusion is read from config, not hardcoded', () => {
    const disposal = lossOf({ securityId: BTC });
    const replacement = replacementAt(5, { securityId: BTC, lotId: 'lot-btc-replacement' });
    const isDigitalAsset = (securityId: string): boolean => securityId === BTC;

    // Default policy, dated 2026-09: §1091 reaches "stocks or securities" and
    // digital assets are property, so no flag.
    expect(DEFAULT_WASH_SALE_CONFIG.appliesToDigitalAssets).toBe(false);
    expect(DEFAULT_WASH_SALE_CONFIG.asOf).toBe('2026-09');
    const underDefault = scanForPossibleWashSales({
      disposals: [disposal],
      acquisitions: [replacement],
      soldHoldingPeriodStart: soldPeriods,
      isDigitalAsset,
    });
    expect(underDefault).toEqual([]);

    // Flip only the config — no code change, no new branch — and the same
    // history flags. This is the assertion that the carve-out is a value: a
    // hardcoded `if (isCrypto) return` would leave this empty.
    const futureLaw: WashSaleConfig = { appliesToDigitalAssets: true, asOf: '2027-01' };
    const underFutureLaw = scanForPossibleWashSales({
      disposals: [disposal],
      acquisitions: [replacement],
      soldHoldingPeriodStart: soldPeriods,
      config: futureLaw,
      isDigitalAsset,
    });
    expect(underFutureLaw).toHaveLength(1);
    expect(underFutureLaw[0]?.label).toBe(POSSIBLE_WASH_SALE);
    expect(underFutureLaw[0]?.securityId).toBe(BTC);

    // And the exclusion is about the *asset*, not about the account: an equity
    // loss in the same scan is flagged either way.
    const mixed = scanForPossibleWashSales({
      disposals: [disposal, lossOf({ id: 'disposal-equity' })],
      acquisitions: [replacement, replacementAt(5)],
      soldHoldingPeriodStart: new Map([
        ['disposal-1', SOLD_PERIOD_START],
        ['disposal-equity', SOLD_PERIOD_START],
      ]),
      isDigitalAsset,
    });
    expect(mixed.map((flag) => flag.securityId)).toEqual([SECURITY]);
  });

  it('the default config is frozen, so nothing mutates the policy at runtime', () => {
    expect(Object.isFrozen(DEFAULT_WASH_SALE_CONFIG)).toBe(true);
  });
});

describe('applying a flag to the replacement lot', () => {
  function replacementLot(overrides: Partial<Parameters<typeof openLot>[0]> = {}): Lot {
    return openLot({
      id: 'lot-replacement-10',
      accountId: TAXABLE,
      securityId: SECURITY,
      openDate: DateOnly.addDays(SALE_DATE, 10),
      quantity: Quantity.of('100'),
      basis: usd('9000.00'),
      currency: USD,
      basisSource: 'BROKER',
      acquisitionType: 'BUY',
      ...overrides,
    }).lot;
  }

  it('a wash sale is labelled POSSIBLE_WASH_SALE and adjusts the replacement lot', () => {
    // The worked example, end to end. Sold 100 shares at a $1,000 loss on
    // 2026-03-15, having held them since 2024-01-10; bought 100 back ten days
    // later for $9,000.
    //
    //   basis            $9,000 + $1,000 disallowed  = $10,000
    //   holding period   tacked back to 2024-01-10 (not 2026-03-25)
    //
    // Both halves, always together. Software that adds the basis and forgets
    // the tacking reports a long-term gain as short-term for up to a year,
    // which is the more expensive error and the one nobody notices.
    const flags = scanForPossibleWashSales({
      disposals: [lossOf()],
      acquisitions: [replacementAt(10)],
      soldHoldingPeriodStart: soldPeriods,
    });
    expect(flags).toHaveLength(1);
    const flag = flags[0];
    if (flag === undefined) throw new Error('unreachable');
    expect(flag.label).toBe(POSSIBLE_WASH_SALE);
    expect(flag.disallowedLoss).toEqual(usd('1000.00'));
    expect(flag.tackedHoldingPeriodStartDate).toBe(SOLD_PERIOD_START);

    const before = replacementLot();
    const after = applyWashSaleToLot(before, flag);

    expect(after.basis).toEqual(usd('10000.00'));
    expect(after.washSaleAdjustment).toEqual(usd('1000.00'));
    expect(after.holdingPeriodStartDate).toBe(SOLD_PERIOD_START);
    // The lot still *opened* when it opened; only the period moved.
    expect(after.openDate).toBe(before.openDate);
    // Which is the point: a sale a month later is long-term, not short-term.
    expect(termOf(after.holdingPeriodStartDate, DateOnly.parse('2026-04-30'))).toBe('LONG_TERM');
    expect(termOf(before.holdingPeriodStartDate, DateOnly.parse('2026-04-30'))).toBe('SHORT_TERM');

    // Applying the set is the same as applying the one, and leaves other lots
    // untouched.
    const other = replacementLot({ id: 'lot-unrelated' });
    const [applied, untouched] = applyWashSales([replacementLot(), other], [flag]);
    expect(applied?.basis).toEqual(usd('10000.00'));
    expect(untouched?.basis).toEqual(usd('9000.00'));
  });

  it('applying the same flag twice adjusts the basis once, not twice', () => {
    // The bug this is here to prevent is invisible and compounding. The scan
    // is a pure function of the stored transaction history, so a re-delivered
    // sync run regenerates exactly the same flags; an `applyWashSales` that
    // *added* the disallowed loss would add $1,000 again on every nightly
    // sync, and the only symptom would be a capital gain that shrank a little
    // each night. Setting rather than adding makes the second application a
    // no-op by construction.
    const flags = scanForPossibleWashSales({
      disposals: [lossOf()],
      acquisitions: [replacementAt(10)],
      soldHoldingPeriodStart: soldPeriods,
    });
    const once = applyWashSales([replacementLot()], flags);
    const twice = applyWashSales(once, flags);
    const thrice = applyWashSales(twice, flags);

    expect(once[0]?.basis).toEqual(usd('10000.00'));
    expect(twice).toEqual(once);
    expect(thrice).toEqual(once);
    expect(twice[0]?.washSaleAdjustment).toEqual(usd('1000.00'));
  });

  it('two flags on one lot sum, rather than the last one winning', () => {
    // The other half of set semantics: the adjustment is the *total* of every
    // flag naming the lot, so applying them together must not lose one.
    const flags = scanForPossibleWashSales({
      disposals: [
        lossOf(),
        lossOf({ id: 'disposal-2', date: DateOnly.addDays(SALE_DATE, 2), gain: usd('-500.00') }),
      ],
      acquisitions: [replacementAt(10)],
      soldHoldingPeriodStart: new Map([
        ['disposal-1', SOLD_PERIOD_START],
        ['disposal-2', SOLD_PERIOD_START],
      ]),
    });
    expect(flags).toHaveLength(2);

    const [adjusted] = applyWashSales([replacementLot()], flags);
    expect(adjusted?.washSaleAdjustment).toEqual(usd('1500.00'));
    expect(adjusted?.basis).toEqual(usd('10500.00'));
    // And still idempotent with two flags in play.
    expect(applyWashSales([adjusted as Lot], flags)).toEqual([adjusted]);
  });

  it('leaves a lot no flag names completely alone', () => {
    const flags = scanForPossibleWashSales({
      disposals: [lossOf()],
      acquisitions: [replacementAt(10)],
      soldHoldingPeriodStart: soldPeriods,
    });
    // Including one that already carries an adjustment from an earlier run:
    // a partial flag set must not silently erase history it says nothing about.
    const unrelated = {
      ...replacementLot({ id: 'lot-unrelated' }),
      washSaleAdjustment: usd('25.00'),
    };
    expect(applyWashSales([unrelated], flags)).toEqual([unrelated]);
  });

  it('leaves an unknown-basis lot alone rather than inventing a number to add to', () => {
    // There is nothing to add $1,000 to. Manufacturing a basis here would turn
    // an `unavailable` into a figure — the laundering 04 §5.5 forbids — and
    // 0014's `cost_basis_lots_wash_adjustment_needs_a_basis` says the same
    // thing to every other write path.
    const flags = scanForPossibleWashSales({
      disposals: [lossOf()],
      acquisitions: [replacementAt(10)],
      soldHoldingPeriodStart: soldPeriods,
    });
    const unknown = replacementLot({ basis: null, basisSource: 'ESTIMATED' });
    const after = applyWashSaleToLot(unknown, flags[0] as never);
    expect(after.basis).toBeNull();
    expect(after.washSaleAdjustment).toEqual(Money.zero(USD));
    expect(after).toEqual(unknown);
  });

  it('leaves an IRA replacement alone: the loss is lost, not deferred', () => {
    const flags = scanForPossibleWashSales({
      disposals: [lossOf()],
      acquisitions: [replacementAt(10, { accountId: IRA, isRetirementAccount: true })],
      soldHoldingPeriodStart: soldPeriods,
    });
    const iraLot = replacementLot({ accountId: IRA });
    const after = applyWashSaleToLot(iraLot, flags[0] as never);
    expect(after).toEqual(iraLot);
    expect(flags[0]?.basisAdjustmentIsPermanentlyLost).toBe(true);
  });

  it('a wash-sale adjustment only ever raises a basis, never lowers it', () => {
    const flags = scanForPossibleWashSales({
      disposals: [lossOf()],
      acquisitions: [replacementAt(10)],
      soldHoldingPeriodStart: soldPeriods,
    });
    const after = applyWashSaleToLot(replacementLot(), flags[0] as never);
    expect(Money.isNegative(after.washSaleAdjustment)).toBe(false);
    expect(Money.compare(after.basis as ReturnType<typeof Money.of>, usd('9000.00'))).toBe(1);
  });
});
