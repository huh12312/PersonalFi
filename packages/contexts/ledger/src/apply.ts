// SPDX-License-Identifier: MIT
/**
 * The sync write path: provider facts in, stable user-facing rows out.
 *
 * Everything a provider says about a transaction arrives here and nowhere else.
 * The function is built around four properties, each of which costs real user
 * data the first time it is missing:
 *
 * 1. **Idempotency.** Replaying a page changes nothing. Three layers, per 04 §4.4:
 *    the natural key `(account_id, provider, provider_transaction_id)`; a content
 *    hash, so a `modified` carrying an unchanged payload bumps `last_seen_at` and
 *    writes nothing else; and no event at all when a run touched nothing, so a
 *    replay does not wake four consumers to recompute the same answer.
 * 2. **The surrogate id survives pending → posted** (decision D10, 01 §5.2). Plaid
 *    represents settlement as *delete + insert*. Handled naively, the user's
 *    category, note, splits and exclusions die with the pending row. Here the
 *    `transactions` row never moves: only `current_fact_id` advances.
 * 3. **Order independence.** `removed[]` and the `added[]` that supersedes it are
 *    not ordered relative to each other and need not share a page. Both orders
 *    converge on the same state — see `applyRemovals`.
 * 4. **One resolver.** Every `effective_*` column is written by
 *    `resolveEffective()` and by nothing else, so a list page and a budget total
 *    cannot disagree about what a transaction is called or when it happened.
 *
 * The *shape* of the implementation follows from a fifth, practical property: the
 * seed loader pushes thousands of transactions through one call, so this preloads
 * in a fixed number of queries, decides in memory against indexed maps, and writes
 * in batches — rather than issuing six round trips per transaction and turning a
 * demo-data load into a coffee break.
 *
 * ## A note on "immutable facts"
 *
 * 04 §2.2 describes `transaction_fact` as append-only with one row per provider
 * revision. Migration 0004 gives `transactions_provider` a unique index on
 * `(account_id, provider, provider_transaction_id)` with no `revision` component,
 * so a revision advances the existing row in place: `revision` counts how many
 * distinct payloads we have seen and `raw` holds the latest. The audit trail that
 * matters for correctness — the pending → posted linkage — is fully preserved in
 * `superseded_by_id`. Full per-revision history needs a new table and a new
 * migration (an already-merged migration is immutable); see the WP 1.1 evidence
 * note, "deferred".
 */
import { DateOnly, newId, type Clock } from '@core/kernel';
import { appendEvent, canonicalJson } from '@core/platform';
import { sha256 } from '@core/secretbox';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  accounts,
  ledgerDedupKeys,
  transactions,
  transactionsProvider,
  type TransactionProviderRow,
  type TransactionRow,
} from '../schema/index.ts';
import { dateOnlyOf, factOf, moneyOf, outboxOf, overlayOf, type LedgerExecutor } from './db.ts';
import { resolveEffective } from './effective.ts';
import { LedgerError } from './errors.ts';
import { TransactionSupersededByPosted, TransactionsUpserted } from './events.ts';
import { ensureMerchants, type WantedMerchant } from './merchant-store.ts';
import {
  dedupKeyOf,
  normaliseMerchantName,
  resolveMerchantIdentity,
  type MerchantCounterparty,
} from './normalise.ts';
import { EMPTY_OVERLAY, NO_RULE, type ProviderTransactionInput } from './types.ts';

/** Postgres caps a statement at 65535 bound parameters; this stays well inside it. */
const INSERT_CHUNK = 400;
/** `inArray` list size. Same reasoning, one parameter per element. */
const SELECT_CHUNK = 900;

export interface ApplyOptions {
  /**
   * Fuzzy pending → posted matching, for the institutions that supply no
   * `pending_transaction_id` (01 §5.2: "we own the fuzzy match"). Deliberately
   * conservative — see `findFuzzyPredecessor`.
   */
  readonly fuzzyPendingMatch?: boolean;
  /** Days either side for the fuzzy match. Plaid settles in one to three days. */
  readonly fuzzyWindowDays?: number;
  /** Cross-provider duplicate marking. Marks only; never merges, never deletes. */
  readonly detectDuplicates?: boolean;
}

const DEFAULT_OPTIONS: Required<ApplyOptions> = Object.freeze({
  fuzzyPendingMatch: true,
  fuzzyWindowDays: 3,
  detectDuplicates: true,
});

