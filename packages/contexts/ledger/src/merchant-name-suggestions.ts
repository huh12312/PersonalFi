// SPDX-License-Identifier: MIT
/**
 * WP 11.6: merchant display-name suggestions — the ledger's half.
 *
 * `@ctx/insights` owns the `merchant.name` query type (its kill ladder, approval,
 * run row and the substring-preserving validator); `@advisor/local-model` owns
 * the prompt and the call; the composition root joins them. What lives here is
 * everything that reads or writes ledger tables:
 *
 *   * **which merchants to ask about** (`listMerchantNameCandidates`): noise
 *     merchants only (`detectMerchantNoise`, confirmed against a transaction's
 *     provider facts, never the holder's rename), at most `limit` per run,
 *     one per `normalized_key`, and never a key that already has a row here (a
 *     suggestion, a dismissal or a refusal) or that the holder has renamed on
 *     any transaction;
 *   * **recording an answer** (`recordMerchantNameAnswer`): insert-only, one row
 *     per key, `ON CONFLICT DO NOTHING` — a key is asked once;
 *   * **the holder's decision**: `acceptMerchantNameSuggestion` writes the
 *     suggested name through `setTransactionOverlay` — the manual rename's own
 *     function (`PATCH /transactions/:id` with `payeeName`, and the bulk route's
 *     loop of it) — on every transaction of the merchant that the holder has not
 *     renamed, in one database transaction; `dismissMerchantNameSuggestion`
 *     records the dismissal. Neither writes `merchants.display_name` or
 *     `transactions.effective_name` itself, and nothing here applies a name
 *     without the holder's call.
 */
import { newId, type Clock } from '@core/kernel';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  merchantNameSuggestions,
  merchants,
  transactions,
  transactionsProvider,
  type MerchantNameStatus,
  type MerchantNameSuggestionRow,
} from '../schema/index.ts';
import type { LedgerWriteContext } from './accounts.ts';
import type { LedgerDatabase, LedgerExecutor } from './db.ts';
import { LedgerError } from './errors.ts';
import { detectMerchantNoise, mayBeNoise, type MerchantNoiseShape } from './merchant-noise.ts';
import { resolveMerchantIdentity, type MerchantCounterparty } from './normalise.ts';
import { setTransactionOverlay } from './overlay.ts';

/** At most this many descriptors are asked about per holder per nightly run. */
export const MERCHANT_NAME_RUN_CAP = 50;
/** At most this many candidates a listing returns (the api's "not asked yet" hint, never a run). */
export const MERCHANT_NAME_LIST_MAX = 500;

export interface MerchantNameCandidate {
  readonly merchantId: string;
  readonly normalizedKey: string;
  /** The normaliser's residue: what the model is sent and what its answer is validated against. */
  readonly descriptor: string;
  readonly strippedPrefix: string | null;
  readonly shapes: readonly MerchantNoiseShape[];
  /** Transactions of the merchant the holder has not renamed (the order the run asks in). */
  readonly transactions: number;
}

export interface MerchantNameCandidates {
  readonly candidates: readonly MerchantNameCandidate[];
  /** Noise merchants left for a later run because of the cap. */
  readonly deferred: number;
  readonly skipped: {
    /** A row already exists for the key: suggested, accepted, dismissed or refused. */
    readonly asked: number;
    /** The holder renamed a transaction whose descriptor resolves to the key. */
    readonly renamed: number;
    /** No transaction of the merchant is left unrenamed. */
    readonly noTransaction: number;
    /** The shape pre-screen matched the stored display, but the bank's own text is not noise. */
    readonly notNoise: number;
  };
}

interface FactSlice {
  readonly name: string;
  readonly merchantName: string | null;
  readonly provider: string;
  readonly counterparties: unknown;
}

function identityInput(fact: FactSlice) {
  return {
    name: fact.name,
    merchantName: fact.merchantName,
    provider: fact.provider,
    counterparties: fact.counterparties as readonly MerchantCounterparty[] | null,
  };
}

/** The descriptor keys of every transaction the holder renamed: what the bank sent resolves to these. */
async function renamedDescriptorKeys(
  executor: LedgerExecutor,
  userId: string,
): Promise<ReadonlySet<string>> {
  const rows = await executor
    .select({
      name: transactionsProvider.name,
      merchantName: transactionsProvider.merchantName,
      provider: transactionsProvider.provider,
      counterparties: transactionsProvider.counterparties,
    })
    .from(transactions)
    .innerJoin(transactionsProvider, eq(transactions.currentFactId, transactionsProvider.id))
    .where(and(eq(transactions.userId, userId), isNotNull(transactions.userMerchantName)));
  const keys = new Set<string>();
  for (const row of rows) {
    const key = resolveMerchantIdentity(identityInput(row)).key;
    if (key !== null) keys.add(key);
  }
  return keys;
}

