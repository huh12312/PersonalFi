// SPDX-License-Identifier: MIT
/**
 * The lot engine: open a lot, match a disposal against lots, split the result
 * into short-term and long-term.
 *
 * Pure, and pure in the strong sense — no clock, no database, no ids minted
 * here. Everything is `Quantity` (a decimal string over `NUMERIC(38,18)`),
 * `Money` (`bigint` minor units) and `DateOnly`. There is no `number` in any
 * signature in this file, because a lot is the one place in the app where a
 * rounding error becomes a tax number.
 *
 * ## The five methods, and what actually differs between them
 *
 * Only the **order** differs. Every method picks lots off a queue, takes as
 * much of each as it needs, and stops. So `orderLotsFor(method, …)` is the
 * whole of the method vocabulary and `matchDisposal` is one function rather
 * than five:
 *
 * | method        | order                                          | why                                                     |
 * |---------------|------------------------------------------------|---------------------------------------------------------|
 * | `FIFO`        | `open_date` asc, then `id` asc                 | the default, and the IRS default when nothing is elected |
 * | `LIFO`        | `open_date` desc, then `id` desc               | most recent first                                        |
 * | `HIFO`        | basis per unit desc, then `open_date` asc      | least gain first; a tax-loss-harvesting default          |
 * | `SPECIFIC_ID` | exactly the ids the caller named, in order     | the recommended method for a taxable account             |
 * | `AVERAGE_COST`| `open_date` asc, over a *pooled* per-unit basis| mutual funds only, sticky once elected                   |
 *
 * `id` breaks every tie, and it is a tie-break rather than an accident: two
 * lots opened on the same day must select **reproducibly**, or the same sale
 * run twice produces two different tax answers. That reproducibility is what
 * `'FIFO, LIFO, HIFO and specific-ID select different lots for the same sale
 * and each is reproducible'` asserts.
 *
 * **HIFO puts unknown-basis lots last**, and that is a deliberate refusal
 * rather than a sort convention: "highest in" cannot rank a lot whose basis
 * nobody knows, and treating an unknown as a zero basis would make it rank
 * *lowest* — the exact gain-from-zero fabrication 04 §5.5 forbids, arriving
 * through a comparator instead of through a subtraction.
 *
 * ## Basis is consumed exactly, never re-derived
 *
 * A lot carries `basis` (the total for its *original* `quantity`, which is what
 * a 1099-B shows) and `basisConsumed` (what disposals have already taken).
 * A partial disposal takes
 *
 *     consumed = allocate(basis − basisConsumed, [taken, remaining − taken])[0]
 *
 * — `Money.allocate`'s largest-remainder split, so the parts always sum back.
 * The invariant that falls out, and that `'basis is conserved across a chain of
 * partial disposals'` asserts as a property: for any sequence of disposals,
 * `Σ matched basis + remaining basis = basis`, to the cent, with no drift. The
 * naive alternative — recomputing a per-unit basis and multiplying — loses a
 * cent per disposal and loses it silently.
 *
 * ## Unknown basis propagates; it never becomes a zero
 *
 * A match against a lot with `basis === null` yields `basis: null` and
 * `gain: null`. `realizedGainOf` then reports the term's total as
 * `unavailable` rather than summing the knowable half into a number that looks
 * complete. 04 §5.5 and 07 §6.2; `src/basis.ts` carries the same discipline for
 * the unrealised side.
 */
import {
  DateOnly,
  Money,
  Quantity,
  type CurrencyCode,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
  type Quantity as QuantityType,
} from '@core/kernel';
import {
  ACQUISITION_TYPES,
  BASIS_METHODS,
  BASIS_SOURCES,
  type AcquisitionType,
  type BasisMethod,
  type BasisSource,
} from '../schema/index.ts';

export { ACQUISITION_TYPES, BASIS_METHODS, BASIS_SOURCES };
export type { AcquisitionType, BasisMethod, BasisSource };

/**
 * IRC §1222: long-term is *more than* one year. Held exactly 365 days is
 * short-term; 366 is long-term.
 *
 * The boundary is one `>` and it is worth a sentence, because getting it wrong
 * moves a gain between a 37% bracket and a 15% one and nothing about the output
 * looks different. `'a lot held exactly 365 days is short-term and one held 366
 * days is long-term'` is the test, and the sabotage that proves the test works
 * is that `>` turned into `>=`.
 */
