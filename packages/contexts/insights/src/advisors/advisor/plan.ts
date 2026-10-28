// SPDX-License-Identifier: MIT
/**
 * `advisor.plan` (WP 11.5d; 12 §2.3 step 5): the request and the validator.
 *
 * After the holder picks an option the model lists one to six steps, each
 * `{ text, action_href }`. **`action_href` is one of a closed list of real
 * in-app routes** (`topics.ts`' `ADVISOR_ACTION_SCREENS`: 11.5c's screens plus
 * the goal, rule, connection and plan screens). Never an execution — the app
 * links, the holder acts (07 §7.5 rule 4) — and never an external address.
 *
 *   * `plan.schema`, `plan.count` (outside one to six);
 *   * `plan.external_url` — an href with a scheme or a host;
 *   * `plan.href_unlisted` — any other href not in the list ("go ahead and
 *     move it" has nowhere to go);
 *   * `plan.execution` — a step saying the app (or the advisor) will move,
 *     pay, transfer, trade or cancel anything;
 *   * `plan.text.<prose>` — the step's text: every figure as the context
 *     wrote it, no link in the text, the copy linter (a plan step is an
 *     action's rationale: it may say what the screen is for, never "you
 *     should").
 */
import { newId } from '@core/kernel';
import { canonicalRunDigest } from '../../preview.ts';
import {
  checkAdvisorProse,
  exactKeys,
  isRecord,
  type AdvisorContextCheck,
  type AdvisorContextFigure,
  type AdvisorContextObject,
  type ProseRefusal,
} from './context.ts';
import {
  ADVISOR_MAX_PLAN_STEPS,
  ADVISOR_MIN_PLAN_STEPS,
  ADVISOR_PLAN_STEP_MAX,
} from './manifest.ts';
import type { AdvisorOption, BuiltContextStepRequest } from './options.ts';
import {
  ADVISOR_ACTION_SCREEN_PATHS,
  ADVISOR_ACTION_SCREENS,
  isAdvisorActionScreen,
  type AdvisorActionScreen,
} from './topics.ts';
import type { AdvisorTradeoff } from './tradeoffs.ts';

export interface PlanSubject {
  readonly context: AdvisorContextObject;
  readonly picked: {
    readonly id: string;
    readonly label: string;
    readonly summary: string;
    readonly benefit: readonly AdvisorContextFigure[];
    readonly cost: readonly AdvisorContextFigure[];
    readonly note: string;
  };
  readonly action_screens: readonly { readonly path: string; readonly label: string }[];
  readonly max_steps: number;
}

export function buildPlanRequest(input: {
  readonly context: AdvisorContextObject;
  readonly option: AdvisorOption;
  readonly tradeoff: AdvisorTradeoff;
  readonly grantedScopes: readonly string[];
  readonly now: Date;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}): BuiltContextStepRequest<'advisor_plan', PlanSubject> {
  const subject: PlanSubject = {
    context: input.context,
    picked: {
      id: input.option.id,
      label: input.option.label,
      summary: input.option.summary,
      benefit: input.tradeoff.benefit.map((figure) => ({ ...figure })),
      cost: input.tradeoff.cost.map((figure) => ({ ...figure })),
      note: input.tradeoff.note,
    },
    action_screens: ADVISOR_ACTION_SCREEN_PATHS.map((path) => ({
      path,
      label: ADVISOR_ACTION_SCREENS[path],
    })),
    max_steps: ADVISOR_MAX_PLAN_STEPS,
  };
  const payload = { snapshot: { advisor_plan: subject }, granted_scopes: [...input.grantedScopes] };
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

export interface AdvisorPlanStep {
  readonly text: string;
  readonly action_href: AdvisorActionScreen;
  /** The app's label for the screen ("Goals"). */
  readonly action_label: string;
}

export type PlanRefusal =
  | 'plan.schema'
  | 'plan.count'
  | 'plan.external_url'
  | 'plan.href_unlisted'
  | 'plan.execution'
  | `plan.text.${ProseRefusal}`;

export type PlanValidation =
  | { readonly ok: true; readonly steps: readonly AdvisorPlanStep[] }
  | { readonly ok: false; readonly refusal: PlanRefusal; readonly detail: string };

function refused(refusal: PlanRefusal, detail: string): PlanValidation {
  return { ok: false, refusal, detail };
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|www\.)/iu;
/** "the app will move …", "I'll transfer …", "we can pay …": an execution claim. */
const EXECUTION =
  /\b(?:i|we|the app|personalfi|the advisor)\s*(?:will|can|'ll|shall|am going to|are going to|is going to|has|have)\s+(?:now\s+)?(?:move|transfer|pay|send|wire|buy|sell|trade|rebalance|cancel|close|withdraw|deposit|execute)\w*\b|\b(?:done|moved|transferred|paid) (?:it )?for you\b/iu;

/** Pure and total over arbitrary JSON. */
export function validatePlanReply(reply: unknown, check: AdvisorContextCheck): PlanValidation {
  if (!isRecord(reply) || !exactKeys(reply, ['steps']) || !Array.isArray(reply['steps'])) {
    return refused('plan.schema', 'the reply is not exactly { steps: [...] }');
  }
  const raw = reply['steps'] as unknown[];
  for (const entry of raw) {
    if (
      !isRecord(entry) ||
      !exactKeys(entry, ['text', 'action_href']) ||
      typeof entry['text'] !== 'string' ||
      typeof entry['action_href'] !== 'string'
    ) {
      return refused('plan.schema', 'a step is not exactly { text, action_href }');
    }
  }
  if (raw.length < ADVISOR_MIN_PLAN_STEPS || raw.length > ADVISOR_MAX_PLAN_STEPS) {
    return refused(
      'plan.count',
      `${String(raw.length)} steps; between ${String(ADVISOR_MIN_PLAN_STEPS)} and ${String(ADVISOR_MAX_PLAN_STEPS)}`,
    );
  }
  const steps: AdvisorPlanStep[] = [];
  for (const entry of raw as Record<string, string>[]) {
    const href = (entry['action_href'] ?? '').trim();
    if (EXTERNAL.test(href)) {
      return refused('plan.external_url', `${href.slice(0, 64)} is not a screen of this app`);
    }
    if (!isAdvisorActionScreen(href)) {
      return refused('plan.href_unlisted', `${href.slice(0, 64)} is not one of the action screens`);
    }
    const text = (entry['text'] ?? '').trim();
    if (EXECUTION.test(text)) {
      return refused('plan.execution', 'a step says the app will act; the holder acts');
    }
    const checked = checkAdvisorProse(text, {
      max: ADVISOR_PLAN_STEP_MAX,
      maxSentences: 2,
      field: 'action_rationale',
      trace: check.trace,
      sent: check.sent,
      knowledge: check.knowledge,
    });
    if (!checked.ok) return refused(`plan.text.${checked.refusal}`, checked.detail);
    steps.push({ text, action_href: href, action_label: ADVISOR_ACTION_SCREENS[href] });
  }
  return { ok: true, steps };
}
