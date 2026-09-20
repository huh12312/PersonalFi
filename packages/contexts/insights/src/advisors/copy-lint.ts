// SPDX-License-Identifier: MIT
/**
 * `lint_advice_copy` — 07 §7.2's language rules, "enforced in code, not in
 * review".
 *
 * Three different failures share one linter because they share one question:
 * *is this sentence something the app is entitled to say?*
 *
 *   1. **Banned phrasing.** 07 §7.2's regex list, verbatim. "You should", "we
 *      recommend", "buy", "sell", "guaranteed returns", "will grow". PersonalFi
 *      is not an adviser (07 §7.1) and the product framing has to match the
 *      legal one — but the list is also simply good advice design: every banned
 *      form is one that states a conclusion where the preferred form states a
 *      *number and its cost*.
 *   2. **Imperative advice.** "Cancel Spotify" is not on 07's banned list and is
 *      exactly what 07's preferred-forms table replaces with "You have two music
 *      services. Keeping one would save $131/yr." A regex for a sentence that
 *      *opens with a verb at the user* catches the whole family rather than the
 *      ten phrasings somebody thought of. It applies to the narrative fields
 *      only: an **action label** is supposed to be an imperative — that is what
 *      a button says — and linting it would be linting the wrong thing.
 *   3. **Untraced numerals.** The same check the validator's step 7 performs,
 *      hoisted to where a rule author sees it. This is redundant with the
 *      pipeline *by design*: the pipeline's rejection costs an insight at 04:15
 *      and shows up as a number on a diagnostics screen; this one fails a test
 *      with the offending sentence in the message.
 *
 * And one rule that is neither of those three:
 *
 *   4. **No merchant tokens in prose.** D22 says a merchant crosses as
 *      `MERCHANT_<hash>` and never as a name, so a rule *cannot* write "Spotify"
 *      — it does not have it. The failure mode that leaves is a rule writing
 *      `MERCHANT_1154fb18cad7` into a sentence, which is a database identifier
 *      shown to a human. The vendor belongs in `evidence[].source_ref`, where
 *      the UI resolves it for display against data the advisor never saw.
 *      Evidence *values* are exempt: an evidence row citing `merchant_ref` must
 *      quote what it resolved to, and the validator checks that it does.
 *
 * ## What this linter deliberately does not do
 *
 * It does not check Markdown safety (`validate/markdown.ts` owns that, and it
 * rejects rather than warns), and it does not check that a recommendation is
 * paired with its cost — 07 §7.2's "always pair a recommendation with its cost".
 * That last one is a real rule and it is not lintable: "cost" is a judgement
 * about whether the sentence is complete, not a pattern. It is enforced instead
 * by the catalogue's shape — a rule that claims an impact must declare the
 * derivation behind it — and by review.
 */
import type { Insight } from '../contract/response.ts';
import { renderedText } from '../validate/markdown.ts';
import { untraceableNumerals, type TraceContext } from '../validate/numerals.ts';

export type CopyRule =
  'banned_phrase' | 'imperative_advice' | 'merchant_token_in_prose' | 'untraced_numeral';

export type CopyField =
  | 'title'
  | 'summary_md'
  | 'impact_basis'
  | 'caveat'
  | 'evidence_label'
  | 'evidence_value'
  | 'action_label'
  | 'action_rationale';

export interface CopyViolation {
  readonly rule: CopyRule;
  readonly field: CopyField;
  readonly detail: string;
}

/**
 * 07 §7.2's list, transcribed.
 *
 * `\bbuy\b(?!\s*-?\s*and-hold)` keeps "buy-and-hold" sayable, because it names a
 * strategy rather than instructing a purchase — that exception is 07's, not an
 * addition.
 */
