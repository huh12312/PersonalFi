// SPDX-License-Identifier: MIT
/**
 * `ask.narrate`: the request and the validator of its reply (WP 11.5c).
 *
 * ## What the narrator is sent, and nothing else
 *
 *   * the question (already through the pre-check) and the context date;
 *   * per call the app ran: the app's label for it ("emergency-fund cover
 *     (target 3 months)"), its status, its date, the not-available reason if
 *     any, and **its figures as the app writes them**, each with its
 *     `source_refs` — top-level first, at most `ASK_NARRATE_FIGURES_PER_CALL`
 *     — and a few facts (an order's name, an asset class), quoted whole;
 *   * the knowledge the results rest on: the reviewed playbook pages of the
 *     functions called (none today: every page is a draft and the knowledge
 *     base refuses a draft — the run records it as withheld) and the WP 4.2
 *     parameters the calls read, rendered.
 *
 * Never an input block, a snapshot, a row, an account or an institution: the
 * figures are aggregates the catalogue computed and checked (11.5b).
 * `granted_scopes` is the union of the calls' own scopes, catalogue order.
 *
 * ## The reply, validated before anything is stored (`validateAskNarrateReply`)
 *
 * Exactly `{ answer: string }`, and the answer:
 *
 *   * `narrate.schema`, `narrate.empty`, `narrate.too_long` (over 900
 *     characters), `narrate.sentences` (over four);
 *   * `narrate.markup` (Markdown, braces, angle brackets), `narrate.link`;
 *   * `narrate.function_reference` — a catalogue function's name the app did
 *     not run for this question (an answer that pretends to have looked at
 *     something it was never given);
 *   * `narrate.numeral` / `narrate.word_figure` — a figure, in digits or in
 *     words, that is none of the results' figures as written (the numerals
 *     check, `validate/numerals.ts`, over the union of every result's figures
 *     and the arguments the calls ran with);
 *   * `narrate.citation.*` — a `[playbook:…]` or `[param:…]` marker the
 *     knowledge base's resolver refuses (`citation.page_not_sent` for a draft
 *     page, which can never have been sent; `citation.unknown`; …);
 *   * `narrate.copy` — the insight copy linter (07 §7.2's banned phrases, an
 *     imperative at a sentence start, a merchant pseudonym).
 *
 * A refused answer is never shown: the screen shows the app's own rendering of
 * the results instead (`results.ts`' `askFallbackRendering`).
 */
import { newId } from '@core/kernel';
import { ADVISOR_SCOPES, type AdvisorScope } from '../../contract/scopes.ts';
import { CATALOGUE_FUNCTION_NAMES } from '../../catalogue/catalogue.ts';
import {
  CITATION_MARKER,
  knowledgeReadRecord,
  resolveCitations,
  type KnowledgeCatalogue,
  type KnowledgeReadRecord,
  type SentKnowledge,
} from '../../knowledge/citations.ts';
import type { ParameterCitation } from '../../knowledge/params.ts';
import { renderParameter } from '../../knowledge/params.ts';
import type { ReviewedPlaybookPage } from '../../knowledge/playbook.ts';
import { canonicalRunDigest } from '../../preview.ts';
import { linkTargetsOf, markdownViolations, renderedText } from '../../validate/markdown.ts';
import {
  extractNumerals,
  maskLiterals,
  stripUrls,
  untraceableInFinding,
  untraceableWordFiguresInFinding,
  type FindingTraceContext,
} from '../../validate/numerals.ts';
import { lintAdviceCopy } from '../copy-lint.ts';
import {
  ASK_ANSWER_MAX,
  ASK_ANSWER_MAX_SENTENCES,
  ASK_NARRATE_FACTS_PER_CALL,
  ASK_NARRATE_FIGURES_PER_CALL,
} from './manifest.ts';
import { askCallLabel, percentText, type AskResultView } from './results.ts';

export interface AskNarrateFigure {
  readonly label: string;
  readonly text: string;
  readonly source_refs: readonly string[];
}

export interface AskNarrateResult {
  readonly function: string;
  readonly label: string;
  readonly status: 'ok' | 'not_available' | 'refused';
  readonly as_of: string | null;
  readonly not_available: string | null;
  readonly figures: readonly AskNarrateFigure[];
  /** Figures this result has beyond those sent (the screen shows them; the answer may not use them). */
  readonly more_figures: number;
  readonly facts: readonly string[];
}

export interface AskNarrateKnowledge {
  readonly pages: readonly {
    readonly key: string;
    readonly title: string;
    readonly text: string;
  }[];
  readonly params: readonly { readonly key: string; readonly rendered: string }[];
}

