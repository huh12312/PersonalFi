// SPDX-License-Identifier: MIT
/**
 * The consumer: a sync landed, so re-derive holdings and lots for what it
 * touched.
 *
 * Contexts write events and never call each other, so this is how the lot
 * engine learns that a connector ran. The pump delivers each event once, in
 * order, inside its own transaction, with a replay button.
 *
 * ## The port, and why the facts are not in the payload
 *
 * `connections.SyncRunCompleted` carries counts, not rows — the payload
 * discipline every context here follows. So the consumer asks an
 * `InvestmentSyncPort` for the run's `ProviderHoldingFact`s and
 * `ProviderInvestmentTransactionFact`s, **through the `@connector/port`
 * types**, and `apps/api/src/domain.ts` supplies the adapter. Two reasons that
 * is a port rather than an import:
 *
 *   1. `personalfi/layer-imports` forbids one context importing another, and
 *      the facts live behind `@ctx/connections`;
 *   2. it is the seam the R6 verdict needs. The same port serves an exact
 *      `BROKER` leg from Coinbase v3 *and* an `IMPORTED` CSV leg for the
 *      deposits, staking rewards and transfers v3 does not report, without the
 *      engine knowing which of the two it is looking at.
 *
 * ## Idempotence
 *
 * `runLotSync` is a deterministic function of the facts and current state:
 *
 *   * `investment_transactions` is upserted on the provider natural key, so a
 *     re-fetched date window (there is no cursor — 01 §5.5) writes the same
 *     rows;
 *   * a lot's id is **derived from the transaction that opened it**, not
 *     minted, so re-processing the same transaction updates the same lot rather
 *     than opening a second one;
 *   * lots are rebuilt from the full transaction history for each touched
 *     (account, security) pair and written with `onConflictDoUpdate`, so the
 *     second pass produces identical rows.
 *
 * Delivering the event twice therefore produces the same rows and appends no
 * second event — `test/db/consumer.test.ts` asserts exactly that, comparing
 * whole rows and the `domain_events` count.
 *
 * "Appends no second event" is not free: every emit site compares the state it
 * computed against the state that was already stored and stays silent when
 * they match (`lotsAreUnchanged`, and `upsertHolding`'s `changed` flag, which
 * Postgres answers with an `IS DISTINCT FROM` guard on the `DO UPDATE`). The
 * one deliberate exception is a Rev. Rul. 2008-5 wash sale, which adjusts no
 * lot and therefore leaves no state to remember it by; it is re-announced, and
 * the reason is written at the emit site.
 *
 * ## Failure posture
 *
 * The handler runs inside the pump's transaction: a throw rolls back the
 * derivation *and* the offset, and the event is retried with backoff. Nothing
 * here catches. A run that touched no investment account returns early and
 * advances the offset — that is not a failure, it is a checking account.
 */
import {
  DateOnly,
  Money,
  Quantity,
  newId,
  type Clock,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
} from '@core/kernel';
import type { ProviderHoldingFact, ProviderInvestmentTransactionFact } from '@connector/port';
import {
  appendEvent,
  registerConsumer,
  type ConsumerContext,
  type EventEnvelope,
  type Executor,
  type RegisteredConsumer,
} from '@core/platform';
import {
  HoldingsUpdated,
  LotsUpdated,
  PossibleWashSaleFlagged,
  RealizedGainRecorded,
} from './events.ts';
import {
  absoluteQuantity,
  basisForAcquisition,
  basisSourceFor,
  holdingOf,
  investmentTransactionOf,
  lotEffectOf,
  acquisitionTypeOf,
  warningForEstimatedBasis,
  type InvestmentTransaction,
  type UnresolvedSecurityLabel,
} from './holdings.ts';
import {
  carryLotsOnTransfer,
  matchDisposal,
  openLot,
  type DisposalResult,
  type Lot,
} from './lots.ts';
import type { LotStore, UnresolvedHolding } from './lots-store.ts';
import {
  applyWashSales,
  scanForPossibleWashSales,
  type AcquisitionForScan,
  type DisposalForScan,
  type PossibleWashSale,
  type WashSaleConfig,
} from './wash-sale.ts';