export const BANNED_PHRASES: readonly { readonly name: string; readonly pattern: RegExp }[] =
  Object.freeze([
    { name: 'you should', pattern: /\byou should\b/i },
    { name: 'buy', pattern: /\bbuy\b(?!\s*-?\s*and-hold)/i },
    { name: 'sell', pattern: /\bsell\b/i },
    { name: 'we recommend', pattern: /\bwe recommend\b/i },
    { name: 'best stock/fund/investment', pattern: /\bbest (stock|fund|investment)\b/i },
    { name: 'guaranteed returns', pattern: /\bguaranteed returns?\b/i },
    { name: 'will grow/earn/return', pattern: /\bwill (grow|earn|return)\b/i },
    { name: 'risk-free', pattern: /\brisk-?free\b/i },
    { name: "can't lose", pattern: /\bcan'?t lose\b/i },
    { name: 'should invest in', pattern: /\bshould invest in\b/i },
  ]);

/**
 * Verbs that make a sentence an instruction rather than a finding.
 *
 * Matched only at the start of a sentence, so "Keeping one would leave $131 a
 * year" passes and "Cancel one of them" does not, and "the payment moves on the
 * first" is untouched because `moves` is not `Move` at a sentence boundary.
 */
const IMPERATIVE_VERBS = [
  'buy',
  'cancel',
  'close',
  'invest',
  'move',
  'open',
  'pay',
  'sell',
  'stop',
  'switch',
  'transfer',
] as const;

const IMPERATIVE = new RegExp(
  `(?:^|[.!?]\\s+|\\n\\s*[-*]\\s*)(${IMPERATIVE_VERBS.join('|')})\\b`,
  'i',
);

const MERCHANT_TOKEN = /MERCHANT_[0-9a-f]{6,}/i;

/** The fields an imperative is a violation in. An action label is a button. */
const NARRATIVE_FIELDS: ReadonlySet<CopyField> = new Set<CopyField>([
  'title',
  'summary_md',
  'impact_basis',
  'caveat',
]);

/** The fields a raw merchant token may legitimately appear in. */
const TOKEN_EXEMPT_FIELDS: ReadonlySet<CopyField> = new Set<CopyField>(['evidence_value']);

/**
 * Lint one string.
 *
 * `context` is optional so the linter is usable over a *template* — a sentence
 * with no snapshot behind it yet — in which case the numeral rule is skipped and
 * the other three still apply.
 */
export function lintAdviceCopy(
  text: string,
  field: CopyField,
  context?: TraceContext,
): readonly CopyViolation[] {
  const violations: CopyViolation[] = [];
  const plain = renderedText(text);

  for (const banned of BANNED_PHRASES) {
    if (banned.pattern.test(plain)) {
      violations.push({ rule: 'banned_phrase', field, detail: banned.name });
    }
  }

  if (NARRATIVE_FIELDS.has(field)) {
    const match = IMPERATIVE.exec(plain);
    if (match !== null) {
      violations.push({
        rule: 'imperative_advice',
        field,
        detail: `sentence opens with '${match[1] ?? ''}'`,
      });
    }
  }

  if (!TOKEN_EXEMPT_FIELDS.has(field) && MERCHANT_TOKEN.test(plain)) {
    violations.push({
      rule: 'merchant_token_in_prose',
      field,
      detail: 'a merchant pseudonym belongs in an evidence ref, not in a sentence',
    });
  }

  if (context !== undefined) {
    for (const numeral of untraceableNumerals(plain, context)) {
      violations.push({
        rule: 'untraced_numeral',
        field,
        detail: `${numeral.raw} in "${plain.slice(0, 96)}"`,
      });
    }
  }

  return violations;
}

/**
 * Lint every string on one insight.
 *
 * The field list mirrors `validate/markdown.ts`'s `renderableStrings` — the same
 * set the numeral check reads — because a field a human sees and this linter
 * does not is the gap the whole exercise is about.
 */
export function lintInsightCopy(
  insight: Insight,
  context?: TraceContext,
): readonly CopyViolation[] {
  const parts: (readonly [string, CopyField])[] = [
    [insight.title, 'title'],
    [insight.summary_md, 'summary_md'],
    [insight.impact.basis, 'impact_basis'],
    ...insight.caveats.map((text): readonly [string, CopyField] => [text, 'caveat']),
    ...insight.evidence.map((row): readonly [string, CopyField] => [row.label, 'evidence_label']),
    ...insight.evidence.flatMap((row): (readonly [string, CopyField])[] =>
      row.value === null ? [] : [[row.value, 'evidence_value']],
    ),
    ...insight.proposed_actions.map((action): readonly [string, CopyField] => [
      action.label,
      'action_label',
    ]),
    ...insight.proposed_actions.map((action): readonly [string, CopyField] => [
      action.rationale_md,
      'action_rationale',
    ]),
  ];

  return parts.flatMap(([text, field]) => lintAdviceCopy(text, field, context));
}
