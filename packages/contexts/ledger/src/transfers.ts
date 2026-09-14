// SPDX-License-Identifier: MIT
/**
 * Internal transfer pairing.
 *
 * Money moving between two accounts you own is double-counted by construction
 * when both are linked: once as an outflow, once as an inflow. "Spend totals
 * contain zero internal transfers" is a Phase 1 exit criterion, and a paired
 * `transfer_links` row is how a downstream context knows to drop both legs.
 *
 * The matching is split in two on purpose:
 *
 *   * `proposeTransferPairs` is **pure** — legs in, proposals out, no database,
 *     no clock. That is what makes the invariants (one leg to at most one pair,
 *     never two legs on one account, never a rejected pair, symmetry under input
 *     order) property-testable over thousands of generated ledgers rather than
 *     over the four cases someone thought to write down;
 *   * `pairTransfers` does the I/O around it and appends the event.
 *
 * The evidence for a match — day gap, confidence, how it matched — is persisted
 * beside the link, because "why did you decide these two rows were one movement?"
 * is a product requirement and not a debugging nicety. A user who cannot see the
 * reason cannot correct it, and a heuristic nobody can correct is one users learn
 * to distrust wholesale.
 */
import { DateOnly, newId, type Money as MoneyType } from '@core/kernel';
import { appendEvent } from '@core/platform';
import { and, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  rejectedTransferPairs,
  transactions,
  transferLinks,
  type TransferMatchKind,
} from '../schema/index.ts';
import { moneyOf, outboxOf, type LedgerExecutor } from './db.ts';
import { LedgerError } from './errors.ts';
import { TransferPaired } from './events.ts';
import type { LedgerWriteContext } from './accounts.ts';

/** The slice of a transaction the pairing heuristic is allowed to see. */
export interface TransferLeg {
  readonly id: string;
  readonly accountId: string;
  readonly date: DateOnly;
  /** Signed, house convention: negative = outflow. */
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly name: string;
}

export interface TransferProposal {
  readonly outflowId: string;
  readonly inflowId: string;
  /** The magnitude moved, positive. */
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly dayGap: number;
  readonly confidence: number;
  readonly howMatched: TransferMatchKind;
}

export interface TransferPairingOptions {
  /** Two legs of one movement rarely land more than a few days apart. */
  readonly windowDays?: number;
  /** Absolute slack, for a wire fee shaved off the receiving side. */
  readonly toleranceMinor?: bigint;
  /** Proportional slack, for an FX or crypto conversion. 0.01 = 1%. */
  readonly tolerancePercent?: number;
  /** Below this, a proposal is not persisted. */
  readonly minConfidence?: number;
}

const DEFAULTS: Required<TransferPairingOptions> = Object.freeze({
  windowDays: 5,
  toleranceMinor: 0n,
  tolerancePercent: 0,
  minConfidence: 0.5,
});

/**
 * Words that make a descriptor look like a movement rather than a purchase.
 * A small confidence bonus, never a gate: plenty of real transfers are described
 * as nothing but the counterparty bank's name.
 */
const TRANSFER_WORDS = [
  'transfer',
  'xfer',
  'withdrawal',
  'deposit',
  'payment',
  'pmt',
  'ach',
  'wire',
  'autopay',
  'online banking',
];

/**
 * Propose pairings. Pure, deterministic, and total.
 *
 * The gates, each of which exists because dropping it produces a specific wrong
 * answer:
 *
 *   * **opposite sign** — two outflows are two expenses, not a movement;
 *   * **different accounts** — a refund is same-account and opposite-sign, and is
 *     emphatically not a transfer (that is `refunds.ts`);
 *   * **same currency** — pairing across currencies needs an FX rate as of the
 *     day, which this context does not have and must not guess;
 *   * **magnitudes equal within tolerance**, default exact;
 *   * **within `windowDays`**;
 *   * **neither leg already paired**, which the caller enforces by not passing
 *     paired legs, and the database enforces again with two unique indexes;
 *   * **not rejected** — a negative decision is data, and re-proposing a pair the
 *     user already dismissed is the single most annoying thing a finance app does.
 *
 * Resolution when several candidates compete is a greedy pass over proposals
 * sorted by confidence, then by day gap, then by id — deterministic, and biased
 * towards the most certain pair rather than the first one encountered.
 */
