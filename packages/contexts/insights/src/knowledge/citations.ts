// SPDX-License-Identifier: MIT
/**
 * The citation resolver (WP 11.5a; 12 §2.2 and §4: "a sentence asserting a
 * limit, rate or rule without a resolvable citation is refused by the same
 * resolver that checks `source_ref`").
 *
 * A narration that rests on the knowledge base cites what it rests on, inline:
 *
 *   * `[playbook:<page key>]` — a playbook page, e.g. `[playbook:debt-order]`;
 *   * `[param:<parameter key>]` — a cited parameter, e.g.
 *     `[param:tax.us.2026.retirement.ira_contribution]`.
 *
 * `resolveCitations(text, sent, catalogue)` holds the narration to what was
 * actually **sent** — the pages and parameters in the context object — in the
 * same way 08 §4.3 holds an insight's `source_ref` to the snapshot it was
 * sent: a reference to something real that the model was never given is not a
 * citation, it is a recollection, and the model has no memory it is allowed to
 * use. Refusal classes, checked in this order:
 *
 *   * `citation.malformed` — a marker whose key is not a key, or a raw
 *     `{{param:…}}` placeholder (a page's syntax, never a narration's);
 *   * `citation.unknown` — a page or parameter key the knowledge base does
 *     not hold (a 2027 key while the store holds 2026 is one);
 *   * `citation.page_not_sent` — a real page, not in the context (a draft
 *     page is always this: it can never have been sent);
 *   * `citation.param_not_sent` — a real parameter, not in the context;
 *   * `numeral` — a figure that is neither a sent parameter's value as the
 *     app renders it, a figure in a sent page, nor one the caller allows
 *     (`validate/numerals.ts`'s narrow, as-written trace);
 *   * `word_figure` — the same, spelled out with a scale or currency cue.
 *
 * A parameter rendered into a sent page counts as sent: the model read its
 * value there.
 *
 * ## What a narration records
 *
 * `knowledgeReadRecord` is the shape 11.5d stores beside a narration: every
 * page it was sent, by key, version and digest, and every parameter, by key,
 * rendered value, as-of date and store version — so "why did it say $7,500?"
 * is answerable after the page has moved on and the store has gained a year.
 */
import { z } from 'zod';
import {
  extractNumerals,
  maskLiterals,
  stripUrls,
  untraceableInFinding,
  untraceableWordFiguresInFinding,
  type FindingTraceContext,
} from '../validate/numerals.ts';
import {
  PARAMETER_KEY_PATTERN,
  parameterFigures,
  renderParameter,
  type ParameterCitation,
} from './params.ts';
import { PLAYBOOK_KEY_PATTERN } from './page.ts';
import { isKnowledgeRefusal, type KnowledgeBase, type ReviewedPlaybookPage } from './playbook.ts';

export const CITATION_REFUSAL_CLASSES = [
  'citation.malformed',
  'citation.unknown',
  'citation.page_not_sent',
  'citation.param_not_sent',
  'numeral',
  'word_figure',
] as const;
export type CitationRefusalClass = (typeof CITATION_REFUSAL_CLASSES)[number];

