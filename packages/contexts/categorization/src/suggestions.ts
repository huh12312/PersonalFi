// SPDX-License-Identifier: MIT
/**
 * WP 11.2: category suggestions for the abstained residue — this context's half.
 *
 * 11 §3.1's residue row: where all six tiers abstain, a local model may
 * *propose* one category from the holder's own taxonomy with a one-line reason.
 * This file owns the data around that proposal and none of the model:
 *
 *   * **the payload** — `residueFeaturesOf` turns a transaction into exactly the
 *     classifier's own features (`classifierFeaturesOf`), less the MCC leaf:
 *     normalised payee tokens, MCC family, PFC primary, amount bucket, account
 *     kind, direction, day bucket. Never the memo, never an account id, never
 *     the raw descriptor beyond the normaliser's tokens. Building the payload
 *     *from* the feature list rather than beside it is what keeps the two from
 *     drifting: a field the classifier does not see cannot reach the model.
 *   * **the cache** — one answer per (merchant key, taxonomy version). The
 *     merchant key is the payee tokens, joined: the thing the model was shown.
 *   * **where a suggestion lands** — on the `category_abstentions` row, never in
 *     `category_assignments`. The row stays uncategorised; the Inbox shows a chip.
 *   * **"Not this"** — `rejected_at` on the cache row (the negative example) and
 *     the chip cleared on that merchant's rows. The classifier is not touched.
 *   * **the precision gate** — `category_suggestion_evals`, read by the Enable
 *     switch: ≥ 85 % precision over ≥ 20 scored rows (11 §6 item 4).
 *
 * The model call, its kill ladder, its approval and its validation are
 * `@ctx/insights`' (`categorize.suggest`); the composition root joins the two.
 */
import { newId } from '@core/kernel';
import { configHash } from '@core/platform';
import { sql } from 'drizzle-orm';
import { listCategories } from './categories.ts';
import type {
  CategorizationContext,
  CategorizationDatabase,
  CategorizationExecutor,
} from './db.ts';
import { classifierFeaturesOf, type Decision, type DecisionInput } from './engine.ts';
import { replayGoldSet, type ConfusionPair, type GoldExample } from './eval/replay.ts';
import {
  streamTransactions,
  type CategorizableTransaction,
  type LedgerPort,
} from './ledger-port.ts';
import { decisionInputOf } from './service.ts';
import { UNCATEGORISED_KEY } from './taxonomy.ts';
import type { SuggestionModelChoice, SuggestionVerdict } from '../schema/index.ts';

/** At most this many residue rows (one per merchant) per model request. */
export const SUGGESTION_BATCH_MAX = 50;
/** The reason's ceiling, in characters. The DDL says the same. */
export const SUGGESTION_REASON_MAX = 140;
/** The worker job a sync's categorisation pass enqueues (deduped per holder). */
export const SUGGEST_JOB_KIND = 'categorization.suggest';
/** The worker job behind Settings' "Measure". */
export const SUGGEST_MEASURE_JOB_KIND = 'categorization.suggest_measure';
/** 11 §6 item 4: suggestions stay off below this, measured on the holder's own history. */
export const SUGGESTION_GATE = Object.freeze({ minPrecision: 0.85, minScored: 20 });

// ---------------------------------------------------------------------------
// The payload: the classifier's features, nothing else
// ---------------------------------------------------------------------------

/** One residue row as the model may see it. Snake case: this is the wire shape. */
export interface ResidueFeatures {
  readonly payee_tokens: readonly string[];
  readonly mcc_family: string | null;
  readonly pfc_primary: string | null;
  readonly amount_bucket: string;
  readonly account_kind: string | null;
  readonly direction: 'in' | 'out';
  readonly day_bucket: 'early' | 'mid' | 'late';
}

/**
 * The model's view of one transaction, read off `classifierFeaturesOf`. A
 * feature prefix not handled here (the MCC leaf `m:`) is dropped, so a feature
 * added to the classifier later reaches the model only by an edit to this
 * function — and the scope-minimisation snapshot test fails until it is made.
 */