export function proposeTransferPairs(
  legs: readonly TransferLeg[],
  options: TransferPairingOptions & { rejected?: ReadonlySet<string> } = {},
): TransferProposal[] {
  const config = { ...DEFAULTS, ...options };
  const rejected = options.rejected ?? new Set<string>();

  const outflows = legs.filter((leg) => leg.amountMinor < 0n);
  const inflows = legs
    .filter((leg) => leg.amountMinor > 0n)
    .sort((a, b) => compareBigint(a.amountMinor, b.amountMinor) || compareString(a.id, b.id));
  const magnitudes = inflows.map((leg) => leg.amountMinor);

  const candidates: TransferProposal[] = [];
  for (const outflow of outflows) {
    const magnitude = -outflow.amountMinor;
    const slack = toleranceFor(magnitude, config);
    // The inflow list is sorted by magnitude, so the admissible band is a
    // contiguous slice: two binary searches instead of a scan per outflow.
    for (
      let index = lowerBound(magnitudes, magnitude - slack);
      index < inflows.length;
      index += 1
    ) {
      const inflow = inflows[index];
      if (inflow === undefined) break;
      if (inflow.amountMinor > magnitude + slack) break;
      if (inflow.accountId === outflow.accountId) continue;
      if (inflow.currency !== outflow.currency) continue;
      if (rejected.has(rejectionKey(outflow.id, inflow.id))) continue;
      const dayGap = Math.abs(DateOnly.differenceInDays(outflow.date, inflow.date));
      if (dayGap > config.windowDays) continue;

      const difference = abs(inflow.amountMinor - magnitude);
      const scored = score(difference, magnitude, dayGap, outflow, inflow, config);
      if (scored.confidence < config.minConfidence) continue;
      candidates.push({
        outflowId: outflow.id,
        inflowId: inflow.id,
        amountMinor: magnitude,
        currency: outflow.currency,
        dayGap,
        confidence: scored.confidence,
        howMatched: scored.howMatched,
      });
    }
  }

  candidates.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.dayGap - b.dayGap ||
      compareString(a.outflowId, b.outflowId) ||
      compareString(a.inflowId, b.inflowId),
  );

  const used = new Set<string>();
  const accepted: TransferProposal[] = [];
  for (const candidate of candidates) {
    if (used.has(candidate.outflowId) || used.has(candidate.inflowId)) continue;
    used.add(candidate.outflowId);
    used.add(candidate.inflowId);
    accepted.push(candidate);
  }
  return accepted;
}

function toleranceFor(magnitude: bigint, config: Required<TransferPairingOptions>): bigint {
  const proportional =
    config.tolerancePercent <= 0
      ? 0n
      : BigInt(Math.floor(Number(magnitude) * config.tolerancePercent));
  return config.toleranceMinor > proportional ? config.toleranceMinor : proportional;
}

function score(
  difference: bigint,
  magnitude: bigint,
  dayGap: number,
  outflow: TransferLeg,
  inflow: TransferLeg,
  config: Required<TransferPairingOptions>,
): { confidence: number; howMatched: TransferMatchKind } {
  const wordBonus = looksLikeTransfer(outflow.name) || looksLikeTransfer(inflow.name) ? 0.02 : 0;

  if (difference === 0n) {
    if (dayGap === 0) {
      return { confidence: clamp(0.98 + wordBonus), howMatched: 'exact_amount_same_day' };
    }
    const decay = 0.05 * dayGap;
    return { confidence: clamp(0.95 - decay + wordBonus), howMatched: 'exact_amount_near_date' };
  }

  // A near miss is worth less the further off it is, scaled by how much slack the
  // caller allowed: a 1% tolerance that lands 1% out is the weakest possible match.
  const relative = magnitude === 0n ? 1 : Number(difference) / Number(magnitude);
  const span = Math.max(config.tolerancePercent, 0.0001);
  const penalty = 0.2 * Math.min(relative / span, 1);
  return {
    confidence: clamp(0.78 - 0.05 * dayGap - penalty + wordBonus),
    howMatched: 'amount_within_tolerance',
  };
}