/**
 * The event types this consumer wants.
 *
 * Strings rather than imports: an event type is a wire contract, like a URL,
 * and duplicating it is the honest cost of the decoupling the outbox provides.
 */
export const CONSUMED_EVENT_TYPES = ['connections.SyncRunCompleted'] as const;

/**
 * The consumer name carries a version by convention. Changing what the lot
 * engine concludes means bumping it and replaying from 0, which rebuilds every
 * lot from the transaction history — which is the whole reason lots are derived
 * rather than stored as provider assertions.
 */
export const CONSUMER_NAME = 'investments.lots@v1';

/**
 * How this context reads a sync run's investment facts: a port, not an import.
 *
 * Read-only. This context writes its own five tables and never touches
 * `@ctx/connections`'.
 */
export interface InvestmentSyncPort {
  /**
   * The facts one run produced, already resolved to `security_id` by WP 3.1's
   * `SecurityResolver`. A position the resolver abstained on is **absent**, not
   * present with a null security: 07's rule is that an unresolved thing fails
   * loudly rather than minting a row, and `SecurityResolutionFailed` is the
   * record that it existed.
   */
  factsForRun(
    userId: string,
    syncRunId: string,
  ): Promise<{
    readonly provider: string;
    readonly asOfDate: DateOnlyType;
    readonly holdings: readonly ResolvedHoldingFact[];
    readonly transactions: readonly ResolvedTransactionFact[];
    /**
     * WP 10.4. The positions this run reported that the resolver abstained on,
     * with the account they are in and why. Optional so a port that predates
     * it still type-checks; when it is present, the consumer replaces each
     * reported account's `unresolved_holdings` with exactly these.
     */
    readonly unresolvedHoldings?: readonly UnresolvedHoldingFact[];
  }>;
  /** True when the account is tax-advantaged — Rev. Rul. 2008-5's IRA case. */
  isRetirementAccount(accountId: string): Promise<boolean>;
  /** True when the security is a digital asset, for the dated wash-sale flag. */
  isDigitalAsset(securityId: string): Promise<boolean>;
}

export interface ResolvedHoldingFact {
  readonly fact: ProviderHoldingFact;
  readonly accountId: string;
  readonly securityId: string;
}

/**
 * WP 10.4. A position the resolver could not identify: the provider's fact, the
 * ledger account it is in, and every tier's abstention. Never a holding.
 */
export interface UnresolvedHoldingFact {
  readonly fact: ProviderHoldingFact;
  readonly accountId: string;
  readonly abstentions: readonly {
    readonly tier: string;
    readonly reason: string;
    readonly detail: string | null;
  }[];
}

export interface ResolvedTransactionFact {
  readonly fact: ProviderInvestmentTransactionFact;
  readonly accountId: string;
  readonly securityId: string | null;
  /**
   * WP 10.4. Present when the fact named a security the resolver could not
   * identify; `securityId` is then `null`. The movement is stored (Activity
   * lists it under this name) and excluded from lots and performance.
   */
  readonly unresolved?: UnresolvedSecurityLabel | null;
  /** `BROKER` for an exact provider leg, `IMPORTED` for a CSV one. */
  readonly source: 'BROKER' | 'IMPORTED' | 'USER';
}

export interface LotSyncDependencies {
  readonly store: LotStore;
  readonly port: InvestmentSyncPort;
  readonly clock: Clock;
  readonly outbox: Executor;
  readonly washSaleConfig?: WashSaleConfig;
  /** Minor-unit scale for the account currency. Defaults to 2. */
  readonly minorScale?: number;
}

