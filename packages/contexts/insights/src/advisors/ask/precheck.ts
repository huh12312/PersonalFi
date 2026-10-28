// SPDX-License-Identifier: MIT
/**
 * The deterministic pre-check every question goes through before any model is
 * asked (WP 11.5c; 12 §4's refusal classes). Pure, total and the same
 * function the api (before it creates a session), the worker (again, before
 * the compile call), the red team and the evaluation call.
 *
 * ## Refused (`question.*`): the question itself is not one the app will send
 *
 *   * `question.empty`, `question.too_long` (over `ASK_QUESTION_MAX`);
 *   * `question.instruction` — text written to steer a model rather than to
 *     ask: "ignore the limits", "disregard previous instructions", a role
 *     label (`system:`), our own fence, a chat-template token, `[INST]`,
 *     "you are now", "developer mode". A hosted provider never sees it;
 *   * `question.merchant_token` — a `MERCHANT_…` pseudonym, which only ever
 *     appears in text an advisor was sent: pasted payload, not a question;
 *   * `question.markup` — an HTML-ish tag or a code fence.
 *
 * ## Out of scope (`unanswerable`, `out_of_scope`): 07 §1's line, 12 §7 decision 1
 *
 * Security selection, market timing, tax filing, insurance, estate planning
 * and **execution** (PersonalFi never moves money: "go ahead and move it").
 * Keyword patterns, deliberately conservative: an obvious one never costs a
 * hosted call, and a subtle one is still caught by the compiler's own
 * `unanswerable.reason` — the pre-check is the cheap half of a two-part rule,
 * not the whole of it.
 */
import { ASK_QUESTION_MAX } from './manifest.ts';
import type { AskNearestScreen } from './screens.ts';

export const ASK_QUESTION_REFUSAL_CLASSES = [
  'question.empty',
  'question.too_long',
  'question.instruction',
  'question.merchant_token',
  'question.markup',
] as const;
export type AskQuestionRefusal = (typeof ASK_QUESTION_REFUSAL_CLASSES)[number];

export const ASK_OUT_OF_SCOPE_TOPICS = [
  'security_selection',
  'market_timing',
  'tax_filing',
  'insurance',
  'estate',
  'execution',
] as const;
export type AskOutOfScopeTopic = (typeof ASK_OUT_OF_SCOPE_TOPICS)[number];

/** The words for each topic, and the screen nearest to what the holder may want instead. */
export const ASK_TOPIC_WORDS: Readonly<
  Record<AskOutOfScopeTopic, { readonly words: string; readonly screen: AskNearestScreen }>
> = Object.freeze({
  security_selection: {
    words: 'which security, fund or coin to hold — PersonalFi never names one',
    screen: '/investments',
  },
  market_timing: {
    words: 'when to buy or sell — PersonalFi does not time markets',
    screen: '/investments',
  },
  tax_filing: { words: 'preparing or filing a tax return', screen: '/reports' },
  insurance: { words: 'insurance', screen: '/' },
  estate: { words: 'wills, trusts and estate planning', screen: '/accounts' },
  execution: {
    words: 'moving money or acting on an account — PersonalFi never executes anything',
    screen: '/accounts',
  },
});

export type AskPrecheck =
  | { readonly kind: 'ok'; readonly question: string }
  | { readonly kind: 'refused'; readonly refusal: AskQuestionRefusal; readonly detail: string }
  | {
      readonly kind: 'out_of_scope';
      readonly topic: AskOutOfScopeTopic;
      readonly screen: AskNearestScreen;
    };

const INSTRUCTION_PATTERNS: readonly RegExp[] = Object.freeze([
  // "ignore the limits", "disregard previous instructions", "override your rules" …
  /\b(?:ignore|disregard|forget|override|bypass|skip)\s+(?:(?:all|any|the|your|my|of|these|those|its|every)\s+)*(?:previous|prior|above|earlier|preceding|system|instructions?|prompts?|rules?|limits?|checks?|validators?|guardrails?|catalogue|catalog|constraints?|restrictions?|filters?)\b/iu,
  // A role label: an attempt to be read as a turn.
  /\b(?:system|assistant|developer)\s*:/iu,
  // Our own fence, chat-template control tokens, Llama-2 markers.
  /<\s*\/?\s*untrusted[\s_-]*data/iu,
  /<\|[^|<>\n]{0,64}\|>/u,
  /\[\s*\/?\s*INST\s*\]|<<\s*\/?\s*SYS\s*>>/iu,
  // Persona and mode switches.
  /\byou are (?:now|no longer)\b/iu,
  /\b(?:developer|god|jailbreak|dan) mode\b/iu,
  /\bnew instructions?\b/iu,
  /\b(?:pretend|act as if) (?:you|the)\b/iu,
  /\breply (?:only )?with\b/iu,
]);

