// SPDX-License-Identifier: MIT
/**
 * The restricted Markdown subset an advisor may write, and the plain text a
 * human will actually read.
 *
 * 03 §8.1 rule 4: "output is data, never instructions". Two consequences live
 * here, and they are different problems that happen to share a parser:
 *
 *   * **What renders.** `summary_md` is not rendered as Markdown-at-large. The
 *     subset below — emphasis, inline code, bullet lists, links whose target is
 *     checked elsewhere — is what the UI will render; everything else is
 *     rejected at validation time rather than stripped at render time. Stripping
 *     at render time is how an `<img onerror=…>` becomes somebody else's problem
 *     in Phase 5, and it also makes the *stored* text and the *shown* text
 *     different, which breaks the numeral check below.
 *   * **What the numeral check reads.** The anti-fabrication rule is about
 *     numbers "a human will read", so the text it reads must be the text a human
 *     reads: the rendered plain text, with syntax removed and link *targets*
 *     removed but link *captions* kept. A `[$227.88 a year](…)` caption is read;
 *     the `2024` in the URL is not, because a URL's digits are not a claim about
 *     the user's money.
 *
 * ## Why rejection, not sanitisation
 *
 * Sanitising leaves the advisor no signal: it keeps sending HTML, we keep
 * quietly removing it, and nobody learns. Rejecting an insight whose body
 * contains a raw tag is a counted rejection on `advisor_runs`, visible in the
 * feed's diagnostics, and costs one insight rather than gaining a rendering
 * surface. The advisors in question are ours until Phase 5, so the price of
 * being strict is a fixed test, and the benefit arrives with the first model.
 *
 * ## What "no HTML" means precisely
 *
 * Any `<` followed by a letter, `/` or `!` is refused, which covers tags,
 * closing tags, comments and doctypes. A bare `<` used as "less than" is
 * allowed, because `available < 0` is a sentence an advisor should be able to
 * write and it cannot open an element.
 */

/** The disallowed constructs, each with the name a diagnostic prints. */
export type MarkdownViolation =
  | 'html_tag'
  | 'html_entity'
  | 'image'
  | 'autolink_scheme'
  | 'heading'
  | 'blockquote'
  | 'code_fence'
  | 'table'
  | 'footnote'
  | 'control_character'
  | 'too_long';

export const MAX_SUMMARY_LENGTH = 2000;

