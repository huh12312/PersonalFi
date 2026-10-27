// SPDX-License-Identifier: MIT
/**
 * The service: the engine, plus a database and a clock.
 *
 * Everything here is a thin shell around `decide()`. The split is deliberate and
 * it is what makes the accuracy numbers in this WP's evidence document mean
 * anything: the decision logic is a pure function measured against a golden set
 * with no database in the loop, and this file is the part that reads the inputs,
 * writes the rows and emits the events. A bug in the first is a wrong category; a
 * bug in the second is a lost one. They are found by different tests.
 */
import { newId } from '@core/kernel';
import { appendEvent } from '@core/platform';
import { sql } from 'drizzle-orm';
import { COLD_MODEL, train, type ClassifierModel } from './classifier.ts';
import {
  confidenceText,
  outboxOf,
  type CategorizationContext,
  type CategorizationDatabase,
  type CategorizationExecutor,
} from './db.ts';
import {
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_MERCHANT_SUPPORT,
  classifierFeaturesOf,
  decide,
  shouldReplace,
  type AssignmentSource,
  type Decision,
  type DecisionInput,
  type MerchantDefault,
} from './engine.ts';
import { AssignmentsChanged, MerchantDefaultLearned, RuleApplied } from './events.ts';
import { CategorizationError } from './errors.ts';
import {
  streamTransactions,
  type CategorizableTransaction,
  type LedgerPort,
} from './ledger-port.ts';
import { cleanDescriptor } from './normalize/descriptor.ts';
import { fingerprint } from './normalize/fingerprint.ts';
import { titleCase } from './normalize/cluster.ts';
import { matchRule } from './rules/match.ts';
import {
  IMPLEMENTED_ACTIONS,
  ruleSchema,
  type Rule,
  type RuleAction,
  type RuleConditions,
} from './rules/schema.ts';
import { categoryIdsByKey, categoryKeysById } from './seed-taxonomy.ts';
import { UNCATEGORISED_KEY, isAssignableKey } from './taxonomy.ts';

/** What triggered a batch. Carried on `AssignmentsChanged` for replay clarity. */
export type CategorizationTrigger =
  'sync' | 'rule_apply' | 'confirm' | 'backfill' | 'model_retrain';

