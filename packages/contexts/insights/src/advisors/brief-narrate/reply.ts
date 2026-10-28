// SPDX-License-Identifier: MIT
/**
 * Validating a `brief.narrate` reply — every word the model wrote is
 * untrusted, and nothing reaches `brief_narrations` as text, a screen or a
 * notification until it passes here (11 §4, "Validation, per reply, before
 * anything is stored"). Both fields are held to every rule; a reply is
 * accepted whole or refused whole, so a holder never sees half a composition.
 *
 *   * **Schema pin.** Exactly `{ narration: string, recap: string }`
 *     (`schema`).
 *   * **Length.** narration 1–1 200 characters, recap 1–600 after trimming
 *     (`empty`, `too_long`); the narration at most three sentences
 *     (`sentences`: "two or three sentences").
 *   * **Markup.** Plain text: no Markdown at all (not even the narrator's
 *     emphasis), no braces or angle brackets (`markup`); no link, Markdown or
 *     bare (`link`).
 *   * **Figures.** Every numeral, after the week label, the dates and the
 *     items' own titles and wordings are masked, must be one of the Brief's
 *     figures or the items' headline figures as written (`numeral`), and so
 *     must every spelled-out figure with a scale or currency cue
 *     (`word_figure`) — `request.ts`' `briefNarrateTraceContext`.
 *   * **G5-15 — the items the Brief chose, and no other** (`item_reference`):
 *     neither text may name the title of a finding the Brief did not choose
 *     (the holder's other live findings, never sent), and a quoted title must
 *     be one of the titles sent.
 *   * **The Brief's order** (`order`): the narration must name the Brief's
 *     first item by its title, before any other, and the titles it names must
 *     appear in the Brief's order — a reply that reorders the week (by a figure
 *     it invented, or by none) is refused.
 *   * **Copy.** The insight copy linter on both (`copy`: 07 §7.2's banned
 *     phrases, an imperative at a sentence start, a merchant pseudonym).
 *
 * A refusal is a class, recorded on the run and on the Brief's narration row,
 * and the Brief's deterministic opening stands — never a template filled in.
 * Pure: the same function validates a production run, the red team's replies,
 * the evaluation harness and the self-test's grounding probe.
 */
import { lintAdviceCopy } from '../copy-lint.ts';
import { linkTargetsOf, markdownViolations, renderedText } from '../../validate/markdown.ts';
import { untraceableInFinding, untraceableWordFiguresInFinding } from '../../validate/numerals.ts';
import { normaliseTitle, type BriefNarrateCheck } from './request.ts';

export const BRIEF_NARRATION_TEXT_MAX = 1200;
export const BRIEF_RECAP_TEXT_MAX = 600;
export const BRIEF_NARRATION_MAX_SENTENCES = 3;

export const BRIEF_NARRATE_REFUSAL_CLASSES = [
  'schema',
  'empty',
  'too_long',
  'sentences',
  'markup',
  'link',
  'numeral',
  'word_figure',
  'item_reference',
  'order',
  'copy',
] as const;
export type BriefNarrateRefusalClass = (typeof BRIEF_NARRATE_REFUSAL_CLASSES)[number];

export type BriefNarrateValidation =
  | { readonly ok: true; readonly narration: string; readonly recap: string }
  | {
      readonly ok: false;
      readonly refusal: BriefNarrateRefusalClass;
      readonly field: 'narration' | 'recap' | 'reply';
      readonly detail: string;
    };