/** `<a`, `</a`, `<!--`. A lone `<` before a space or a digit is not a tag. */
const HTML_TAG = /<[/!a-zA-Z]/;
/** `&lt;`, `&#60;`, `&#x3c;`. An entity is a way to write a tag one hop later. */
const HTML_ENTITY = /&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;
const IMAGE = /!\[/;
/** `javascript:`, `data:`, `vbscript:` anywhere, in any casing. */
const DANGEROUS_SCHEME = /(?:javascript|data|vbscript|file|blob)\s*:/i;

/**
 * Whether `target` opens with a scheme `markdownViolations` already refuses
 * (`autolink_scheme`, above). The link-target check (F-3, `pipeline.ts`)
 * skips such a target rather than also refusing it under `checkLink`'s own
 * `scheme_not_https`: the two checks would otherwise report the identical
 * refusal under two different names, and this module's is the one with the
 * test coverage for it. A non-dangerous non-`https` scheme (`http:`, `ftp:`)
 * is not skipped — `checkLink` is the only thing that refuses those.
 */
export function isDangerousScheme(target: string): boolean {
  return DANGEROUS_SCHEME.test(target);
}
const HEADING = /^\s{0,3}#{1,6}\s/m;
const BLOCKQUOTE = /^\s{0,3}>/m;
const CODE_FENCE = /^\s{0,3}(?:```|~~~)/m;
const TABLE = /^\s{0,3}\|/m;
const FOOTNOTE = /\[\^/;

/**
 * C0/C1 controls (keeping `\t` and `\n`), plus the Unicode bidi overrides.
 *
 * Written as a code-point scan rather than a character class for two reasons:
 * a regex literal containing raw control bytes is a file nobody can safely
 * hand-edit, and the bidi half earns an explanation that a range in a character
 * class has nowhere to put. `U+202E` (right-to-left override) makes `$1,000`
 * render as `000,1$` without changing a byte of the stored string — so a body
 * that passes the numeral check can still show the user a different figure.
 * Refusing the characters is the only place that gap closes, because every
 * check downstream reads bytes and the user reads glyphs.
 */
export function hasForbiddenCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) return true;
    // U+2028/U+2029 line/paragraph separators, U+202A–U+202E embeddings and
    // overrides, U+2066–U+2069 isolates.
    if (code === 0x2028 || code === 0x2029) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
  }
  return false;
}

/**
 * Every rule `summary_md` (and `rationale_md`) must satisfy.
 *
 * Returns the violations rather than a boolean, because the pipeline records
 * *which* rule an advisor broke: "advisor X keeps emitting tables" is an
 * actionable diagnostic and "advisor X failed markdown validation" is not.
 */
export function markdownViolations(text: string): readonly MarkdownViolation[] {
  const violations: MarkdownViolation[] = [];
  if (text.length > MAX_SUMMARY_LENGTH) violations.push('too_long');
  if (hasForbiddenCharacter(text)) violations.push('control_character');
  if (HTML_TAG.test(text)) violations.push('html_tag');
  if (HTML_ENTITY.test(text)) violations.push('html_entity');
  if (IMAGE.test(text)) violations.push('image');
  if (DANGEROUS_SCHEME.test(text)) violations.push('autolink_scheme');
  if (HEADING.test(text)) violations.push('heading');
  if (BLOCKQUOTE.test(text)) violations.push('blockquote');
  if (CODE_FENCE.test(text)) violations.push('code_fence');
  if (TABLE.test(text)) violations.push('table');
  if (FOOTNOTE.test(text)) violations.push('footnote');
  return violations;
}

/**
 * The plain text a human reads, from the Markdown an advisor wrote.
 *
 * Only the subset survives validation, so this does not have to be a Markdown
 * parser — it has to undo exactly the constructs the subset permits:
 *
 *   * `[caption](target)` → `caption`. The caption is read to the user; the
 *     target is a link and is checked against the egress allow-list instead.
 *   * `` `code` `` → `code`. Inline code is still text on the screen.
 *   * `**bold**`, `*italic*`, `__bold__`, `_italic_` → the word inside.
 *   * `- ` / `* ` / `1. ` markers at the start of a line → nothing. A numbered
 *     list's `1.` is syntax, not a figure, and leaving it in would demand that
 *     every advisor's third bullet have a `3` somewhere in the snapshot.
 *
 * Total: any string goes in, a string comes out, and every quantifier is
 * bounded so a pathological body cannot make the regex engine the slow part.
 * The numeral check is only as trustworthy as this function's refusal to throw.
 */
export function renderedText(markdown: string): string {
  let text = markdown;
  // Links first: a caption may itself contain emphasis, and removing the target
  // before unwrapping emphasis keeps a `)` inside a URL from being read as the
  // end of something else.
  text = text.replace(/\[([^\]]{0,200})\]\(([^)\s]{0,2048})(?:\s+"[^"]{0,200}")?\)/g, '$1');
  text = text.replace(/`([^`]{0,500})`/g, '$1');
  text = text.replace(/\*\*([^*]{0,500})\*\*/g, '$1');
  text = text.replace(/__([^_]{0,500})__/g, '$1');
  text = text.replace(/\*([^*]{0,500})\*/g, '$1');
  text = text.replace(/(^|\s)_([^_]{0,500})_(?=\s|$)/g, '$1$2');
  text = text.replace(/^[ \t]{0,8}(?:[-*+]|\d{1,3}[.)])[ \t]+/gm, '');
  return text;
}

/**
 * Every string an advisor wrote that a human will see, for one insight.
 *
 * Collected in one place so the numeral check cannot be handed a *subset*: an
 * insight whose fabricated figure sits in `impact.basis` or in a caveat rather
 * than in `summary_md` is still an insight with a fabricated figure, and the
 * likeliest way to get that wrong is for the list of "fields we check" to live
 * at the call site and fall behind the schema.
 */
export interface RenderableFields {
  readonly title: string;
  readonly summaryMd: string;
  readonly impactBasis: string;
  readonly evidenceLabels: readonly string[];
  readonly evidenceValues: readonly string[];
  readonly actionLabels: readonly string[];
  readonly actionRationales: readonly string[];
  readonly caveats: readonly string[];
}

/** A markdown link's `(target)`, captured alongside the caption `renderedText` keeps. */
const MARKDOWN_LINK = /\[[^\]]{0,200}\]\(([^)\s]{0,2048})(?:\s+"[^"]{0,200}")?\)/g;
const BARE_URL = /\bhttps?:\/\/\S+/giu;

/**
 * Every link *target* in `text` — what a click actually sends a browser to
 * (F-3). `markdown.ts`'s subset permits "links whose target is checked
 * elsewhere"; this is the other half of `renderedText`, which keeps a link's
 * *caption* and discards its target. Two shapes: a markdown link's `(target)`,
 * and a bare URL written with no markdown syntax at all (`"Details:
 * https://…"` passes every markdown rule there is, because it never uses any).
 */
export function linkTargetsOf(text: string): readonly string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const target = match[1];
    if (target !== undefined) targets.push(target);
  }
  const withoutMarkdownTargets = text.replace(MARKDOWN_LINK, ' ');
  for (const match of withoutMarkdownTargets.matchAll(BARE_URL)) targets.push(match[0]);
  return targets;
}

export function renderableStrings(fields: RenderableFields): readonly string[] {
  return [
    fields.title,
    renderedText(fields.summaryMd),
    fields.impactBasis,
    ...fields.evidenceLabels,
    ...fields.evidenceValues,
    ...fields.actionLabels,
    ...fields.actionRationales.map(renderedText),
    ...fields.caveats,
  ];
}