export interface CategorizeResult {
  readonly considered: number;
  readonly written: number;
  readonly skipped: number;
  readonly bySource: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Loading the decision context
// ---------------------------------------------------------------------------

/**
 * Read every rule, dropping the ones that no longer parse.
 *
 * A rule stored months ago by a schema that has since changed must not be able
 * to stop a sync. It is skipped, and the reason is returned so the caller can log
 * it once per pass rather than once per transaction — forty transactions each
 * logging the same broken rule is how a real signal gets buried.
 */
export async function loadRules(
  executor: CategorizationExecutor,
  userId: string,
): Promise<{ rules: readonly Rule[]; rejected: readonly { id: string; reason: string }[] }> {
  const result = await executor.execute<Record<string, unknown>>(sql`
    SELECT id, user_id, name, priority, enabled, conditions, actions,
           run_on_sync, stop_processing, created_from_transaction_id
      FROM rules
     WHERE user_id = ${userId}
     ORDER BY priority, id
  `);

  const rules: Rule[] = [];
  const rejected: { id: string; reason: string }[] = [];
  for (const row of result.rows) {
    const parsed = ruleSchema.safeParse({
      id: row['id'],
      userId: row['user_id'],
      name: row['name'],
      priority: row['priority'],
      enabled: row['enabled'],
      conditions: row['conditions'],
      actions: row['actions'],
      runOnSync: row['run_on_sync'],
      stopProcessing: row['stop_processing'],
      createdFromTransactionId: row['created_from_transaction_id'] ?? null,
    });
    if (parsed.success) rules.push(parsed.data);
    else
      rejected.push({
        id: String(row['id']),
        reason: parsed.error.issues[0]?.message ?? 'invalid',
      });
  }
  return { rules, rejected };
}

/** The active model, or the cold one. A user with no confirmations has the cold one. */
export async function loadClassifier(
  executor: CategorizationExecutor,
  userId: string,
): Promise<ClassifierModel> {
  const result = await executor.execute<{ model: ClassifierModel }>(
    sql`SELECT model FROM classifier_versions WHERE user_id = ${userId} AND is_active LIMIT 1`,
  );
  return result.rows[0]?.model ?? COLD_MODEL;
}

interface MerchantDefaultRow extends Record<string, unknown> {
  id: string;
  ledger_merchant_id: string;
  category_key: string | null;
  default_support_count: number;
  user_locked: boolean;
}

/** Every merchant default in one query, keyed by ledger merchant id. */
export async function loadMerchantDefaults(
  executor: CategorizationExecutor,
  userId: string,
): Promise<ReadonlyMap<string, MerchantDefault>> {
  const result = await executor.execute<MerchantDefaultRow>(sql`
    SELECT p.id, p.ledger_merchant_id, c.key AS category_key,
           p.default_support_count, p.user_locked
      FROM merchant_profiles p
      LEFT JOIN categories c ON c.id = p.default_category_id
     WHERE p.user_id = ${userId} AND p.default_category_id IS NOT NULL
  `);
  const defaults = new Map<string, MerchantDefault>();
  for (const row of result.rows) {
    if (row.category_key === null) continue;
    defaults.set(row.ledger_merchant_id, {
      categoryKey: row.category_key,
      locked: row.user_locked,
      supportCount: row.default_support_count,
    });
  }
  return defaults;
}

export interface CategorizeOptions {
  readonly confidenceFloor?: number;
  readonly merchantSupportThreshold?: number;
  readonly trigger?: CategorizationTrigger;
  readonly ruleId?: string | null;
  /** Decide, report, and write nothing. What `applyRule`'s preview mode uses. */
  readonly dryRun?: boolean;
}

/** Turn a ledger row into the engine's input. The one place the mapping lives. */
export function decisionInputOf(transaction: CategorizableTransaction): DecisionInput {
  return {
    transactionId: transaction.id,
    payee: transaction.payee,
    cleanedPayee: cleanDescriptor(transaction.rawDescriptor || transaction.payee).cleaned,
    amountMinor: transaction.amountMinor,
    currency: transaction.currency,
    accountId: transaction.accountId,
    accountType: transaction.accountType,
    date: transaction.date,
    providerCategory: transaction.providerCategory,
    mcc: transaction.mcc,
    isTransfer: transaction.isTransfer,
    userCategoryId: transaction.userCategoryId,
  };
}

// ---------------------------------------------------------------------------
// The main write path
// ---------------------------------------------------------------------------

/**
 * Decide and record a category for each of `transactionIds`.
 *
 * The whole batch runs in one database transaction so the assignments and the
 * `AssignmentsChanged` event commit together — an assignment written without its
 * event is an assignment no budget ever hears about, and a crash between the two
 * is exactly what the outbox exists to make impossible (decision D7).
 *
 * **Idempotent**, in 04 §5.2's sense: a row is rewritten only when the fresh
 * decision comes from a tier at least as authoritative as the stored one *and*
 * actually says something different. Re-running a sync page therefore writes
 * nothing and emits an event with `count: 0`, rather than churning history and
 * waking every consumer.
 */
export async function categorizeTransactions(
  database: CategorizationDatabase,
  port: LedgerPort,
  input: { readonly transactionIds?: readonly string[]; readonly accountIds?: readonly string[] },
  context: CategorizationContext,
  options: CategorizeOptions = {},
): Promise<CategorizeResult> {
  const trigger = options.trigger ?? 'sync';

  return database.transaction(async (tx) => {
    const executor = tx as unknown as CategorizationExecutor;
    // Sequential, not `Promise.all`. A Drizzle transaction handle is one pooled
    // client, and node-postgres serialises concurrent queries on a single client
    // behind a deprecation warning today and an error in pg 9. Four round trips
    // once per batch is not the cost worth taking that risk for.
    const { rules } = await loadRules(executor, context.userId);
    const classifier = await loadClassifier(executor, context.userId);
    const merchantDefaults = await loadMerchantDefaults(executor, context.userId);
    const idByKey = await categoryIdsByKey(executor, context.userId);

    if (idByKey.size === 0) {
      throw new CategorizationError(
        'categorization.taxonomy_not_seeded',
        'this user has no categories; call seedSystemTaxonomy() first',
        { userId: context.userId },
      );
    }

    const decisionContext = {
      rules: trigger === 'sync' ? rules.filter((rule) => rule.runOnSync) : rules,
      merchantDefault: null,
      classifier,
      confidenceFloor: options.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR,
      merchantSupportThreshold: options.merchantSupportThreshold ?? DEFAULT_MERCHANT_SUPPORT,
    };

    const changed: string[] = [];
    const bySource: Record<string, number> = {};
    let considered = 0;
    let skipped = 0;

    for await (const transaction of streamTransactions(port, {
      userId: context.userId,
      ...(input.transactionIds === undefined ? {} : { transactionIds: input.transactionIds }),
      ...(input.accountIds === undefined ? {} : { accountIds: input.accountIds }),
    })) {
      considered += 1;

      const decision = decide(decisionInputOf(transaction), {
        ...decisionContext,
        merchantDefault:
          transaction.merchantId === null
            ? null
            : (merchantDefaults.get(transaction.merchantId) ?? null),
      });

      // Tier 1 won: the user already said so through the ledger's overlay, and
      // this context has nothing to add. Recording an assignment here would
      // create a second answer to "what category is this?", which is the exact
      // failure the overlay design exists to prevent.
      if (decision.source === 'user') {
        skipped += 1;
        continue;
      }

      const wrote =
        options.dryRun === true
          ? await wouldWrite(executor, transaction.id, decision, idByKey)
          : await writeAssignment(executor, transaction.id, decision, idByKey, context);

      if (!wrote) {
        // WP 11.1: every tier abstained and nothing was ever assigned, so
        // `category_assignments` has no row to hold the working. Keep it
        // anyway, in `category_abstentions`, so the Inbox's "why" is read
        // from what decided rather than re-decided. A preview writes nothing.
        if (options.dryRun !== true && decision.source === 'none') {
          await recordAbstention(executor, transaction.id, decision, context);
        }
        skipped += 1;
        continue;
      }
      changed.push(transaction.id);
      bySource[decision.source] = (bySource[decision.source] ?? 0) + 1;

      // The rule tier's write path (wp1.4 evidence §6): only a *winning* rule
      // decision is worth pushing to @ctx/ledger's resolveEffective seam. A
      // preview never writes anything, here or anywhere (dryRun above already
      // guaranteed that), and every other source (merchant_default, provider,
      // classifier, none) is a tier ledger has no column for — it stays entirely
      // in this context's own category_assignments, read back through
      // explainAssignment.
      if (options.dryRun !== true && decision.source === 'rule') {
        const ruleCategoryId = idByKey.get(decision.categoryKey);
        if (ruleCategoryId !== undefined) {
          await port.writeRuleCategory({
            userId: context.userId,
            transactionId: transaction.id,
            ruleCategoryId,
            correlationId: context.correlationId,
            causationId: context.causationId ?? null,
          });
        }
      }
    }

    if (changed.length > 0 && options.dryRun !== true) {
      await appendEvent(
        outboxOf(executor),
        AssignmentsChanged.create(
          {
            transactionIds: changed,
            count: changed.length,
            bySource,
            trigger,
            ruleId: options.ruleId ?? null,
          },
          {
            userId: context.userId,
            correlationId: context.correlationId,
            causationId: context.causationId ?? null,
          },
        ),
      );
    }

    return { considered, written: changed.length, skipped, bySource };
  });
}

/** True when this decision would change the stored answer. No writes. */
async function wouldWrite(
  executor: CategorizationExecutor,
  transactionId: string,
  decision: Decision,
  idByKey: ReadonlyMap<string, string>,
): Promise<boolean> {
  const categoryId = idByKey.get(decision.categoryKey);
  if (categoryId === undefined) return false;
  const current = await currentAssignment(executor, transactionId);
  if (current === null) return decision.categoryKey !== UNCATEGORISED_KEY;
  if (!shouldReplace(current.source, decision.source)) return false;
  return current.categoryId !== categoryId || current.source !== decision.source;
}

interface CurrentAssignment {
  id: string;
  categoryId: string;
  source: AssignmentSource;
  version: number;
}

async function currentAssignment(
  executor: CategorizationExecutor,
  transactionId: string,
): Promise<CurrentAssignment | null> {
  const result = await executor.execute<{
    id: string;
    category_id: string;
    source: AssignmentSource;
    version: number;
  }>(sql`
    SELECT id, category_id, source, version
      FROM category_assignments
     WHERE transaction_id = ${transactionId} AND is_current
     LIMIT 1
  `);
  const row = result.rows[0];
  return row === null || row === undefined
    ? null
    : { id: row.id, categoryId: row.category_id, source: row.source, version: row.version };
}

/**
 * Write one decision, superseding whatever was current.
 *
 * Returns false when nothing was written, which happens far more often than it
 * is written: on a re-sync, every row already has the answer this pass just
 * recomputed. Two guards, in order, and both matter:
 *
 *   1. `shouldReplace` — never demote. A transaction categorised by a rule must
 *      not fall back to the classifier because the rule was disabled.
 *   2. same category *and* same source — a no-op write would still bump the
 *      version, grow the history, and put the transaction in an event that wakes
 *      every downstream consumer for nothing.
 */
async function writeAssignment(
  executor: CategorizationExecutor,
  transactionId: string,
  decision: Decision,
  idByKey: ReadonlyMap<string, string>,
  context: CategorizationContext,
): Promise<boolean> {
  const categoryId = idByKey.get(decision.categoryKey);
  if (categoryId === undefined) return false;

  const current = await currentAssignment(executor, transactionId);
  if (current !== null) {
    if (!shouldReplace(current.source, decision.source)) return false;
    if (current.categoryId === categoryId && current.source === decision.source) return false;
  } else if (decision.categoryKey === UNCATEGORISED_KEY) {
    // Recording "we don't know" as the very first thing we ever say about a
    // transaction buys a row and says nothing. The absence of an assignment
    // already means uncategorised, and the review queue reads both.
    return false;
  }

  const now = context.clock.now();
  // Demote first, then insert: the partial unique index on `is_current` makes
  // the other order fail, which is the index doing its job.
  if (current !== null) {
    await executor.execute(
      sql`UPDATE category_assignments SET is_current = FALSE WHERE id = ${current.id}`,
    );
  }

  await executor.execute(sql`
    INSERT INTO category_assignments
      (id, user_id, transaction_id, category_id, source, confidence, rule_id, evidence,
       decided_at, version, is_current)
    VALUES (
      ${newId()}, ${context.userId}, ${transactionId}, ${categoryId}, ${decision.source},
      ${confidenceText(decision.confidence)}::numeric, ${decision.ruleId},
      ${JSON.stringify({ chain: decision.chain, deferredActions: decision.deferredActions })}::jsonb,
      ${now.toISOString()}::timestamptz, ${(current?.version ?? 0) + 1}, TRUE
    )
  `);
  await clearAbstention(executor, context.userId, transactionId);
  return true;
}

/**
 * Record the working behind an abstention, when there is no assignment to hold it.
 *
 * Rewritten only when the chain changes (`IS DISTINCT FROM`), so a re-sync that
 * reaches the same abstention writes nothing and `decided_at` keeps saying when
 * that working was first recorded. A transaction that already has an assignment
 * keeps its assignment's working: an abstention never demotes (`shouldReplace`),
 * so the stored assignment is still the answer and still the explanation.
 */
async function recordAbstention(
  executor: CategorizationExecutor,
  transactionId: string,
  decision: Decision,
  context: CategorizationContext,
): Promise<void> {
  const current = await currentAssignment(executor, transactionId);
  if (current !== null) return;
  await executor.execute(sql`
    INSERT INTO category_abstentions (id, user_id, transaction_id, evidence, decided_at)
    VALUES (
      ${newId()}, ${context.userId}, ${transactionId},
      ${JSON.stringify({ chain: decision.chain })}::jsonb,
      ${context.clock.now().toISOString()}::timestamptz
    )
    ON CONFLICT (user_id, transaction_id) DO UPDATE SET
      evidence = EXCLUDED.evidence,
      decided_at = EXCLUDED.decided_at
    WHERE category_abstentions.evidence IS DISTINCT FROM EXCLUDED.evidence
  `);
}

/** An assignment now holds the working; the abstention it replaces is stale. */
async function clearAbstention(
  executor: CategorizationExecutor,
  userId: string,
  transactionId: string,
): Promise<void> {
  await executor.execute(
    sql`DELETE FROM category_abstentions WHERE user_id = ${userId} AND transaction_id = ${transactionId}`,
  );
}

// ---------------------------------------------------------------------------
// Explainability
// ---------------------------------------------------------------------------

export interface AssignmentExplanation {
  readonly transactionId: string;
  readonly categoryKey: string;
  readonly categoryLabel: string;
  readonly source: AssignmentSource;
  readonly confidence: number;
  readonly ruleId: string | null;
  readonly decidedAt: Date;
  readonly version: number;
  readonly confirmedAt: Date | null;
  /** Every tier, in order, including those that abstained and why. */
  readonly chain: readonly unknown[];
  /** Earlier decisions about this transaction, newest first. */
  readonly history: readonly {
    readonly categoryKey: string;
    readonly source: AssignmentSource;
    readonly version: number;
    readonly decidedAt: Date;
  }[];
}

/**
 * Why is this transaction in this category?
 *
 * Reads the *stored* chain rather than re-deciding. Recomputing would answer a
 * subtly different question — "what would we decide today?" — and would present
 * today's rules as the reason for a decision made under last month's. When those
 * two answers differ, the difference is the interesting part, and it is only
 * visible if the original is kept.
 */
export async function explainAssignment(
  executor: CategorizationExecutor,
  input: { readonly userId: string; readonly transactionId: string },
): Promise<AssignmentExplanation> {
  const result = await executor.execute<{
    category_key: string;
    category_label: string;
    source: AssignmentSource;
    confidence: string;
    rule_id: string | null;
    evidence: { chain?: unknown[] };
    decided_at: string | Date;
    version: number;
    confirmed_at: string | Date | null;
  }>(sql`
    SELECT c.key AS category_key, c.label AS category_label, a.source, a.confidence,
           a.rule_id, a.evidence, a.decided_at, a.version, a.confirmed_at
      FROM category_assignments a
      JOIN categories c ON c.id = a.category_id
     WHERE a.transaction_id = ${input.transactionId}
       AND a.user_id = ${input.userId}
       AND a.is_current
     LIMIT 1
  `);

  const row = result.rows[0];
  if (row === undefined) {
    throw new CategorizationError(
      'categorization.assignment_not_found',
      `no current assignment for transaction ${input.transactionId}`,
      { transactionId: input.transactionId },
    );
  }

  const historyResult = await executor.execute<{
    category_key: string;
    source: AssignmentSource;
    version: number;
    decided_at: string | Date;
  }>(sql`
    SELECT c.key AS category_key, a.source, a.version, a.decided_at
      FROM category_assignments a
      JOIN categories c ON c.id = a.category_id
     WHERE a.transaction_id = ${input.transactionId} AND NOT a.is_current
     ORDER BY a.version DESC
  `);

  return {
    transactionId: input.transactionId,
    categoryKey: row.category_key,
    categoryLabel: row.category_label,
    source: row.source,
    confidence: Number(row.confidence),
    ruleId: row.rule_id,
    decidedAt: new Date(row.decided_at),
    version: row.version,
    confirmedAt: row.confirmed_at === null ? null : new Date(row.confirmed_at),
    chain: row.evidence?.chain ?? [],
    history: historyResult.rows.map((entry) => ({
      categoryKey: entry.category_key,
      source: entry.source,
      version: entry.version,
      decidedAt: new Date(entry.decided_at),
    })),
  };
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

export interface ConfirmResult {
  readonly transactionId: string;
  readonly categoryKey: string;
  readonly merchantDefaultUpdated: boolean;
  readonly merchantSupportCount: number;
  readonly featuresCounted: number;
}

/**
 * The user says "this is the category".
 *
 * Three things happen, and the order is load bearing:
 *
 *   1. a `user`-sourced assignment supersedes whatever was current — this is the
 *      record of intent, and nothing below may ever outvote it;
 *   2. the classifier's feature counts go up, which is what makes the next
 *      similar transaction easier;
 *   3. the merchant's learned default moves, and crosses a threshold at three
 *      (04 §5.2: "if ≥ 3 prior transactions for this merchant share a
 *      user-assigned category, adopt it").
 *
 * Step 3 only counts confirmations that *agree*. A merchant where the user has
 * filed four transactions under Groceries and one under Shopping has a support
 * count of four for Groceries, not five — otherwise a single correction would
 * push a merchant over a threshold on the strength of disagreement.
 *
 * Note what this does **not** do: write `@ctx/ledger`'s `user_category_id`. That
 * column is the ledger's overlay and only `setTransactionOverlay` may write it;
 * the API layer calls both, in one request, and the evidence document proposes
 * the ledger hook that makes the two views agree.
 */
export async function confirmAssignment(
  database: CategorizationDatabase,
  input: {
    readonly transactionId: string;
    readonly categoryKey: string;
    readonly transaction: CategorizableTransaction;
  },
  context: CategorizationContext,
): Promise<ConfirmResult> {
  if (!isAssignableKey(input.categoryKey)) {
    throw new CategorizationError(
      'categorization.category_not_assignable',
      `${input.categoryKey} is not a leaf category`,
      { categoryKey: input.categoryKey },
    );
  }

  return database.transaction(async (tx) => {
    const executor = tx as unknown as CategorizationExecutor;
    const idByKey = await categoryIdsByKey(executor, context.userId);
    const categoryId = idByKey.get(input.categoryKey);
    if (categoryId === undefined) {
      throw new CategorizationError(
        'categorization.category_not_found',
        `no category ${input.categoryKey} for this user`,
        { categoryKey: input.categoryKey },
      );
    }

    const now = context.clock.now();
    const current = await currentAssignment(executor, input.transactionId);
    if (current !== null) {
      await executor.execute(
        sql`UPDATE category_assignments SET is_current = FALSE WHERE id = ${current.id}`,
      );
    }
    await executor.execute(sql`
      INSERT INTO category_assignments
        (id, user_id, transaction_id, category_id, source, confidence, rule_id, evidence,
         decided_at, version, is_current, confirmed_at)
      VALUES (
        ${newId()}, ${context.userId}, ${input.transactionId}, ${categoryId}, 'user', 1.0000, NULL,
        ${JSON.stringify({ chain: [{ source: 'user', won: true, detail: 'You chose this category.' }] })}::jsonb,
        ${now.toISOString()}::timestamptz, ${(current?.version ?? 0) + 1}, TRUE, ${now.toISOString()}::timestamptz
      )
    `);
    await clearAbstention(executor, context.userId, input.transactionId);

    // --- 2. the classifier's corpus ---------------------------------------
    // `classifierFeaturesOf` over `decisionInputOf`: the features counted here
    // are, by construction, the features `decide` will score (WP 11.1 added
    // the provider primary and the day of month, and both reach training only
    // because this goes through the same function).
    const features = classifierFeaturesOf(decisionInputOf(input.transaction));
    for (const feature of features) {
      await executor.execute(sql`
        INSERT INTO classifier_examples (id, user_id, feature, category_id, count, updated_at)
        VALUES (${newId()}, ${context.userId}, ${feature}, ${categoryId}, 1, ${now.toISOString()}::timestamptz)
        ON CONFLICT (user_id, feature, category_id)
        DO UPDATE SET count = classifier_examples.count + 1, updated_at = EXCLUDED.updated_at
      `);
    }

    // --- 3. the merchant's default ----------------------------------------
    let merchantDefaultUpdated = false;
    let merchantSupportCount = 0;
    const merchantId = input.transaction.merchantId;
    if (merchantId !== null) {
      // Support is *accumulated* rather than recounted: a confirmation is by
      // construction one more agreeing observation, and the `ON CONFLICT` below
      // does the arithmetic in one statement. The counter is a cache of "how
      // many confirmed assignments agree", and the confirmed assignments are
      // still the source of truth if it ever needs rebuilding.
      const cleaned = cleanDescriptor(
        input.transaction.rawDescriptor || input.transaction.payee,
      ).cleaned;
      const profile = await executor.execute<{
        id: string;
        default_category_id: string | null;
        default_support_count: number;
        user_locked: boolean;
      }>(sql`
        INSERT INTO merchant_profiles
          (id, user_id, ledger_merchant_id, canonical_name, fingerprint,
           descriptor_patterns, default_category_id, default_support_count, last_seen_at)
        VALUES (
          ${newId()}, ${context.userId}, ${merchantId},
          ${titleCase(input.transaction.providerMerchantName ?? cleaned)},
          ${fingerprint(cleaned)}, ${JSON.stringify([cleaned])}::jsonb,
          ${categoryId}, 1, ${now.toISOString()}::timestamptz
        )
        ON CONFLICT (user_id, ledger_merchant_id) DO UPDATE SET
          -- A locked profile is the user's stated intent about the *merchant*,
          -- which a single transaction's confirmation must not silently move.
          default_category_id = CASE
            WHEN merchant_profiles.user_locked THEN merchant_profiles.default_category_id
            ELSE EXCLUDED.default_category_id END,
          default_support_count = CASE
            WHEN merchant_profiles.user_locked THEN merchant_profiles.default_support_count
            WHEN merchant_profiles.default_category_id = EXCLUDED.default_category_id
              THEN merchant_profiles.default_support_count + 1
            -- Disagreement resets to one rather than decrementing: the user just
            -- told us the old answer was wrong, and carrying its accumulated
            -- support forward would keep applying it.
            ELSE 1 END,
          descriptor_patterns = CASE
            WHEN merchant_profiles.descriptor_patterns @> EXCLUDED.descriptor_patterns
              THEN merchant_profiles.descriptor_patterns
            ELSE merchant_profiles.descriptor_patterns || EXCLUDED.descriptor_patterns END,
          last_seen_at = EXCLUDED.last_seen_at,
          updated_at = now()
        RETURNING id, default_category_id, default_support_count, user_locked
      `);

      const row = profile.rows[0];
      if (row !== undefined) {
        merchantDefaultUpdated = true;
        merchantSupportCount = row.default_support_count;
        // Emitted at the crossing, not on every confirmation: the fact worth
        // reacting to is "this merchant became automatic", and saying it once is
        // the difference between the app feeling like it learned and nagging.
        if (row.default_support_count === DEFAULT_MERCHANT_SUPPORT) {
          await appendEvent(
            outboxOf(executor),
            MerchantDefaultLearned.create(
              {
                merchantProfileId: row.id,
                ledgerMerchantId: merchantId,
                categoryId,
                supportCount: row.default_support_count,
                locked: row.user_locked,
              },
              { userId: context.userId, correlationId: context.correlationId },
            ),
          );
        }
      }
    }

    await appendEvent(
      outboxOf(executor),
      AssignmentsChanged.create(
        {
          transactionIds: [input.transactionId],
          count: 1,
          bySource: { user: 1 },
          trigger: 'confirm',
          ruleId: null,
        },
        { userId: context.userId, correlationId: context.correlationId },
      ),
    );

    return {
      transactionId: input.transactionId,
      categoryKey: input.categoryKey,
      merchantDefaultUpdated,
      merchantSupportCount,
      featuresCounted: features.length,
    };
  });
}

/**
 * Rebuild the classifier from the confirmed corpus and activate it.
 *
 * A full retrain, not an incremental update: with a few thousand features it
 * takes milliseconds, and "the model is a pure function of the confirmed
 * assignments" means a bug in training is fixed by re-running training rather
 * than by repairing accumulated state.
 */
export async function retrainClassifier(
  database: CategorizationDatabase,
  context: CategorizationContext,
): Promise<ClassifierModel> {
  return database.transaction(async (tx) => {
    const executor = tx as unknown as CategorizationExecutor;
    const keyById = await categoryKeysById(executor, context.userId);

    const counts = await executor.execute<{
      feature: string;
      category_id: string;
      count: number;
    }>(sql`
      SELECT feature, category_id, count
        FROM classifier_examples
       WHERE user_id = ${context.userId} AND count > 0
    `);

    // `train` takes examples, not counts, because a count table is an
    // optimisation of a corpus and the model should not know that. Expanding
    // here keeps `train` testable from a plain list in a unit test.
    const examples: { features: string[]; categoryKey: string }[] = [];
    const perCategoryFeatures = new Map<string, string[]>();
    for (const row of counts.rows) {
      const key = keyById.get(row.category_id);
      if (key === undefined) continue;
      const bucket = perCategoryFeatures.get(key) ?? [];
      for (let index = 0; index < row.count; index += 1) bucket.push(row.feature);
      perCategoryFeatures.set(key, bucket);
    }

    const confirmed = await executor.execute<{ category_id: string; count: string }>(sql`
      SELECT category_id, count(*) AS count
        FROM category_assignments
       WHERE user_id = ${context.userId} AND confirmed_at IS NOT NULL AND is_current
       GROUP BY category_id
    `);
    for (const row of confirmed.rows) {
      const key = keyById.get(row.category_id);
      if (key === undefined) continue;
      const features = perCategoryFeatures.get(key) ?? [];
      const exampleCount = Number(row.count);
      const perExample = Math.max(1, Math.ceil(features.length / Math.max(1, exampleCount)));
      for (let index = 0; index < exampleCount; index += 1) {
        examples.push({
          features: features.slice(index * perExample, (index + 1) * perExample),
          categoryKey: key,
        });
      }
    }

    const model = train(examples);
    const version = await nextClassifierVersion(executor, context.userId);
    await executor.execute(
      sql`UPDATE classifier_versions SET is_active = FALSE WHERE user_id = ${context.userId} AND is_active`,
    );
    await executor.execute(sql`
      INSERT INTO classifier_versions
        (id, user_id, version, model, example_count, category_count, is_active, trained_at)
      VALUES (
        ${newId()}, ${context.userId}, ${version}, ${JSON.stringify({ ...model, version })}::jsonb,
        ${model.totalExamples}, ${Object.keys(model.categoryCounts).length}, TRUE,
        ${context.clock.now().toISOString()}::timestamptz
      )
    `);
    return { ...model, version };
  });
}

async function nextClassifierVersion(
  executor: CategorizationExecutor,
  userId: string,
): Promise<number> {
  const result = await executor.execute<{ version: number | null }>(
    sql`SELECT max(version) AS version FROM classifier_versions WHERE user_id = ${userId}`,
  );
  return (result.rows[0]?.version ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Every `set_category` action's `categoryKey`, resolved against *this user's*
 * own chart and required to be a leaf.
 *
 * The REST surface (WP 2.5) is the first place a rule's category can be
 * anything other than a value the caller typed straight from `TAXONOMY` — a
 * user's custom category (`createCategory`) is a row that exists for exactly
 * one user, keyed the same way a system one is. So this checks the *table*,
 * scoped to `userId`, rather than the static `isAssignableKey`: a key that
 * belongs to another user's custom category, or to nobody at all, is
 * indistinguishable from a typo and refused the same way —
 * `rules-routes.test.ts`'s "a rule may not be created for another user's
 * category".
 */
async function assertRuleCategoriesOwned(
  executor: CategorizationExecutor,
  userId: string,
  actions: readonly RuleAction[],
): Promise<void> {
  const keys = [
    ...new Set(
      actions
        .filter((action) => action.type === 'set_category')
        .map((action) => (action as Extract<RuleAction, { type: 'set_category' }>).categoryKey),
    ),
  ];
  if (keys.length === 0) return;

  const result = await executor.execute<{ key: string }>(sql`
    SELECT c.key
      FROM categories c
     WHERE c.user_id = ${userId}
       AND c.key IN (${keys})
       AND c.archived_at IS NULL
       AND (SELECT count(*) FROM categories child WHERE child.parent_id = c.id) = 0
  `);
  const owned = new Set(result.rows.map((row) => row.key));
  const missing = keys.find((key) => !owned.has(key));
  if (missing !== undefined) {
    throw new CategorizationError(
      'categorization.category_not_assignable',
      `${missing} is not an assignable category of yours`,
      { categoryKey: missing },
    );
  }
}

export interface RuleWriteInput {
  readonly name: string;
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly conditions: RuleConditions;
  readonly actions: readonly RuleAction[];
  readonly runOnSync?: boolean;
  readonly stopProcessing?: boolean;
}

export interface RuleRecord extends Rule {
  readonly lastAppliedAt: Date | null;
  readonly lastAppliedCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface RuleRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  name: string;
  priority: number;
  enabled: boolean;
  conditions: unknown;
  actions: unknown;
  run_on_sync: boolean;
  stop_processing: boolean;
  created_from_transaction_id: string | null;
  last_applied_at: string | Date | null;
  last_applied_count: number;
  created_at: string | Date;
  updated_at: string | Date;
}

function ruleRecordOf(row: RuleRow): RuleRecord {
  const parsed = ruleSchema.parse({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    priority: row.priority,
    enabled: row.enabled,
    conditions: row.conditions,
    actions: row.actions,
    runOnSync: row.run_on_sync,
    stopProcessing: row.stop_processing,
    createdFromTransactionId: row.created_from_transaction_id,
  });
  return {
    ...parsed,
    lastAppliedAt: row.last_applied_at === null ? null : new Date(row.last_applied_at),
    lastAppliedCount: Number(row.last_applied_count),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Every rule this user has, parsed and with its apply history. Distinct from
 * `loadRules` (above): that one feeds the matching engine and silently drops a
 * rule that fails to parse (a broken rule must not stop a sync); this one is
 * `GET /rules` and a rule the route cannot render is a bug the user should see,
 * not one hidden from them, so a parse failure here throws.
 */
export async function listRuleRecords(
  executor: CategorizationExecutor,
  userId: string,
): Promise<readonly RuleRecord[]> {
  const result = await executor.execute<RuleRow>(sql`
    SELECT id, user_id, name, priority, enabled, conditions, actions, run_on_sync,
           stop_processing, created_from_transaction_id, last_applied_at, last_applied_count,
           created_at, updated_at
      FROM rules
     WHERE user_id = ${userId}
     ORDER BY priority, id
  `);
  return result.rows.map(ruleRecordOf);
}

async function requireOwnRule(
  executor: CategorizationExecutor,
  userId: string,
  ruleId: string,
): Promise<RuleRecord> {
  const result = await executor.execute<RuleRow>(sql`
    SELECT id, user_id, name, priority, enabled, conditions, actions, run_on_sync,
           stop_processing, created_from_transaction_id, last_applied_at, last_applied_count,
           created_at, updated_at
      FROM rules
     WHERE id = ${ruleId} AND user_id = ${userId}
  `);
  const row = result.rows[0];
  // Scoped to `user_id` in the query, so another user's rule id reads as
  // "not found" rather than confirming it exists.
  if (row === undefined) {
    throw new CategorizationError('categorization.rule_not_found', `no rule ${ruleId}`, { ruleId });
  }
  return ruleRecordOf(row);
}

/** `POST /rules`. Validates the whole rule, including that its categories are this user's. */
export async function createRule(
  executor: CategorizationExecutor,
  input: { readonly userId: string } & RuleWriteInput,
): Promise<RuleRecord> {
  const candidate = {
    id: newId(),
    userId: input.userId,
    name: input.name,
    priority: input.priority ?? 100,
    enabled: input.enabled ?? true,
    conditions: input.conditions,
    actions: input.actions,
    runOnSync: input.runOnSync ?? true,
    stopProcessing: input.stopProcessing ?? false,
    createdFromTransactionId: null,
  };
  const parsed = ruleSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CategorizationError(
      'categorization.rule_invalid',
      parsed.error.issues[0]?.message ?? 'rule did not validate',
      { issues: parsed.error.issues },
    );
  }
  await assertRuleCategoriesOwned(executor, input.userId, parsed.data.actions);

  await executor.execute(sql`
    INSERT INTO rules
      (id, user_id, name, priority, enabled, conditions, actions, run_on_sync, stop_processing,
       created_from_transaction_id)
    VALUES (
      ${parsed.data.id}, ${input.userId}, ${parsed.data.name}, ${parsed.data.priority},
      ${parsed.data.enabled}, ${JSON.stringify(parsed.data.conditions)}::jsonb,
      ${JSON.stringify(parsed.data.actions)}::jsonb, ${parsed.data.runOnSync},
      ${parsed.data.stopProcessing}, NULL
    )
  `);

  return requireOwnRule(executor, input.userId, parsed.data.id);
}

/** `PATCH /rules/{id}`. Partial; unset fields keep their stored value. */
export async function updateRule(
  executor: CategorizationExecutor,
  input: { readonly userId: string; readonly ruleId: string } & Partial<RuleWriteInput>,
): Promise<RuleRecord> {
  const existing = await requireOwnRule(executor, input.userId, input.ruleId);

  const candidate = {
    id: existing.id,
    userId: existing.userId,
    name: input.name ?? existing.name,
    priority: input.priority ?? existing.priority,
    enabled: input.enabled ?? existing.enabled,
    conditions: input.conditions ?? existing.conditions,
    actions: input.actions ?? existing.actions,
    runOnSync: input.runOnSync ?? existing.runOnSync,
    stopProcessing: input.stopProcessing ?? existing.stopProcessing,
    createdFromTransactionId: existing.createdFromTransactionId,
  };
  const parsed = ruleSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CategorizationError(
      'categorization.rule_invalid',
      parsed.error.issues[0]?.message ?? 'rule did not validate',
      { issues: parsed.error.issues },
    );
  }
  if (input.actions !== undefined) {
    await assertRuleCategoriesOwned(executor, input.userId, parsed.data.actions);
  }

  await executor.execute(sql`
    UPDATE rules SET
      name            = ${parsed.data.name},
      priority        = ${parsed.data.priority},
      enabled         = ${parsed.data.enabled},
      conditions      = ${JSON.stringify(parsed.data.conditions)}::jsonb,
      actions         = ${JSON.stringify(parsed.data.actions)}::jsonb,
      run_on_sync     = ${parsed.data.runOnSync},
      stop_processing = ${parsed.data.stopProcessing},
      updated_at      = now()
     WHERE id = ${input.ruleId} AND user_id = ${input.userId}
  `);

  return requireOwnRule(executor, input.userId, input.ruleId);
}

/** `DELETE /rules/{id}`. Hard delete — `rule_runs` cascades with it (migration 0006). */
export async function deleteRule(
  executor: CategorizationExecutor,
  input: { readonly userId: string; readonly ruleId: string },
): Promise<{ readonly deleted: boolean }> {
  const result = await executor.execute<{ id: string }>(sql`
    DELETE FROM rules WHERE id = ${input.ruleId} AND user_id = ${input.userId} RETURNING id
  `);
  return { deleted: result.rows.length > 0 };
}

export interface ApplyRuleResult {
  readonly ruleId: string;
  /** The `rule_runs` row this produced. Present for a preview too — see below. */
  readonly runId: string;
  readonly preview: boolean;
  readonly matchedCount: number;
  /** How many assignments would change (preview) or did change (apply). */
  readonly changedCount: number;
  /** A sample of what would change, for the confirmation dialog. */
  readonly sample: readonly { readonly transactionId: string; readonly payee: string }[];
  /**
   * This rule's non-`set_category` actions that are in `IMPLEMENTED_ACTIONS`
   * (WP 2.5: `link_recurring`, `notify`, and anything earlier already there).
   * "Recorded", not "done" — see `rules/schema.ts`'s doc comment on
   * `IMPLEMENTED_ACTIONS`. Always empty for a preview.
   */
  readonly actionsRecorded: readonly RuleAction['type'][];
}

/** A matched rule's non-`set_category` actions that this phase can at least record. */
function implementedActionsOf(rule: Rule): readonly RuleAction['type'][] {
  return rule.actions
    .filter((action) => action.type !== 'set_category' && IMPLEMENTED_ACTIONS.has(action.type))
    .map((action) => action.type);
}

/**
 * Run one rule over existing transactions.
 *
 * `preview: true` is not a convenience — it is the feature. A retroactive rule
 * apply is the single most destructive thing this context can do to a user's
 * history, and "this will change 912 transactions" shown *before* the fact is
 * what turns that from a trap into a tool. The preview runs the same code path
 * with `dryRun` set, so the number it shows is produced by the logic that will
 * actually run, not by a second implementation that will drift from it.
 */
export async function applyRule(
  database: CategorizationDatabase,
  port: LedgerPort,
  input: { readonly ruleId: string; readonly retroactive?: boolean; readonly preview?: boolean },
  context: CategorizationContext,
  options: CategorizeOptions = {},
): Promise<ApplyRuleResult> {
  const preview = input.preview === true;
  const startedAt = context.clock.now();

  const { rules } = await loadRules(database as unknown as CategorizationExecutor, context.userId);
  const rule = rules.find((candidate) => candidate.id === input.ruleId);
  if (rule === undefined) {
    throw new CategorizationError('categorization.rule_not_found', `no rule ${input.ruleId}`, {
      ruleId: input.ruleId,
    });
  }

  // Find the matching transactions first, without writing anything. Matching is
  // pure and cheap; deciding is neither, and a rule that matches nothing should
  // cost one pass rather than one pass plus a transaction.
  const matched: { transactionId: string; payee: string }[] = [];
  for await (const transaction of streamTransactions(port, { userId: context.userId })) {
    const subject = {
      payee: transaction.payee,
      cleanedPayee: cleanDescriptor(transaction.rawDescriptor || transaction.payee).cleaned,
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
      accountId: transaction.accountId,
      date: transaction.date,
      providerCodes: providerCodes(transaction.providerCategory),
      isTransfer: transaction.isTransfer,
    };
    if (!matchRule(rule, subject).matched) continue;
    // Without `retroactive`, a rule only claims transactions nothing has
    // confidently claimed yet. With it, it re-decides everything it matches —
    // which `shouldReplace` still stops from overriding a user's own edit.
    if (input.retroactive !== true && transaction.userCategoryId !== null) continue;
    matched.push({ transactionId: transaction.id, payee: transaction.payee });
  }

  const result = await categorizeTransactions(
    database,
    port,
    { transactionIds: matched.map((entry) => entry.transactionId) },
    context,
    { ...options, trigger: 'rule_apply', ruleId: rule.id, dryRun: preview },
  );

  const runId = newId();

  if (preview) {
    // A preview is recorded too, and the reason is in this package's
    // OWNERSHIP.md: a preview count and the later apply count disagreeing is
    // exactly the signal that something moved in between, and it is invisible
    // after the fact unless both were written down. No `RuleApplied` event,
    // though — nothing happened, and a notification saying otherwise would be a
    // lie.
    await database.transaction(async (tx) => {
      const executor = tx as unknown as CategorizationExecutor;
      await executor.execute(sql`
        INSERT INTO rule_runs
          (id, user_id, rule_id, mode, retroactive, matched_count, changed_count, started_at, finished_at)
        VALUES (
          ${runId}, ${context.userId}, ${rule.id}, 'preview', ${input.retroactive === true},
          ${matched.length}, ${result.written},
          ${startedAt.toISOString()}::timestamptz, ${context.clock.now().toISOString()}::timestamptz
        )
      `);
    });

    return {
      ruleId: rule.id,
      runId,
      preview: true,
      matchedCount: matched.length,
      changedCount: result.written,
      sample: matched.slice(0, 10),
      actionsRecorded: [],
    };
  }

  const actionsRecorded = matched.length > 0 ? implementedActionsOf(rule) : [];

  await database.transaction(async (tx) => {
    const executor = tx as unknown as CategorizationExecutor;
    await executor.execute(sql`
      INSERT INTO rule_runs
        (id, user_id, rule_id, mode, retroactive, matched_count, changed_count, started_at, finished_at)
      VALUES (
        ${runId}, ${context.userId}, ${rule.id}, 'apply', ${input.retroactive === true},
        ${matched.length}, ${result.written},
        ${startedAt.toISOString()}::timestamptz, ${context.clock.now().toISOString()}::timestamptz
      )
    `);
    await executor.execute(sql`
      UPDATE rules
         SET last_applied_at = ${context.clock.now().toISOString()}::timestamptz,
             last_applied_count = ${result.written},
             updated_at = now()
       WHERE id = ${rule.id}
    `);
    await appendEvent(
      outboxOf(executor),
      RuleApplied.create(
        {
          ruleId: rule.id,
          runId,
          retroactive: input.retroactive === true,
          matchedCount: matched.length,
          changedCount: result.written,
          actionsRecorded: [...actionsRecorded],
        },
        { userId: context.userId, correlationId: context.correlationId },
      ),
    );
  });

  return {
    ruleId: rule.id,
    runId,
    preview: false,
    matchedCount: matched.length,
    changedCount: result.written,
    sample: matched.slice(0, 10),
    actionsRecorded,
  };
}

/**
 * "Always categorise CHEWY as Pets", from a transaction the user is looking at.
 *
 * 04 §5.2 asks for exactly this and says why: rules are the power feature and
 * "make them cheap to create from a transaction detail view". Cheap means the
 * user picks a category and presses a button — the payee condition is derived
 * from the *cleaned* descriptor, because a rule written against
 * `SQ *BLUE BOTTLE 4471` matches one transaction and a rule written against
 * `BLUE BOTTLE` matches the merchant.
 */
export async function createRuleFromTransaction(
  database: CategorizationDatabase,
  input: {
    readonly transaction: CategorizableTransaction;
    readonly categoryKey: string;
    readonly name?: string;
    readonly priority?: number;
    readonly runOnSync?: boolean;
  },
  context: CategorizationContext,
): Promise<Rule> {
  if (!isAssignableKey(input.categoryKey)) {
    throw new CategorizationError(
      'categorization.category_not_assignable',
      `${input.categoryKey} is not a leaf category`,
      { categoryKey: input.categoryKey },
    );
  }

  const cleaned = cleanDescriptor(
    input.transaction.rawDescriptor || input.transaction.payee,
  ).cleaned;
  const candidate = {
    id: newId(),
    userId: context.userId,
    name: input.name ?? `Always categorise ${titleCase(cleaned)}`,
    priority: input.priority ?? 100,
    enabled: true,
    conditions: {
      all: [{ type: 'payee' as const, match: 'contains' as const, value: cleaned }],
      any: [],
    },
    actions: [{ type: 'set_category' as const, categoryKey: input.categoryKey }],
    runOnSync: input.runOnSync ?? true,
    stopProcessing: false,
    createdFromTransactionId: input.transaction.id,
  };

  const parsed = ruleSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new CategorizationError(
      'categorization.rule_invalid',
      parsed.error.issues[0]?.message ?? 'rule did not validate',
      { issues: parsed.error.issues },
    );
  }

  await database.transaction(async (tx) => {
    const executor = tx as unknown as CategorizationExecutor;
    await executor.execute(sql`
      INSERT INTO rules
        (id, user_id, name, priority, enabled, conditions, actions, run_on_sync,
         stop_processing, created_from_transaction_id)
      VALUES (
        ${parsed.data.id}, ${context.userId}, ${parsed.data.name}, ${parsed.data.priority}, TRUE,
        ${JSON.stringify(parsed.data.conditions)}::jsonb, ${JSON.stringify(parsed.data.actions)}::jsonb,
        ${parsed.data.runOnSync}, FALSE, ${parsed.data.createdFromTransactionId}
      )
    `);
  });

  return parsed.data;
}

function providerCodes(raw: unknown): readonly string[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  return [record['primary'], record['detailed']].filter(
    (value): value is string => typeof value === 'string',
  );
}