const BRACKETS = /[<>{}]/u;
const BARE_LINK = /(?:\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|app|dev)\b)/iu;
/** A quotation: straight or curly double quotes, at most a title's length. */
const QUOTED = /["“]([^"“”]{3,200})["”]/gu;
const SENTENCE_END = /[.!?](?=\s|$)/gu;

type Field = 'narration' | 'recap';

function refused(
  refusal: BriefNarrateRefusalClass,
  field: Field | 'reply',
  detail: string,
): BriefNarrateValidation {
  return { ok: false, refusal, field, detail };
}

/** Every title in `text` (folded), by first position. */
function titlePositions(text: string, titles: readonly string[]): Map<number, number> {
  const folded = normaliseTitle(text);
  const positions = new Map<number, number>();
  titles.forEach((title, index) => {
    const at = folded.indexOf(normaliseTitle(title));
    if (at >= 0) positions.set(index, at);
  });
  return positions;
}

/** `text` with every sent title removed — so a title's own punctuation is not counted as a sentence. */
function withoutTitles(text: string, titles: readonly string[]): string {
  let out = text;
  for (const title of [...titles].sort((left, right) => right.length - left.length)) {
    if (title.length > 0) out = out.split(title).join('the action');
  }
  return out;
}

function checkField(
  field: Field,
  raw: string,
  max: number,
  check: BriefNarrateCheck,
): BriefNarrateValidation | null {
  const text = raw.trim();
  if (text.length === 0) return refused('empty', field, `the ${field} is empty`);
  if ([...text].length > max) {
    return refused('too_long', field, `the ${field} is over ${String(max)} characters`);
  }
  if (field === 'narration') {
    const sentences = (withoutTitles(text, check.chosenTitles).match(SENTENCE_END) ?? []).length;
    if (sentences > BRIEF_NARRATION_MAX_SENTENCES) {
      return refused(
        'sentences',
        field,
        `the narration has ${String(sentences)} sentences; at most ${String(BRIEF_NARRATION_MAX_SENTENCES)}`,
      );
    }
  }
  const markup = markdownViolations(text);
  // Plain text only: the Brief renders it as text, so even the narrator's
  // allowed emphasis would reach the holder as stray asterisks.
  if (markup.length > 0 || BRACKETS.test(text) || renderedText(text) !== text) {
    return refused(
      'markup',
      field,
      markup.length > 0 ? markup.join(', ') : 'braces, angle brackets or Markdown',
    );
  }
  if (linkTargetsOf(text).length > 0 || BARE_LINK.test(text)) {
    return refused('link', field, `the ${field} carries a link`);
  }
  const plain = renderedText(text);
  const outside = untraceableInFinding(plain, check.trace);
  if (outside.length > 0) {
    return refused(
      'numeral',
      field,
      `${String(outside.length)} figure(s) not in the Brief: ${outside
        .slice(0, 4)
        .map((numeral) => numeral.raw)
        .join(', ')}`,
    );
  }
  const words = untraceableWordFiguresInFinding(plain, check.trace);
  if (words.length > 0) {
    return refused(
      'word_figure',
      field,
      `a figure in words not in the Brief: ${words[0]?.raw ?? ''}`,
    );
  }
  // G5-15: the items the Brief chose, and no other.
  const folded = normaliseTitle(plain);
  const foreign = check.foreignTitles.find((title) => folded.includes(normaliseTitle(title)));
  if (foreign !== undefined) {
    return refused('item_reference', field, 'names a finding the Brief did not choose');
  }
  const chosen = new Set(check.chosenTitles.map(normaliseTitle));
  for (const match of plain.matchAll(QUOTED)) {
    const quoted = normaliseTitle(match[1] ?? '');
    if (!chosen.has(quoted)) {
      return refused(
        'item_reference',
        field,
        'quotes a title that is not one of the Brief’s items',
      );
    }
  }
  if (field === 'narration') {
    const positions = titlePositions(plain, check.chosenTitles);
    const first = positions.get(0);
    if (first === undefined) {
      return refused('order', field, 'the Brief’s first action is not named by its title');
    }
    const ordered = [...positions.entries()].sort((left, right) => left[1] - right[1]);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous !== undefined && current !== undefined && current[0] < previous[0]) {
        return refused('order', field, 'the actions are not in the Brief’s order');
      }
    }
  }
  const copy = lintAdviceCopy(text, 'summary_md');
  if (copy.length > 0) {
    return refused('copy', field, copy.map((violation) => violation.detail).join('; '));
  }
  return null;
}

export function validateBriefNarrateReply(
  reply: unknown,
  check: BriefNarrateCheck,
): BriefNarrateValidation {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
    return refused('schema', 'reply', 'the reply is not a JSON object');
  }
  const record = reply as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const narration = record['narration'];
  const recap = record['recap'];
  if (
    keys.length !== 2 ||
    keys[0] !== 'narration' ||
    keys[1] !== 'recap' ||
    typeof narration !== 'string' ||
    typeof recap !== 'string'
  ) {
    return refused(
      'schema',
      'reply',
      'the reply is not exactly { narration: string, recap: string }',
    );
  }
  const first = checkField('narration', narration, BRIEF_NARRATION_TEXT_MAX, check);
  if (first !== null) return first;
  const second = checkField('recap', recap, BRIEF_RECAP_TEXT_MAX, check);
  if (second !== null) return second;
  return { ok: true, narration: narration.trim(), recap: recap.trim() };
}