export interface ApplyProviderTransactionsInput {
  readonly userId: string;
  readonly accountId: string;
  readonly provider: string;
  readonly added?: readonly ProviderTransactionInput[];
  readonly modified?: readonly ProviderTransactionInput[];
  /** Provider transaction ids only — Plaid's `removed[]` carries no objects. */
  readonly removed?: readonly string[];
  readonly clock: Clock;
  /** Ties a whole sync run together in the event log. */
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly options?: ApplyOptions;
}

/** What one pending fact's settlement did, for the caller and for the event. */
export interface SupersededPending {
  readonly transactionId: string;
  readonly pendingFactId: string;
  readonly postedFactId: string;
  readonly amountChanged: boolean;
  readonly dateChanged: boolean;
  readonly howMatched: 'provider_link' | 'fuzzy';
}

export interface ApplyResult {
  readonly addedTransactionIds: readonly string[];
  readonly updatedTransactionIds: readonly string[];
  readonly removedTransactionIds: readonly string[];
  readonly superseded: readonly SupersededPending[];
  /** `modified` payloads whose content hash matched: `last_seen_at` only. */
  readonly unchangedFactCount: number;
  /** Rows marked as a cross-provider duplicate of an existing row. */
  readonly duplicateTransactionIds: readonly string[];
  readonly effectiveDateFrom: string | null;
  readonly effectiveDateTo: string | null;
}

/** In-memory state of one provider fact, existing or planned. */
interface FactPlan {
  row: TransactionProviderRow;
  readonly isNew: boolean;
  dirty: boolean;
}

/** In-memory state of one user-facing row, existing or planned. */
interface TxnPlan {
  row: TransactionRow;
  readonly isNew: boolean;
  dirty: boolean;
}

/**
 * Every row this call might touch, indexed the three ways the algorithm asks for
 * it: by natural key (does this provider id already exist?), by surrogate id
 * (what does this pointer point at?), and fact → owner (who points at me?).
 *
 * The indexes are the difference between an O(n) and an O(n²) apply, which for a
 * 5,000-transaction seed load is the difference between a second and a minute.
 */
class PlanStore {
  readonly factsByKey = new Map<string, FactPlan>();
  readonly factsById = new Map<string, FactPlan>();
  readonly txnsById = new Map<string, TxnPlan>();
  readonly #ownerByFactId = new Map<string, TxnPlan>();

  addFact(plan: FactPlan): FactPlan {
    this.factsByKey.set(plan.row.providerTransactionId, plan);
    this.factsById.set(plan.row.id, plan);
    return plan;
  }

  addTxn(plan: TxnPlan): TxnPlan {
    this.txnsById.set(plan.row.id, plan);
    this.#ownerByFactId.set(plan.row.currentFactId, plan);
    return plan;
  }

  ownerOf(factId: string): TxnPlan | undefined {
    return this.#ownerByFactId.get(factId);
  }

  /** Advance a row's pointer, keeping the fact → owner index honest. */
  repoint(plan: TxnPlan, factId: string, now: Date): void {
    this.#ownerByFactId.delete(plan.row.currentFactId);
    plan.row = { ...plan.row, currentFactId: factId, removedAt: null, updatedAt: now };
    plan.dirty = true;
    this.#ownerByFactId.set(factId, plan);
  }
}

/**
 * Apply one page of provider truth.
 *
 * Call inside the caller's transaction, together with the cursor advance: a
 * committed cursor with uncommitted data is a permanent silent gap, because the
 * provider will never resend it (01 §5.1).
 */