function looksLikeTransfer(name: string): boolean {
  const lower = name.toLowerCase();
  return TRANSFER_WORDS.some((word) => lower.includes(word));
}

/** The database stores `confidence > 0 AND confidence <= 1`; so does this. */
function clamp(value: number): number {
  return Math.min(1, Math.max(0.01, Number(value.toFixed(4))));
}

// ---------------------------------------------------------------------------
// The I/O around it
// ---------------------------------------------------------------------------

export interface PairTransfersInput extends TransferPairingOptions {
  readonly userId: string;
  /** Restrict to a window, e.g. the one a sync just touched. */
  readonly dateFrom?: DateOnly;
  readonly dateTo?: DateOnly;
}

export interface PairTransfersResult {
  readonly paired: readonly (TransferProposal & { transferLinkId: string })[];
  readonly consideredLegs: number;
}

export async function pairTransfers(
  executor: LedgerExecutor,
  input: PairTransfersInput,
  context: LedgerWriteContext,
): Promise<PairTransfersResult> {
  const now = context.clock.now();

  const rows = await executor
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      date: transactions.effectiveDate,
      amountMinor: transactions.effectiveAmountMinor,
      currency: transactions.effectiveCurrency,
      name: transactions.effectiveName,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, input.userId),
        isNull(transactions.removedAt),
        isNull(transactions.supersededById),
        // Two unique indexes make "already paired" a database invariant; this
        // keeps an already-paired leg out of the heuristic's sight in the first
        // place, so it cannot waste a proposal on one.
        isNull(transactions.transferLinkId),
        ne(transactions.effectiveAmountMinor, 0n),
        input.dateFrom === undefined ? undefined : gte(transactions.effectiveDate, input.dateFrom),
        input.dateTo === undefined ? undefined : lte(transactions.effectiveDate, input.dateTo),
      ),
    );

  const legs: TransferLeg[] = rows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    date: DateOnly.parse(row.date),
    amountMinor: row.amountMinor,
    currency: row.currency.trim(),
    name: row.name,
  }));

  const rejected = await loadRejections(executor, input.userId);
  const proposals = proposeTransferPairs(legs, { ...input, rejected });

  const paired: (TransferProposal & { transferLinkId: string })[] = [];
  for (const proposal of proposals) {
    const transferLinkId = newId();
    const inserted = await executor
      .insert(transferLinks)
      .values({
        id: transferLinkId,
        userId: input.userId,
        outflowTransactionId: proposal.outflowId,
        inflowTransactionId: proposal.inflowId,
        amountMinor: proposal.amountMinor,
        currency: proposal.currency,
        dayGap: proposal.dayGap,
        confidence: proposal.confidence,
        howMatched: proposal.howMatched,
        createdAt: now,
      })
      // A concurrent pairing run may have claimed one of these legs between the
      // SELECT above and here. The unique index is the arbiter; losing the race
      // is a no-op, not an error.
      .onConflictDoNothing()
      .returning({ id: transferLinks.id });
    if (inserted.length === 0) continue;

    await markLegs(executor, [proposal.outflowId, proposal.inflowId], transferLinkId, now);
    await appendEvent(
      outboxOf(executor),
      TransferPaired.create(
        {
          transferLinkId,
          outflowTransactionId: proposal.outflowId,
          inflowTransactionId: proposal.inflowId,
          confidence: proposal.confidence,
          howMatched: proposal.howMatched,
        },
        {
          userId: input.userId,
          aggregateId: transferLinkId,
          correlationId: context.correlationId,
          causationId: context.causationId ?? null,
        },
        context.clock,
      ),
    );
    paired.push({ ...proposal, transferLinkId });
  }

  return { paired, consideredLegs: legs.length };
}