/**
 * The noise merchants a run may ask about, most-used first, at most `limit`
 * (`MERCHANT_NAME_RUN_CAP` by default, never more than `MERCHANT_NAME_LIST_MAX`).
 * Deterministic: the same tables give the same list in the same order.
 */
export async function listMerchantNameCandidates(
  executor: LedgerExecutor,
  userId: string,
  options: { readonly limit?: number } = {},
): Promise<MerchantNameCandidates> {
  const limit = Math.max(
    0,
    Math.min(options.limit ?? MERCHANT_NAME_RUN_CAP, MERCHANT_NAME_LIST_MAX),
  );
  const rows = await executor
    .select({
      id: merchants.id,
      normalizedKey: merchants.normalizedKey,
      displayName: merchants.displayName,
    })
    .from(merchants)
    .where(eq(merchants.userId, userId))
    .orderBy(asc(merchants.normalizedKey));
  // A cheap pre-screen over the stored display (tens of rows); the verdict that
  // counts is the bank's own text, below.
  const screened = rows.filter((row) => mayBeNoise(row.displayName));
  const skipped = { asked: 0, renamed: 0, noTransaction: 0, notNoise: 0 };
  if (screened.length === 0) return { candidates: [], deferred: 0, skipped };

  const asked = new Set(
    (
      await executor
        .select({ normalizedKey: merchantNameSuggestions.normalizedKey })
        .from(merchantNameSuggestions)
        .where(eq(merchantNameSuggestions.userId, userId))
    ).map((row) => row.normalizedKey),
  );
  const renamed = await renamedDescriptorKeys(executor, userId);

  const open = screened.filter((row) => {
    if (asked.has(row.normalizedKey)) {
      skipped.asked += 1;
      return false;
    }
    if (renamed.has(row.normalizedKey)) {
      skipped.renamed += 1;
      return false;
    }
    return true;
  });
  if (open.length === 0) return { candidates: [], deferred: 0, skipped };

  const facts = await executor
    .select({
      merchantId: transactions.effectiveMerchantId,
      name: transactionsProvider.name,
      merchantName: transactionsProvider.merchantName,
      provider: transactionsProvider.provider,
      counterparties: transactionsProvider.counterparties,
    })
    .from(transactions)
    .innerJoin(transactionsProvider, eq(transactions.currentFactId, transactionsProvider.id))
    .where(
      and(
        eq(transactions.userId, userId),
        inArray(
          transactions.effectiveMerchantId,
          open.map((row) => row.id),
        ),
        isNull(transactions.userMerchantName),
      ),
    )
    .orderBy(desc(transactions.effectiveDate), desc(transactions.id));
  const latest = new Map<string, FactSlice>();
  const counts = new Map<string, number>();
  for (const fact of facts) {
    if (fact.merchantId === null) continue;
    counts.set(fact.merchantId, (counts.get(fact.merchantId) ?? 0) + 1);
    if (!latest.has(fact.merchantId)) latest.set(fact.merchantId, fact);
  }

  const found: MerchantNameCandidate[] = [];
  for (const row of open) {
    const fact = latest.get(row.id);
    if (fact === undefined) {
      skipped.noTransaction += 1;
      continue;
    }
    const verdict = detectMerchantNoise(identityInput(fact));
    if (!verdict.noise || verdict.key !== row.normalizedKey) {
      skipped.notNoise += 1;
      continue;
    }
    found.push({
      merchantId: row.id,
      normalizedKey: row.normalizedKey,
      descriptor: verdict.descriptor,
      strippedPrefix: verdict.strippedPrefix,
      shapes: verdict.shapes,
      transactions: counts.get(row.id) ?? 0,
    });
  }
  found.sort(
    (a, b) =>
      b.transactions - a.transactions ||
      (a.normalizedKey < b.normalizedKey ? -1 : a.normalizedKey > b.normalizedKey ? 1 : 0),
  );
  return {
    candidates: found.slice(0, limit),
    deferred: Math.max(0, found.length - limit),
    skipped,
  };
}

export type MerchantNameAnswer =
  | { readonly status: 'suggested'; readonly displayName: string }
  | { readonly status: 'refused'; readonly refusalClass: string };

