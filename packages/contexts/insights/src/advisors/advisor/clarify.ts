// SPDX-License-Identifier: MIT
/**
 * `advisor.clarify` (WP 11.5d; 12 §2.3 step 1): the request and the validator.
 *
 * ## What is sent, and nothing else
 *
 *   * the opening question, after 11.5c's deterministic pre-check;
 *   * the holder-visible catalogue listing's **summaries** (name and summary;
 *     never a schema, never a result);
 *   * the plan's defaults when there are some: the plan's retirement age (by
 *     the ref `plan:retirement_age`) and **the goals' names with their
 *     `goal_ref`s** (`goal:GOAL_…`) — never a goal id, never a balance.
 *     Resolving "my house goal" to a ref is this step's job, and the reply may
 *     name only refs that were sent.
 *
 * ## The reply, validated (`validateClarifyReply`)
 *
 * Exactly `{ restatement, questions, assumed }`:
 *
 *   * `clarify.schema` — anything else;
 *   * `clarify.restatement.*` — the restatement's prose checks (`empty`,
 *     `too_long`, `sentences`, `markup`, `link`, `copy`), and **`numeral` /
 *     `word_figure` against the question only**: a restatement may repeat the
 *     holder's own figures and add none;
 *   * `clarify.too_many_questions` — more than two;
 *   * `clarify.not_a_question` — a question that is not one sentence ending
 *     in a question mark; its prose checks as `clarify.question.*`;
 *   * `clarify.too_many_assumed`, and **`clarify.ref_not_sent`** — an assumed
 *     default (or a `GOAL_` pseudonym in the prose) that was not in the
 *     defaults sent.
 *
 * ## A session opened from a finding (WP 11.5e)
 *
 * The subject gains `about`: the finding's title and its rule's name and
 * words, **as a quoted fact**. The restatement may name the finding by
 * quoting them whole; they are never mined for a figure — the title is masked
 * out of the question before the question's own figures are read, so a
 * restatement that lifts "2.4 months" out of the title on its own is refused
 * (`numeral`), exactly as a figure the holder never typed would be.
 */
import { newId } from '@core/kernel';
import { canonicalRunDigest } from '../../preview.ts';
import {
  extractNumerals,
  maskLiterals,
  type FindingTraceContext,
} from '../../validate/numerals.ts';
import {
  ADVISOR_CLARIFYING_QUESTION_MAX,
  ADVISOR_MAX_ASSUMED,
  ADVISOR_MAX_QUESTIONS,
  ADVISOR_RESTATEMENT_MAX,
} from './manifest.ts';
import { checkAdvisorProse, exactKeys, isRecord, type ProseRefusal } from './context.ts';

export interface AdvisorDefaults {
  /** The plan's retirement age, when the holder has a plan the narrator grant lets the advisor read. */
  readonly retirementAge: number | null;
  /** The goals' names and their pseudonymous refs. Never an id. */
  readonly goals: readonly { readonly goal_ref: string; readonly name: string }[];
}

export interface ClarifySubject {
  readonly question: string;
  readonly functions: readonly { readonly name: string; readonly summary: string }[];
  readonly defaults: {
    readonly refs: readonly {
      readonly ref: string;
      readonly about: string;
      readonly value: string;
    }[];
  };
  readonly max_questions: number;
  /** WP 11.5e: the finding the session was opened from — quoted, never a figure source. Absent otherwise. */
  readonly about?: ClarifyAbout;
}

/** The finding as the clarify step is told it: its title and its rule, in the app's words. */
export interface ClarifyAbout {
  readonly title: string;
  readonly rule: { readonly name: string; readonly text: string };
}

export interface ClarifyCheck {
  readonly question: string;
  readonly refs: readonly string[];
  readonly goalRefs: readonly string[];
  /** WP 11.5e: prose the restatement may quote whole and never mine (the finding's title and rule). */
  readonly quoted?: readonly string[];
}

export interface AdvisorWireRequest<Subject> {
  readonly request_id: string;
  readonly subject: Subject;
  readonly deadline: string;
  readonly max_response_bytes: number;
}

