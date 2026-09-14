// SPDX-License-Identifier: MIT
/**
 * The decision function.
 *
 * One pure function, six tiers, strict order, and **every tier records what it
 * did whether it won or not**. That last part is the whole reason this is a
 * separate module from the service: an engine that returns only its answer can
 * be tested only on its answer, and "why is my coffee filed under Shopping?" is
 * the question this app has to be able to answer on demand.
 *
 * ## The order (04 §5.2, extended)
 *
 * | # | Tier               | Beats everything below because                                  |
 * |---|--------------------|-----------------------------------------------------------------|
 * | 1 | `user`             | The user said so. Absolute; nothing overrides an explicit edit.  |
 * | 2 | `rule`             | The user said so in advance, and generally.                      |
 * | 3 | `merchant_default` | A locked merchant is intent; a learned one is this user's history.|
 * | 4 | `provider`         | Plaid's enrichment: good, general, and not about *this* user.     |
 * | 5 | `classifier`       | A guess from this user's own confirmations, or an abstention.     |
 * | 6 | `none`             | Honest ignorance. Better than a wrong answer in a budget.         |
 *
 * Tier 1 is not evaluated here so much as *observed*: the user's category lives
 * in `@ctx/ledger`'s overlay (`transactions.user_category_id`), this context does
 * not own that column, and the ledger's `resolveEffective` already treats it as
 * final. What this function does is refuse to produce a competing answer when it
 * is set — which is why `decide` takes `userCategoryId` and returns immediately.
 *
 * ## Idempotence
 *
 * 04 §5.2: "Re-running categorisation must be safe and idempotent: it only ever
 * touches rows whose source is a *lower-priority* stage than the one now
 * matching." `decide` is a pure function of its inputs, so running it five times
 * gives the same answer five times; `shouldReplace` below is the other half —
 * the rule the *writer* applies so that a re-run never demotes a decision.
 */

import type { DateOnly } from '@core/kernel';
import type { ClassifierModel } from './classifier.ts';
import { featuresOf, predict, type ClassifierOutcome } from './classifier.ts';
import { matchProviderCategory, readProviderCategory, type ProviderMatch } from './pfc-map.ts';
import { matchRule, orderRules, type MatchSubject, type RuleMatch } from './rules/match.ts';
import {
  IMPLEMENTED_ACTIONS,
  type Rule,
  type RuleAction,
  type RuleCondition,
} from './rules/schema.ts';
import { UNCATEGORISED_KEY, isAssignableKey } from './taxonomy.ts';

/** Where a decision came from. Mirrors the `category_assignments.source` enum. */
export type AssignmentSource =
  | 'user'
  | 'rule'
  | 'merchant_default'
  | 'provider'
  | 'classifier'
  | 'none';

/**
 * Tier precedence as a number, so "is the new decision at least as authoritative
 * as the stored one?" is a comparison rather than a chain of `if`s repeated at
 * three call sites.
 */
const PRECEDENCE: Readonly<Record<AssignmentSource, number>> = Object.freeze({
  user: 5,
  rule: 4,
  merchant_default: 3,
  provider: 2,
  classifier: 1,
  none: 0,
});

export function precedenceOf(source: AssignmentSource): number {
  return PRECEDENCE[source];
}

/**
 * May a fresh decision overwrite a stored one?
 *
 * Yes when it comes from a tier at least as authoritative. **Not** when it would
 * demote: a transaction categorised by a rule must not silently fall back to the
 * classifier because the rule was disabled — the previous answer stands until
 * something explicitly retracts it. Equal tiers may replace each other, which is
 * what makes editing a rule take effect.
 */
export function shouldReplace(stored: AssignmentSource, fresh: AssignmentSource): boolean {
  if (stored === 'user') return fresh === 'user';
  return PRECEDENCE[fresh] >= PRECEDENCE[stored];
}

export interface MerchantDefault {
  readonly categoryKey: string;
  /** The user pinned this merchant's category. Beats a learned default. */
  readonly locked: boolean;
  /** How many confirmed transactions the learned default rests on. */
  readonly supportCount: number;
}

export interface DecisionInput {
  readonly transactionId: string;
  /** The resolved payee, as the ledger's `effective_name` has it. */
  readonly payee: string;
  /** `cleanDescriptor(...).cleaned`. */
  readonly cleanedPayee: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly accountId: string;
  readonly accountType: string | null;
  readonly date: DateOnly;
  /** `transactions_provider.provider_category`, verbatim. */
  readonly providerCategory: unknown;
  readonly mcc: string | null;
  readonly isTransfer: boolean;
  /** The ledger overlay. Non-null means the user has spoken and tier 1 wins. */
  readonly userCategoryId: string | null;
}

export interface DecisionContext {
  readonly rules: readonly Rule[];
  readonly merchantDefault: MerchantDefault | null;
  readonly classifier: ClassifierModel;
  /** Below this, the classifier abstains. 04 §5.2's "threshold". */
  readonly confidenceFloor: number;
  /** Learned merchant defaults need this much support (04 §5.2 says three). */
  readonly merchantSupportThreshold: number;
}