export interface LotSyncInput {
  readonly userId: string;
  readonly syncRunId: string;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface LotSyncResult {
  readonly holdingsTouched: number;
  readonly lotsOpened: readonly string[];
  readonly lotsClosed: readonly string[];
  readonly washSales: readonly PossibleWashSale[];
  readonly realized: readonly DisposalResult[];
}

/**
 * A lot's id is a function of the transaction that opened it.
 *
 * Not `newId()`. A minted id would make re-processing the same transaction open
 * a second lot, which is the failure mode "idempotent" exists to prevent and
 * the one that is hardest to notice — the quantities double and every downstream
 * number is exactly twice what it should be, which looks like a different bug.
 *
 * UUIDv5 over the transaction id is not available here without a dependency, so
 * the store keys on `opened_by_transaction_id` and this function returns the
 * existing lot's id when one is found; `newId()` is reached only for a
 * genuinely new lot.
 */
function lotIdFor(existing: readonly Lot[], transactionId: string): string {
  return existing.find((lot) => lot.openedByTransactionId === transactionId)?.id ?? newId();
}

/**
 * Re-derive holdings and lots for one sync run.
 *
 * The order is deliberate: transactions first (they are the evidence lots are
 * built from), then lots, then the wash-sale scan — which runs **across every
 * account**, after the lots exist, because a replacement in another account
 * cannot be seen from inside the account that sold.
 */
export async function runLotSync(
  dependencies: LotSyncDependencies,
  input: LotSyncInput,
): Promise<LotSyncResult> {
  const { store, port, clock, outbox } = dependencies;
  const scale = dependencies.minorScale ?? 2;
  const facts = await port.factsForRun(input.userId, input.syncRunId);

  const context = {
    userId: input.userId,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
  };

  // ---- 1. the transaction ledger ----------------------------------------
  const stored: InvestmentTransaction[] = [];
  for (const resolved of facts.transactions) {
    const transaction = investmentTransactionOf(resolved.fact, {
      id: newId(),
      accountId: resolved.accountId,
      securityId: resolved.securityId,
      provider: facts.provider,
      source: resolved.source,
      unresolved: resolved.unresolved ?? null,
    });
    const { id } = await store.upsertInvestmentTransaction(input.userId, transaction);
    stored.push({ ...transaction, id });
  }

  // ---- 2. self-transfers, before anything else --------------------------
  //
  // 07 §6.2: an outbound on wallet A and an inbound on wallet B, same asset,
  // inside 24h, quantity within the network fee, is *one* movement and not two.
  // It must be matched **first**, because processing either half on its own
  // produces exactly the two wrong answers that section names — the source
  // looks like a disposal, and the destination like an acquisition whose basis
  // nobody knows.
  const carried = await carrySelfTransfers(dependencies, input.userId, stored);

  // ---- 3. lots, per (account, security) ---------------------------------
  const scopes = new Map<string, { accountId: string; securityId: string }>();
  for (const transaction of stored) {
    if (transaction.securityId === null) continue;
    if (carried.has(transaction.id)) continue;
    if (lotEffectOf(transaction.type) === 'NONE') continue;
    scopes.set(`${transaction.accountId}${transaction.securityId}`, {
      accountId: transaction.accountId,
      securityId: transaction.securityId,
    });
  }

  const lotsOpened: string[] = [];
  const lotsClosed: string[] = [];
  const realized: DisposalResult[] = [];
  const acquisitions: AcquisitionForScan[] = [];
  const disposals: DisposalForScan[] = [];
  const soldHoldingPeriodStart = new Map<string, DateOnlyType>();

  for (const scope of scopes.values()) {
    const existing = await store.listOpenLots(input.userId, scope.accountId, scope.securityId);
    let lots: readonly Lot[] = existing;
    const method = await store.basisMethodFor(input.userId, scope.accountId, scope.securityId);

    // Events this scope wants to emit, held back until we know the scope
    // actually changed. A re-delivered sync run recomputes the same lots from
    // the same stored transactions, so nothing changes and nothing is
    // announced — see this file's "Idempotence" header.
    const pendingScopeEvents: Parameters<typeof appendEvent>[1][] = [];

    const ordered = stored
      .filter(
        (transaction) =>
          transaction.accountId === scope.accountId && transaction.securityId === scope.securityId,
      )
      .sort((a, b) => DateOnly.compare(a.tradeDate, b.tradeDate));

    for (const transaction of ordered) {
      const effect = lotEffectOf(transaction.type);
      const quantity = absoluteQuantity(transaction.quantity);
      if (Quantity.compare(quantity, Quantity.zero) <= 0) continue;

      if (effect === 'OPEN' || effect === 'CARRY_IN') {
        const acquisitionType = acquisitionTypeOf(transaction.type);
        if (acquisitionType === null) continue;
        const basis = basisForAcquisition(transaction, scale);
        const id = lotIdFor(lots, transaction.id);
        const { lot } = openLot({
          id,
          accountId: scope.accountId,
          securityId: scope.securityId,
          openDate: transaction.tradeDate,
          quantity,
          basis,
          currency: transaction.amount.currency,
          basisSource: basisSourceFor(transaction.source, basis),
          acquisitionType,
          basisWarning: basis === null ? warningForEstimatedBasis(transaction) : null,
          openedByTransactionId: transaction.id,
        });
        lots = [...lots.filter((existingLot) => existingLot.id !== id), lot];
        lotsOpened.push(id);
        acquisitions.push({
          lotId: id,
          accountId: scope.accountId,
          securityId: scope.securityId,
          openDate: transaction.tradeDate,
          quantity,
          isRetirementAccount: await port.isRetirementAccount(scope.accountId),
        });
        continue;
      }

      if (effect === 'CLOSE' || effect === 'CARRY_OUT') {
        // A transfer out is *not* a disposal. It leaves the account carrying
        // its lots; the destination's TRANSFER_IN is the other half, and
        // `carryLotsOnTransfer` is what moves the basis and the holding period.
        // Realising a gain here is 07 §6.2's "single most common source of
        // wrong crypto tax numbers", so the branch is explicit.
        if (effect === 'CARRY_OUT') continue;

        const result = matchDisposal(lots, {
          accountId: scope.accountId,
          securityId: scope.securityId,
          date: transaction.tradeDate,
          quantity,
          proceeds: Money.absolute(transaction.amount),
          fees: transaction.fees,
          method,
        });
        lots = result.lots;
        realized.push(result);
        for (const match of result.matches) {
          if (
            Quantity.compare(
              lots.find((lot) => lot.id === match.lotId)?.quantityRemaining ?? Quantity.zero,
              Quantity.zero,
            ) === 0
          ) {
            lotsClosed.push(match.lotId);
          }
        }
        const shortTermGain = totalGainOf(result);
        disposals.push({
          id: transaction.id,
          accountId: scope.accountId,
          securityId: scope.securityId,
          date: transaction.tradeDate,
          quantity,
          gain: shortTermGain,
        });
        const earliest = result.matches
          .map((match) => match.holdingPeriodStartDate)
          .sort((a, b) => DateOnly.compare(a, b))[0];
        if (earliest !== undefined) soldHoldingPeriodStart.set(transaction.id, earliest);

        pendingScopeEvents.push(
          RealizedGainRecorded.create(
            {
              accountId: scope.accountId,
              securityId: scope.securityId,
              transactionId: transaction.id,
              disposalDate: transaction.tradeDate,
              method,
              matchedLotIds: result.matches.map((match) => match.lotId),
              currency: result.realized.currency,
              shortTermStatus: result.realized.shortTerm.status,
              shortTermMinor:
                result.realized.shortTerm.status === 'available'
                  ? result.realized.shortTerm.amount.minor.toString()
                  : null,
              longTermStatus: result.realized.longTerm.status,
              longTermMinor:
                result.realized.longTerm.status === 'available'
                  ? result.realized.longTerm.amount.minor.toString()
                  : null,
              proceedsMinor: result.realized.proceeds.minor.toString(),
              feesMinor: result.realized.fees.minor.toString(),
            },
            context,
            clock,
          ),
        );
      }
    }

    // The whole point of the comparison: a re-delivered run recomputes the
    // identical lots, so it writes nothing and says nothing. Without this, a
    // Plaid account that re-fetches the same date window every night would
    // wake every downstream consumer every night with "your lots changed".
    if (lotsAreUnchanged(existing, lots)) continue;

    await store.saveLots(input.userId, lots);
    for (const event of pendingScopeEvents) {
      await appendEvent(outbox, event);
    }
    await appendEvent(
      outbox,
      LotsUpdated.create(
        {
          accountId: scope.accountId,
          securityId: scope.securityId,
          openedLotIds: lotsOpened.filter((id) => lots.some((lot) => lot.id === id)),
          closedLotIds: lotsClosed,
          adjustedLotIds: [],
          estimatedBasisCount: lots.filter((lot) => lot.basisSource === 'ESTIMATED').length,
        },
        context,
        clock,
      ),
    );
  }

  // ---- 4. the wash-sale scan, across every account -----------------------
  const digitalAssets = new Map<string, boolean>();
  for (const disposal of disposals) {
    if (!digitalAssets.has(disposal.securityId)) {
      digitalAssets.set(disposal.securityId, await port.isDigitalAsset(disposal.securityId));
    }
  }
  const washSales = scanForPossibleWashSales({
    disposals,
    // Every lot in the security, in every account — not just the ones this run
    // opened. 07 §4.4's trap.
    acquisitions: await allAcquisitionsFor(dependencies, input.userId, disposals, acquisitions),
    soldHoldingPeriodStart,
    // Spread conditionally rather than passing `config: dependencies.washSaleConfig`:
    // under `exactOptionalPropertyTypes` an explicit `undefined` is not an absent
    // optional, and absent is what makes `scanForPossibleWashSales` fall back to
    // `DEFAULT_WASH_SALE_CONFIG` by its own documented rule rather than by ours.
    ...(dependencies.washSaleConfig === undefined ? {} : { config: dependencies.washSaleConfig }),
    isDigitalAsset: (securityId) => digitalAssets.get(securityId) === true,
  });

  // Grouped by security and applied **all at once**, not one flag at a time:
  // `applyWashSales` sets each named lot's adjustment to the total of the flags
  // it is named in, so feeding it one flag per call would make the last flag
  // win and lose the rest. Loading the security's lots once is also one query
  // instead of one per flag.
  const washSalesBySecurity = new Map<string, PossibleWashSale[]>();
  for (const flag of washSales) {
    const existing = washSalesBySecurity.get(flag.securityId);
    if (existing === undefined) washSalesBySecurity.set(flag.securityId, [flag]);
    else existing.push(flag);
  }

  // Which replacement lots this run actually moved. On a re-delivered run the
  // adjustment is already in place, `applyWashSales` is a no-op by
  // construction, this set is empty and no event is appended — which is the
  // idempotence promise at the top of this file.
  const newlyAdjustedLotIds = new Set<string>();
  for (const [securityId, flagsForSecurity] of washSalesBySecurity) {
    const affected = await dependencies.store.listLotsForSecurity(input.userId, securityId);
    const adjusted = applyWashSales(affected, flagsForSecurity);
    const before = new Map(affected.map((lot) => [lot.id, lotFingerprint(lot)]));
    for (const lot of adjusted) {
      if (before.get(lot.id) !== lotFingerprint(lot)) newlyAdjustedLotIds.add(lot.id);
    }
    if (newlyAdjustedLotIds.size > 0) {
      await dependencies.store.saveLots(input.userId, adjusted);
    }
  }

  for (const flag of washSales) {
    // A Rev. Rul. 2008-5 flag adjusts no lot — the loss is permanently lost
    // rather than deferred — so there is no lot state that could record "this
    // was already announced", and it is re-announced on every run. That is the
    // deliberate trade: the outbox is at-least-once and every consumer is
    // obliged to be idempotent, and the alternative is never telling the user
    // about the one wash sale that actually costs them the whole deduction.
    if (!newlyAdjustedLotIds.has(flag.replacementLotId) && !flag.basisAdjustmentIsPermanentlyLost) {
      continue;
    }
    await appendEvent(
      outbox,
      PossibleWashSaleFlagged.create(
        {
          label: flag.label,
          securityId: flag.securityId,
          disposalAccountId: flag.disposalAccountId,
          replacementAccountId: flag.replacementAccountId,
          replacementLotId: flag.replacementLotId,
          saleDate: flag.saleDate,
          replacementDate: flag.replacementDate,
          offsetDays: flag.offsetDays,
          disallowedLossMinor: flag.disallowedLoss.minor.toString(),
          currency: flag.disallowedLoss.currency,
          tackedHoldingPeriodStartDate: flag.tackedHoldingPeriodStartDate,
          basisAdjustmentIsPermanentlyLost: flag.basisAdjustmentIsPermanentlyLost,
        },
        context,
        clock,
      ),
    );
  }

  // ---- 5. the positions themselves --------------------------------------
  const byAccount = new Map<
    string,
    { securityIds: string[]; unavailable: number; changed: boolean }
  >();
  for (const resolved of facts.holdings) {
    const holding = holdingOf(resolved.fact, {
      accountId: resolved.accountId,
      securityId: resolved.securityId,
      asOfDate: facts.asOfDate,
    });
    const { changed } = await store.upsertHolding(input.userId, holding, { id: newId() });
    // The snapshot is written either way: it is one row per calendar day and
    // re-writing today's identical row is what makes a mid-day re-sync a
    // revision rather than a duplicate.
    await store.recordHoldingSnapshot(input.userId, holding);
    const entry = byAccount.get(resolved.accountId) ?? {
      securityIds: [],
      unavailable: 0,
      changed: false,
    };
    entry.securityIds.push(resolved.securityId);
    if (holding.costBasis === null) entry.unavailable += 1;
    entry.changed ||= changed;
    byAccount.set(resolved.accountId, entry);
  }

  // ---- 6. the positions nobody could identify (WP 10.4) ----------------
  //
  // Replaced per (account, provider) for every account this run reported
  // holdings for — resolved or not — so a security that resolved this time is
  // simply not re-inserted, and that is what clears its row. An account whose
  // positions all resolved gets an empty replacement. A port that does not
  // report unresolved positions (`undefined`) leaves the table alone rather
  // than wiping it on the strength of an answer it never gave.
  if (facts.unresolvedHoldings !== undefined) {
    const reported = new Set<string>([
      ...facts.holdings.map((holding) => holding.accountId),
      ...facts.unresolvedHoldings.map((holding) => holding.accountId),
    ]);
    const observedAt = clock.now();
    for (const accountId of reported) {
      await store.replaceUnresolvedHoldings(
        input.userId,
        { accountId, provider: facts.provider },
        facts.unresolvedHoldings
          .filter((holding) => holding.accountId === accountId)
          .map((holding) =>
            unresolvedHoldingOf(holding, facts.provider, facts.asOfDate, {
              syncRunId: input.syncRunId,
              observedAt,
            }),
          ),
      );
    }
  }

  for (const [accountId, entry] of byAccount) {
    // Nothing in this account's positions moved, so there is nothing to say.
    if (!entry.changed) continue;
    await appendEvent(
      outbox,
      HoldingsUpdated.create(
        {
          accountId,
          securityIds: entry.securityIds,
          addedCount: entry.securityIds.length,
          updatedCount: 0,
          costBasisUnavailableCount: entry.unavailable,
          asOfDate: facts.asOfDate,
        },
        context,
        clock,
      ),
    );
  }

  return {
    holdingsTouched: facts.holdings.length,
    lotsOpened,
    lotsClosed,
    washSales,
    realized,
  };
}

/**
 * A provider's holding fact, as the row `unresolved_holdings` keeps: the
 * provider's own names, the quantity, and the institution's own value labelled
 * as such. A ticker is the first `ticker` identifier the provider gave.
 */
function unresolvedHoldingOf(
  holding: UnresolvedHoldingFact,
  provider: string,
  asOfDate: DateOnlyType,
  run: { readonly syncRunId: string; readonly observedAt: Date },
): UnresolvedHolding {
  const security = holding.fact.security;
  const ticker =
    security.identifiers.find((identifier) => identifier.kind === 'ticker')?.value ?? null;
  const quantityText = holding.fact.quantity.trim();
  return {
    accountId: holding.accountId,
    provider,
    providerSecurityId: security.providerSecurityId ?? null,
    name: security.name ?? null,
    ticker,
    quantity: Quantity.of(quantityText === '' ? '0' : quantityText),
    institutionValue: holding.fact.value,
    currency: holding.fact.value?.currency ?? security.currency ?? 'USD',
    abstentions: holding.abstentions.map((entry) => ({
      tier: entry.tier,
      reason: entry.reason,
      detail: entry.detail,
    })),
    syncRunId: run.syncRunId,
    asOfDate,
    observedAt: run.observedAt,
  };
}

/** 07 §6.2's matching window for the two halves of one self-transfer. */
export const SELF_TRANSFER_WINDOW_DAYS = 1;

/**
 * Pair `TRANSFER_OUT`/`TRANSFER_IN` halves and carry the lots between them.
 *
 * Returns the ids of every transaction that was consumed as half of a pair, so
 * the main loop skips them — an unpaired transfer still falls through to the
 * ordinary path, where a `TRANSFER_OUT` closes nothing and a `TRANSFER_IN`
 * opens a lot whose basis is `ESTIMATED` with a warning. That fallback is the
 * honest one: an inbound with no matching outbound genuinely *is* an
 * acquisition we cannot price.
 *
 * Nothing is realised on a carry. `carryLotsOnTransfer` keeps `openDate`,
 * `holdingPeriodStartDate`, `basis`, `basisSource` and `washSaleAdjustment`, so
 * a coin bought two years ago and moved to a new wallet yesterday is still
 * long-term and still has its original basis — which is precisely what 07 §6.2
 * says most software gets wrong.
 */
async function carrySelfTransfers(
  dependencies: LotSyncDependencies,
  userId: string,
  transactions: readonly InvestmentTransaction[],
): Promise<ReadonlySet<string>> {
  const consumed = new Set<string>();
  const outbound = transactions.filter((transaction) => transaction.type === 'TRANSFER_OUT');
  const inbound = transactions.filter((transaction) => transaction.type === 'TRANSFER_IN');

  for (const out of outbound) {
    if (out.securityId === null) continue;
    const match = inbound.find(
      (candidate) =>
        !consumed.has(candidate.id) &&
        candidate.securityId === out.securityId &&
        candidate.accountId !== out.accountId &&
        Math.abs(DateOnly.differenceInDays(out.tradeDate, candidate.tradeDate)) <=
          SELF_TRANSFER_WINDOW_DAYS,
    );
    if (match === undefined) continue;

    const sourceLots = await dependencies.store.listOpenLots(userId, out.accountId, out.securityId);
    const { lots } = carryLotsOnTransfer(sourceLots, {
      fromAccountId: out.accountId,
      toAccountId: match.accountId,
      securityId: out.securityId,
      newLotId: () => newId(),
    });
    await dependencies.store.saveLots(userId, lots);
    consumed.add(out.id);
    consumed.add(match.id);
  }
  return consumed;
}

/**
 * Every acquisition that could be a replacement: this run's, plus every open
 * lot in the same security in **any** account.
 *
 * The union matters. A loss sold today is most often replaced by a purchase
 * made *before* it — a dividend reinvestment inside the 30 days before the sale
 * is the textbook accidental wash sale — and that lot was opened by an earlier
 * run, so this run's acquisitions alone would miss it.
 */
async function allAcquisitionsFor(
  dependencies: LotSyncDependencies,
  userId: string,
  disposals: readonly DisposalForScan[],
  fromThisRun: readonly AcquisitionForScan[],
): Promise<readonly AcquisitionForScan[]> {
  const securityIds = new Set(disposals.map((disposal) => disposal.securityId));
  const seen = new Set(fromThisRun.map((acquisition) => acquisition.lotId));
  const all: AcquisitionForScan[] = [...fromThisRun];
  for (const securityId of securityIds) {
    for (const lot of await dependencies.store.listLotsForSecurity(userId, securityId)) {
      if (seen.has(lot.id)) continue;
      seen.add(lot.id);
      all.push({
        lotId: lot.id,
        accountId: lot.accountId,
        securityId: lot.securityId,
        openDate: lot.openDate,
        quantity: lot.quantity,
        isRetirementAccount: await dependencies.port.isRetirementAccount(lot.accountId),
      });
    }
  }
  return all;
}

/**
 * The realised gain of a disposal as one number, or `null`.
 *
 * `null` when either term is `unavailable`, because the wash-sale scan asks
 * "was this a loss?" and the honest answer for a disposal with an unknown basis
 * is "we cannot say" — not "no". A `false` there would silently suppress a
 * warning the user is entitled to.
 */
/**
 * A lot's whole state as one comparable string.
 *
 * Used to answer "did this run change anything?" without a deep-equality
 * helper and without comparing object identity, which would always say yes
 * because every pass rebuilds the objects. Every field the engine can move is
 * in here; the ones it cannot (account, security, currency, source) are not,
 * because a change in those would be a different lot.
 */
function lotFingerprint(lot: Lot): string {
  return [
    lot.id,
    Quantity.toDatabaseString(lot.quantity),
    Quantity.toDatabaseString(lot.quantityRemaining),
    lot.basis === null ? 'null' : lot.basis.minor.toString(),
    lot.basisConsumed.minor.toString(),
    lot.openDate,
    lot.holdingPeriodStartDate,
    lot.basisSource,
    lot.acquisitionType,
    lot.washSaleAdjustment.minor.toString(),
  ].join('|');
}

/** Whether two sets of lots are the same lots in the same state, order-independently. */
function lotsAreUnchanged(before: readonly Lot[], after: readonly Lot[]): boolean {
  if (before.length !== after.length) return false;
  const left = before.map(lotFingerprint).sort();
  const right = after.map(lotFingerprint).sort();
  return left.every((value, index) => value === right[index]);
}

function totalGainOf(result: DisposalResult): MoneyType | null {
  const { shortTerm, longTerm, currency } = result.realized;
  if (shortTerm.status !== 'available' || longTerm.status !== 'available') return null;
  return Money.add(Money.add(Money.zero(currency), shortTerm.amount), longTerm.amount);
}

export interface LotConsumerOptions {
  readonly washSaleConfig?: WashSaleConfig;
  readonly minorScale?: number;
}

/**
 * Wire the consumer.
 *
 * `database` is not a parameter: the store and the outbox both have to be built
 * over the pump's *transaction*, or a `LotsUpdated` survives a rolled-back
 * derivation. `storeFor` is therefore a factory the composition root supplies,
 * the same shape `securityResolverFor` takes in `apps/api/src/domain.ts`.
 */
export function createLotConsumer(dependencies: {
  readonly storeFor: (context: ConsumerContext) => LotStore;
  readonly outboxFor: (context: ConsumerContext) => Executor;
  readonly port: InvestmentSyncPort;
  readonly clock: Clock;
  readonly options?: LotConsumerOptions;
}): RegisteredConsumer {
  return registerConsumer(
    CONSUMER_NAME,
    async (event: EventEnvelope, context: ConsumerContext) => {
      const payload = event.payload as { syncRunId?: string; status?: string };
      // A failed run produced no facts. Advancing the offset is correct: the
      // failure is `@ctx/connections`' to report, and re-deriving nothing on
      // every retry would be work with no output.
      if (payload.status !== 'success' || payload.syncRunId === undefined) return;
      await runLotSync(
        {
          store: dependencies.storeFor(context),
          port: dependencies.port,
          clock: dependencies.clock,
          outbox: dependencies.outboxFor(context),
          // Conditional spreads, not `?.` reads: `exactOptionalPropertyTypes`
          // distinguishes an absent option from one explicitly set to
          // `undefined`, and `runLotSync` owns both defaults (FIFO-side wash
          // config, minor scale 2).
          ...(dependencies.options?.washSaleConfig === undefined
            ? {}
            : { washSaleConfig: dependencies.options.washSaleConfig }),
          ...(dependencies.options?.minorScale === undefined
            ? {}
            : { minorScale: dependencies.options.minorScale }),
        },
        {
          userId: event.userId,
          syncRunId: payload.syncRunId,
          correlationId: event.correlationId,
          causationId: event.id,
        },
      );
    },
    { filter: [...CONSUMED_EVENT_TYPES] },
  );
}
