// SPDX-License-Identifier: MIT
/**
 * Which investment movements are **external flows** — and the one rule that
 * makes a time-weighted or money-weighted return mean anything.
 *
 * WP 10.3. 07 §4.2 splits a period at every *external* cash flow: money that
 * crossed the account boundary. A contribution, a withdrawal, a transfer in or
 * out (cash or in kind). Everything else that happens inside the account — a
 * buy, a sell, a dividend, a reinvested dividend, interest, a fee, a tax
 * withheld, a split, a merger — is **part of the return**, not a flow. Getting
 * this wrong in either direction is silent and plausible:
 *
 *   * a dividend counted as a contribution makes the income vanish from the
 *     return (TWR and MWR both read 0 for a portfolio that earned 4%);
 *   * a 401(k) contribution counted as a trade (Plaid files it as
 *     `buy/contribution`, not `cash/contribution`) makes every payroll deposit
 *     look like investment growth;
 *   * a fee counted as a withdrawal hides the drag the holder is paying.
 *
 * ## Why this reads the provider's subtype, not only the house type
 *
 * `investment_transactions.type` is the house vocabulary the **lot engine**
 * needs (`holdings.ts`): a `buy/contribution` *must* stay a `BUY`, because it
 * opens a lot. Whether the same row is also money arriving from outside is a
 * different question with a different answer, and `subtype` keeps the
 * provider's own word precisely so it can be asked (the schema's header: "the
 * provider's own word, verbatim"). Classifying here, at read time, also means
 * rows stored before this file existed are classified correctly with no
 * backfill.
 *
 * ## A missing value is not a zero (O-2)
 *
 * Three cases are **excluded and named**, never folded in:
 *
 *   * a movement in another currency (D4: no rate this code did not read);
 *   * an external transfer with no cash amount (an in-kind transfer) that
 *     cannot be valued — the caller prices it at the transfer date and, when
 *     no price exists, counts it in `unvaluedTransfers`;
 *   * a cash movement whose provider word this file does not recognise
 *     (`cash/pending credit`, a `cash` row with no subtype, an `OTHER` that
 *     moved money): `role: 'unclassified'`. Treating it as a contribution would
 *     invent a flow; treating it as nothing would invent a return. It is
 *     counted and listed, and the period summary says it is incomplete.
 *
 * Pure: no I/O, no clock. The route reads rows and prices; this decides.
 */
import {
  Money,
  Quantity,
  type CurrencyCode,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
  type Quantity as QuantityType,
} from '@core/kernel';
import type { ExternalFlow } from './twr.ts';

/**
 * What a holder reads in the Activity list's "Type" column, and what its type
 * filter offers. `contribution` covers a transfer in, `withdrawal` a transfer
 * out (and a retirement-account distribution).
 */