export const LONG_TERM_HOLDING_DAYS = 365;

export type Term = 'SHORT_TERM' | 'LONG_TERM';

/** FIFO when nobody elected anything — which is also what the IRS assumes. */
export const DEFAULT_BASIS_METHOD: BasisMethod = 'FIFO';

/**
 * 07 §4.4: AVERAGE_COST is "mutual funds only". Enumerated rather than
 * open-coded so the refusal message can name what it did see.
 */
export const AVERAGE_COST_ELIGIBLE_TYPES = ['mutual_fund'] as const;

/** One open tax lot. The unit the whole engine moves. */
export interface Lot {
  readonly id: string;
  /** The Rev. Proc. 2024-28 basis scope: one account, or one wallet. */
  readonly accountId: string;
  readonly securityId: string;
  /** When it was acquired. */
  readonly openDate: DateOnlyType;
  /** Where the holding period starts — earlier after a wash sale tacked one on. */
  readonly holdingPeriodStartDate: DateOnlyType;
  /** As acquired. Always > 0. */
  readonly quantity: QuantityType;
  /** What is left. `0 <= quantityRemaining <= quantity`, always. */
  readonly quantityRemaining: QuantityType;
  /** Total basis for `quantity`. **`null` means unknown, never zero.** */
  readonly basis: MoneyType | null;
  /** What disposals have taken out of `basis` so far. */
  readonly basisConsumed: MoneyType;
  readonly currency: CurrencyCode;
  readonly basisSource: BasisSource;
  readonly acquisitionType: AcquisitionType;
  /** Mandatory when `basisSource === 'ESTIMATED'`. The string the UI must show. */
  readonly basisWarning: string | null;
  /** The §1091 loss already folded into `basis`. Never negative. */
  readonly washSaleAdjustment: MoneyType;
  readonly openedByTransactionId: string | null;
  readonly sourceTxnHash: string | null;
}

/** Why a caller is being warned. Codes, never prose a UI would have to parse. */
export const LOT_WARNING_CODES = [
  'basis_unknown',
  'basis_estimated',
  'short_quantity',
  'specific_id_lot_missing',
  'specific_id_insufficient',
  'average_cost_pool_incomplete',
] as const;
export type LotWarningCode = (typeof LOT_WARNING_CODES)[number];

export interface LotWarning {
  readonly code: LotWarningCode;
  /** The lot or transaction the warning is about, when it is about one. */
  readonly subjectId: string | null;
  readonly detail: string;
}

