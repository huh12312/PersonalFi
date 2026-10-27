// SPDX-License-Identifier: MIT
/**
 * Validating an `insight.explain` reply — every word the model wrote is
 * untrusted, and nothing reaches the cache or a screen until it passes here
 * (11 §4, "Validation, per reply, before anything is stored").
 *
 *   * **Schema pin.** Exactly `{ explanation: string }`; anything else — an
 *     extra key, a wrong type, a reply that was not JSON — is `schema`.
 *   * **Length.** 1–900 characters after trimming (`empty`, `too_long`).
 *   * **Markup.** The narrator's sanitised Markdown subset and no more
 *     (`validate/markdown.ts`: no HTML, entity, image, heading, block quote,
 *     code fence, table, footnote or control character), and no braces or
 *     angle brackets at all — a slot (`{{e1}}`) or a tag is not prose
 *     (`markup`). No link of any kind, Markdown or bare (`link`).
 *   * **Figures.** Every numeral, after the subject's literals and prose
 *     quotations are masked, must be one of **this subject's** figures as
 *     written (`numeral`), and so must every spelled-out figure with a scale
 *     or currency cue (`word_figure`) — `request.ts`' `explainTraceContext`,
 *     the narrator's narrow trace over the evidence union only.
 *   * **Copy.** The insight copy linter (`copy`: 07 §7.2's banned phrases,
 *     an imperative at a sentence start, a merchant pseudonym in prose).
 *
 * A refusal is a class, recorded on the run and in the cache, and shown as a
 * refusal — never replaced by a template. Pure: the same function validates a
 * production run, the red team's replies and the self-test's grounding probe.
 */
import { lintAdviceCopy } from '../copy-lint.ts';
import { linkTargetsOf, markdownViolations, renderedText } from '../../validate/markdown.ts';
import {
  untraceableInFinding,
  untraceableWordFiguresInFinding,
  type FindingTraceContext,
} from '../../validate/numerals.ts';

export const EXPLAIN_TEXT_MAX = 900;

export const EXPLAIN_REFUSAL_CLASSES = [
  'schema',
  'empty',
  'too_long',
  'markup',
  'link',
  'numeral',
  'word_figure',
  'copy',
] as const;
export type ExplainRefusalClass = (typeof EXPLAIN_REFUSAL_CLASSES)[number];

export type ExplainValidation =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly refusal: ExplainRefusalClass; readonly detail: string };

const BRACKETS = /[<>{}]/u;
const BARE_LINK = /(?:\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|app|dev)\b)/iu;

function refused(refusal: ExplainRefusalClass, detail: string): ExplainValidation {
  return { ok: false, refusal, detail };
}

export function validateExplainReply(
  reply: unknown,
  trace: FindingTraceContext,
): ExplainValidation {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
    return refused('schema', 'the reply is not a JSON object');
  }
  const keys = Object.keys(reply);
  const raw = (reply as Record<string, unknown>)['explanation'];
  if (keys.length !== 1 || keys[0] !== 'explanation' || typeof raw !== 'string') {
    return refused('schema', 'the reply is not exactly { explanation: string }');
  }
  const text = raw.trim();
  if (text.length === 0) return refused('empty', 'the explanation is empty');
  if ([...text].length > EXPLAIN_TEXT_MAX) {
    return refused('too_long', `the explanation is over ${String(EXPLAIN_TEXT_MAX)} characters`);
  }
  const markup = markdownViolations(text);
  if (markup.length > 0 || BRACKETS.test(text)) {
    return refused('markup', markup.length > 0 ? markup.join(', ') : 'braces or angle brackets');
  }
  if (linkTargetsOf(text).length > 0 || BARE_LINK.test(text)) {
    return refused('link', 'the explanation carries a link');
  }
  const plain = renderedText(text);
  const outside = untraceableInFinding(plain, trace);
  if (outside.length > 0) {
    return refused(
      'numeral',
      `${String(outside.length)} figure(s) not in the evidence: ${outside
        .slice(0, 4)
        .map((numeral) => numeral.raw)
        .join(', ')}`,
    );
  }
  const words = untraceableWordFiguresInFinding(plain, trace);
  if (words.length > 0) {
    return refused('word_figure', `a figure in words not in the evidence: ${words[0]?.raw ?? ''}`);
  }
  const copy = lintAdviceCopy(text, 'summary_md');
  if (copy.length > 0) {
    return refused('copy', copy.map((violation) => violation.detail).join('; '));
  }
  return { ok: true, text };
}