/**
 * Record what the model answered for one key. Insert-only: a key that already
 * has a row keeps it (`false`), so a second ask — a race, a redelivery — can
 * never overwrite a suggestion, a dismissal or an accept.
 */
export async function recordMerchantNameAnswer(
  executor: LedgerExecutor,
  context: { readonly userId: string; readonly clock: Clock },
  input: {
    readonly normalizedKey: string;
    readonly descriptor: string;
    readonly strippedPrefix: string | null;
    readonly answer: MerchantNameAnswer;
    readonly llmProvider: 'ollama';
    readonly llmModel: string;
    readonly runId: string;
    readonly inputDigest: string;
  },
): Promise<boolean> {
  const now = context.clock.now();
  const rows = await executor
    .insert(merchantNameSuggestions)
    .values({
      id: newId(),
      userId: context.userId,
      normalizedKey: input.normalizedKey,
      descriptor: input.descriptor,
      strippedPrefix: input.strippedPrefix,
      status: input.answer.status,
      displayName: input.answer.status === 'suggested' ? input.answer.displayName : null,
      refusalClass: input.answer.status === 'refused' ? input.answer.refusalClass : null,
      llmProvider: input.llmProvider,
      llmModel: input.llmModel,
      runId: input.runId,
      inputDigest: input.inputDigest,
      suggestedAt: now,
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: merchantNameSuggestions.id });
  return rows.length > 0;
}

export interface MerchantNameSuggestionView {
  readonly id: string;
  /** The merchant the key names now, or `null` when no `merchants` row has it any more. */
  readonly merchantId: string | null;
  readonly normalizedKey: string;
  readonly descriptor: string;
  readonly strippedPrefix: string | null;
  readonly status: MerchantNameStatus;
  readonly displayName: string | null;
  readonly refusalClass: string | null;
  readonly llmProvider: string;
  readonly llmModel: string;
  readonly runId: string;
  readonly suggestedAt: Date;
  readonly decidedAt: Date | null;
}

function viewOf(
  row: MerchantNameSuggestionRow,
  merchantId: string | null,
): MerchantNameSuggestionView {
  return {
    id: row.id,
    merchantId,
    normalizedKey: row.normalizedKey,
    descriptor: row.descriptor,
    strippedPrefix: row.strippedPrefix,
    status: row.status,
    displayName: row.displayName,
    refusalClass: row.refusalClass,
    llmProvider: row.llmProvider,
    llmModel: row.llmModel,
    runId: row.runId,
    suggestedAt: row.suggestedAt,
    decidedAt: row.decidedAt,
  };
}

/** This holder's rows, newest first, optionally only some statuses. */
export async function listMerchantNameSuggestions(
  executor: LedgerExecutor,
  userId: string,
  options: { readonly statuses?: readonly MerchantNameStatus[] } = {},
): Promise<readonly MerchantNameSuggestionView[]> {
  const rows = await executor
    .select({ suggestion: merchantNameSuggestions, merchantId: merchants.id })
    .from(merchantNameSuggestions)
    .leftJoin(
      merchants,
      and(
        eq(merchants.userId, merchantNameSuggestions.userId),
        eq(merchants.normalizedKey, merchantNameSuggestions.normalizedKey),
      ),
    )
    .where(
      and(
        eq(merchantNameSuggestions.userId, userId),
        options.statuses === undefined || options.statuses.length === 0
          ? undefined
          : inArray(merchantNameSuggestions.status, [...options.statuses]),
      ),
    )
    .orderBy(desc(merchantNameSuggestions.suggestedAt), desc(merchantNameSuggestions.id));
  return rows.map((row) => viewOf(row.suggestion, row.merchantId));
}

async function lockedSuggestion(
  executor: LedgerExecutor,
  userId: string,
  suggestionId: string,
): Promise<MerchantNameSuggestionRow> {
  const rows = await executor
    .select()
    .from(merchantNameSuggestions)
    .where(
      and(eq(merchantNameSuggestions.id, suggestionId), eq(merchantNameSuggestions.userId, userId)),
    )
    .for('update');
  const row = rows[0];
  if (row === undefined) {
    throw new LedgerError(
      'ledger.merchant_name_suggestion_not_found',
      `no merchant name suggestion ${suggestionId}`,
    );
  }
  return row;
}