export class LotError extends Error {
  // A field and an assignment rather than a TypeScript parameter property: the
  // repo compiles with `erasableSyntaxOnly`, so every construct has to survive
  // type stripping with no emit.
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LotError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Quantity <-> weight
// ---------------------------------------------------------------------------

/**
 * A quantity as an exact integer of 1e-18 units, for `Money.allocate`'s weights.
 *
 * `toDatabaseString` fixes the scale at 18, so removing the point is exact —
 * no rounding, no float, and the same integer a `NUMERIC(38,18)` column holds.
 */
export function quantityWeight(value: QuantityType): bigint {
  return BigInt(Quantity.toDatabaseString(value).replace('.', ''));
}

// ---------------------------------------------------------------------------
// Opening a lot
// ---------------------------------------------------------------------------

export interface OpenLotInput {
  readonly id: string;
  readonly accountId: string;
  readonly securityId: string;
  readonly openDate: DateOnlyType;
  /** Defaults to `openDate`; a carried self-transfer supplies the original. */
  readonly holdingPeriodStartDate?: DateOnlyType;
  readonly quantity: QuantityType;
  /** `null` when nobody reported one. The engine will never invent a number. */
  readonly basis: MoneyType | null;
  readonly currency: CurrencyCode;
  readonly basisSource: BasisSource;
  readonly acquisitionType: AcquisitionType;
  readonly basisWarning?: string | null;
  readonly openedByTransactionId?: string | null;
  readonly sourceTxnHash?: string | null;
}

export interface OpenLotResult {
  readonly lot: Lot;
  readonly warnings: readonly LotWarning[];
}

/**
 * The default warning text for a lot nobody could price.
 *
 * A constant rather than a per-call string so that every producer says the same
 * thing and a grep finds all of them. 07 §6.2 requires the warning to be
 * *visible*; making it unavoidable at construction is how that survives a
 * refactor.
 */
export const UNKNOWN_BASIS_WARNING =
  'Cost basis is unknown for this lot. Gain and loss are reported as unavailable, ' +
  'not as gain from a zero basis.';

/**
 * Build a lot, refusing every shape that would launder an unknown basis into a
 * number.
 *
 * Three refusals, all `LotError`:
 *
 *   * a non-positive quantity — a lot of nothing is not a lot;
 *   * a negative basis — there is no such thing;
 *   * an unknown basis on a source that claims to *know* (`BROKER`, `IMPORTED`,
 *     `USER`, `SAFE_HARBOR_ALLOC`). A broker that reported nothing did not
 *     report zero, and the only honest source for "we do not know" is
 *     `ESTIMATED`. The database CHECK
 *     `cost_basis_lots_unknown_basis_is_declared_estimated` says the same thing
 *     to every other write path.
 */
export function openLot(input: OpenLotInput): OpenLotResult {
  if (Quantity.compare(input.quantity, Quantity.zero) <= 0) {
    throw new LotError('lot.quantity_not_positive', `a lot needs a positive quantity`);
  }
  if (input.basis !== null && Money.isNegative(input.basis)) {
    throw new LotError('lot.basis_negative', 'a cost basis is never negative');
  }
  if (input.basis === null && input.basisSource !== 'ESTIMATED') {
    throw new LotError(
      'lot.unknown_basis_must_be_estimated',
      `a lot with no basis must declare basis_source ESTIMATED, not ${input.basisSource}`,
    );
  }

  const holdingPeriodStartDate = input.holdingPeriodStartDate ?? input.openDate;
  if (DateOnly.isAfter(holdingPeriodStartDate, input.openDate)) {
    throw new LotError(
      'lot.holding_period_after_open',
      'a holding period starts no later than the lot opens; tacking moves it earlier',
    );
  }

  const warnings: LotWarning[] = [];
  let basisWarning = input.basisWarning ?? null;
  if (input.basis === null) {
    basisWarning ??= UNKNOWN_BASIS_WARNING;
    warnings.push({
      code: 'basis_unknown',
      subjectId: input.id,
      detail: basisWarning,
    });
  } else if (input.basisSource === 'ESTIMATED') {
    basisWarning ??= UNKNOWN_BASIS_WARNING;
    warnings.push({ code: 'basis_estimated', subjectId: input.id, detail: basisWarning });
  }

  const lot: Lot = {
    id: input.id,
    accountId: input.accountId,
    securityId: input.securityId,
    openDate: input.openDate,
    holdingPeriodStartDate,
    quantity: input.quantity,
    quantityRemaining: input.quantity,
    basis: input.basis,
    basisConsumed: Money.zero(input.currency),
    currency: input.currency,
    basisSource: input.basisSource,
    acquisitionType: input.acquisitionType,
    basisWarning,
    washSaleAdjustment: Money.zero(input.currency),
    openedByTransactionId: input.openedByTransactionId ?? null,
    sourceTxnHash: input.sourceTxnHash ?? null,
  };
  return { lot, warnings };
}

// ---------------------------------------------------------------------------
// Reading a lot
// ---------------------------------------------------------------------------

/** Basis still attached to `quantityRemaining`. `null` when the basis is unknown. */
export function remainingBasisOf(lot: Lot): MoneyType | null {
  return lot.basis === null ? null : Money.subtract(lot.basis, lot.basisConsumed);
}

export function isOpen(lot: Lot): boolean {
  return Quantity.compare(lot.quantityRemaining, Quantity.zero) > 0;
}

/**
 * Basis per unit of what remains, as a decimal string, or `null` when unknown.
 *
 * Used by HIFO's comparator and by nothing that writes a column: this is a
 * ratio of two exact values and it is only ever compared, never stored.
 */
export function remainingBasisPerUnit(lot: Lot): QuantityType | null {
  const remaining = remainingBasisOf(lot);
  if (remaining === null) return null;
  if (Quantity.compare(lot.quantityRemaining, Quantity.zero) <= 0) return null;
  return Quantity.divide(
    Quantity.of(remaining.minor.toString()),
    Quantity.toDatabaseString(lot.quantityRemaining),
  );
}

/** Short-term at exactly 365 days; long-term only above it. See `LONG_TERM_HOLDING_DAYS`. */
export function termOf(holdingPeriodStartDate: DateOnlyType, disposalDate: DateOnlyType): Term {
  const heldDays = DateOnly.differenceInDays(holdingPeriodStartDate, disposalDate);
  return heldDays > LONG_TERM_HOLDING_DAYS ? 'LONG_TERM' : 'SHORT_TERM';
}

// ---------------------------------------------------------------------------
// Ordering: the only thing the five methods disagree about
// ---------------------------------------------------------------------------

export interface OrderLotsOptions {
  readonly method: BasisMethod;
  /** `SPECIFIC_ID` only. The lots the user picked, in the order they picked them. */
  readonly specificLotIds?: readonly string[];
}

/**
 * The queue a disposal eats from, per method.
 *
 * Returns a new array; the input is never mutated, because a caller holding the
 * lots for a second method would otherwise get the first method's order.
 */
export function orderLotsFor(lots: readonly Lot[], options: OrderLotsOptions): readonly Lot[] {
  const open = lots.filter(isOpen);
  switch (options.method) {
    case 'FIFO':
    case 'AVERAGE_COST':
      // AVERAGE_COST pools the *basis* but still consumes oldest-first, because
      // the holding period is per lot and an average has none.
      return [...open].sort(byOpenDateThenId(1));
    case 'LIFO':
      return [...open].sort(byOpenDateThenId(-1));
    case 'HIFO':
      return [...open].sort(byBasisPerUnitDescending);
    case 'SPECIFIC_ID': {
      const picked = options.specificLotIds ?? [];
      const byId = new Map(open.map((lot) => [lot.id, lot]));
      const ordered: Lot[] = [];
      for (const id of picked) {
        const lot = byId.get(id);
        if (lot !== undefined) ordered.push(lot);
      }
      return ordered;
    }
  }
}

function byOpenDateThenId(direction: 1 | -1): (a: Lot, b: Lot) => number {
  return (a, b) => {
    const byDate = DateOnly.compare(a.openDate, b.openDate);
    if (byDate !== 0) return byDate * direction;
    return a.id < b.id ? -direction : a.id > b.id ? direction : 0;
  };
}

/**
 * Highest basis per unit first — with every unknown-basis lot at the back.
 *
 * See the file header: an unknown is not a low basis, and letting it sort as
 * one is gain-from-zero arriving through a comparator.
 */
function byBasisPerUnitDescending(a: Lot, b: Lot): number {
  const left = remainingBasisPerUnit(a);
  const right = remainingBasisPerUnit(b);
  if (left === null && right === null) return byOpenDateThenId(1)(a, b);
  if (left === null) return 1;
  if (right === null) return -1;
  const byBasis = Quantity.compare(right, left);
  if (byBasis !== 0) return byBasis;
  return byOpenDateThenId(1)(a, b);
}

// ---------------------------------------------------------------------------
// Matching a disposal
// ---------------------------------------------------------------------------

export interface DisposalRequest {
  readonly accountId: string;
  readonly securityId: string;
  readonly date: DateOnlyType;
  /** Positive: how much is leaving. A sale of 3 shares is `'3'`, never `'-3'`. */
  readonly quantity: QuantityType;
  /** Gross proceeds, positive. Fees come off separately. */
  readonly proceeds: MoneyType;
  readonly fees?: MoneyType;
  readonly method?: BasisMethod;
  readonly specificLotIds?: readonly string[];
}

/** One lot, partly or wholly consumed by one disposal. */
export interface LotMatch {
  readonly lotId: string;
  readonly quantity: QuantityType;
  /** The share of gross proceeds attributed to this lot. */
  readonly proceeds: MoneyType;
  /** The basis taken from this lot. `null` when the lot's basis is unknown. */
  readonly basis: MoneyType | null;
  readonly holdingPeriodStartDate: DateOnlyType;
  readonly term: Term;
  /** `proceeds − basis − fee share`. `null` exactly when `basis` is. */
  readonly gain: MoneyType | null;
}

/**
 * A realised result, per term.
 *
 * A discriminated union rather than a `Money` with a flag, for the reason 04
 * §5.5 gives about FX: a number with a fallback is a number somebody will read
 * without checking the flag. `unavailable` carries the lots that caused it so
 * the UI can name them.
 */
export type RealizedAmount =
  | { readonly status: 'available'; readonly amount: MoneyType }
  | { readonly status: 'unavailable'; readonly lotIds: readonly string[] };

export interface RealizedGain {
  readonly shortTerm: RealizedAmount;
  readonly longTerm: RealizedAmount;
  readonly proceeds: MoneyType;
  readonly fees: MoneyType;
  readonly currency: CurrencyCode;
}

export interface DisposalResult {
  readonly matches: readonly LotMatch[];
  /** Every lot the caller passed in, with the consumed ones decremented. */
  readonly lots: readonly Lot[];
  readonly realized: RealizedGain;
  /** How much of the request could not be matched. `'0'` when it all could. */
  readonly unmatchedQuantity: QuantityType;
  readonly warnings: readonly LotWarning[];
}

/**
 * Consume `request.quantity` from `lots`, in the elected method's order.
 *
 * Scoped to `accountId` **and** `securityId`: Rev. Proc. 2024-28 makes basis
 * per wallet, so a lot in another account is not eligible no matter how well it
 * would have sorted. A caller that hands in lots from several accounts gets the
 * right answer anyway, because the filter is here rather than in the caller.
 *
 * Short quantity is a `warning`, not a throw. A provider that reported a sale
 * whose lots we never saw is an ordinary condition on a partially-imported
 * account — the R6 verdict guarantees it on every Coinbase wallet — and
 * throwing would abandon the part we *can* attribute. `unmatchedQuantity` is
 * the honest report.
 */
export function matchDisposal(
  lots: readonly Lot[],
  request: DisposalRequest,
): DisposalResult {
  const method = request.method ?? DEFAULT_BASIS_METHOD;
  const currency = request.proceeds.currency;
  const fees = request.fees ?? Money.zero(currency);
  const warnings: LotWarning[] = [];

  if (Quantity.compare(request.quantity, Quantity.zero) <= 0) {
    throw new LotError('disposal.quantity_not_positive', 'a disposal needs a positive quantity');
  }

  const eligible = lots.filter(
    (lot) => lot.accountId === request.accountId && lot.securityId === request.securityId,
  );
  const queue = orderLotsFor(eligible, { method, specificLotIds: request.specificLotIds });

  if (method === 'SPECIFIC_ID') {
    const available = new Set(eligible.filter(isOpen).map((lot) => lot.id));
    for (const id of request.specificLotIds ?? []) {
      if (!available.has(id)) {
        warnings.push({
          code: 'specific_id_lot_missing',
          subjectId: id,
          detail: 'the named lot is closed, or belongs to another account or security',
        });
      }
    }
  }
  if (method === 'AVERAGE_COST' && queue.some((lot) => lot.basis === null)) {
    warnings.push({
      code: 'average_cost_pool_incomplete',
      subjectId: null,
      detail:
        'at least one lot in the average-cost pool has no basis, so the pooled average is ' +
        'unavailable rather than understated',
    });
  }

  // AVERAGE_COST pools the basis across every open lot *before* any of it is
  // consumed, exactly as the regulation does; the per-lot figures below then
  // come out of the pool rather than out of each lot's own basis.
  const pooled = method === 'AVERAGE_COST' ? pooledBasisOf(queue, currency) : null;

  const taken = new Map<string, { quantity: QuantityType; basis: MoneyType | null }>();
  let remainingToMatch = request.quantity;
  for (const lot of queue) {
    if (Quantity.compare(remainingToMatch, Quantity.zero) <= 0) break;
    const available = lot.quantityRemaining;
    const take =
      Quantity.compare(available, remainingToMatch) <= 0 ? available : remainingToMatch;
    if (Quantity.compare(take, Quantity.zero) <= 0) continue;

    const basis =
      pooled === null
        ? basisTakenFrom(lot, take)
        : pooled === 'unavailable'
          ? null
          : proRata(pooled.basis, take, pooled.quantity);

    taken.set(lot.id, { quantity: take, basis });
    remainingToMatch = Quantity.subtract(remainingToMatch, take);
  }

  if (Quantity.compare(remainingToMatch, Quantity.zero) > 0) {
    warnings.push({
      code: method === 'SPECIFIC_ID' ? 'specific_id_insufficient' : 'short_quantity',
      subjectId: null,
      detail:
        `${Quantity.toDatabaseString(remainingToMatch)} of the disposal has no lot to come ` +
        'from; its basis is unavailable rather than zero',
    });
  }

  // Gross proceeds and fees are split across the matched lots by quantity, with
  // `Money.allocate`'s largest-remainder rule, so no cent is created or lost.
  const matchedIds = [...taken.keys()];
  const weights = matchedIds.map((id) => quantityWeight(taken.get(id)?.quantity ?? Quantity.zero));
  const proceedShares = splitAcross(request.proceeds, weights);
  const feeShares = splitAcross(fees, weights);

  const matches: LotMatch[] = [];
  const byId = new Map(eligible.map((lot) => [lot.id, lot]));
  matchedIds.forEach((id, index) => {
    const lot = byId.get(id);
    const slice = taken.get(id);
    if (lot === undefined || slice === undefined) return;
    const proceeds = proceedShares[index] ?? Money.zero(currency);
    const feeShare = feeShares[index] ?? Money.zero(currency);
    const gain =
      slice.basis === null
        ? null
        : Money.subtract(Money.subtract(proceeds, slice.basis), feeShare);
    if (slice.basis === null) {
      warnings.push({
        code: 'basis_unknown',
        subjectId: id,
        detail: UNKNOWN_BASIS_WARNING,
      });
    }
    matches.push({
      lotId: id,
      quantity: slice.quantity,
      proceeds,
      basis: slice.basis,
      holdingPeriodStartDate: lot.holdingPeriodStartDate,
      term: termOf(lot.holdingPeriodStartDate, request.date),
      gain,
    });
  });

  const updated = lots.map((lot) => {
    const slice = taken.get(lot.id);
    if (slice === undefined) return lot;
    return {
      ...lot,
      quantityRemaining: Quantity.subtract(lot.quantityRemaining, slice.quantity),
      basisConsumed:
        slice.basis === null || pooled !== null
          ? lot.basisConsumed
          : Money.add(lot.basisConsumed, slice.basis),
    };
  });

  return {
    matches,
    lots: updated,
    realized: realizedGainOf(matches, {
      proceeds: request.proceeds,
      fees,
      unmatched: Quantity.compare(remainingToMatch, Quantity.zero) > 0,
    }),
    unmatchedQuantity: remainingToMatch,
    warnings,
  };
}

/** The basis a lot gives up for `take`, prorated out of what it has left. */
function basisTakenFrom(lot: Lot, take: QuantityType): MoneyType | null {
  const remainingBasis = remainingBasisOf(lot);
  if (remainingBasis === null) return null;
  return proRata(remainingBasis, take, lot.quantityRemaining);
}

/**
 * `amount × taken / total`, exactly, by splitting rather than dividing.
 *
 * `Money.allocate` distributes the remainder by the largest-remainder method,
 * so `allocate(x, [a, b])[0] + allocate(x, [a, b])[1] === x` always. Taking the
 * whole of `total` therefore returns the whole of `amount` with no residue,
 * which is what makes the conservation property hold across a chain of partial
 * disposals.
 */
function proRata(amount: MoneyType, taken: QuantityType, total: QuantityType): MoneyType {
  const takenWeight = quantityWeight(taken);
  const totalWeight = quantityWeight(total);
  if (totalWeight <= 0n || takenWeight >= totalWeight) return amount;
  const [share] = Money.allocate(amount, [takenWeight, totalWeight - takenWeight]);
  return share ?? Money.zero(amount.currency);
}

/** `Money.allocate`, tolerant of an all-zero weight vector (nothing matched). */
function splitAcross(amount: MoneyType, weights: readonly bigint[]): readonly MoneyType[] {
  if (weights.length === 0) return [];
  if (weights.every((weight) => weight === 0n)) {
    return weights.map(() => Money.zero(amount.currency));
  }
  return Money.allocate(amount, weights);
}

type PooledBasis = { readonly basis: MoneyType; readonly quantity: QuantityType } | 'unavailable';

/**
 * The AVERAGE_COST pool: every open lot's remaining basis over every open lot's
 * remaining quantity.
 *
 * `unavailable` as soon as one lot has no basis — an average over a pool with a
 * hole in it is not an average, it is the known part of the pool quietly
 * relabelled as all of it.
 */
function pooledBasisOf(lots: readonly Lot[], currency: CurrencyCode): PooledBasis {
  let basis = Money.zero(currency);
  let quantity = Quantity.zero;
  for (const lot of lots) {
    const remaining = remainingBasisOf(lot);
    if (remaining === null) return 'unavailable';
    basis = Money.add(basis, remaining);
    quantity = Quantity.add(quantity, lot.quantityRemaining);
  }
  return { basis, quantity };
}

export interface RealizedGainContext {
  readonly proceeds: MoneyType;
  readonly fees: MoneyType;
  /** True when part of the disposal had no lot at all. */
  readonly unmatched: boolean;
}

/**
 * Sum matches into a short-term and a long-term figure.
 *
 * A term whose matches include *any* unknown basis is `unavailable`. Not
 * "available, minus the unknown part" — that is a smaller number that looks
 * like a complete one, and it is the specific failure 04 §5.5 names. An
 * unmatched remainder poisons **both** terms, because nothing is known about
 * when the missing lot was opened.
 */
export function realizedGainOf(
  matches: readonly LotMatch[],
  context: RealizedGainContext,
): RealizedGain {
  const currency = context.proceeds.currency;
  const build = (term: Term): RealizedAmount => {
    const forTerm = matches.filter((match) => match.term === term);
    const unknown = forTerm.filter((match) => match.gain === null).map((match) => match.lotId);
    if (unknown.length > 0 || context.unmatched) {
      return { status: 'unavailable', lotIds: unknown };
    }
    return {
      status: 'available',
      amount: Money.sum(
        forTerm.map((match) => match.gain as MoneyType),
        currency,
      ),
    };
  };
  return {
    shortTerm: build('SHORT_TERM'),
    longTerm: build('LONG_TERM'),
    proceeds: context.proceeds,
    fees: context.fees,
    currency,
  };
}

/**
 * Carry lots from one account to another without realising anything.
 *
 * 07 §6.2: "Self-transfers are not taxable but must carry lots (with original
 * `acquired_at` and basis) to the destination wallet. This is the single most
 * common source of wrong crypto tax numbers."
 *
 * So this is deliberately *not* `matchDisposal` followed by `openLot`: that
 * pair would compute a gain against a transfer's notional proceeds and restart
 * the holding period, which is exactly the wrong answer twice. The lot keeps
 * its `openDate`, its `holdingPeriodStartDate`, its `basis`, its
 * `basisConsumed`, its `basisSource` and its `washSaleAdjustment`; the only
 * things that change are the account and the id.
 *
 * `newLotId` mints the destination id, passed in rather than generated so this
 * file stays pure and a test can make the mapping legible.
 */
export function carryLotsOnTransfer(
  lots: readonly Lot[],
  options: {
    readonly fromAccountId: string;
    readonly toAccountId: string;
    readonly securityId: string;
    readonly newLotId: (source: Lot) => string;
  },
): { readonly lots: readonly Lot[]; readonly carried: readonly Lot[] } {
  const carried: Lot[] = [];
  const next: Lot[] = [];
  for (const lot of lots) {
    const moves =
      lot.accountId === options.fromAccountId &&
      lot.securityId === options.securityId &&
      isOpen(lot);
    if (!moves) {
      next.push(lot);
      continue;
    }
    const moved: Lot = {
      ...lot,
      id: options.newLotId(lot),
      accountId: options.toAccountId,
      // The quantity that moves is what is left; what was already disposed of
      // stays disposed of in the source account's history.
      quantity: lot.quantityRemaining,
      quantityRemaining: lot.quantityRemaining,
      basis: remainingBasisOf(lot),
      basisConsumed: Money.zero(lot.currency),
      acquisitionType: lot.acquisitionType,
    };
    carried.push(moved);
    next.push({ ...lot, quantityRemaining: Quantity.zero });
  }
  // The emptied source lots stay in the list rather than being filtered out:
  // a caller persists what this returns, and dropping them would leave the
  // source account still holding a quantity that has moved.
  return { lots: [...next, ...carried], carried };
}
