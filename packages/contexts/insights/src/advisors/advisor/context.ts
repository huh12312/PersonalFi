// SPDX-License-Identifier: MIT
/**
 * The advisor's context object (WP 11.5d; 12 §2.3 step 2, 07 §7.3) and the
 * checks every model sentence in it is held to.
 *
 * After the gather step the app has: the clarified question, the holder's
 * answers, the catalogue results (11.5c's `AskResultView`s, every figure the
 * app's own rendering with its `source_refs`), and the knowledge sent
 * (reviewed playbook pages — none today — and the parameters the calls read).
 * That is the context object. Its digest is stored on the session, and the
 * options, trade-offs and plan steps are each sent it (inside their own
 * payloads, which `advisor_runs` digests), so "why did it say that?" is
 * answerable from the row six months later.
 *
 * Each figure the model may point at carries a **ref** of the app's own
 * making: `r<n>:<figure path>` — the n-th result's figure at that path
 * (`r1:plans[0].total_interest`). An option's backing and a trade-off's
 * benefit and cost are lists of these refs, and a ref resolves only to a
 * figure the context object carries: never a figure the model wrote.
 */
import { configHash } from '@core/platform';
import {
  knowledgeReadRecord,
  resolveCitations,
  CITATION_MARKER,
  type KnowledgeCatalogue,
  type KnowledgeReadRecord,
  type SentKnowledge,
} from '../../knowledge/citations.ts';
import { linkTargetsOf, markdownViolations, renderedText } from '../../validate/markdown.ts';
import {
  untraceableInFinding,
  untraceableWordFiguresInFinding,
  type FindingTraceContext,
} from '../../validate/numerals.ts';
import { lintAdviceCopy, type CopyField } from '../copy-lint.ts';
import {
  askNarrateSubjectOf,
  askNarrateTraceContext,
  type AskKnowledgeSent,
} from '../ask/narrate.ts';
import type { AskResultView } from '../ask/results.ts';
import { ADVISOR_FIGURES_PER_RESULT } from './manifest.ts';
import { isFindingResult } from './origin.ts';

export interface AdvisorContextFigure {
  readonly ref: string;
  readonly label: string;
  readonly text: string;
  /**
   * WP 11.5e: on a finding's own figures only (`finding.evidence`), the evidence row's `source_ref` — the
   * snapshot path the validator resolved when the built-in wrote it. Absent on a catalogue figure.
   */
  readonly source_refs?: readonly string[];
}

export interface AdvisorContextResult {
  readonly id: string;
  readonly function: string;
  readonly label: string;
  readonly status: 'ok' | 'not_available' | 'refused';
  readonly as_of: string | null;
  readonly not_available: string | null;
  readonly figures: readonly AdvisorContextFigure[];
  readonly more_figures: number;
  readonly facts: readonly string[];
}

export interface AdvisorContextObject {
  /** The clarified question (the restatement), as validated. */
  readonly question: string;
  readonly answers: readonly { readonly question: string; readonly answer: string }[];
  readonly date: string;
  readonly results: readonly AdvisorContextResult[];
  readonly knowledge: {
    readonly pages: readonly {
      readonly key: string;
      readonly title: string;
      readonly text: string;
    }[];
    readonly params: readonly { readonly key: string; readonly rendered: string }[];
  };
}

export interface AdvisorContextCheck {
  readonly trace: FindingTraceContext;
  readonly allowedFigures: readonly string[];
  readonly sent: SentKnowledge;
  readonly knowledge: KnowledgeCatalogue | null;
  /** ref → the figure, for every figure the context carries. */
  readonly refs: ReadonlyMap<string, AdvisorContextFigure>;
}

export interface BuiltAdvisorContext {
  readonly context: AdvisorContextObject;
  /** `sha256:` over the canonical context object (07 §7.3). */
  readonly digest: string;
  readonly check: AdvisorContextCheck;
}

/** The ref of one result's figure: `r1:plans[0].total_interest`. */
export function figureRef(resultIndex: number, key: string): string {
  return `r${String(resultIndex + 1)}:${key}`;
}

/** The context object, its digest and its checks. Pure. */
export function buildAdvisorContext(input: {
  readonly restatement: string;
  readonly answers: readonly { readonly question: string; readonly answer: string }[];
  readonly date: string;
  readonly results: readonly AskResultView[];
  readonly knowledge: AskKnowledgeSent;
  readonly knowledgeCatalogue: KnowledgeCatalogue | null;
}): BuiltAdvisorContext {
  const subject = askNarrateSubjectOf({
    question: input.restatement,
    date: input.date,
    results: input.results.map((result) => ({
      ...result,
      figures: result.figures.slice(0, ADVISOR_FIGURES_PER_RESULT),
    })),
    knowledge: input.knowledge,
  });
  const refs = new Map<string, AdvisorContextFigure>();
  const results: AdvisorContextResult[] = input.results.map((result, index) => {
    const sent = result.figures.slice(0, ADVISOR_FIGURES_PER_RESULT);
    const narrated = subject.results[index];
    const finding = isFindingResult(result);
    const figures = sent.map((figure) => {
      const entry: AdvisorContextFigure = {
        ref: figureRef(index, figure.key),
        label: figure.label,
        text: figure.text,
        ...(finding ? { source_refs: [...figure.source_refs] } : {}),
      };
      refs.set(entry.ref, entry);
      return entry;
    });
    return {
      id: `r${String(index + 1)}`,
      function: result.function,
      label: result.label,
      status: result.status,
      as_of: result.as_of,
      not_available: narrated?.not_available ?? null,
      figures,
      more_figures: result.figures_total - sent.length,
      facts: narrated?.facts ?? [],
    };
  });
  const context: AdvisorContextObject = {
    question: input.restatement,
    answers: input.answers.map((entry) => ({ question: entry.question, answer: entry.answer })),
    date: input.date,
    results,
    knowledge: subject.knowledge,
  };
  const traced = askNarrateTraceContext({
    subject,
    results: input.results.map((result) => ({
      ...result,
      figures: result.figures.slice(0, ADVISOR_FIGURES_PER_RESULT),
    })),
  });
  // The holder's own answers are prose a reply may quote whole, never a figure source.
  const trace: FindingTraceContext = {
    ...traced.trace,
    prose: [
      ...traced.trace.prose,
      ...input.answers.flatMap((entry) => [entry.question, entry.answer]),
      // WP 11.5e: a finding's label carries its title — quotable whole, never a figure source.
      ...input.results.filter((result) => isFindingResult(result)).map((result) => result.label),
    ].filter((text) => text.length >= 3),
  };
  return {
    context,
    digest: `sha256:${configHash(context as unknown as Record<string, unknown>)}`,
    check: {
      trace,
      allowedFigures: traced.allowed,
      sent: {
        pages: input.knowledge.pages,
        params: input.knowledge.params,
        allowedFigures: traced.allowed,
      },
      knowledge: input.knowledgeCatalogue,
      refs,
    },
  };
}