/**
 * The holder's Accept: the suggested name becomes **their** rename of the
 * merchant — `setTransactionOverlay({ userMerchantName })`, the manual rename's
 * own function, once per transaction of the merchant they have not renamed
 * themselves, all in one database transaction (as `POST /transactions/bulk`
 * runs it). A rename the holder already typed is never overwritten.
 *
 * Re-runnable on an accepted suggestion: a transaction of the same merchant that
 * arrived after the first Accept still reads the bank's text, and a second Accept
 * renames it the same way. Never on a dismissed or refused row.
 */
export async function acceptMerchantNameSuggestion(
  database: LedgerDatabase,
  input: { readonly userId: string; readonly suggestionId: string },
  context: LedgerWriteContext,
): Promise<{ readonly suggestion: MerchantNameSuggestionView; readonly renamed: number }> {
  return database.transaction(async (tx) => {
    const row = await lockedSuggestion(tx, input.userId, input.suggestionId);
    if ((row.status !== 'suggested' && row.status !== 'accepted') || row.displayName === null) {
      throw new LedgerError(
        'ledger.merchant_name_suggestion_closed',
        `merchant name suggestion ${row.id} is ${row.status}; only a suggested or accepted one can be applied`,
      );
    }
    const merchant = (
      await tx
        .select({ id: merchants.id })
        .from(merchants)
        .where(
          and(eq(merchants.userId, input.userId), eq(merchants.normalizedKey, row.normalizedKey)),
        )
    )[0];
    const targets =
      merchant === undefined
        ? []
        : await tx
            .select({ id: transactions.id })
            .from(transactions)
            .where(
              and(
                eq(transactions.userId, input.userId),
                eq(transactions.effectiveMerchantId, merchant.id),
                isNull(transactions.userMerchantName),
              ),
            )
            .orderBy(asc(transactions.id));
    for (const target of targets) {
      await setTransactionOverlay(
        tx,
        {
          userId: input.userId,
          transactionId: target.id,
          patch: { userMerchantName: row.displayName },
        },
        context,
      );
    }
    const now = context.clock.now();
    const decidedAt = row.status === 'accepted' ? (row.decidedAt ?? now) : now;
    await tx
      .update(merchantNameSuggestions)
      .set({ status: 'accepted', decidedAt, updatedAt: now })
      .where(eq(merchantNameSuggestions.id, row.id));
    return {
      suggestion: viewOf(
        { ...row, status: 'accepted', decidedAt, updatedAt: now },
        merchant?.id ?? null,
      ),
      renamed: targets.length,
    };
  });
}

/**
 * The holder's Dismiss: recorded, and the key is never asked about again. A
 * rename an earlier Accept made stays — it is the holder's overlay now, undone the
 * way any rename is.
 */
export async function dismissMerchantNameSuggestion(
  database: LedgerDatabase,
  input: { readonly userId: string; readonly suggestionId: string },
  context: LedgerWriteContext,
): Promise<MerchantNameSuggestionView> {
  return database.transaction(async (tx) => {
    const row = await lockedSuggestion(tx, input.userId, input.suggestionId);
    if (row.status !== 'suggested' && row.status !== 'accepted') {
      throw new LedgerError(
        'ledger.merchant_name_suggestion_closed',
        `merchant name suggestion ${row.id} is ${row.status}; only a suggested or accepted one can be dismissed`,
      );
    }
    const now = context.clock.now();
    await tx
      .update(merchantNameSuggestions)
      .set({ status: 'dismissed', decidedAt: now, updatedAt: now })
      .where(eq(merchantNameSuggestions.id, row.id));
    const merchant = (
      await tx
        .select({ id: merchants.id })
        .from(merchants)
        .where(
          and(eq(merchants.userId, input.userId), eq(merchants.normalizedKey, row.normalizedKey)),
        )
    )[0];
    return viewOf(
      { ...row, status: 'dismissed', decidedAt: now, updatedAt: now },
      merchant?.id ?? null,
    );
  });
}

/** Counts by status, for the run summary and the tests. */
export async function countMerchantNameSuggestions(
  executor: LedgerExecutor,
  userId: string,
): Promise<Readonly<Record<MerchantNameStatus, number>>> {
  const rows = await executor
    .select({ status: merchantNameSuggestions.status, n: sql<number>`count(*)::int` })
    .from(merchantNameSuggestions)
    .where(eq(merchantNameSuggestions.userId, userId))
    .groupBy(merchantNameSuggestions.status);
  const counts: Record<MerchantNameStatus, number> = {
    suggested: 0,
    accepted: 0,
    dismissed: 0,
    refused: 0,
  };
  for (const row of rows) counts[row.status] = Number(row.n);
  return counts;
}