export interface AdvisorPayload<Key extends string, Subject> {
  readonly snapshot: Readonly<Record<Key, Subject>>;
  readonly granted_scopes: readonly string[];
}

export interface BuiltClarifyRequest {
  readonly request: AdvisorWireRequest<ClarifySubject>;
  readonly payload: AdvisorPayload<'advisor_clarify', ClarifySubject>;
  readonly digest: string;
  readonly check: ClarifyCheck;
}

export const PLAN_RETIREMENT_AGE_REF = 'plan:retirement_age';

/** The refs a clarify subject offers, from the holder's defaults. Pure. */
export function clarifyDefaultRefs(
  defaults: AdvisorDefaults,
): readonly { readonly ref: string; readonly about: string; readonly value: string }[] {
  return [
    ...(defaults.retirementAge === null
      ? []
      : [
          {
            ref: PLAN_RETIREMENT_AGE_REF,
            about: 'the retirement age in your plan',
            value: `age ${String(defaults.retirementAge)}`,
          },
        ]),
    ...defaults.goals.map((goal) => ({
      ref: `goal:${goal.goal_ref}`,
      about: 'a goal',
      value: goal.name,
    })),
  ];
}

export function buildClarifyRequest(input: {
  readonly question: string;
  readonly listing: readonly { readonly name: string; readonly summary: string }[];
  readonly defaults: AdvisorDefaults;
  readonly grantedScopes: readonly string[];
  readonly now: Date;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  /** WP 11.5e: the finding a session opened from it is about. */
  readonly about?: ClarifyAbout | null;
}): BuiltClarifyRequest {
  const refs = clarifyDefaultRefs(input.defaults);
  const about = input.about ?? null;
  const subject: ClarifySubject = {
    question: input.question,
    functions: input.listing.map((entry) => ({ name: entry.name, summary: entry.summary })),
    defaults: { refs: refs.map((entry) => ({ ...entry })) },
    max_questions: ADVISOR_MAX_QUESTIONS,
    ...(about === null
      ? {}
      : {
          about: {
            title: about.title,
            rule: { name: about.rule.name, text: about.rule.text },
          },
        }),
  };
  const payload = {
    snapshot: { advisor_clarify: subject },
    granted_scopes: [...input.grantedScopes],
  };
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
      question: input.question,
      refs: refs.map((entry) => entry.ref),
      goalRefs: input.defaults.goals.map((goal) => goal.goal_ref),
      ...(about === null ? {} : { quoted: [about.title, about.rule.name, about.rule.text] }),
    },
  };
}

// ---------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------

export interface Clarification {
  readonly restatement: string;
  readonly questions: readonly string[];
  readonly assumed: readonly { readonly about: string; readonly value_ref: string }[];
}

export type ClarifyRefusal =
  | 'clarify.schema'
  | `clarify.restatement.${ProseRefusal}`
  | `clarify.question.${ProseRefusal}`
  | 'clarify.too_many_questions'
  | 'clarify.not_a_question'
  | 'clarify.too_many_assumed'
  | 'clarify.ref_not_sent';

export type ClarifyValidation =
  | { readonly ok: true; readonly clarification: Clarification }
  | { readonly ok: false; readonly refusal: ClarifyRefusal; readonly detail: string };

const DATE_TOKEN = /\b\d{4}-\d{2}(?:-\d{2})?\b/gu;
const GOAL_TOKEN = /\bGOAL_[0-9A-Za-z]{4,}\b/gu;

/**
 * The question's own figures, as written: the only figures a restatement may
 * carry. WP 11.5e: `quoted` prose (a finding's title and rule) is masked out
 * of the question before its figures are read and may be quoted whole — never
 * mined for a figure.
 */