/** One tier's turn, win or lose. The decision chain is an array of these. */
export interface TierOutcome {
  readonly source: AssignmentSource;
  readonly won: boolean;
  /** Prose a UI can print directly. Present whether the tier won or abstained. */
  readonly detail: string;
  readonly categoryKey?: string | null;
  readonly confidence?: number;
  readonly ruleId?: string | null;
}

export interface Decision {
  readonly transactionId: string;
  readonly categoryKey: string;
  readonly source: AssignmentSource;
  readonly confidence: number;
  readonly ruleId: string | null;
  /** Every tier, in order, including the ones that abstained. */
  readonly chain: readonly TierOutcome[];
  /** Non-category actions from matched rules, in rule order. */
  readonly actions: readonly RuleAction[];
  /** Actions a rule asked for that this phase cannot carry out yet. */
  readonly deferredActions: readonly RuleAction[];
}

export const DEFAULT_CONFIDENCE_FLOOR = 0.6;
export const DEFAULT_MERCHANT_SUPPORT = 3;

export function decide(input: DecisionInput, context: DecisionContext): Decision {
  const chain: TierOutcome[] = [];

  // --- tier 1: the user's own edit -----------------------------------------
  if (input.userCategoryId !== null) {
    chain.push({
      source: 'user',
      won: true,
      detail: 'You set this category, so nothing else was considered.',
      categoryKey: null,
      confidence: 1,
    });
    return {
      transactionId: input.transactionId,
      // The overlay holds an id, not a key, and this context resolves ids to
      // keys only where it has the table to hand. The service turns this into a
      // no-op write; the engine's job is to record that tier 1 won.
      categoryKey: UNCATEGORISED_KEY,
      source: 'user',
      confidence: 1,
      ruleId: null,
      chain,
      actions: [],
      deferredActions: [],
    };
  }
  chain.push({ source: 'user', won: false, detail: 'You have not set a category on this one.' });

  // --- tier 2: rules --------------------------------------------------------
  const subject: MatchSubject = {
    payee: input.payee,
    cleanedPayee: input.cleanedPayee,
    amountMinor: input.amountMinor,
    currency: input.currency,
    accountId: input.accountId,
    date: input.date,
    providerCodes: providerCodesOf(input.providerCategory),
    isTransfer: input.isTransfer,
  };

  const actions: RuleAction[] = [];
  const deferredActions: RuleAction[] = [];
  let categoryFromRule: { rule: Rule; categoryKey: string; match: RuleMatch } | null = null;
  const matchedRuleIds: string[] = [];

  for (const rule of orderRules(context.rules)) {
    const match = matchRule(rule, subject);
    if (!match.matched) continue;
    matchedRuleIds.push(rule.id);

    for (const action of rule.actions) {
      if (action.type === 'set_category') {
        // First matching rule wins the category; later rules may still add a
        // note or a tag. That is what makes "categorise CHEWY as Pets" and "tag
        // everything on the joint card" compose instead of fighting.
        if (categoryFromRule === null && isAssignableKey(action.categoryKey)) {
          categoryFromRule = { rule, categoryKey: action.categoryKey, match };
        }
        continue;
      }
      if (IMPLEMENTED_ACTIONS.has(action.type)) actions.push(action);
      else deferredActions.push(action);
    }

    if (rule.stopProcessing) break;
  }

  if (categoryFromRule !== null) {
    const reasons = categoryFromRule.match.outcomes
      .filter((outcome) => outcome.matched)
      .map((outcome) => describeCondition(outcome.condition));
    chain.push({
      source: 'rule',
      won: true,
      detail: `Rule “${categoryFromRule.rule.name}” matched: ${reasons.join(' and ')}.`,
      categoryKey: categoryFromRule.categoryKey,
      confidence: 1,
      ruleId: categoryFromRule.rule.id,
    });
    return {
      transactionId: input.transactionId,
      categoryKey: categoryFromRule.categoryKey,
      source: 'rule',
      // A rule is an instruction, not an estimate. 1.0 is the honest number.
      confidence: 1,
      ruleId: categoryFromRule.rule.id,
      chain,
      actions,
      deferredActions,
    };
  }
  chain.push({
    source: 'rule',
    won: false,
    detail:
      matchedRuleIds.length === 0
        ? `None of your ${context.rules.length} rule(s) matched.`
        : `${matchedRuleIds.length} rule(s) matched but none set a category.`,
  });

  // --- tier 3: the merchant's default --------------------------------------
  const merchant = context.merchantDefault;
  if (merchant !== null && isAssignableKey(merchant.categoryKey)) {
    if (merchant.locked) {
      chain.push({
        source: 'merchant_default',
        won: true,
        detail: 'You pinned this category for this merchant.',
        categoryKey: merchant.categoryKey,
        confidence: 1,
      });
      return finish(input, merchant.categoryKey, 'merchant_default', 1, null, chain, actions, deferredActions);
    }
    if (merchant.supportCount >= context.merchantSupportThreshold) {
      // Confidence grows with support and saturates below certainty: nine
      // agreeing transactions are better evidence than three, and neither is
      // proof. Capped at 0.95 so a learned default never presents itself as a
      // fact the user stated.
      const confidence = Math.min(0.95, 0.7 + 0.05 * (merchant.supportCount - context.merchantSupportThreshold));
      chain.push({
        source: 'merchant_default',
        won: true,
        detail: `${merchant.supportCount} earlier transactions with this merchant are filed here.`,
        categoryKey: merchant.categoryKey,
        confidence,
      });
      return finish(input, merchant.categoryKey, 'merchant_default', confidence, null, chain, actions, deferredActions);
    }
    chain.push({
      source: 'merchant_default',
      won: false,
      detail: `Only ${merchant.supportCount} earlier transaction(s) here; ${context.merchantSupportThreshold} are needed.`,
    });
  } else {
    chain.push({
      source: 'merchant_default',
      won: false,
      detail: 'No default set or learned for this merchant.',
    });
  }

  // --- tier 4: the provider's category -------------------------------------
  const providerMatch: ProviderMatch | null = matchProviderCategory(
    readProviderCategory(input.providerCategory),
  );
  if (providerMatch !== null && isAssignableKey(providerMatch.categoryKey)) {
    chain.push({
      source: 'provider',
      won: true,
      detail: `Your bank’s data service classified this as ${providerMatch.matchedCode}.`,
      categoryKey: providerMatch.categoryKey,
      confidence: providerMatch.confidence,
    });
    return finish(
      input,
      providerMatch.categoryKey,
      'provider',
      providerMatch.confidence,
      null,
      chain,
      actions,
      deferredActions,
    );
  }
  chain.push({
    source: 'provider',
    won: false,
    detail:
      input.providerCategory === null || input.providerCategory === undefined
        ? 'Your bank’s data service sent no category for this one.'
        : 'Your bank’s data service sent a category we do not recognise.',
  });

  // --- tier 5: the classifier ----------------------------------------------
  const features = featuresOf({
    cleanedPayee: input.cleanedPayee,
    amountMinor: input.amountMinor,
    accountType: input.accountType,
    mcc: input.mcc,
  });
  const outcome: ClassifierOutcome = predict(context.classifier, features, context.confidenceFloor);

  if (outcome.kind === 'predicted' && isAssignableKey(outcome.categoryKey)) {
    chain.push({
      source: 'classifier',
      won: true,
      detail: `Learned from your own history — strongest signals: ${outcome.topFeatures
        .map((contribution) => contribution.feature)
        .join(', ')}.`,
      categoryKey: outcome.categoryKey,
      confidence: outcome.confidence,
    });
    return finish(
      input,
      outcome.categoryKey,
      'classifier',
      outcome.confidence,
      null,
      chain,
      actions,
      deferredActions,
    );
  }
  chain.push({
    source: 'classifier',
    won: false,
    detail: outcome.kind === 'abstained' ? outcome.reason : 'predicted a category we do not recognise',
  });

  // --- tier 6: say so ------------------------------------------------------
  chain.push({
    source: 'none',
    won: true,
    detail: 'Nothing was confident enough, so this is left for you to decide.',
    categoryKey: UNCATEGORISED_KEY,
    confidence: 0,
  });
  return finish(input, UNCATEGORISED_KEY, 'none', 0, null, chain, actions, deferredActions);
}