/** Structurally `@advisor/local-model`'s `AskNarrateSubject`. */
export interface AskNarrateSubject {
  readonly question: string;
  readonly date: string;
  readonly results: readonly AskNarrateResult[];
  readonly knowledge: AskNarrateKnowledge;
  readonly max_sentences: number;
  readonly max_characters: number;
}

export interface AskNarrateWireRequest {
  readonly request_id: string;
  readonly subject: AskNarrateSubject;
  readonly deadline: string;
  readonly max_response_bytes: number;
}

export interface AskNarratePayload {
  readonly snapshot: { readonly ask_narrate: AskNarrateSubject };
  readonly granted_scopes: readonly string[];
}

/** What the knowledge base gave the narration, and what it refused to give. */
export interface AskKnowledgeSent {
  readonly pages: readonly ReviewedPlaybookPage[];
  readonly params: readonly ParameterCitation[];
  /** Pages the functions rest on that were not sent, with the knowledge base's refusal code. */
  readonly withheld: readonly { readonly key: string; readonly code: string }[];
}

export interface AskNarrateCheck {
  readonly trace: FindingTraceContext;
  /** The functions the app ran for this question. */
  readonly ran: readonly string[];
  readonly sent: SentKnowledge;
  /** `null` when no knowledge base is bound: then any citation marker is refused as unknown. */
  readonly knowledge: KnowledgeCatalogue | null;
  /** Every figure text the results license (for the citation resolver's own numeral pass). */
  readonly allowedFigures: readonly string[];
}

export interface BuiltAskNarrateRequest {
  readonly request: AskNarrateWireRequest;
  readonly payload: AskNarratePayload;
  readonly digest: string;
  readonly check: AskNarrateCheck;
}

function catalogueOrder(scopes: Iterable<string>): AdvisorScope[] {
  const wanted = new Set(scopes);
  return ADVISOR_SCOPES.filter((scope) => wanted.has(scope));
}

/** The subject for one question's results. Pure. */
export function askNarrateSubjectOf(input: {
  readonly question: string;
  readonly date: string;
  readonly results: readonly AskResultView[];
  readonly knowledge: Pick<AskKnowledgeSent, 'pages' | 'params'>;
}): AskNarrateSubject {
  return {
    question: input.question,
    date: input.date,
    results: input.results.map((result) => {
      const figures = result.figures.slice(0, ASK_NARRATE_FIGURES_PER_CALL);
      return {
        function: result.function,
        label: result.label,
        status: result.status,
        as_of: result.as_of,
        not_available:
          result.status === 'not_available'
            ? (result.not_available?.reason ?? 'Not available.')
            : result.status === 'refused'
              ? 'This calculation could not run for what was asked.'
              : null,
        figures: figures.map((figure) => ({
          label: figure.label,
          text: figure.text,
          source_refs: figure.source_refs.slice(0, 4),
        })),
        more_figures: result.figures_total - figures.length,
        facts: [
          ...new Set(
            result.facts
              .map((fact) => fact.text)
              .filter((text) => !/^[A-Z]{2,}_[0-9A-Za-z]{6,}$/u.test(text)),
          ),
        ].slice(0, ASK_NARRATE_FACTS_PER_CALL),
      };
    }),
    knowledge: {
      pages: input.knowledge.pages.map((page) => ({
        key: page.key,
        title: page.title,
        text: page.text,
      })),
      params: input.knowledge.params.flatMap((citation) => {
        const rendered = renderParameter(citation);
        return rendered === null ? [] : [{ key: citation.key, rendered }];
      }),
    },
    max_sentences: ASK_ANSWER_MAX_SENTENCES,
    max_characters: ASK_ANSWER_MAX,
  };
}

const DATE_TOKEN = /\b\d{4}-\d{2}(?:-\d{2})?\b/g;
const PSEUDONYM_TOKEN = /\b[A-Z]{2,}_[0-9A-Za-z]{6,}\b/g;

/** Texts the compiled arguments license ("$400.00", "3", "2026", "62, 67, 70"). */
function argumentTexts(results: readonly AskResultView[]): readonly string[] {
  return results.map((result) => askCallLabel(result.function, result.args));
}

/**
 * The narrow trace over one question's results: the figures as the app wrote
 * them (and the raw decimals, and a ratio's percentage), the arguments the
 * calls ran with, every date masked whole, and the facts and the question as
 * prose a reply may quote whole — never mined for a figure.
 */