export function residueFeaturesOf(input: DecisionInput): ResidueFeatures {
  const tokens: string[] = [];
  let mccFamily: string | null = null;
  let pfcPrimary: string | null = null;
  let amountBucket = '0';
  let accountKind: string | null = null;
  let direction: 'in' | 'out' = 'out';
  let dayBucket: 'early' | 'mid' | 'late' = 'early';
  for (const feature of classifierFeaturesOf(input)) {
    const colon = feature.indexOf(':');
    const prefix = feature.slice(0, colon);
    const value = feature.slice(colon + 1);
    if (prefix === 't') tokens.push(value);
    else if (prefix === 'mf') mccFamily = value;
    else if (prefix === 'p') pfcPrimary = value;
    else if (prefix === 'b') amountBucket = value;
    else if (prefix === 'a') accountKind = value;
    else if (prefix === 'd') direction = value === 'in' ? 'in' : 'out';
    else if (prefix === 'dm')
      dayBucket = value === 'mid' ? 'mid' : value === 'late' ? 'late' : 'early';
  }
  return {
    payee_tokens: tokens,
    mcc_family: mccFamily,
    pfc_primary: pfcPrimary,
    amount_bucket: amountBucket,
    account_kind: accountKind,
    direction,
    day_bucket: dayBucket,
  };
}

/** The cache key: the payee tokens the model is shown, joined. `null` when there are none. */
export function merchantKeyOf(features: ResidueFeatures): string | null {
  const key = features.payee_tokens.join(' ').slice(0, 256);
  return key === '' ? null : key;
}

// ---------------------------------------------------------------------------
// The taxonomy the model may choose from, and its version
// ---------------------------------------------------------------------------

export interface SuggestionCategory {
  readonly id: string;
  readonly key: string;
  readonly label: string;
}

export interface SuggestionTaxonomy {
  /** `sha256:` over (id, key, label) of every entry, sorted: a rename or a new category is a new version. */
  readonly version: string;
  readonly categories: readonly SuggestionCategory[];
}