export function questionTraceContext(
  question: string,
  quoted: readonly string[] = [],
): FindingTraceContext {
  const prose = quoted.map((text) => text.trim()).filter((text) => text.length >= 3);
  const literals = [...new Set([...question.matchAll(DATE_TOKEN)].map((match) => match[0]))];
  // Longest first, whole: `maskLiterals` skips long literals, and a title may run to 200 characters.
  let masked = question;
  for (const text of [...prose].sort((left, right) => right.length - left.length)) {
    masked = masked.split(text).join(' ');
  }
  const figures = new Set<string>();
  for (const numeral of extractNumerals(maskLiterals(masked, literals))) {
    figures.add(numeral.isPercent ? `${numeral.normalized}%` : numeral.normalized);
  }
  return { figures, literals, prose };
}

function refused(refusal: ClarifyRefusal, detail: string): ClarifyValidation {
  return { ok: false, refusal, detail };
}

/** Pure and total over arbitrary JSON. */
export function validateClarifyReply(reply: unknown, check: ClarifyCheck): ClarifyValidation {
  if (!isRecord(reply) || !exactKeys(reply, ['restatement', 'questions', 'assumed'])) {
    return refused(
      'clarify.schema',
      'the reply is not exactly { restatement, questions, assumed }',
    );
  }
  const { restatement, questions, assumed } = reply;
  if (typeof restatement !== 'string' || !Array.isArray(questions) || !Array.isArray(assumed)) {
    return refused('clarify.schema', 'a field has the wrong type');
  }
  if (questions.some((entry) => typeof entry !== 'string')) {
    return refused('clarify.schema', 'a question is not a string');
  }
  for (const entry of assumed as unknown[]) {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ['about', 'value_ref']) ||
      typeof entry['about'] !== 'string' ||
      typeof entry['value_ref'] !== 'string'
    ) {
      return refused('clarify.schema', 'an assumed default is not exactly { about, value_ref }');
    }
  }
  const trace = questionTraceContext(check.question, check.quoted ?? []);
  const proseOf = (text: string, max: number, maxSentences: number) =>
    checkAdvisorProse(text, {
      max,
      maxSentences,
      field: 'summary_md',
      trace,
      sent: null,
      knowledge: null,
    });
  const restated = proseOf(restatement, ADVISOR_RESTATEMENT_MAX, 2);
  if (!restated.ok) return refused(`clarify.restatement.${restated.refusal}`, restated.detail);
  if (questions.length > ADVISOR_MAX_QUESTIONS) {
    return refused(
      'clarify.too_many_questions',
      `${String(questions.length)} questions; at most ${String(ADVISOR_MAX_QUESTIONS)}`,
    );
  }
  const asked: string[] = [];
  for (const raw of questions as string[]) {
    const text = raw.trim();
    // A question is one sentence that ends in its only question mark.
    if (!/\?$/u.test(text) || (text.match(/[?.!]/gu) ?? []).length !== 1) {
      return refused(
        'clarify.not_a_question',
        'a clarifying question is not one sentence ending in “?”',
      );
    }
    const checked = proseOf(text, ADVISOR_CLARIFYING_QUESTION_MAX, 1);
    if (!checked.ok) return refused(`clarify.question.${checked.refusal}`, checked.detail);
    asked.push(text);
  }
  if (assumed.length > ADVISOR_MAX_ASSUMED) {
    return refused(
      'clarify.too_many_assumed',
      `at most ${String(ADVISOR_MAX_ASSUMED)} assumed defaults`,
    );
  }
  const sent = new Set(check.refs);
  const defaults = (assumed as Record<string, string>[]).map((entry) => ({
    about: (entry['about'] ?? '').trim().slice(0, 80),
    value_ref: entry['value_ref'] ?? '',
  }));
  for (const entry of defaults) {
    if (!sent.has(entry.value_ref)) {
      return refused(
        'clarify.ref_not_sent',
        `${entry.value_ref.slice(0, 64)} was not among the defaults sent`,
      );
    }
  }
  const goals = new Set(check.goalRefs);
  for (const text of [restatement, ...asked]) {
    for (const match of text.matchAll(GOAL_TOKEN)) {
      if (!goals.has(match[0])) {
        return refused('clarify.ref_not_sent', `${match[0]} was not among the goals sent`);
      }
    }
  }
  return {
    ok: true,
    clarification: { restatement: restatement.trim(), questions: asked, assumed: defaults },
  };
}
