// SPDX-License-Identifier: MIT
/**
 * WP 11.1's one built-in: the rule suggestion, reading
 * `categorization.rule_candidates` (advisor contract 1.7.0). Not a 07 §3.3
 * rule — 11 §3.1 asked for it — so it carries no 07 number of its own.
 */
import type { BuiltinRule } from '../../support.ts';
import { spendingRuleSuggestion } from './rule-suggestion.ts';

export {
  RULE_SUGGESTION_ADVISOR_ID,
  RULE_SUGGESTION_MIN_CONFIRMATIONS,
  spendingRuleSuggestion,
} from './rule-suggestion.ts';

export const RULE_SUGGESTION_RULES: readonly BuiltinRule[] = Object.freeze([
  spendingRuleSuggestion,
]);