export function askNarrateTraceContext(input: {
  readonly subject: AskNarrateSubject;
  readonly results: readonly AskResultView[];
}): { readonly trace: FindingTraceContext; readonly allowed: readonly string[] } {
  const sentKeys = new Set(
    input.subject.results.flatMap((result) =>
      result.figures.map((figure) => `${result.function}\u0000${figure.label}`),
    ),
  );
  const figureTexts: string[] = [];
  const literals = new Set<string>([input.subject.date]);
  for (const result of input.results) {
    if (result.as_of !== null) literals.add(result.as_of);
    for (const figure of result.figures) {
      if (!sentKeys.has(`${result.function}\u0000${figure.label}`)) continue;
      if (figure.kind === 'date') {
        literals.add(figure.text);
        continue;
      }
      figureTexts.push(figure.text);
      if (figure.raw !== null) {
        figureTexts.push(figure.raw);
        const percent = percentText(figure.raw);
        if (percent !== null) figureTexts.push(percent);
      }
    }
  }
  figureTexts.push(...argumentTexts(input.results));
  for (const param of input.subject.knowledge.params) figureTexts.push(param.rendered);
  const prose = [
    input.subject.question,
    ...input.subject.results.flatMap((result) => result.facts),
    ...input.subject.results.flatMap((result) =>
      result.not_available === null ? [] : [result.not_available],
    ),
  ].filter((text) => text.length >= 3);
  const tokens = new Set<string>();
  for (const text of [...figureTexts, ...prose, ...literals]) {
    for (const match of text.matchAll(DATE_TOKEN)) tokens.add(match[0]);
    for (const match of text.matchAll(PSEUDONYM_TOKEN)) tokens.add(match[0]);
  }
  const tokenList = [...tokens].sort((left, right) => right.length - left.length);
  const figures = new Set<string>();
  for (const text of figureTexts) {
    const masked = maskLiterals(stripUrls(text), tokenList);
    for (const numeral of extractNumerals(masked)) {
      figures.add(numeral.isPercent ? `${numeral.normalized}%` : numeral.normalized);
    }
  }
  for (const token of tokenList) literals.add(token);
  return {
    trace: {
      figures,
      literals: [...literals]
        .filter((literal) => literal.length > 0)
        .sort((left, right) => right.length - left.length)
        .slice(0, 512),
      prose,
    },
    allowed: figureTexts,
  };
}

export function buildAskNarrateRequest(input: {
  readonly question: string;
  readonly date: string;
  readonly results: readonly AskResultView[];
  readonly knowledge: AskKnowledgeSent;
  readonly knowledgeCatalogue: KnowledgeCatalogue | null;
  readonly now: Date;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}): BuiltAskNarrateRequest {
  const subject = askNarrateSubjectOf(input);
  const payload: AskNarratePayload = {
    snapshot: { ask_narrate: subject },
    granted_scopes: catalogueOrder(input.results.flatMap((result) => result.scopes)),
  };
  const { trace, allowed } = askNarrateTraceContext({ subject, results: input.results });
  return {
    request: {
      request_id: newId(),
      subject,
      deadline: new Date(input.now.getTime() + input.timeoutMs).toISOString(),
      max_response_bytes: input.maxResponseBytes,
    },
    payload,
    digest: canonicalRunDigest(payload),
    check: {
      trace,
      ran: input.results.map((result) => result.function),
      sent: {
        pages: input.knowledge.pages,
        params: input.knowledge.params,
        allowedFigures: allowed,
      },
      knowledge: input.knowledgeCatalogue,
      allowedFigures: allowed,
    },
  };
}

// ---------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------

export const ASK_NARRATE_REFUSAL_CLASSES = [
  'narrate.schema',
  'narrate.empty',
  'narrate.too_long',
  'narrate.sentences',
  'narrate.markup',
  'narrate.link',
  'narrate.function_reference',
  'narrate.numeral',
  'narrate.word_figure',
  'narrate.citation.malformed',
  'narrate.citation.unknown',
  'narrate.citation.page_not_sent',
  'narrate.citation.param_not_sent',
  'narrate.citation.numeral',
  'narrate.citation.word_figure',
  'narrate.copy',
] as const;
export type AskNarrateRefusalClass = (typeof ASK_NARRATE_REFUSAL_CLASSES)[number];

export type AskNarrateValidation =
  | {
      readonly ok: true;
      /** As the model wrote it (markers included): what is stored. */
      readonly text: string;
      /** The cited pages and parameters, and the read record the session keeps. */
      readonly record: KnowledgeReadRecord | null;
    }
  | { readonly ok: false; readonly refusal: AskNarrateRefusalClass; readonly detail: string };