export async function applyProviderTransactions(
  executor: LedgerExecutor,
  input: ApplyProviderTransactionsInput,
): Promise<ApplyResult> {
  const options = { ...DEFAULT_OPTIONS, ...input.options };
  const now = input.clock.now();
  const { userId, accountId, provider } = input;

  await assertAccountExists(executor, userId, accountId);

  // Pending first, so a page carrying both halves of a settlement resolves the
  // identity migration in one pass whatever order the provider used.
  const incoming = dedupeIncoming([...(input.added ?? []), ...(input.modified ?? [])]);
  incoming.sort((a, b) => Number(b.pending) - Number(a.pending));
  const removed = [...new Set(input.removed ?? [])];

  const store = new PlanStore();
  const wanted = new Set<string>(removed);
  for (const item of incoming) {
    wanted.add(item.providerTransactionId);
    if (item.pendingTransactionId !== null) wanted.add(item.pendingTransactionId);
  }

  await loadFacts(executor, store, accountId, provider, [...wanted]);
  await loadOwners(executor, store);
  const pendingCandidates = options.fuzzyPendingMatch
    ? await loadPendingCandidates(executor, store, accountId)
    : [];

  const addedIds: string[] = [];
  const updatedIds = new Set<string>();
  const superseded: SupersededPending[] = [];
  let unchangedFactCount = 0;

  for (const item of incoming) {
    const hash = contentHashOf(provider, item);
    const existing = store.factsByKey.get(item.providerTransactionId);

    if (existing !== undefined) {
      const changed = existing.row.contentHash !== hash;
      if (changed) {
        // A real revision. The natural key is unique per account, so this
        // advances the current revision in place rather than adding a row.
        existing.row = {
          ...existing.row,
          ...factColumnsOf(item),
          contentHash: hash,
          revision: existing.row.revision + 1,
        };
      } else {
        unchangedFactCount += 1;
      }
      // A tombstoned fact that reappears in `added[]` is a reclaim, not a no-op:
      // the provider changed its mind and the user's overlay is still attached.
      const reclaimed = existing.row.removedAt !== null;
      existing.row = { ...existing.row, lastSeenAt: now, removedAt: null };
      existing.dirty = true;

      const owner = store.ownerOf(existing.row.id);
      if (owner === undefined) {
        // A fact with no user-facing row and no successor: repair rather than
        // leave a real purchase invisible. Only reachable after a partial failure.
        addedIds.push(newTransaction(store, userId, accountId, existing.row, now).row.id);
      } else if (changed || reclaimed || owner.row.removedAt !== null) {
        owner.row = { ...owner.row, removedAt: null, updatedAt: now };
        owner.dirty = true;
        updatedIds.add(owner.row.id);
      }
      continue;
    }

    const factRow: TransactionProviderRow = {
      id: newId(),
      userId,
      accountId,
      provider,
      ...factColumnsOf(item),
      contentHash: hash,
      revision: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      removedAt: null,
      supersededById: null,
    };
    store.addFact({ row: factRow, isNew: true, dirty: false });

    const predecessor = findPredecessor(store, pendingCandidates, item, options);
    if (predecessor === undefined) {
      addedIds.push(newTransaction(store, userId, accountId, factRow, now).row.id);
      continue;
    }

    // The identity migration (decision D10). `transactions.id` does not move and
    // the overlay does not move; only the pointer advances, and the superseded
    // fact is stamped so the audit trail survives.
    const before = factOf(predecessor.fact.row);
    const after = factOf(factRow);
    predecessor.fact.row = { ...predecessor.fact.row, supersededById: factRow.id };
    predecessor.fact.dirty = true;
    store.repoint(predecessor.txn, factRow.id, now);
    updatedIds.add(predecessor.txn.row.id);
    superseded.push({
      transactionId: predecessor.txn.row.id,
      pendingFactId: predecessor.fact.row.id,
      postedFactId: factRow.id,
      amountChanged: before.amount.minor !== after.amount.minor,
      dateChanged:
        (before.authorizedDate ?? before.postedDate) !== (after.authorizedDate ?? after.postedDate),
      howMatched: predecessor.howMatched,
    });
  }

  const removedTransactionIds = applyRemovals(store, removed, now);

  const merchantIds = await resolveMerchants(executor, store, userId, now);
  await writeFacts(executor, store);
  await writeTransactions(executor, store, merchantIds, now);

  const touched = [...store.txnsById.values()].filter((plan) => plan.isNew || plan.dirty);
  const duplicateTransactionIds = options.detectDuplicates
    ? await syncDedupKeys(executor, store, userId, provider, touched, now)
    : [];

  const dates = touched.map((plan) => plan.row.effectiveDate).sort();
  const result: ApplyResult = {
    addedTransactionIds: addedIds,
    updatedTransactionIds: [...updatedIds].filter((id) => !addedIds.includes(id)),
    removedTransactionIds,
    superseded,
    unchangedFactCount,
    duplicateTransactionIds,
    effectiveDateFrom: dates[0] ?? null,
    effectiveDateTo: dates.at(-1) ?? null,
  };

  await emitEvents(executor, input, result);
  return result;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function assertAccountExists(
  executor: LedgerExecutor,
  userId: string,
  accountId: string,
): Promise<void> {
  const rows = await executor
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
  if (rows[0] === undefined) {
    throw new LedgerError('ledger.account_not_found', `no account ${accountId} for this user`);
  }
}

/** Facts for the natural keys this page mentions. */
async function loadFacts(
  executor: LedgerExecutor,
  store: PlanStore,
  accountId: string,
  provider: string,
  providerTransactionIds: readonly string[],
): Promise<void> {
  for (const chunk of chunked(providerTransactionIds, SELECT_CHUNK)) {
    const rows = await executor
      .select()
      .from(transactionsProvider)
      .where(
        and(
          eq(transactionsProvider.accountId, accountId),
          eq(transactionsProvider.provider, provider),
          inArray(transactionsProvider.providerTransactionId, chunk),
        ),
      );
    for (const row of rows) store.addFact({ row, isNew: false, dirty: false });
  }
}

/** The user-facing rows that point at any fact loaded so far. */
async function loadOwners(executor: LedgerExecutor, store: PlanStore): Promise<void> {
  const factIds = [...store.factsById.keys()];
  for (const chunk of chunked(factIds, SELECT_CHUNK)) {
    const rows = await executor
      .select()
      .from(transactions)
      .where(inArray(transactions.currentFactId, chunk));
    for (const row of rows) {
      if (store.txnsById.has(row.id)) continue;
      store.addTxn({ row, isNew: false, dirty: false });
    }
  }
}

/**
 * Open pending rows on this account, and the facts they point at, for the fuzzy
 * path. Small by construction — a pending charge lives for a day or three — so
 * this is one cheap partial-index scan plus one lookup by primary key.
 */
async function loadPendingCandidates(
  executor: LedgerExecutor,
  store: PlanStore,
  accountId: string,
): Promise<TxnPlan[]> {
  const rows = await executor
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.pending, true),
        isNull(transactions.removedAt),
      ),
    );

  const candidates: TxnPlan[] = [];
  for (const row of rows) {
    const existing = store.txnsById.get(row.id);
    candidates.push(existing ?? store.addTxn({ row, isNew: false, dirty: false }));
  }

  const missingFactIds = candidates
    .map((plan) => plan.row.currentFactId)
    .filter((id) => !store.factsById.has(id));
  for (const chunk of chunked(missingFactIds, SELECT_CHUNK)) {
    const facts = await executor
      .select()
      .from(transactionsProvider)
      .where(inArray(transactionsProvider.id, chunk));
    for (const row of facts) store.addFact({ row, isNew: false, dirty: false });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

interface Predecessor {
  readonly fact: FactPlan;
  readonly txn: TxnPlan;
  readonly howMatched: 'provider_link' | 'fuzzy';
}

function findPredecessor(
  store: PlanStore,
  pendingCandidates: readonly TxnPlan[],
  item: ProviderTransactionInput,
  options: Required<ApplyOptions>,
): Predecessor | undefined {
  if (item.pendingTransactionId !== null) {
    const fact = store.factsByKey.get(item.pendingTransactionId);
    if (fact === undefined) return undefined;
    const txn = store.ownerOf(fact.row.id);
    if (txn === undefined) return undefined;
    return { fact, txn, howMatched: 'provider_link' };
  }
  if (!options.fuzzyPendingMatch || item.pending) return undefined;
  return findFuzzyPredecessor(store, pendingCandidates, item, options);
}

/**
 * The fuzzy pending → posted match, for institutions that supply no
 * `pending_transaction_id`.
 *
 * 01 §5.2 is unambiguous about the trade: **prefer showing a duplicate over
 * silently merging two real transactions** — under-merging is a UI annoyance,
 * over-merging is data loss. So every gate here is tight, and an ambiguous match
 * is refused outright rather than guessed:
 *
 *   * same account (the caller already scoped it), same currency, same sign;
 *   * the candidate is still pending, not removed, and not already superseded;
 *   * within `fuzzyWindowDays` of the incoming effective date;
 *   * **either** the amount is identical **or** the normalised payee is identical
 *     — the amount moves for tips, FX and gas holds, and the descriptor moves for
 *     a processor that renames at settlement, but both changing at once is
 *     indistinguishable from two unrelated purchases;
 *   * exactly one candidate survives. Two candidates means we do not know, and
 *     the honest answer to "we do not know" is a visible duplicate.
 */
function findFuzzyPredecessor(
  store: PlanStore,
  pendingCandidates: readonly TxnPlan[],
  item: ProviderTransactionInput,
  options: Required<ApplyOptions>,
): Predecessor | undefined {
  const effectiveDate = item.authorizedDate ?? item.postedDate;
  const nameKey = normaliseMerchantName(item.merchantName ?? item.name).key;
  const matches: Predecessor[] = [];

  for (const txn of pendingCandidates) {
    if (txn.row.removedAt !== null || !txn.row.pending) continue;
    const fact = store.factsById.get(txn.row.currentFactId);
    if (fact === undefined || fact.row.supersededById !== null) continue;
    if (fact.row.providerTransactionId === item.providerTransactionId) continue;
    if (fact.row.currency !== item.amount.currency) continue;
    if (fact.row.amountMinor < 0n !== item.amount.minor < 0n) continue;

    const candidateDate = dateOnlyOf(fact.row.authorizedDate ?? fact.row.postedDate);
    if (
      Math.abs(DateOnly.differenceInDays(candidateDate, effectiveDate)) > options.fuzzyWindowDays
    ) {
      continue;
    }

    const sameAmount = fact.row.amountMinor === item.amount.minor;
    const candidateKey = normaliseMerchantName(fact.row.merchantName ?? fact.row.name).key;
    const sameName = candidateKey !== '' && candidateKey === nameKey;
    if (!sameAmount && !sameName) continue;

    matches.push({ fact, txn, howMatched: 'fuzzy' });
  }

  return matches.length === 1 ? matches[0] : undefined;
}

function newTransaction(
  store: PlanStore,
  userId: string,
  accountId: string,
  fact: TransactionProviderRow,
  now: Date,
): TxnPlan {
  const row: TransactionRow = {
    id: newId(),
    userId,
    accountId,
    currentFactId: fact.id,
    // Placeholders. Every one of these is overwritten by `resolveEffective()` in
    // `writeTransactions`; they exist so the object is a complete row, never
    // because they are a second opinion about what the transaction says.
    effectiveDate: fact.postedDate,
    effectiveAmountMinor: fact.amountMinor,
    effectiveCurrency: fact.currency,
    effectiveName: fact.name,
    effectiveMerchantId: null,
    pending: fact.pending,
    userNote: EMPTY_OVERLAY.userNote,
    userExcluded: EMPTY_OVERLAY.userExcluded,
    userCategoryId: EMPTY_OVERLAY.userCategoryId,
    userMerchantName: EMPTY_OVERLAY.userMerchantName,
    // The rule tier (04 §2.2's middle tier) is @ctx/categorization's to write,
    // through setRuleCategory — never here. A brand-new row starts with no rule
    // decision, same as it starts with no user edit.
    ruleCategoryId: NO_RULE.ruleCategoryId,
    isTransfer: false,
    transferLinkId: null,
    refundOfId: null,
    refundConfidence: null,
    supersededById: null,
    supersededReason: null,
    removedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  return store.addTxn({ row, isNew: true, dirty: true });
}

/**
 * `removed[]`, handled so that both possible arrival orders converge.
 *
 * *Added first, removed second*: the pending fact already carries
 * `superseded_by_id` and its user-facing row already points at the posted fact,
 * so nothing points at the tombstone and this is a no-op on `transactions` —
 * which is right, because the charge still exists, it just settled.
 *
 * *Removed first, added second*: nothing supersedes the fact yet, so the row is
 * soft-hidden here; the `added[]` that arrives in a later page re-points it and
 * clears `removed_at`. The overlay survives either way, which is the whole reason
 * this is a tombstone and not a `DELETE`.
 *
 * *Removed with no successor ever*: the row stays hidden. That is a genuine
 * provider retraction — a duplicate charge reversed by the bank — and the user's
 * annotations are kept in case a later page reclaims it.
 */
function applyRemovals(store: PlanStore, removed: readonly string[], now: Date): string[] {
  const hidden: string[] = [];
  for (const providerTransactionId of removed) {
    const fact = store.factsByKey.get(providerTransactionId);
    if (fact === undefined) continue;
    if (fact.row.removedAt === null) {
      fact.row = { ...fact.row, removedAt: now };
      fact.dirty = true;
    }
    if (fact.row.supersededById !== null) continue;
    const owner = store.ownerOf(fact.row.id);
    if (owner === undefined || owner.row.removedAt !== null) continue;
    owner.row = { ...owner.row, removedAt: now, updatedAt: now };
    owner.dirty = true;
    hidden.push(owner.row.id);
  }
  return hidden;
}

// ---------------------------------------------------------------------------
// Merchants
// ---------------------------------------------------------------------------

/**
 * Map every normalised payee key this page produced to a `merchants` row, in a
 * fixed number of queries rather than two per transaction.
 *
 * `resolveEffective` is pure and therefore cannot do this itself — that is
 * exactly why it returns a `merchantKey` and not a merchant id (see
 * `effective.ts`). The writer resolves the key once; every reader uses the
 * stored id.
 */
async function resolveMerchants(
  executor: LedgerExecutor,
  store: PlanStore,
  userId: string,
  now: Date,
): Promise<Map<string, string>> {
  const wanted = new Map<string, WantedMerchant>(); // normalised key -> row material
  for (const plan of store.txnsById.values()) {
    if (!plan.isNew && !plan.dirty) continue;
    const fact = store.factsById.get(plan.row.currentFactId);
    if (fact === undefined) continue;

    // Decision D25's full rule: a provider that asserts a merchant *entity* has
    // told us a payee exists on evidence we do not have, so its answer outranks
    // the text gate, and its ids are recorded on the row.
    //
    // The inputs here must be *exactly* the inputs `resolveEffective` sees, or
    // this half creates a `merchants` row the projection half never points at.
    // That is not a coincidence to be maintained by hand: `factOf` puts
    // `provider` and `counterparties` on `TransactionFact` precisely so both
    // halves read the same evidence, and `merchant-identity.test.ts` asserts the
    // orphan count is zero rather than trusting the two call sites to agree.
    const overlay = overlayOf(plan.row);
    const identity = resolveMerchantIdentity({
      name: fact.row.name,
      merchantName: fact.row.merchantName,
      userMerchantName: overlay.userMerchantName,
      provider: fact.row.provider,
      counterparties: fact.row.counterparties as readonly MerchantCounterparty[] | null,
    });
    if (identity.key === null) continue;

    // Union the evidence: two facts for one payee may each carry a different
    // entity id, and `ensureMerchants` is called once with the merged view.
    const existing = wanted.get(identity.key);
    wanted.set(identity.key, {
      display: existing?.display ?? identity.display,
      entityIds:
        existing === undefined
          ? identity.entityIds
          : [...new Set([...existing.entityIds, ...identity.entityIds])].sort(),
    });
  }
  return ensureMerchants(executor, userId, wanted, now);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function writeFacts(executor: LedgerExecutor, store: PlanStore): Promise<void> {
  const inserts = [...store.factsById.values()]
    .filter((plan) => plan.isNew)
    .map((plan) => plan.row);
  for (const chunk of chunked(inserts, INSERT_CHUNK)) {
    await executor.insert(transactionsProvider).values(chunk);
  }
  for (const plan of store.factsById.values()) {
    if (plan.isNew || !plan.dirty) continue;
    const { id, ...rest } = plan.row;
    await executor.update(transactionsProvider).set(rest).where(eq(transactionsProvider.id, id));
  }
}

/**
 * Write the user-facing rows, refreshing every `effective_*` column through
 * `resolveEffective()`.
 *
 * This is the only place those columns are written. `effective-invariant.test.ts`
 * walks every row in the database and asserts the stored values equal a fresh
 * resolution of the fact and the overlay, which is what keeps "denormalised for
 * speed" from quietly becoming "a second source of truth".
 */
async function writeTransactions(
  executor: LedgerExecutor,
  store: PlanStore,
  merchantIds: ReadonlyMap<string, string>,
  now: Date,
): Promise<void> {
  const inserts: TransactionRow[] = [];
  const updates: TxnPlan[] = [];

  for (const plan of store.txnsById.values()) {
    if (!plan.isNew && !plan.dirty) continue;
    const fact = store.factsById.get(plan.row.currentFactId);
    if (fact === undefined) continue;
    plan.row = { ...projectEffective(plan.row, fact.row, merchantIds), updatedAt: now };
    if (plan.isNew) inserts.push(plan.row);
    else updates.push(plan);
  }

  for (const chunk of chunked(inserts, INSERT_CHUNK)) {
    await executor.insert(transactions).values(chunk);
  }
  for (const plan of updates) {
    const { id, createdAt: _createdAt, ...rest } = plan.row;
    await executor.update(transactions).set(rest).where(eq(transactions.id, id));
  }
}

/**
 * The projection, in one place: fact + overlay → the six `effective_*` columns.
 *
 * Exported (via `src/index.ts`) because the overlay write path needs exactly the
 * same computation, and a second implementation of it is precisely the drift this
 * whole design exists to prevent.
 */
export function projectEffective(
  row: TransactionRow,
  fact: TransactionProviderRow,
  merchantIds: ReadonlyMap<string, string>,
): TransactionRow {
  const effective = resolveEffective(factOf(fact), overlayOf(row));
  return {
    ...row,
    effectiveDate: effective.date,
    effectiveAmountMinor: effective.amount.minor,
    effectiveCurrency: effective.amount.currency,
    effectiveName: effective.name,
    effectiveMerchantId:
      effective.merchantKey === null ? null : (merchantIds.get(effective.merchantKey) ?? null),
    pending: effective.pending,
  };
}

/**
 * Cross-provider duplicate detection.
 *
 * The fingerprint excludes the provider and the provider's id, because those are
 * exactly what differs between two sightings of one purchase (a bank linked
 * through both Plaid and a CSV import). A match is only ever **marked**
 * (`superseded_by_id`, reason `duplicate`), never merged and never deleted.
 *
 * Two rows from the **same** provider sharing a fingerprint are left alone on
 * purpose: two identical coffees on the same day at the same shop are a real and
 * common event, and no provider reports one purchase twice under two ids.
 */
async function syncDedupKeys(
  executor: LedgerExecutor,
  store: PlanStore,
  userId: string,
  provider: string,
  touched: readonly TxnPlan[],
  now: Date,
): Promise<string[]> {
  if (touched.length === 0) return [];

  const rows = [];
  for (const plan of touched) {
    const fact = store.factsById.get(plan.row.currentFactId);
    if (fact === undefined) continue;
    const nameKey = normaliseMerchantName(fact.row.merchantName ?? fact.row.name).key;
    rows.push({
      id: newId(),
      userId,
      transactionId: plan.row.id,
      accountId: plan.row.accountId,
      provider,
      dedupKey: dedupKeyOf({
        postedDate: dateOnlyOf(fact.row.postedDate),
        amount: moneyOf(fact.row.amountMinor, fact.row.currency),
        nameKey,
      }),
      nameKey,
      postedDate: fact.row.postedDate,
      amountMinor: fact.row.amountMinor,
      currency: fact.row.currency,
      createdAt: now,
    });
  }
  if (rows.length === 0) return [];

  for (const chunk of chunked(rows, INSERT_CHUNK)) {
    await executor
      .insert(ledgerDedupKeys)
      .values(chunk)
      .onConflictDoUpdate({
        target: ledgerDedupKeys.transactionId,
        set: {
          dedupKey: sql`excluded.dedup_key`,
          nameKey: sql`excluded.name_key`,
          postedDate: sql`excluded.posted_date`,
          amountMinor: sql`excluded.amount_minor`,
          currency: sql`excluded.currency`,
          provider: sql`excluded.provider`,
          accountId: sql`excluded.account_id`,
        },
      });
  }

  const rivals = new Map<string, { transactionId: string; provider: string }[]>();
  for (const chunk of chunked([...new Set(rows.map((row) => row.dedupKey))], SELECT_CHUNK)) {
    const found = await executor
      .select({
        transactionId: ledgerDedupKeys.transactionId,
        dedupKey: ledgerDedupKeys.dedupKey,
        provider: ledgerDedupKeys.provider,
      })
      .from(ledgerDedupKeys)
      .where(and(eq(ledgerDedupKeys.userId, userId), inArray(ledgerDedupKeys.dedupKey, chunk)));
    for (const row of found) {
      const bucket = rivals.get(row.dedupKey) ?? [];
      bucket.push({ transactionId: row.transactionId, provider: row.provider });
      rivals.set(row.dedupKey, bucket);
    }
  }

  const marked: string[] = [];
  for (const row of rows) {
    // UUIDv7 is time-ordered, so the lexicographically smaller id is the one we
    // saw first. The newcomer is the duplicate; the original keeps its place in
    // every aggregate that has already counted it.
    const original = (rivals.get(row.dedupKey) ?? [])
      .filter((rival) => rival.provider !== provider && rival.transactionId < row.transactionId)
      .sort((a, b) => (a.transactionId < b.transactionId ? -1 : 1))[0];
    if (original === undefined) continue;
    const updated = await executor
      .update(transactions)
      .set({
        supersededById: original.transactionId,
        supersededReason: 'duplicate',
        updatedAt: now,
      })
      .where(and(eq(transactions.id, row.transactionId), isNull(transactions.supersededById)))
      .returning({ id: transactions.id });
    if (updated.length > 0) marked.push(row.transactionId);
  }
  return marked;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Append inside the caller's transaction, and only when something changed.
 *
 * A replayed page that touched nothing appends nothing. Consumers recompute a
 * deterministic function of current state, so waking four of them to recompute an
 * unchanged answer is pure cost — and that property is what makes the idempotency
 * test assertable: "apply twice" must leave the outbox exactly one event longer,
 * not two.
 */
async function emitEvents(
  executor: LedgerExecutor,
  input: ApplyProviderTransactionsInput,
  result: ApplyResult,
): Promise<void> {
  const context = {
    userId: input.userId,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
  };
  const outbox = outboxOf(executor);

  for (const event of result.superseded) {
    await appendEvent(
      outbox,
      TransactionSupersededByPosted.create(
        {
          transactionId: event.transactionId,
          accountId: input.accountId,
          pendingFactId: event.pendingFactId,
          postedFactId: event.postedFactId,
          amountChanged: event.amountChanged,
          dateChanged: event.dateChanged,
        },
        { ...context, aggregateId: event.transactionId },
        input.clock,
      ),
    );
  }

  const changed =
    result.addedTransactionIds.length +
    result.updatedTransactionIds.length +
    result.removedTransactionIds.length;
  if (changed === 0) return;

  await appendEvent(
    outbox,
    TransactionsUpserted.create(
      {
        accountId: input.accountId,
        addedIds: [...result.addedTransactionIds],
        updatedIds: [...result.updatedTransactionIds],
        removedIds: [...result.removedTransactionIds],
        dateFrom: result.effectiveDateFrom,
        dateTo: result.effectiveDateTo,
        count: changed,
      },
      { ...context, aggregateId: input.accountId },
      input.clock,
    ),
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * The content hash behind idempotency layer 2 (04 §4.4).
 *
 * Everything the provider stated that we model, in canonical key order, so a
 * `modified` carrying a semantically identical payload hashes identically no
 * matter how the adapter happened to order its object keys. `raw` is deliberately
 * excluded: a provider adding a field we do not model should not manufacture a
 * revision on every row it has ever sent.
 */
export function contentHashOf(provider: string, item: ProviderTransactionInput): string {
  const material = canonicalJson({
    provider,
    providerTransactionId: item.providerTransactionId,
    pendingTransactionId: item.pendingTransactionId,
    amountMinor: item.amount.minor.toString(),
    currency: item.amount.currency,
    isoCurrency: item.isoCurrency,
    postedDate: item.postedDate,
    authorizedDate: item.authorizedDate,
    postedAt: item.postedAt?.toISOString() ?? null,
    authorizedAt: item.authorizedAt?.toISOString() ?? null,
    name: item.name,
    merchantName: item.merchantName,
    originalDescription: item.originalDescription,
    paymentChannel: item.paymentChannel,
    providerCategory: item.providerCategory ?? null,
    pending: item.pending,
    location: item.location ?? null,
    counterparties: item.counterparties ?? null,
  });
  const digest = sha256(new TextEncoder().encode(material));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** The provider-stated columns of a fact row, shared by insert and revision. */
function factColumnsOf(item: ProviderTransactionInput) {
  return {
    providerTransactionId: item.providerTransactionId,
    pendingTransactionId: item.pendingTransactionId,
    amountMinor: item.amount.minor,
    currency: item.amount.currency,
    isoCurrency: item.isoCurrency,
    postedDate: item.postedDate as string,
    authorizedDate: item.authorizedDate as string | null,
    postedAt: item.postedAt,
    authorizedAt: item.authorizedAt,
    name: item.name,
    merchantName: item.merchantName,
    originalDescription: item.originalDescription,
    paymentChannel: item.paymentChannel,
    providerCategory: item.providerCategory ?? null,
    pending: item.pending,
    location: item.location ?? null,
    counterparties: item.counterparties ?? null,
    raw: item.raw ?? {},
  };
}

/** Last statement wins: a page mentioning one id twice is the provider's call. */
function dedupeIncoming(items: readonly ProviderTransactionInput[]): ProviderTransactionInput[] {
  const byId = new Map<string, ProviderTransactionInput>();
  for (const item of items) byId.set(item.providerTransactionId, item);
  return [...byId.values()];
}

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}