/** `[playbook:debt-order]`, `[param:tax.us.2026.hsa.family]`. */
export const CITATION_MARKER = /\[(playbook|param):([^\]]*)\]/g;
const RAW_PLACEHOLDER = /\{\{\s*param:/;
const DATE_TOKEN = /\b\d{4}-\d{2}(?:-\d{2})?\b/g;

/** What was in the context object. */
export interface SentKnowledge {
  readonly pages: readonly ReviewedPlaybookPage[];
  readonly params: readonly ParameterCitation[];
  /** Figures the caller's own results license (a catalogue result's `$1,234.56`, `12%`), as rendered. */
  readonly allowedFigures?: readonly string[];
}

/** What exists, sent or not — the knowledge base's keys. */
export interface KnowledgeCatalogue {
  pageExists(key: string): boolean;
  paramExists(key: string): boolean;
}

/** The catalogue a knowledge base answers. */
export function knowledgeCatalogueOf(knowledge: KnowledgeBase): KnowledgeCatalogue {
  const pages = new Set(knowledge.playbook.keys());
  return {
    pageExists: (key) => pages.has(key),
    paramExists: (key) => {
      try {
        knowledge.params.get(key);
        return true;
      } catch (error) {
        if (isKnowledgeRefusal(error)) return false;
        throw error;
      }
    },
  };
}

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const knowledgeReadRecordSchema = z.strictObject({
  format: z.literal('personalfi.knowledge-read/1'),
  /** Every page sent, by key; the version and digest it was read at. */
  pages: z.array(
    z.strictObject({
      key: z.string().regex(PLAYBOOK_KEY_PATTERN),
      version: z.int().positive(),
      digest: z.string().regex(SHA256),
    }),
  ),
  /** Every parameter sent, directly or rendered into a sent page. */
  params: z.array(
    z.strictObject({
      key: z.string().regex(PARAMETER_KEY_PATTERN),
      kind: z.string().min(1),
      /** The inline text the app renders it as, or `null` for a table, schedule or fact. */
      rendered: z.string().nullable(),
      asOf: z.string().regex(ISO_DATE),
      parametersVersion: z.string().regex(SHA256),
    }),
  ),
  /** The keys the narration actually cited — a subset of the above. */
  cited: z.strictObject({ pages: z.array(z.string()), params: z.array(z.string()) }),
});
export type KnowledgeReadRecord = z.infer<typeof knowledgeReadRecordSchema>;

export type CitationValidation =
  | {
      readonly ok: true;
      readonly cited: { readonly pages: readonly string[]; readonly params: readonly string[] };
      readonly record: KnowledgeReadRecord;
    }
  | { readonly ok: false; readonly refusal: CitationRefusalClass; readonly detail: string };

/** Every parameter the context carried: those sent, and those rendered into a sent page. */
function sentParams(sent: SentKnowledge): ReadonlyMap<string, ParameterCitation> {
  const all = new Map<string, ParameterCitation>();
  for (const citation of [...sent.params, ...sent.pages.flatMap((page) => page.params)]) {
    if (!all.has(citation.key)) all.set(citation.key, citation);
  }
  return all;
}

/** The record 11.5d stores beside a narration: what it read, and what it cited. */
export function knowledgeReadRecord(
  sent: SentKnowledge,
  cited: { readonly pages: readonly string[]; readonly params: readonly string[] } = {
    pages: [],
    params: [],
  },
): KnowledgeReadRecord {
  const pages = [...new Map(sent.pages.map((page) => [page.key, page])).values()]
    .map((page) => ({ key: page.key, version: page.version, digest: page.digest }))
    .sort((left, right) => (left.key < right.key ? -1 : 1));
  const params = [...sentParams(sent).values()]
    .map((citation) => ({
      key: citation.key,
      kind: citation.kind,
      rendered: renderParameter(citation),
      asOf: citation.asOf,
      parametersVersion: citation.parametersVersion,
    }))
    .sort((left, right) => (left.key < right.key ? -1 : 1));
  return knowledgeReadRecordSchema.parse({
    format: 'personalfi.knowledge-read/1',
    pages,
    params,
    cited: { pages: [...cited.pages].sort(), params: [...cited.params].sort() },
  });
}

function figureIdsOf(text: string, literals: readonly string[]): readonly string[] {
  return extractNumerals(maskLiterals(stripUrls(text), literals)).map((numeral) =>
    numeral.isPercent ? `${numeral.normalized}%` : numeral.normalized,
  );
}

function refused(refusal: CitationRefusalClass, detail: string): CitationValidation {
  return { ok: false, refusal, detail };
}

/**
 * Resolve every citation in `text` against what was sent, then hold every
 * figure in it to the sent parameters, the sent pages and the caller's own.
 * Pure and total: the same function a production run, the red team and an
 * evaluation call.
 */
export function resolveCitations(
  text: string,
  sent: SentKnowledge,
  catalogue: KnowledgeCatalogue,
): CitationValidation {
  if (RAW_PLACEHOLDER.test(text)) {
    return refused(
      'citation.malformed',
      'a raw {{param:…}} placeholder is a page’s syntax, not a citation',
    );
  }
  const pagesSent = new Set(sent.pages.map((page) => page.key));
  const params = sentParams(sent);
  const citedPages: string[] = [];
  const citedParams: string[] = [];
  for (const match of text.matchAll(CITATION_MARKER)) {
    const kind = match[1];
    const key = match[2] ?? '';
    if (kind === 'playbook') {
      if (!PLAYBOOK_KEY_PATTERN.test(key))
        return refused('citation.malformed', `[playbook:${key}]`);
      if (!catalogue.pageExists(key)) return refused('citation.unknown', `no playbook page ${key}`);
      if (!pagesSent.has(key))
        return refused('citation.page_not_sent', `the page ${key} was not sent`);
      if (!citedPages.includes(key)) citedPages.push(key);
    } else {
      if (!PARAMETER_KEY_PATTERN.test(key)) return refused('citation.malformed', `[param:${key}]`);
      if (!catalogue.paramExists(key)) return refused('citation.unknown', `no parameter ${key}`);
      if (!params.has(key))
        return refused('citation.param_not_sent', `the parameter ${key} was not sent`);
      if (!citedParams.includes(key)) citedParams.push(key);
    }
  }

  // The markers' own digits (a key's year) are not figures.
  const plain = text.replace(CITATION_MARKER, ' ');
  const pageTexts = sent.pages.map((page) => page.text);
  const literals = new Set<string>();
  for (const source of [...pageTexts, plain]) {
    for (const match of source.matchAll(DATE_TOKEN)) literals.add(match[0]);
  }
  const literalList = [...literals].sort((left, right) => right.length - left.length);
  const figures = new Set<string>();
  for (const citation of params.values())
    for (const figure of parameterFigures(citation)) figures.add(figure);
  for (const pageText of pageTexts)
    for (const figure of figureIdsOf(pageText, literalList)) figures.add(figure);
  for (const allowed of sent.allowedFigures ?? []) {
    for (const figure of figureIdsOf(allowed, literalList)) figures.add(figure);
  }
  const context: FindingTraceContext = {
    figures,
    literals: literalList,
    prose: sent.pages
      .flatMap((page) => Object.values(page.sections))
      .filter((section) => section.length >= 3),
  };
  const outside = untraceableInFinding(plain, context);
  if (outside.length > 0) {
    return refused(
      'numeral',
      `${String(outside.length)} figure(s) neither sent nor allowed: ${outside
        .slice(0, 4)
        .map((numeral) => numeral.raw)
        .join(', ')}`,
    );
  }
  const words = untraceableWordFiguresInFinding(plain, context);
  if (words.length > 0) {
    return refused(
      'word_figure',
      `a figure in words neither sent nor allowed: ${words[0]?.raw ?? ''}`,
    );
  }
  const cited = { pages: citedPages, params: citedParams };
  return { ok: true, cited, record: knowledgeReadRecord(sent, cited) };
}
