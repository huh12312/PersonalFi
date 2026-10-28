// SPDX-License-Identifier: MIT
/**
 * `advisor.judge` — the rubric judge (WP 11.5d; 12 §5 "Advice quality",
 * §7 decision 3).
 *
 * A second model call that scores the advisor's wording against a rubric in
 * code (`topics.ts`: per playbook page, did the wording surface the cost, did
 * it say when the approach does not apply, did it stay in scope). It is sent
 * **only the narration and the rubric — never the holder's data**: the
 * narration is the restatement, the options and the trade-off notes as the
 * validators passed them, with **every figure masked** (`[figure]`) before it
 * is sent, so not even the figures the narration quoted cross. Its provider
 * rule and consent are the advisor's own (D31).
 *
 * The score is **evidence, never a gate**: a low score never stops a session
 * (the cost-pairing validator is the gate, `tradeoffs.ts`), and a judge that
 * fails or is refused leaves the session as it was with `judge_error` set.
 *
 * The reply is exactly `{ scores: [{ criterion, met, reason }] }`:
 *
 *   * `judge.schema`, `judge.coverage` (every rubric criterion exactly once);
 *   * `judge.too_long` — a reason over 200 characters;
 *   * **`judge.holder_data`** — a reason carrying a digit, a currency sign, a
 *     pseudonym (`MERCHANT_…`, `GOAL_…`) or a date: the judge was sent none,
 *     so anything of the kind is invented or leaked, and nothing of it is
 *     stored.
 */
import { newId } from '@core/kernel';
import { canonicalRunDigest } from '../../preview.ts';
import { exactKeys, isRecord } from './context.ts';
import type { AdvisorPayload, AdvisorWireRequest } from './clarify.ts';
import { ADVISOR_JUDGE_REASON_MAX } from './manifest.ts';
import type { AdvisorRubric } from './topics.ts';

export interface JudgeSubject {
  readonly narration: readonly { readonly part: string; readonly text: string }[];
  readonly rubric: AdvisorRubric;
}

export interface BuiltJudgeRequest {
  readonly request: AdvisorWireRequest<JudgeSubject>;
  readonly payload: AdvisorPayload<'advisor_judge', JudgeSubject>;
  readonly digest: string;
}

const MONEY_OR_NUMBER =
  /(?:[$€£¥]\s?)?[+-]?\d[\d,]*(?:\.\d+)?(?:\s?%)?(?:\s?(?:[kmb]|thousand|million|billion)\b)?/giu;
const NUMBER_WORDS =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|quarter|dozen)\b/giu;
const PSEUDONYM = /\b[A-Z]{2,}_[0-9A-Za-z]{4,}\b/gu;

/**
 * The narration with every figure, number word and pseudonym masked. What the
 * judge sees: the wording, and nothing of the holder's.
 */
export function maskNarration(text: string): string {
  return text
    .replace(PSEUDONYM, '[ref]')
    .replace(MONEY_OR_NUMBER, '[figure]')
    .replace(NUMBER_WORDS, '[figure]')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

export function buildJudgeRequest(input: {
  readonly narration: readonly { readonly part: string; readonly text: string }[];
  readonly rubric: AdvisorRubric;
  readonly now: Date;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}): BuiltJudgeRequest {
  const subject: JudgeSubject = {
    narration: input.narration.map((entry) => ({
      part: entry.part,
      text: maskNarration(entry.text),
    })),
    rubric: {
      page: input.rubric.page,
      criteria: input.rubric.criteria.map((criterion) => ({ ...criterion })),
    },
  };
  // No data category crosses: the judge is sent wording and a rubric.
  const payload = { snapshot: { advisor_judge: subject }, granted_scopes: [] as string[] };
  return {
    request: {
      request_id: newId(),
      subject,
      deadline: new Date(input.now.getTime() + input.timeoutMs).toISOString(),
      max_response_bytes: input.maxResponseBytes,
    },
    payload,
    digest: canonicalRunDigest(payload),
  };
}

export interface JudgeScore {
  /** `met / criteria`, three places: `0.667`. */
  readonly score: string;
  readonly criteria: readonly {
    readonly criterion: string;
    readonly met: boolean;
    readonly reason: string;
  }[];
  readonly page: string;
}

export type JudgeRefusal =
  'judge.schema' | 'judge.coverage' | 'judge.too_long' | 'judge.holder_data';

export type JudgeValidation =
  | { readonly ok: true; readonly score: JudgeScore }
  | { readonly ok: false; readonly refusal: JudgeRefusal; readonly detail: string };

function refused(refusal: JudgeRefusal, detail: string): JudgeValidation {
  return { ok: false, refusal, detail };
}

/** What the judge may not write: anything that looks like the holder's data. */
const HOLDER_DATA =
  /\d|[$€£¥]|\b(?:MERCHANT|GOAL|ACCOUNT|LIABILITY|INSTITUTION)_|\bmerchant_ref\b/iu;

/** `met / total` to three places, by integer arithmetic. */
export function scoreText(met: number, total: number): string {
  if (total <= 0) return '0.000';
  const thousandths = Math.round((met * 1000) / total);
  const whole = Math.floor(thousandths / 1000);
  return `${String(whole)}.${String(thousandths % 1000).padStart(3, '0')}`;
}

/** Pure and total over arbitrary JSON. */
export function validateJudgeReply(reply: unknown, rubric: AdvisorRubric): JudgeValidation {
  if (!isRecord(reply) || !exactKeys(reply, ['scores']) || !Array.isArray(reply['scores'])) {
    return refused('judge.schema', 'the reply is not exactly { scores: [...] }');
  }
  const raw = reply['scores'] as unknown[];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ['criterion', 'met', 'reason']) ||
      typeof entry['criterion'] !== 'string' ||
      typeof entry['met'] !== 'boolean' ||
      typeof entry['reason'] !== 'string'
    ) {
      return refused('judge.schema', 'a score is not exactly { criterion, met: boolean, reason }');
    }
  }
  const entries = raw as { criterion: string; met: boolean; reason: string }[];
  const wanted = rubric.criteria.map((criterion) => criterion.id as string);
  const named = entries.map((entry) => entry.criterion);
  if (
    named.length !== wanted.length ||
    new Set(named).size !== named.length ||
    named.some((id) => !wanted.includes(id))
  ) {
    return refused('judge.coverage', 'not every rubric criterion exactly once');
  }
  for (const entry of entries) {
    if ([...entry.reason].length > ADVISOR_JUDGE_REASON_MAX) {
      return refused(
        'judge.too_long',
        `a reason over ${String(ADVISOR_JUDGE_REASON_MAX)} characters`,
      );
    }
    if (HOLDER_DATA.test(entry.reason)) {
      return refused(
        'judge.holder_data',
        'a reason carries a figure or a reference it was never sent',
      );
    }
  }
  const ordered = wanted.map(
    (id) => entries.find((entry) => entry.criterion === id) as (typeof entries)[number],
  );
  const met = ordered.filter((entry) => entry.met).length;
  return {
    ok: true,
    score: {
      score: scoreText(met, ordered.length),
      criteria: ordered.map((entry) => ({
        criterion: entry.criterion,
        met: entry.met,
        reason: entry.reason.trim(),
      })),
      page: rubric.page,
    },
  };
}