/**
 * The user says two rows are one movement.
 *
 * Confidence 1.0 and `user_confirmed`, because they are not a heuristic. Any
 * standing rejection of the same pair is withdrawn: the user changed their mind,
 * and leaving the rejection in place would have the next pairing run silently
 * refuse to re-propose what they just confirmed.
 */
export async function confirmTransferPair(
  executor: LedgerExecutor,
  input: { userId: string; outflowTransactionId: string; inflowTransactionId: string },
  context: LedgerWriteContext,
): Promise<{ transferLinkId: string }> {
  const now = context.clock.now();
  const rows = await executor
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountMinor: transactions.effectiveAmountMinor,
      currency: transactions.effectiveCurrency,
      date: transactions.effectiveDate,
      transferLinkId: transactions.transferLinkId,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.userId, input.userId),
        inArray(transactions.id, [input.outflowTransactionId, input.inflowTransactionId]),
      ),
    );

  const outflow = rows.find((row) => row.id === input.outflowTransactionId);
  const inflow = rows.find((row) => row.id === input.inflowTransactionId);
  if (outflow === undefined || inflow === undefined) {
    throw new LedgerError('ledger.transaction_not_found', 'both legs must exist and be yours');
  }
  if (outflow.accountId === inflow.accountId) {
    throw new LedgerError('ledger.transfer_same_account', 'a transfer moves between two accounts');
  }
  if (outflow.transferLinkId !== null || inflow.transferLinkId !== null) {
    throw new LedgerError('ledger.transfer_already_paired', 'one of these legs is already paired');
  }

  const transferLinkId = newId();
  await executor.insert(transferLinks).values({
    id: transferLinkId,
    userId: input.userId,
    outflowTransactionId: outflow.id,
    inflowTransactionId: inflow.id,
    amountMinor: abs(outflow.amountMinor),
    currency: outflow.currency.trim(),
    dayGap: Math.abs(
      DateOnly.differenceInDays(DateOnly.parse(outflow.date), DateOnly.parse(inflow.date)),
    ),
    confidence: 1,
    howMatched: 'user_confirmed',
    createdAt: now,
  });
  await markLegs(executor, [outflow.id, inflow.id], transferLinkId, now);
  await executor
    .delete(rejectedTransferPairs)
    .where(
      and(
        eq(rejectedTransferPairs.userId, input.userId),
        eq(rejectedTransferPairs.lowTransactionId, lowOf(outflow.id, inflow.id)),
        eq(rejectedTransferPairs.highTransactionId, highOf(outflow.id, inflow.id)),
      ),
    );

  await appendEvent(
    outboxOf(executor),
    TransferPaired.create(
      {
        transferLinkId,
        outflowTransactionId: outflow.id,
        inflowTransactionId: inflow.id,
        confidence: 1,
        howMatched: 'user_confirmed',
      },
      {
        userId: input.userId,
        aggregateId: transferLinkId,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
      },
      context.clock,
    ),
  );
  return { transferLinkId };
}

/**
 * The user says no, and it must stay no.
 *
 * Records the rejection *and* undoes any existing link between the two rows.
 * Stored in canonical `(low, high)` id order so the "did they reject this?"
 * lookup is one index probe rather than two, which matters because the pairing
 * heuristic asks it for every candidate it considers.
 */