/** The holder's assignable, unarchived categories, less "Uncategorised". */
export async function suggestionTaxonomy(
  executor: CategorizationExecutor,
  userId: string,
): Promise<SuggestionTaxonomy> {
  const rows = await listCategories(executor, userId);
  const categories = rows
    .filter((row) => row.assignable && row.archivedAt === null && row.key !== UNCATEGORISED_KEY)
    .map((row) => ({ id: row.id, key: row.key, label: row.label }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    version: `sha256:${configHash({ categories: categories.map((entry) => [entry.id, entry.key, entry.label]) })}`,
    categories,
  };
}

// ---------------------------------------------------------------------------
// The residue, grouped by merchant, split into cache hits and misses
// ---------------------------------------------------------------------------

export interface ResidueMerchant {
  readonly merchantKey: string;
  /** The newest of the merchant's residue rows: the one the model is shown. */
  readonly features: ResidueFeatures;
  /** Every residue row of this merchant: the suggestion lands on each. */
  readonly transactionIds: readonly string[];
}

export interface CachedAnswer {
  readonly merchantKey: string;
  readonly verdict: SuggestionVerdict;
  readonly categoryId: string | null;
  readonly reason: string | null;
  readonly runId: string | null;
  readonly rejected: boolean;
}

export interface ResidueForSuggestion {
  /** Merchants with no answer at this taxonomy version: what the model is asked. */
  readonly misses: readonly ResidueMerchant[];
  /** Merchants already answered: applied from the cache, never re-asked. */
  readonly hits: readonly (ResidueMerchant & { readonly answer: CachedAnswer })[];
  /** Residue rows with no payee tokens: nothing a merchant cache could key, never sent. */
  readonly untokened: number;
}

async function abstainedTransactions(
  executor: CategorizationExecutor,
  port: LedgerPort,
  userId: string,
): Promise<CategorizableTransaction[]> {
  const ids = await executor.execute<{ transaction_id: string }>(sql`
    SELECT transaction_id FROM category_abstentions WHERE user_id = ${userId} ORDER BY transaction_id
  `);
  const all = ids.rows.map((row) => row.transaction_id);
  const found: CategorizableTransaction[] = [];
  for (let start = 0; start < all.length; start += 500) {
    for await (const transaction of streamTransactions(port, {
      userId,
      transactionIds: all.slice(start, start + 500),
    })) {
      // The overlay answered since the pass recorded the abstention: not residue.
      if (transaction.userCategoryId === null) found.push(transaction);
    }
  }
  return found;
}

function groupByMerchant(transactions: readonly CategorizableTransaction[]): {
  readonly merchants: ResidueMerchant[];
  readonly untokened: number;
} {
  const groups = new Map<string, { newest: CategorizableTransaction; ids: string[] }>();
  let untokened = 0;
  for (const transaction of transactions) {
    const features = residueFeaturesOf(decisionInputOf(transaction));
    const key = merchantKeyOf(features);
    if (key === null) {
      untokened += 1;
      continue;
    }
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { newest: transaction, ids: [transaction.id] });
    else {
      group.ids.push(transaction.id);
      if (
        transaction.date > group.newest.date ||
        (transaction.date === group.newest.date && transaction.id > group.newest.id)
      ) {
        group.newest = transaction;
      }
    }
  }
  const merchants = [...groups.entries()]
    .map(([merchantKey, group]) => ({
      merchantKey,
      features: residueFeaturesOf(decisionInputOf(group.newest)),
      transactionIds: [...group.ids].sort(),
    }))
    .sort((a, b) => a.merchantKey.localeCompare(b.merchantKey));
  return { merchants, untokened };
}

export async function listResidueForSuggestion(
  executor: CategorizationExecutor,
  port: LedgerPort,
  userId: string,
  taxonomyVersion: string,
): Promise<ResidueForSuggestion> {
  const { merchants, untokened } = groupByMerchant(
    await abstainedTransactions(executor, port, userId),
  );
  if (merchants.length === 0) return { misses: [], hits: [], untokened };
  const cached = await executor.execute<{
    merchant_key: string;
    verdict: SuggestionVerdict;
    category_id: string | null;
    reason: string | null;
    run_id: string | null;
    rejected_at: string | Date | null;
  }>(sql`
    SELECT merchant_key, verdict, category_id, reason, run_id, rejected_at
      FROM category_suggestion_cache
     WHERE user_id = ${userId} AND taxonomy_version = ${taxonomyVersion}
  `);
  const byKey = new Map(cached.rows.map((row) => [row.merchant_key, row]));
  const misses: ResidueMerchant[] = [];
  const hits: (ResidueMerchant & { answer: CachedAnswer })[] = [];
  for (const merchant of merchants) {
    const row = byKey.get(merchant.merchantKey);
    if (row === undefined) misses.push(merchant);
    else
      hits.push({
        ...merchant,
        answer: {
          merchantKey: row.merchant_key,
          verdict: row.verdict,
          categoryId: row.category_id,
          reason: row.reason,
          runId: row.run_id,
          rejected: row.rejected_at !== null,
        },
      });
  }
  return { misses, hits, untokened };
}

// ---------------------------------------------------------------------------
// Recording what came back
// ---------------------------------------------------------------------------

export interface MerchantAnswer {
  readonly merchantKey: string;
  readonly transactionIds: readonly string[];
  readonly verdict: SuggestionVerdict;
  /** Set exactly when `verdict` is `suggested`; a category id of this holder's. */
  readonly categoryId: string | null;
  readonly reason: string | null;
  /** Set exactly when `verdict` is `refused`: the validator's refusal class. */
  readonly refusal: string | null;
}