const MERCHANT_TOKEN = /\bMERCHANT_[0-9a-z]{4,}\b/iu;
const MARKUP = /<\s*\/?\s*[a-z][^<>]*>|```/iu;

const TOPIC_PATTERNS: readonly (readonly [AskOutOfScopeTopic, RegExp])[] = Object.freeze([
  [
    'execution',
    /^\s*(?:please\s+)?(?:go ahead and\s+)?(?:move|transfer|send|pay|wire|withdraw|deposit|rebalance|cancel|close)\b|\bgo ahead\b|\b(?:do|execute|make) (?:it|that|the (?:transfer|trade|payment|move))(?: for me| now)?\b|\bfor me\b[^.?!]{0,40}\b(?:move|transfer|pay|cancel|rebalance)\b/iu,
  ],
  [
    'security_selection',
    /\b(?:which|what)\b[^.?!]{0,40}\b(?:etfs?|stocks?|funds?|crypto(?:currency|currencies)?|coins?|tickers?|shares?|bonds?)\b[^.?!]{0,30}\b(?:should|to|would|could)\s+(?:i\s+|we\s+)?(?:buy|hold|own|pick|choose|invest|get|put)\b|\b(?:best|top|recommended|good)\s+(?:etfs?|stocks?|funds?|index funds?|mutual funds?|crypto(?:currency)?|coins?|shares?)\b|\bshould i (?:buy|sell|invest in|pick)\b|\b(?:buy|sell|pick)\b[^.?!]{0,30}\b(?:stocks?|shares?|etfs?|bitcoin|crypto|funds?)\b|\btell me which\b/iu,
  ],
  [
    'market_timing',
    /\b(?:time the market|market timing|good time to (?:buy|sell|invest|get (?:in|out))|is (?:now|it) (?:a )?(?:good|right|bad) time|when (?:should|to) (?:i )?(?:buy|sell|get (?:in|out))|(?:before|after) the (?:crash|correction|dip)|will the market|market (?:crash|correction|go(?:es|ing)? (?:up|down)))\b/iu,
  ],
  [
    'tax_filing',
    /\b(?:file|filing|prepare|preparing|do|doing) (?:my |our )?(?:tax(?:es)?|tax return|return)\b|\btax returns?\b|\b(?:1040|w-?2|1099|schedule c)\b|\bitemi[sz]e\b|\bdeductions?\b/iu,
  ],
  [
    'insurance',
    /\binsurance\b|\b(?:annuit(?:y|ies)|insurance premiums?|umbrella polic(?:y|ies))\b/iu,
  ],
  [
    'estate',
    /\b(?:estate plan(?:ning)?|my will\b|a will\b|living trust|trust fund|power of attorney|inheritance|beneficiar(?:y|ies)|probate)\b/iu,
  ],
]);

/** Pure: the same question always gets the same answer. */
export function precheckQuestion(raw: string): AskPrecheck {
  const question = raw.replace(/\s+/gu, ' ').trim();
  if (question.length === 0) {
    return { kind: 'refused', refusal: 'question.empty', detail: 'the question is empty' };
  }
  if ([...question].length > ASK_QUESTION_MAX) {
    return {
      kind: 'refused',
      refusal: 'question.too_long',
      detail: `the question is over ${String(ASK_QUESTION_MAX)} characters`,
    };
  }
  const folded = question.normalize('NFKC');
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(folded))) {
    return {
      kind: 'refused',
      refusal: 'question.instruction',
      detail: 'the question carries an instruction to the model',
    };
  }
  if (MERCHANT_TOKEN.test(folded)) {
    return {
      kind: 'refused',
      refusal: 'question.merchant_token',
      detail: 'the question carries a merchant pseudonym',
    };
  }
  if (MARKUP.test(folded)) {
    return { kind: 'refused', refusal: 'question.markup', detail: 'the question carries markup' };
  }
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    if (pattern.test(folded)) {
      return { kind: 'out_of_scope', topic, screen: ASK_TOPIC_WORDS[topic].screen };
    }
  }
  return { kind: 'ok', question };
}