export async function rejectTransferPair(
  executor: LedgerExecutor,
  input: { userId: string; transactionIdA: string; transactionIdB: string; reason?: string | null },
  context: LedgerWriteContext,
): Promise<{ unlinked: boolean }> {
  const now = context.clock.now();
  const low = lowOf(input.transactionIdA, input.transactionIdB);
  const high = highOf(input.transactionIdA, input.transactionIdB);
  if (low === high) {
    throw new LedgerError('ledger.transfer_same_account', 'a pair needs two distinct rows');
  }

  await executor
    .insert(rejectedTransferPairs)
    .values({
      id: newId(),
      userId: input.userId,
      lowTransactionId: low,
      highTransactionId: high,
      reason: input.reason ?? null,
      rejectedAt: now,
    })
    .onConflictDoNothing();

  const links = await executor
    .select({ id: transferLinks.id })
    .from(transferLinks)
    .where(
      and(
        eq(transferLinks.userId, input.userId),
        sql`least(${transferLinks.outflowTransactionId}, ${transferLinks.inflowTransactionId}) = ${low}::uuid`,
        sql`greatest(${transferLinks.outflowTransactionId}, ${transferLinks.inflowTransactionId}) = ${high}::uuid`,
      ),
    );
  if (links.length === 0) return { unlinked: false };

  await executor
    .update(transactions)
    .set({ isTransfer: false, transferLinkId: null, updatedAt: now })
    .where(and(eq(transactions.userId, input.userId), inArray(transactions.id, [low, high])));
  await executor.delete(transferLinks).where(
    inArray(
      transferLinks.id,
      links.map((link) => link.id),
    ),
  );
  return { unlinked: true };
}

/** Every rejected pair for this user, as `low|high` keys. */
export async function loadRejections(
  executor: LedgerExecutor,
  userId: string,
): Promise<Set<string>> {
  const rows = await executor
    .select({
      low: rejectedTransferPairs.lowTransactionId,
      high: rejectedTransferPairs.highTransactionId,
    })
    .from(rejectedTransferPairs)
    .where(eq(rejectedTransferPairs.userId, userId));
  return new Set(rows.map((row) => `${row.low}|${row.high}`));
}

/** The canonical key for a pair, order-insensitive. */
export function rejectionKey(a: string, b: string): string {
  return `${lowOf(a, b)}|${highOf(a, b)}`;
}

export interface TransferLinkSummary {
  readonly id: string;
  readonly outflowTransactionId: string;
  readonly inflowTransactionId: string;
  readonly amount: MoneyType;
  readonly dayGap: number;
  readonly confidence: number;
  readonly howMatched: TransferMatchKind;
  readonly createdAt: Date;
}

export async function listTransferLinks(
  executor: LedgerExecutor,
  input: { userId: string },
): Promise<TransferLinkSummary[]> {
  const rows = await executor
    .select()
    .from(transferLinks)
    .where(eq(transferLinks.userId, input.userId));
  return rows
    .map((row) => ({
      id: row.id,
      outflowTransactionId: row.outflowTransactionId,
      inflowTransactionId: row.inflowTransactionId,
      amount: moneyOf(row.amountMinor, row.currency),
      dayGap: row.dayGap,
      confidence: row.confidence,
      howMatched: row.howMatched,
      createdAt: row.createdAt,
    }))
    .sort((a, b) => compareString(a.id, b.id));
}

async function markLegs(
  executor: LedgerExecutor,
  ids: readonly string[],
  transferLinkId: string,
  now: Date,
): Promise<void> {
  await executor
    .update(transactions)
    .set({ isTransfer: true, transferLinkId, updatedAt: now })
    .where(inArray(transactions.id, [...ids]));
}

function lowOf(a: string, b: string): string {
  return a < b ? a : b;
}

function highOf(a: string, b: string): string {
  return a < b ? b : a;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** First index whose value is >= `target`. The inflow list is sorted by magnitude. */
function lowerBound(values: readonly bigint[], target: bigint): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const value = values[mid];
    if (value === undefined || value < target) low = mid + 1;
    else high = mid;
  }
  return low;
}