const BRACKETS = /[<>{}]/u;
const BARE_LINK = /(?:\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|app|dev)\b)/iu;
const SENTENCE_END = /[.!?](?=\s|$)/gu;
const FUNCTION_NAME = new RegExp(
  `\\b(?:${CATALOGUE_FUNCTION_NAMES.map((name) => name.replace('.', '\\.')).join('|')})\\b`,
  'gu',
);
/** Anything shaped like a catalogue name (`word.word`) that the catalogue does not hold. */
const FUNCTION_SHAPED =
  /\b(?:situation|cash|debt|goal|plan|retirement|investing|limits|recurring|insights|spending|transactions|ledger|accounts|budget|reports)\.[a-z][a-z_]{2,}\b/gu;

function refused(refusal: AskNarrateRefusalClass, detail: string): AskNarrateValidation {
  return { ok: false, refusal, detail };
}

/** The answer as the holder reads it: citation markers out. */
export function askAnswerDisplayText(text: string): string {
  return text
    .replace(CITATION_MARKER, '')
    .replace(/\s+([.,;:!?])/gu, '$1')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

/** Pure and total over arbitrary JSON. */
export function validateAskNarrateReply(
  reply: unknown,
  check: AskNarrateCheck,
): AskNarrateValidation {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) {
    return refused('narrate.schema', 'the reply is not a JSON object');
  }
  const keys = Object.keys(reply);
  const raw = (reply as Record<string, unknown>)['answer'];
  if (keys.length !== 1 || keys[0] !== 'answer' || typeof raw !== 'string') {
    return refused('narrate.schema', 'the reply is not exactly { answer: string }');
  }
  const text = raw.trim();
  if (text.length === 0) return refused('narrate.empty', 'the answer is empty');
  if ([...text].length > ASK_ANSWER_MAX) {
    return refused('narrate.too_long', `the answer is over ${String(ASK_ANSWER_MAX)} characters`);
  }
  const display = askAnswerDisplayText(text);
  const sentences = (display.match(SENTENCE_END) ?? []).length;
  if (sentences > ASK_ANSWER_MAX_SENTENCES) {
    return refused(
      'narrate.sentences',
      `the answer has ${String(sentences)} sentences; at most ${String(ASK_ANSWER_MAX_SENTENCES)}`,
    );
  }
  const markup = markdownViolations(display);
  if (markup.length > 0 || BRACKETS.test(display) || renderedText(display) !== display) {
    return refused(
      'narrate.markup',
      markup.length > 0 ? markup.join(', ') : 'braces, angle brackets or Markdown',
    );
  }
  if (linkTargetsOf(display).length > 0 || BARE_LINK.test(display)) {
    return refused('narrate.link', 'the answer carries a link');
  }
  const ran = new Set(check.ran);
  for (const match of display.matchAll(FUNCTION_NAME)) {
    if (!ran.has(match[0])) {
      return refused('narrate.function_reference', `names ${match[0]}, which was not run`);
    }
  }
  for (const match of display.matchAll(FUNCTION_SHAPED)) {
    if (!ran.has(match[0])) {
      return refused('narrate.function_reference', `names ${match[0]}, which was not run`);
    }
  }
  const outside = untraceableInFinding(display, check.trace);
  if (outside.length > 0) {
    return refused(
      'narrate.numeral',
      `${String(outside.length)} figure(s) not in the results: ${outside
        .slice(0, 4)
        .map((numeral) => numeral.raw)
        .join(', ')}`,
    );
  }
  const words = untraceableWordFiguresInFinding(display, check.trace);
  if (words.length > 0) {
    return refused(
      'narrate.word_figure',
      `a figure in words not in the results: ${words[0]?.raw ?? ''}`,
    );
  }
  let record: KnowledgeReadRecord | null = null;
  const hasMarker = new RegExp(CITATION_MARKER.source, 'u').test(text);
  if (hasMarker && check.knowledge === null) {
    return refused('narrate.citation.unknown', 'a citation, and no knowledge base is bound');
  }
  if (hasMarker && check.knowledge !== null) {
    const cited = resolveCitations(text, check.sent, check.knowledge);
    if (!cited.ok) {
      return refused(`narrate.${cited.refusal}` as AskNarrateRefusalClass, cited.detail);
    }
    record = cited.record;
  } else if (check.knowledge !== null) {
    record = knowledgeReadRecord(check.sent);
  }
  const copy = lintAdviceCopy(display, 'summary_md');
  if (copy.length > 0) {
    return refused('narrate.copy', copy.map((violation) => violation.detail).join('; '));
  }
  return { ok: true, text, record };
}