// ---------------------------------------------------------------------------
// The checks a model sentence is held to
// ---------------------------------------------------------------------------

export type ProseRefusal =
  | 'empty'
  | 'too_long'
  | 'sentences'
  | 'markup'
  | 'link'
  | 'numeral'
  | 'word_figure'
  | 'citation.malformed'
  | 'citation.unknown'
  | 'citation.page_not_sent'
  | 'citation.param_not_sent'
  | 'citation.numeral'
  | 'citation.word_figure'
  | 'copy';

export type ProseVerdict =
  | { readonly ok: true; readonly record: KnowledgeReadRecord | null }
  | { readonly ok: false; readonly refusal: ProseRefusal; readonly detail: string };

const BRACKETS = /[<>{}]/u;
const BARE_LINK = /(?:\bwww\.|\bhttps?:|\b[a-z0-9-]+\.(?:com|net|org|io|co|app|dev)\b)/iu;
const SENTENCE_END = /[.!?](?=\s|$)/gu;

/** The text as a holder reads it: citation markers out. */
export function advisorDisplayText(text: string): string {
  return text
    .replace(CITATION_MARKER, '')
    .replace(/\s+([.,;:!?])/gu, '$1')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

/**
 * One model sentence (or two) against everything 12 §4 asks: the length, the
 * markup, a link, every figure traced to the context (numerals and words), a
 * citation resolved to what was sent, and the copy linter. Pure and total.
 */
export function checkAdvisorProse(
  raw: string,
  input: {
    readonly max: number;
    readonly maxSentences: number | null;
    readonly field: CopyField;
    readonly trace: FindingTraceContext;
    readonly sent: SentKnowledge | null;
    readonly knowledge: KnowledgeCatalogue | null;
  },
): ProseVerdict {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, refusal: 'empty', detail: 'empty' };
  if ([...text].length > input.max) {
    return { ok: false, refusal: 'too_long', detail: `over ${String(input.max)} characters` };
  }
  const display = advisorDisplayText(text);
  if (input.maxSentences !== null) {
    const sentences = (display.match(SENTENCE_END) ?? []).length;
    if (sentences > input.maxSentences) {
      return {
        ok: false,
        refusal: 'sentences',
        detail: `${String(sentences)} sentences; at most ${String(input.maxSentences)}`,
      };
    }
  }
  const markup = markdownViolations(display);
  if (markup.length > 0 || BRACKETS.test(display) || renderedText(display) !== display) {
    return {
      ok: false,
      refusal: 'markup',
      detail: markup.length > 0 ? markup.join(', ') : 'braces, angle brackets or Markdown',
    };
  }
  if (linkTargetsOf(display).length > 0 || BARE_LINK.test(display)) {
    return { ok: false, refusal: 'link', detail: 'carries a link' };
  }
  const outside = untraceableInFinding(display, input.trace);
  if (outside.length > 0) {
    return {
      ok: false,
      refusal: 'numeral',
      detail: `${String(outside.length)} figure(s) not in the context: ${outside
        .slice(0, 4)
        .map((numeral) => numeral.raw)
        .join(', ')}`,
    };
  }
  const words = untraceableWordFiguresInFinding(display, input.trace);
  if (words.length > 0) {
    return {
      ok: false,
      refusal: 'word_figure',
      detail: `a figure in words not in the context: ${words[0]?.raw ?? ''}`,
    };
  }
  let record: KnowledgeReadRecord | null = null;
  const hasMarker = new RegExp(CITATION_MARKER.source, 'u').test(text);
  if (hasMarker && (input.knowledge === null || input.sent === null)) {
    return { ok: false, refusal: 'citation.unknown', detail: 'a citation, and no knowledge base' };
  }
  if (hasMarker && input.knowledge !== null && input.sent !== null) {
    const cited = resolveCitations(text, input.sent, input.knowledge);
    if (!cited.ok) {
      return {
        ok: false,
        refusal: (cited.refusal.startsWith('citation.')
          ? cited.refusal
          : `citation.${cited.refusal}`) as ProseRefusal,
        detail: cited.detail,
      };
    }
    record = cited.record;
  } else if (input.sent !== null && input.knowledge !== null) {
    record = knowledgeReadRecord(input.sent);
  }
  const copy = lintAdviceCopy(display, input.field);
  if (copy.length > 0) {
    return {
      ok: false,
      refusal: 'copy',
      detail: copy.map((violation) => violation.detail).join('; '),
    };
  }
  return { ok: true, record };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return own.length === wanted.length && own.every((key, index) => key === wanted[index]);
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