export interface RecordSuggestionsResult {
  /** Cache rows written (a merchant answered concurrently keeps the first answer). */
  readonly cached: number;
  /** Abstention rows that now carry a suggestion. */
  readonly shown: number;
}

function idArrayOf(ids: readonly string[]) {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

/**
 * Write the cache and put each suggestion on its merchant's abstention rows.
 * Only rows that are still abstentions are touched (an assignment written in
 * the meantime deleted the row), and a suggestion the holder rejected for that
 * merchant is never put back.
 */
export async function recordSuggestions(
  database: CategorizationDatabase,
  context: CategorizationContext,
  input: {
    readonly taxonomyVersion: string;
    readonly model: string;
    readonly runId: string | null;
    readonly answers: readonly MerchantAnswer[];
  },
): Promise<RecordSuggestionsResult> {
  return database.transaction(async (tx) => {
    const executor = tx as unknown as CategorizationExecutor;
    const now = context.clock.now().toISOString();
    let cached = 0;
    let shown = 0;
    for (const answer of input.answers) {
      const inserted = await executor.execute<{ id: string }>(sql`
        INSERT INTO category_suggestion_cache
          (id, user_id, merchant_key, taxonomy_version, model, verdict, category_id, reason,
           refusal, run_id)
        VALUES (
          ${newId()}, ${context.userId}, ${answer.merchantKey}, ${input.taxonomyVersion},
          ${input.model.slice(0, 160)}, ${answer.verdict}, ${answer.categoryId}, ${answer.reason},
          ${answer.refusal}, ${input.runId}
        )
        ON CONFLICT (user_id, merchant_key, taxonomy_version) DO NOTHING
        RETURNING id
      `);
      cached += inserted.rows.length;
      if (inserted.rows.length === 0) continue;
      if (answer.verdict !== 'suggested' || answer.categoryId === null || answer.reason === null) {
        continue;
      }
      shown += await showSuggestion(executor, context.userId, {
        transactionIds: answer.transactionIds,
        categoryId: answer.categoryId,
        reason: answer.reason,
        runId: input.runId,
        at: now,
      });
    }
    return { cached, shown };
  });
}

async function showSuggestion(
  executor: CategorizationExecutor,
  userId: string,
  input: {
    readonly transactionIds: readonly string[];
    readonly categoryId: string;
    readonly reason: string;
    readonly runId: string | null;
    readonly at: string;
  },
): Promise<number> {
  if (input.transactionIds.length === 0) return 0;
  const updated = await executor.execute<{ id: string }>(sql`
    UPDATE category_abstentions
       SET suggested_category_id = ${input.categoryId},
           suggestion_reason = ${input.reason},
           suggestion_run_id = ${input.runId},
           suggested_at = ${input.at}::timestamptz
     WHERE user_id = ${userId}
       AND transaction_id = ANY(${idArrayOf(input.transactionIds)})
       AND suggested_category_id IS NULL
       AND EXISTS (SELECT 1 FROM categories c WHERE c.id = ${input.categoryId} AND c.user_id = ${userId})
    RETURNING id
  `);
  return updated.rows.length;
}

/**
 * Cache hits: a merchant already answered at this taxonomy version gets its
 * answer on any new residue row, without asking the model again. A rejected
 * answer is never shown.
 */
export async function applyCachedSuggestions(
  database: CategorizationDatabase,
  context: CategorizationContext,
  hits: ResidueForSuggestion['hits'],
): Promise<number> {
  const showable = hits.filter(
    (hit) =>
      hit.answer.verdict === 'suggested' &&
      !hit.answer.rejected &&
      hit.answer.categoryId !== null &&
      hit.answer.reason !== null,
  );
  if (showable.length === 0) return 0;
  return database.transaction(async (tx) => {
    const executor = tx as unknown as CategorizationExecutor;
    const now = context.clock.now().toISOString();
    let shown = 0;
    for (const hit of showable) {
      shown += await showSuggestion(executor, context.userId, {
        transactionIds: hit.transactionIds,
        categoryId: hit.answer.categoryId as string,
        reason: hit.answer.reason as string,
        runId: hit.answer.runId,
        at: now,
      });
    }
    return shown;
  });
}

export type RejectOutcome = 'rejected' | 'no_suggestion';

/**
 * "Not this": the holder says the suggested category is wrong for this merchant.
 *
 * Records the negative example on the merchant's cache row(s) — every taxonomy
 * version that suggested this category for it — and clears the chip from every
 * residue row of the merchant that carries the same suggestion. Writes nothing
 * the classifier reads: its abstain floor is unaffected, and no category is
 * assigned. The row stays uncategorised.
 */
export async function rejectSuggestion(
  database: CategorizationDatabase,
  port: LedgerPort,
  input: { readonly transactionId: string },
  context: CategorizationContext,
): Promise<RejectOutcome> {
  return database.transaction(async (tx) => {
    const executor = tx as unknown as CategorizationExecutor;
    const current = await executor.execute<{ suggested_category_id: string | null }>(sql`
      SELECT suggested_category_id FROM category_abstentions
       WHERE user_id = ${context.userId} AND transaction_id = ${input.transactionId}
       FOR UPDATE
    `);
    const categoryId = current.rows[0]?.suggested_category_id ?? null;
    if (categoryId === null) return 'no_suggestion';

    let merchantKey: string | null = null;
    for await (const transaction of streamTransactions(port, {
      userId: context.userId,
      transactionIds: [input.transactionId],
    })) {
      merchantKey = merchantKeyOf(residueFeaturesOf(decisionInputOf(transaction)));
    }
    const sameMerchant: string[] = [input.transactionId];
    if (merchantKey !== null) {
      await executor.execute(sql`
        UPDATE category_suggestion_cache
           SET rejected_at = ${context.clock.now().toISOString()}::timestamptz
         WHERE user_id = ${context.userId}
           AND merchant_key = ${merchantKey}
           AND category_id = ${categoryId}
           AND rejected_at IS NULL
      `);
      const residue = await abstainedTransactions(executor, port, context.userId);
      for (const transaction of residue) {
        if (merchantKeyOf(residueFeaturesOf(decisionInputOf(transaction))) === merchantKey) {
          sameMerchant.push(transaction.id);
        }
      }
    }
    await executor.execute(sql`
      UPDATE category_abstentions
         SET suggested_category_id = NULL, suggestion_reason = NULL,
             suggestion_run_id = NULL, suggested_at = NULL
       WHERE user_id = ${context.userId}
         AND transaction_id = ANY(${idArrayOf([...new Set(sameMerchant)])})
         AND suggested_category_id = ${categoryId}
    `);
    return 'rejected';
  });
}

// ---------------------------------------------------------------------------
// The holder's settings
// ---------------------------------------------------------------------------

export interface SuggestionSettings {
  readonly modelChoice: SuggestionModelChoice;
  readonly hostedConsentedAt: Date | null;
  readonly hostedConsentTextHash: string | null;
}

/** No row: the narrator's pinned local model, and no hosted consent (D22, shipped unticked). */
export const DEFAULT_SUGGESTION_SETTINGS: SuggestionSettings = Object.freeze({
  modelChoice: 'narrator',
  hostedConsentedAt: null,
  hostedConsentTextHash: null,
});

export async function readSuggestionSettings(
  executor: CategorizationExecutor,
  userId: string,
): Promise<SuggestionSettings> {
  const result = await executor.execute<{
    model_choice: SuggestionModelChoice;
    hosted_consented_at: string | Date | null;
    hosted_consent_text_hash: string | null;
  }>(sql`
    SELECT model_choice, hosted_consented_at, hosted_consent_text_hash
      FROM category_suggestion_settings WHERE user_id = ${userId}
  `);
  const row = result.rows[0];
  if (row === undefined) return DEFAULT_SUGGESTION_SETTINGS;
  return {
    modelChoice: row.model_choice,
    hostedConsentedAt: row.hosted_consented_at === null ? null : new Date(row.hosted_consented_at),
    hostedConsentTextHash: row.hosted_consent_text_hash,
  };
}

export async function writeSuggestionSettings(
  executor: CategorizationExecutor,
  context: Pick<CategorizationContext, 'userId' | 'clock'>,
  patch: {
    readonly modelChoice?: SuggestionModelChoice;
    /** `null` withdraws; a hash consents to exactly that text. */
    readonly hostedConsentTextHash?: string | null;
  },
): Promise<SuggestionSettings> {
  const current = await readSuggestionSettings(executor, context.userId);
  const now = context.clock.now();
  const modelChoice = patch.modelChoice ?? current.modelChoice;
  const consentHash =
    patch.hostedConsentTextHash === undefined
      ? current.hostedConsentTextHash
      : patch.hostedConsentTextHash;
  const consentedAt =
    patch.hostedConsentTextHash === undefined
      ? current.hostedConsentedAt
      : patch.hostedConsentTextHash === null
        ? null
        : now;
  await executor.execute(sql`
    INSERT INTO category_suggestion_settings
      (user_id, model_choice, hosted_consented_at, hosted_consent_text_hash, updated_at)
    VALUES (
      ${context.userId}, ${modelChoice},
      ${consentedAt === null ? null : consentedAt.toISOString()}::timestamptz,
      ${consentHash}, ${now.toISOString()}::timestamptz
    )
    ON CONFLICT (user_id) DO UPDATE SET
      model_choice = EXCLUDED.model_choice,
      hosted_consented_at = EXCLUDED.hosted_consented_at,
      hosted_consent_text_hash = EXCLUDED.hosted_consent_text_hash,
      updated_at = EXCLUDED.updated_at
  `);
  return {
    modelChoice,
    hostedConsentedAt: consentedAt,
    hostedConsentTextHash: consentHash,
  };
}

// ---------------------------------------------------------------------------
// The precision gate
// ---------------------------------------------------------------------------

export interface SuggestionEval {
  readonly id: string;
  readonly modelChoice: SuggestionModelChoice;
  readonly model: string;
  readonly modelDigest: string | null;
  readonly status: 'completed' | 'failed';
  readonly failure: string | null;
  readonly goldTotal: number;
  readonly residue: number;
  readonly asked: number;
  readonly scored: number;
  readonly correct: number;
  readonly abstained: number;
  readonly refused: number;
  readonly precision: number | null;
  readonly coverage: number | null;
  readonly confusions: readonly ConfusionPair[];
  readonly batchDigests: readonly string[];
  readonly durationMs: number | null;
  readonly measuredAt: Date;
}

export type GateVerdict =
  | { readonly open: true }
  | {
      readonly open: false;
      readonly reason: 'not_measured' | 'measurement_failed' | 'too_few_rows' | 'below_precision';
    };

/** Pure: does this measurement open the gate? Exactly at 85 % with 20 rows, yes. */
export function gateOf(latest: SuggestionEval | null): GateVerdict {
  if (latest === null) return { open: false, reason: 'not_measured' };
  if (latest.status !== 'completed') return { open: false, reason: 'measurement_failed' };
  if (latest.scored < SUGGESTION_GATE.minScored) return { open: false, reason: 'too_few_rows' };
  // Integer comparison: 17 of 20 is exactly 0.85 and must open, whatever the float does.
  if (latest.correct * 100 < latest.scored * Math.round(SUGGESTION_GATE.minPrecision * 100)) {
    return { open: false, reason: 'below_precision' };
  }
  return { open: true };
}

export async function latestSuggestionEval(
  executor: CategorizationExecutor,
  userId: string,
  modelChoice: SuggestionModelChoice,
): Promise<SuggestionEval | null> {
  const result = await executor.execute<Record<string, unknown>>(sql`
    SELECT * FROM category_suggestion_evals
     WHERE user_id = ${userId} AND model_choice = ${modelChoice}
     ORDER BY measured_at DESC, id DESC
     LIMIT 1
  `);
  const row = result.rows[0];
  if (row === undefined) return null;
  const ratio = (value: unknown): number | null => (value === null ? null : Number(value));
  return {
    id: String(row['id']),
    modelChoice: row['model_choice'] as SuggestionModelChoice,
    model: String(row['model']),
    modelDigest: (row['model_digest'] as string | null) ?? null,
    status: row['status'] as 'completed' | 'failed',
    failure: (row['failure'] as string | null) ?? null,
    goldTotal: Number(row['gold_total']),
    residue: Number(row['residue']),
    asked: Number(row['asked']),
    scored: Number(row['scored']),
    correct: Number(row['correct']),
    abstained: Number(row['abstained']),
    refused: Number(row['refused']),
    precision: ratio(row['precision_ratio']),
    coverage: ratio(row['coverage_ratio']),
    confusions: (row['confusions'] as ConfusionPair[] | null) ?? [],
    batchDigests: (row['batch_digests'] as string[] | null) ?? [],
    durationMs: row['duration_ms'] === null ? null : Number(row['duration_ms']),
    measuredAt: new Date(row['measured_at'] as string | Date),
  };
}

// ---------------------------------------------------------------------------
// The measurement: the model as a seventh tier on the replay's residue
// ---------------------------------------------------------------------------

export interface MeasurementResidue {
  readonly goldTotal: number;
  /** The gold examples every tier abstained on (leave-one-merchant-out). */
  readonly rows: readonly { readonly example: GoldExample; readonly merchantKey: string | null }[];
  /** One representative per merchant key: what the model is asked about. */
  readonly merchants: readonly {
    readonly merchantKey: string;
    readonly features: ResidueFeatures;
  }[];
}

/**
 * The residue of the holder's own history: replay every hand-filed transaction
 * through the six tiers with its merchant held out (`replayGoldSet`, holdout
 * `merchant` — the never-seen-merchant case 11 §5 names as the figure the gate
 * is measured on), keep the rows every tier abstained on. Pure.
 */
export function measurementResidue(
  examples: readonly GoldExample[],
  options: Omit<Parameters<typeof replayGoldSet>[1], 'holdout' | 'onDecision'>,
): MeasurementResidue {
  const abstained: number[] = [];
  replayGoldSet(examples, {
    ...options,
    holdout: 'merchant',
    onDecision: (index: number, decision: Decision) => {
      if (decision.source === 'none' || decision.categoryKey === UNCATEGORISED_KEY) {
        abstained.push(index);
      }
    },
  });
  const rows = abstained.map((index) => {
    const example = examples[index] as GoldExample;
    return { example, merchantKey: merchantKeyOf(residueFeaturesOf(example.input)) };
  });
  const merchants = new Map<string, ResidueFeatures>();
  for (const row of rows) {
    if (row.merchantKey !== null && !merchants.has(row.merchantKey)) {
      merchants.set(row.merchantKey, residueFeaturesOf(row.example.input));
    }
  }
  return {
    goldTotal: examples.length,
    rows,
    merchants: [...merchants.entries()]
      .map(([merchantKey, features]) => ({ merchantKey, features }))
      .sort((a, b) => a.merchantKey.localeCompare(b.merchantKey)),
  };
}

export interface MeasuredAnswer {
  readonly verdict: SuggestionVerdict;
  /** A category key of the holder's, when `suggested`. */
  readonly categoryKey: string | null;
}

export interface MeasurementFigures {
  readonly goldTotal: number;
  readonly residue: number;
  readonly asked: number;
  readonly scored: number;
  readonly correct: number;
  readonly abstained: number;
  readonly refused: number;
  readonly precision: number | null;
  readonly coverage: number | null;
  readonly confusions: readonly ConfusionPair[];
}

function ratio4(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

/**
 * Score the model's answers against the holder's picks, on every residue row
 * of each merchant asked about. Pure. A row whose merchant was not asked
 * (no payee tokens, or no answer) counts in `residue` and nowhere else.
 */
export function scoreMeasurement(
  residue: MeasurementResidue,
  answers: ReadonlyMap<string, MeasuredAnswer>,
): MeasurementFigures {
  let asked = 0;
  let scored = 0;
  let correct = 0;
  let abstained = 0;
  let refused = 0;
  const confusion = new Map<string, ConfusionPair>();
  for (const row of residue.rows) {
    const answer = row.merchantKey === null ? undefined : answers.get(row.merchantKey);
    if (answer === undefined) continue;
    asked += 1;
    if (answer.verdict === 'abstained') abstained += 1;
    else if (answer.verdict === 'refused' || answer.categoryKey === null) refused += 1;
    else {
      scored += 1;
      if (answer.categoryKey === row.example.expectedKey) correct += 1;
      else {
        const pairKey = `${row.example.expectedKey}\u0000${answer.categoryKey}`;
        const existing = confusion.get(pairKey);
        confusion.set(pairKey, {
          expected: row.example.expectedKey,
          got: answer.categoryKey,
          count: (existing?.count ?? 0) + 1,
        });
      }
    }
  }
  return {
    goldTotal: residue.goldTotal,
    residue: residue.rows.length,
    asked,
    scored,
    correct,
    abstained,
    refused,
    precision: ratio4(correct, scored),
    coverage: ratio4(scored, residue.rows.length),
    confusions: [...confusion.values()]
      .sort(
        (a, b) =>
          b.count - a.count || a.expected.localeCompare(b.expected) || a.got.localeCompare(b.got),
      )
      .slice(0, 10),
  };
}

/** The measurement's only write: its own result row. */
export async function recordSuggestionEval(
  executor: CategorizationExecutor,
  context: Pick<CategorizationContext, 'userId' | 'clock'>,
  input: {
    readonly modelChoice: SuggestionModelChoice;
    readonly model: string;
    readonly modelDigest: string | null;
    readonly status: 'completed' | 'failed';
    readonly failure: string | null;
    readonly figures: MeasurementFigures;
    readonly batchDigests: readonly string[];
    readonly durationMs: number | null;
  },
): Promise<string> {
  const id = newId();
  const f = input.figures;
  await executor.execute(sql`
    INSERT INTO category_suggestion_evals
      (id, user_id, model_choice, model, model_digest, status, failure, gold_total, residue,
       asked, scored, correct, abstained, refused, precision_ratio, coverage_ratio, confusions,
       batch_digests, duration_ms, measured_at)
    VALUES (
      ${id}, ${context.userId}, ${input.modelChoice}, ${input.model.slice(0, 160)},
      ${input.modelDigest}, ${input.status}, ${input.failure === null ? null : input.failure.slice(0, 64)},
      ${f.goldTotal}, ${f.residue}, ${f.asked}, ${f.scored}, ${f.correct}, ${f.abstained},
      ${f.refused}, ${f.precision === null ? null : f.precision.toFixed(4)}::numeric,
      ${f.coverage === null ? null : f.coverage.toFixed(4)}::numeric,
      ${JSON.stringify(f.confusions)}::jsonb, ${JSON.stringify(input.batchDigests)}::jsonb,
      ${input.durationMs}, ${context.clock.now().toISOString()}::timestamptz
    )
  `);
  return id;
}

/** Figures for a measurement that could not run (no model, a refusal, an error). */
export function emptyFigures(goldTotal: number, residue: number): MeasurementFigures {
  return {
    goldTotal,
    residue,
    asked: 0,
    scored: 0,
    correct: 0,
    abstained: 0,
    refused: 0,
    precision: null,
    coverage: null,
    confusions: [],
  };
}