export const ACTIVITY_KINDS = [
  'buy',
  'sell',
  'dividend',
  'reinvested_dividend',
  'interest',
  'contribution',
  'withdrawal',
  'fee',
  'tax',
  'split',
  'other',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * What a movement is to a return calculation.
 *
 *   * `external`     — crossed the account boundary: a flow for TWR and MWR.
 *   * `income`       — dividend, reinvested dividend, interest: inside the return.
 *   * `cost`         — a fee or a tax withheld: inside the return (it is the drag).
 *   * `trade`        — buy, sell, split: moves value between positions.
 *   * `internal`     — a corporate action, staking, an airdrop: not a flow.
 *   * `unclassified` — moved money and could be either; excluded and named.
 */
export const PERFORMANCE_ROLES = [
  'external',
  'income',
  'cost',
  'trade',
  'internal',
  'unclassified',
] as const;
export type PerformanceRole = (typeof PERFORMANCE_ROLES)[number];

/** One stored movement, as much of it as classification needs. */
export interface ActivityInput {
  /** The house type (`INVESTMENT_TRANSACTION_TYPES`). A string so a stored row needs no cast. */
  readonly type: string;
  /** The provider's own word, verbatim. */
  readonly subtype: string | null;
  /** House sign: negative = money left the account's cash. */
  readonly amount: MoneyType;
  /** A magnitude, `>= 0`. */
  readonly fees: MoneyType;
  /** Signed as the provider reported it. */
  readonly quantity: QuantityType;
  readonly securityId: string | null;
}

export interface ClassifiedActivity {
  readonly kind: ActivityKind;
  readonly role: PerformanceRole;
  /**
   * Only for `role: 'external'`. **Positive = into the portfolio**, the
   * convention `twr.ts` and `mwr.ts` take. `null` when the movement carried no
   * cash amount and has to be valued (an in-kind transfer): see `inKind`.
   */
  readonly flow: MoneyType | null;
  /**
   * Only for an external movement with no cash amount: what was moved, so the
   * caller can price it on the transfer date. `null` when there is nothing to
   * price (no security or no quantity) — that one is simply unvalued.
   */
  readonly inKind: {
    readonly securityId: string;
    /** A magnitude. The direction is `direction`. */
    readonly quantity: QuantityType;
    readonly direction: 'in' | 'out';
  } | null;
}

/** Plaid's corporate-action words under `type: transfer` (and their CSV cousins). */
const CORPORATE_ACTION =
  /\b(merger|spin[ -]?off|split|exercise|expire|assignment|adjustment|rebalance|stock distribution|trade|conver(t|sion)|reorg)/;
/** Money crossing the account boundary, in any provider's spelling. */
const EXTERNAL_WORD =
  /\b(contribution|deposit|withdraw(al)?|distribution|transfer|send|receive|request|rollover|loan)/;
const INCOME_WORD =
  /\b(dividend|capital gain|unqualified gain|qualified gain|gain|return of capital|income)/;
const TAX_WORD = /\b(tax|withh(e|o)ld|withholding)/;
const FEE_WORD = /\b(fee|expense|commission|charge)/;

function wordOf(subtype: string | null): string {
  return (subtype ?? '').trim().toLowerCase();
}

function directionOf(input: ActivityInput, fallback: 'in' | 'out'): 'in' | 'out' {
  if (Money.isPositive(input.amount)) return 'in';
  if (Money.isNegative(input.amount)) return 'out';
  if (Quantity.isNegative(input.quantity)) return 'out';
  return fallback;
}

/**
 * An external movement. `sign` says how the house amount relates to the flow:
 * `+1` for a cash or transfer row (house `+` = cash arrived = into the
 * portfolio), `-1` for a trade-shaped row (`buy/contribution`: the house
 * amount is the cash the buy *spent*, negative, while the value arrived from
 * outside).
 */
function external(input: ActivityInput, sign: 1 | -1, fallback: 'in' | 'out'): ClassifiedActivity {
  if (!Money.isZero(input.amount)) {
    const flow = sign === 1 ? input.amount : Money.negate(input.amount);
    return {
      kind: Money.isPositive(flow) ? 'contribution' : 'withdrawal',
      role: 'external',
      flow,
      inKind: null,
    };
  }
  const direction = sign === 1 ? directionOf(input, fallback) : fallback;
  const quantity = Quantity.isNegative(input.quantity)
    ? Quantity.negate(input.quantity)
    : input.quantity;
  return {
    kind: direction === 'in' ? 'contribution' : 'withdrawal',
    role: 'external',
    flow: null,
    inKind:
      input.securityId !== null && !Quantity.isZero(quantity)
        ? { securityId: input.securityId, quantity, direction }
        : null,
  };
}

function plain(kind: ActivityKind, role: PerformanceRole): ClassifiedActivity {
  return { kind, role, flow: null, inKind: null };
}

/**
 * Classify one movement. Total over every house type and every subtype: an
 * unknown provider word lands in `other` (internal when it moved no money,
 * `unclassified` when it did), never in a flow.
 */
export function classifyActivity(input: ActivityInput): ClassifiedActivity {
  const word = wordOf(input.subtype);
  switch (input.type) {
    case 'BUY':
      // Plaid `buy/contribution`: "inflow of assets into a tax-advantaged account".
      if (/\bcontribution\b/.test(word)) return external(input, -1, 'in');
      return plain('buy', 'trade');
    case 'SELL':
      // Plaid `sell/distribution`: "outflow of assets from a tax-advantaged account".
      if (/\b(distribution|withdraw)/.test(word) && !/stock distribution/.test(word)) {
        return external(input, -1, 'out');
      }
      return plain('sell', 'trade');
    case 'REINVESTED_DIVIDEND':
      return plain('reinvested_dividend', 'income');
    case 'DIVIDEND':
      return plain('dividend', 'income');
    case 'INTEREST':
      return plain('interest', 'income');
    case 'FEE':
      return plain('fee', 'cost');
    case 'SPLIT':
      return plain('split', 'trade');
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
      if (CORPORATE_ACTION.test(word)) return plain('other', 'internal');
      return external(input, 1, input.type === 'TRANSFER_IN' ? 'in' : 'out');
    case 'GIFT_IN':
      return external(input, 1, 'in');
    case 'CASH':
      return classifyCash(input, word);
    case 'STAKING_REWARD':
    case 'AIRDROP':
    case 'MINING':
    case 'FORK':
      return plain('other', 'internal');
    default:
      return Money.isZero(input.amount)
        ? plain('other', 'internal')
        : plain('other', 'unclassified');
  }
}

/**
 * `CASH` is where Plaid's `cash/*` subtypes land when the house normaliser has
 * no sharper word for them — and it is a mix of external and internal. Order
 * matters: a stock distribution is a corporate action before it is a
 * distribution, and a "capital gain distribution" is income before it is a
 * distribution.
 */
function classifyCash(input: ActivityInput, word: string): ClassifiedActivity {
  if (/stock distribution/.test(word)) return plain('other', 'internal');
  if (INCOME_WORD.test(word)) return plain('dividend', 'income');
  if (/\binterest\b/.test(word)) return plain('interest', 'income');
  if (TAX_WORD.test(word)) return plain('tax', 'cost');
  if (FEE_WORD.test(word) || /margin/.test(word)) return plain('fee', 'cost');
  if (CORPORATE_ACTION.test(word)) return plain('other', 'internal');
  if (EXTERNAL_WORD.test(word)) {
    return external(input, 1, /withdraw|distribution|send/.test(word) ? 'out' : 'in');
  }
  return Money.isZero(input.amount) ? plain('other', 'internal') : plain('other', 'unclassified');
}

// ---------------------------------------------------------------------------
// The period summary — the dollar half of the health snapshot
// ---------------------------------------------------------------------------

/** One classified movement, carrying what the summary names when it excludes. */
export interface SummaryMovement {
  readonly id: string;
  /** The trade date: where an external flow lands in sub-period linking. */
  readonly date: DateOnlyType;
  readonly classified: ClassifiedActivity;
  readonly input: ActivityInput;
  /**
   * The flow the caller valued, for an in-kind transfer it priced on the
   * transfer date. `undefined`: not an in-kind transfer, or not priced.
   */
  readonly valuedFlow?: MoneyType;
}

export interface ActivityTotals {
  readonly currency: CurrencyCode;
  /** Σ external flows, positive = net money in. In-kind transfers at their valued amount. */
  readonly netContributions: MoneyType;
  /** Σ cash dividends and interest received (house sign: a reversal reduces it). */
  readonly dividendsAndInterest: MoneyType;
  /**
   * Σ reinvested dividends, as a magnitude. Reported apart: a broker that
   * reports both the cash dividend and the reinvestment buy would otherwise
   * count one dividend twice.
   */
  readonly reinvestedDividends: MoneyType;
  /** Σ fees: a fee row's own amount, plus the commission (`fees`) on any other row. A magnitude. */
  readonly feesPaid: MoneyType;
  /** Σ taxes withheld, a magnitude. */
  readonly taxesWithheld: MoneyType;
  /** Ids of movements in another currency — excluded from every total above. */
  readonly foreignCurrency: readonly string[];
  /** Ids of external transfers that could not be valued — never a zero flow. */
  readonly unvaluedTransfers: readonly string[];
  /** Ids of movements that moved money and could not be classified. */
  readonly unclassified: readonly string[];
}

/**
 * Sum the period's movements. The same classification `readFlows` uses, so the
 * health strip's "net contributions" and the flows TWR/MWR were measured
 * against are one number, not two that agree by coincidence.
 */
export function summariseActivity(
  movements: readonly SummaryMovement[],
  currency: CurrencyCode,
): ActivityTotals {
  let netContributions = Money.zero(currency);
  let dividendsAndInterest = Money.zero(currency);
  let reinvestedDividends = Money.zero(currency);
  let feesPaid = Money.zero(currency);
  let taxesWithheld = Money.zero(currency);
  const foreignCurrency: string[] = [];
  const unvaluedTransfers: string[] = [];
  const unclassified: string[] = [];

  for (const movement of movements) {
    const { classified, input } = movement;
    if (input.amount.currency !== currency || input.fees.currency !== currency) {
      foreignCurrency.push(movement.id);
      continue;
    }
    switch (classified.role) {
      case 'external': {
        const flow = classified.flow ?? movement.valuedFlow ?? null;
        if (flow === null) unvaluedTransfers.push(movement.id);
        else netContributions = Money.add(netContributions, flow);
        break;
      }
      case 'income':
        if (classified.kind === 'reinvested_dividend') {
          reinvestedDividends = Money.add(reinvestedDividends, Money.absolute(input.amount));
        } else {
          dividendsAndInterest = Money.add(dividendsAndInterest, input.amount);
        }
        break;
      case 'cost':
        if (classified.kind === 'tax') {
          taxesWithheld = Money.add(taxesWithheld, Money.absolute(input.amount));
          continue;
        }
        // A fee row: its own amount, or the `fees` field when the amount is blank.
        feesPaid = Money.add(
          feesPaid,
          Money.isZero(input.amount) ? input.fees : Money.absolute(input.amount),
        );
        continue;
      case 'unclassified':
        unclassified.push(movement.id);
        break;
      case 'trade':
      case 'internal':
        break;
    }
    // A commission on anything that is not itself a fee row.
    feesPaid = Money.add(feesPaid, input.fees);
  }

  return {
    currency,
    netContributions,
    dividendsAndInterest,
    reinvestedDividends,
    feesPaid,
    taxesWithheld,
    foreignCurrency,
    unvaluedTransfers,
    unclassified,
  };
}

export interface PeriodFlows {
  /** Positive = into the portfolio; one per valued external movement, in date order. */
  readonly flows: readonly ExternalFlow[];
  /**
   * External movements left out of the flows: an in-kind transfer with no
   * price on its date, or one with nothing to price, or one in another
   * currency. Counted, never a zero flow — a zero flow would silently credit
   * the whole transferred position to performance.
   */
  readonly unvalued: readonly string[];
}

/**
 * The external flows a TWR/MWR is measured against, from the same
 * classification `summariseActivity` sums. A zero-valued flow is dropped (it
 * changes no sub-period and no XIRR term) rather than kept as a boundary.
 */
export function externalFlowsOf(
  movements: readonly SummaryMovement[],
  currency: CurrencyCode,
): PeriodFlows {
  const flows: ExternalFlow[] = [];
  const unvalued: string[] = [];
  for (const movement of movements) {
    if (movement.classified.role !== 'external') continue;
    const flow = movement.classified.flow ?? movement.valuedFlow ?? null;
    if (flow === null || flow.currency !== currency) {
      unvalued.push(movement.id);
      continue;
    }
    if (Money.isZero(flow)) continue;
    flows.push({ date: movement.date, amount: flow });
  }
  flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { flows, unvalued };
}
