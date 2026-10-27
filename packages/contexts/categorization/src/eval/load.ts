// SPDX-License-Identifier: MIT
/**
 * Reading a holder's gold set: the confirmed assignments, the transactions
 * behind them, the rules, the locked merchant defaults. **Reads only.**
 *
 * Every statement here is a `SELECT`, and the CLI that calls it
 * (`scripts/categorization-eval.ts`) runs on a connection whose transactions
 * are `READ ONLY`, so a write slipped into this file fails at the database
 * rather than landing. `test/wp111.test.ts` (categorization-db) loads inside a
 * `READ ONLY` transaction — so a write here throws — and asserts the row count
 * of every table it could reach is equal before and after.
 *
 * ## What counts as the holder's answer
 *
 * `readHolderAnswers` (`holder-answers.ts`): the category the holder filed by
 * hand — the ledger overlay, or a confirmed assignment where there is no
 * overlay. An answer the holder later replaced is not graded: the replay grades
 * the engine against what the holder says *now*. The transaction is read
 * through the same `LedgerPort` and mapped by the same `decisionInputOf` the
 * sync path uses, so the replay sees what `decide` would.
 */
import { sql } from 'drizzle-orm';
import type { CategorizationExecutor } from '../db.ts';
import { decisionInputOf, loadRules } from '../service.ts';
import type { MerchantDefault } from '../engine.ts';
import type { LedgerPort } from '../ledger-port.ts';
import type { Rule } from '../rules/schema.ts';
import { readHolderAnswers } from './holder-answers.ts';
import type { GoldExample } from './replay.ts';

export interface LoadedGoldSet {
  readonly examples: readonly GoldExample[];
  readonly rules: readonly Rule[];
  readonly lockedMerchantDefaults: ReadonlyMap<string, MerchantDefault>;
  /** Confirmations whose transaction the ledger no longer returns (removed, superseded). */
  readonly missingTransactions: number;
  /** Examples whose answer came from the ledger overlay (`user_category_id`). */
  readonly fromOverlay: number;
  /** Examples whose answer came from a confirmed assignment alone. */
  readonly fromConfirmed: number;
}

export async function loadGoldSet(
  executor: CategorizationExecutor,
  port: LedgerPort,
  userId: string,
): Promise<LoadedGoldSet> {
  const { answers, missingTransactions } = await readHolderAnswers(executor, port, userId);
  const examples: GoldExample[] = answers.map((answer) => ({
    input: decisionInputOf(answer.transaction),
    expectedKey: answer.categoryKey,
    merchantKey: answer.transaction.merchantId,
  }));
  const fromOverlay = answers.filter((answer) => answer.from === 'overlay').length;

  const { rules } = await loadRules(executor, userId);

  const lockedRows = await executor.execute<{
    ledger_merchant_id: string;
    category_key: string;
    default_support_count: number;
  }>(sql`
    SELECT p.ledger_merchant_id, c.key AS category_key, p.default_support_count
      FROM merchant_profiles p
      JOIN categories c ON c.id = p.default_category_id
     WHERE p.user_id = ${userId} AND p.user_locked
  `);
  const lockedMerchantDefaults = new Map<string, MerchantDefault>(
    lockedRows.rows.map((row) => [
      row.ledger_merchant_id,
      { categoryKey: row.category_key, locked: true, supportCount: row.default_support_count },
    ]),
  );

  return {
    examples,
    rules,
    lockedMerchantDefaults,
    missingTransactions,
    fromOverlay,
    fromConfirmed: answers.length - fromOverlay,
  };
}
