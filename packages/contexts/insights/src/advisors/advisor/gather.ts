// SPDX-License-Identifier: MIT
/**
 * `advisor.gather` (WP 11.5d; 12 §2.3 step 2): **11.5c's compile step reused as
 * is** — `askCompileSubjectOf`, `buildAskCompileRequest` and
 * `validateAskCompileReply`, unchanged — over the clarified question: the
 * restatement and the holder's answers, as the question text. The app then
 * runs the compiled calls in process under the holder's grants (11.5c's
 * `runAskCalls`), and reads the playbook pages the question touches, chosen
 * **deterministically by topic keyword** (`topics.ts`), through the knowledge
 * base's review gate: a draft is never sent, and the session records it as
 * withheld. Pages are cited only when they exist; with none reviewed the
 * advisor works from the results and the parameters alone.
 *
 * A compile refusal is the gather step's refusal: `compile.unknown_function`
 * becomes `gather.unknown_function`, and so on.
 */
import {
  isKnowledgeRefusal,
  type KnowledgeBase,
  type ReviewedPlaybookPage,
} from '../../knowledge/playbook.ts';
import { askKnowledgeFor } from '../ask/run.ts';
import type { AskKnowledgeSent } from '../ask/narrate.ts';
import type { AskResultView } from '../ask/results.ts';
import type { AskCompileRefusalClass } from '../ask/compile.ts';
import { ADVISOR_QUESTION_MAX } from './manifest.ts';
import { advisorPagesFor } from './topics.ts';

/** The compile step's question text: the restatement, then each question with its answer. */
export function advisorGatherQuestion(input: {
  readonly restatement: string;
  readonly answers: readonly { readonly question: string; readonly answer: string }[];
}): string {
  const parts = [input.restatement.trim()];
  for (const entry of input.answers) {
    const answer = entry.answer.trim();
    if (answer.length === 0) continue;
    parts.push(`${entry.question.trim()} ${answer}`);
  }
  const text = parts.join(' ').replace(/\s+/gu, ' ').trim();
  return [...text].slice(0, ADVISOR_QUESTION_MAX * 2).join('');
}

export type GatherRefusal = `gather.${string}`;

/** `compile.unknown_function` → `gather.unknown_function`. */
export function gatherRefusalOf(refusal: AskCompileRefusalClass): GatherRefusal {
  return `gather.${refusal.slice('compile.'.length)}`;
}

/**
 * What the knowledge base gives the advisor for this question: the pages its
 * results rest on (11.5c's per-function table) and the pages its topic
 * touches (this package's keyword table), each through the review gate, plus
 * the parameters the calls read.
 */
export function advisorKnowledgeFor(
  knowledge: KnowledgeBase | null,
  input: { readonly text: string; readonly results: readonly AskResultView[] },
): AskKnowledgeSent & { readonly topicPages: readonly string[] } {
  const topicPages = advisorPagesFor(input.text);
  if (knowledge === null) return { pages: [], params: [], withheld: [], topicPages };
  const fromResults = askKnowledgeFor(knowledge, input.results);
  const pages: ReviewedPlaybookPage[] = [...fromResults.pages];
  const withheld = [...fromResults.withheld];
  const seen = new Set([
    ...fromResults.pages.map((page) => page.key),
    ...fromResults.withheld.map((entry) => entry.key),
  ]);
  for (const key of topicPages) {
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      pages.push(knowledge.playbook.get(key));
    } catch (error) {
      if (!isKnowledgeRefusal(error)) throw error;
      withheld.push({ key, code: error.code });
    }
  }
  return { pages, params: fromResults.params, withheld, topicPages };
}