function finish(
  input: DecisionInput,
  categoryKey: string,
  source: AssignmentSource,
  confidence: number,
  ruleId: string | null,
  chain: readonly TierOutcome[],
  actions: readonly RuleAction[],
  deferredActions: readonly RuleAction[],
): Decision {
  return {
    transactionId: input.transactionId,
    categoryKey,
    source,
    confidence,
    ruleId,
    chain,
    actions,
    deferredActions,
  };
}

/** Both PFC codes, so a `provider_category` rule can name either level. */
function providerCodesOf(raw: unknown): readonly string[] {
  const hint = readProviderCategory(raw);
  if (hint === null) return [];
  return [hint.primary, hint.detailed].filter((code): code is string => code !== null);
}

/** One condition, in a sentence. Used in the rule tier's `detail`. */
function describeCondition(condition: RuleCondition): string {
  switch (condition.type) {
    case 'payee':
      return `payee ${condition.match.replaceAll('_', ' ')} “${condition.value}”`;
    case 'payee_regex':
      return `payee matches /${condition.pattern}/`;
    case 'amount':
      return `amount between ${condition.minMinor ?? '−∞'} and ${condition.maxMinor ?? '∞'}`;
    case 'direction':
      return `it is money ${condition.direction === 'outflow' ? 'out' : 'in'}`;
    case 'account':
      return `it is on ${condition.accountIds.length === 1 ? 'that account' : 'one of those accounts'}`;
    case 'day_of_month':
      return `it falls between day ${condition.from} and day ${condition.to}`;
    case 'provider_category':
      return `your bank’s category is one of ${condition.codes.join(', ')}`;
    case 'currency':
      return `the currency is ${condition.currency}`;
    case 'is_transfer':
      return condition.value ? 'it is a transfer' : 'it is not a transfer';
  }
}
