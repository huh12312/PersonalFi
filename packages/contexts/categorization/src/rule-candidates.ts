// SPDX-License-Identifier: MIT
/**
 * Merchants the holder keeps filing the same way by hand — the facts behind
 * WP 11.1's "make this a rule?" suggestion (11 §3.1: "a count, not a model").
 *
 * **Reads only, decides nothing.** This returns every (merchant, category)
 * pair the holder has filed by hand (`readHolderAnswers` — the ledger overlay,
 * or a confirmed assignment) at least `MIN_REPORTED_CONFIRMATIONS` times,
 * with whether a rule already files it and whether the merchant's default is
 * locked. The *threshold* — three — and the rest of the policy live in the
 * built-in advisor (`@ctx/insights`' `spending.rule_suggestion`), where they
 * are tested; pairs below it are returned on purpose, so the advisor's own
 * threshold is the thing a test can see refuse them.
 *
 * "A rule already files it" is answered by `decide` itself, rules only, on the
 * pair's most recent confirmed transaction: if the rule tier would win, a rule
 * covers this merchant and suggesting another would be noise. Asking the engine
 * rather than pattern-matching rule conditions means a rule written by hand,
 * one created from a transaction, and one that matches by amount all count the
 * same way the sync path would count them.
 */
import { sql } from 'drizzle-orm';
import { COLD_MODEL } from './classifier.ts';
import type { CategorizationExecutor } from './db.ts';
import {
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_MERCHANT_SUPPORT,
  decide,
  type DecisionInput,
} from './engine.ts';
import { readHolderAnswers } from './eval/holder-answers.ts';
import type { LedgerPort } from './ledger-port.ts';
import { decisionInputOf, loadRules } from './service.ts';

/** Pairs below this are not worth reading at all. The advisor's threshold is higher. */
export const MIN_REPORTED_CONFIRMATIONS = 2;
/** At most this many pairs, most-confirmed first. A snapshot block has a cap. */
export const MAX_RULE_CANDIDATES = 64;
/** Transactions cited per pair, newest first: the evidence rows. */
export const MAX_CANDIDATE_TRANSACTIONS = 8;

export interface RuleCandidate {
  /** `@ctx/ledger`'s `merchants.id`. */
  readonly merchantId: string;
  readonly categoryId: string;
  readonly categoryKey: string;
  /**
   * Transactions of this merchant the holder filed under this category by hand
   * (`readHolderAnswers`: the ledger overlay, or a confirmed assignment).
   */
  readonly confirmations: number;
  /** Newest first, at most `MAX_CANDIDATE_TRANSACTIONS`. */
  readonly transactionIds: readonly string[];
  /** An enabled rule would file this merchant's latest confirmed transaction. */
  readonly coveredByRule: boolean;
  /** The holder pinned this merchant's category. */
  readonly lockedDefault: boolean;
}

export async function listRuleCandidates(
  executor: CategorizationExecutor,
  port: LedgerPort,
  userId: string,
): Promise<readonly RuleCandidate[]> {
  const { answers } = await readHolderAnswers(executor, port, userId);
  // Newest first, so each pair's transaction ids are newest first.
  const ordered = [...answers].sort(
    (a, b) =>
      b.transaction.date.localeCompare(a.transaction.date) ||
      a.transaction.id.localeCompare(b.transaction.id),
  );
  const transactions = new Map<string, DecisionInput>();
  const groups = new Map<
    string,
    { merchantId: string; categoryId: string; categoryKey: string; ids: string[] }
  >();
  for (const answer of ordered) {
    const merchantId = answer.transaction.merchantId;
    if (merchantId === null) continue;
    transactions.set(answer.transaction.id, decisionInputOf(answer.transaction));
    const key = `${merchantId}|${answer.categoryId}`;
    const group = groups.get(key) ?? {
      merchantId,
      categoryId: answer.categoryId,
      categoryKey: answer.categoryKey,
      ids: [],
    };
    group.ids.push(answer.transaction.id);
    groups.set(key, group);
  }

  const qualifying = [...groups.values()]
    .filter((group) => group.ids.length >= MIN_REPORTED_CONFIRMATIONS)
    .sort(
      (a, b) =>
        b.ids.length - a.ids.length ||
        a.merchantId.localeCompare(b.merchantId) ||
        a.categoryKey.localeCompare(b.categoryKey),
    )
    .slice(0, MAX_RULE_CANDIDATES);
  if (qualifying.length === 0) return [];

  const { rules } = await loadRules(executor, userId);
  const locked = await executor.execute<{ ledger_merchant_id: string }>(sql`
    SELECT ledger_merchant_id FROM merchant_profiles WHERE user_id = ${userId} AND user_locked
  `);
  const lockedMerchants = new Set(locked.rows.map((row) => row.ledger_merchant_id));

  return qualifying.map((group) => {
    const latest = transactions.get(group.ids[0] as string);
    const coveredByRule =
      latest !== undefined &&
      decide(
        { ...latest, userCategoryId: null, providerCategory: null },
        {
          rules,
          merchantDefault: null,
          classifier: COLD_MODEL,
          confidenceFloor: DEFAULT_CONFIDENCE_FLOOR,
          merchantSupportThreshold: DEFAULT_MERCHANT_SUPPORT,
        },
      ).source === 'rule';
    return {
      merchantId: group.merchantId,
      categoryId: group.categoryId,
      categoryKey: group.categoryKey,
      confirmations: group.ids.length,
      transactionIds: group.ids.slice(0, MAX_CANDIDATE_TRANSACTIONS),
      coveredByRule,
      lockedDefault: lockedMerchants.has(group.merchantId),
    };
  });
}
