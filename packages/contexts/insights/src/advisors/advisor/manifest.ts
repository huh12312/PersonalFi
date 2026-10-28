// SPDX-License-Identifier: MIT
/**
 * Ask PersonalFi, advisor mode (WP 11.5d; 12 §2.3's protocol, §4, §5; D31) —
 * six `local_model` query types and one built-in watcher.
 *
 *   1. `advisor.clarify`   the question restated, at most two questions, the
 *                          plan defaults assumed (by ref);
 *   2. `advisor.gather`    11.5c's compile step reused as is (`ask.compile`'s
 *                          request and validator) over the clarified question;
 *                          the app runs the calls and reads the playbook;
 *   3. `advisor.options`   two to four options, each backed by a result figure;
 *   4. `advisor.tradeoffs` per option its benefit and **its cost** (required);
 *   5. `advisor.plan`      the picked option as steps, each an in-app link;
 *   6. `advisor.follow_up` no model: a deterministic watcher (`follow-up.ts`);
 *   +  `advisor.judge`     the rubric judge (12 §5, decision 3): evidence, never
 *                          a gate, and never sent the holder's data.
 *
 * Each model step has its own manifest, payload preview and approval in
 * Advisor management, the kill ladder (levels 1–4), one `advisor_runs` row per
 * call with the payload kept for the run inspector, and the approvable shape
 * folds in **the advisor's consent text** (`advisor-consent/1`): reword it and
 * every step needs a new approval.
 *
 * ## D31: the advisor's own hosted consent
 *
 * A tick-box separate from the narrator's (the `categorize.suggest` pattern):
 * unticked — no row, the default — the advisor runs on the local model; ticked
 * to the exact text below (its sha256 stored), on the hosted provider the
 * holder chose, under the narrator's standing consent and key for it. The
 * text says exactly what leaves this machine.
 */
import { configHash } from '@core/platform';
import type { AdvisorManifest } from '../../contract/manifest.ts';
import type { AdvisorScope } from '../../contract/scopes.ts';
import { ADVISOR_CONTRACT_MAJOR } from '../../contract/version.ts';
import { NARRATOR_SCOPES } from '../local/manifest.ts';
import type { AdvisorStep } from '../../../schema/index.ts';

export type AdvisorModelStepName = AdvisorStep;
export type { AdvisorStep };

export const ADVISOR_STEP_IDS: Readonly<Record<AdvisorStep, string>> = Object.freeze({
  clarify: 'advisor.clarify',
  gather: 'advisor.gather',
  options: 'advisor.options',
  tradeoffs: 'advisor.tradeoffs',
  plan: 'advisor.plan',
  judge: 'advisor.judge',
});
export const ADVISOR_FOLLOW_UP_ADVISOR_ID = 'advisor.follow_up';
export const ADVISOR_STEP_VERSION = '1.0.0';
export const ADVISOR_FOLLOW_UP_VERSION = '1.0.0';

/** The order the protocol runs its model steps in (the judge after the trade-offs). */
export const ADVISOR_STEP_ORDER: readonly AdvisorStep[] = Object.freeze([
  'clarify',
  'gather',
  'options',
  'tradeoffs',
  'judge',
  'plan',
]);

export function advisorStepOf(advisorId: string): AdvisorStep | null {
  const found = (Object.entries(ADVISOR_STEP_IDS) as [AdvisorStep, string][]).find(
    ([, id]) => id === advisorId,
  );
  return found === undefined ? null : found[0];
}

/** The bound: the narrator's own list. `transactions.raw` is never in it. */
export const ADVISOR_SCOPES: readonly AdvisorScope[] = Object.freeze([...NARRATOR_SCOPES]);

// --- caps -------------------------------------------------------------------

export const ADVISOR_QUESTION_MAX = 500;
/** One answer to a clarifying question, in characters. */
export const ADVISOR_ANSWER_MAX = 300;
export const ADVISOR_MAX_QUESTIONS = 2;
export const ADVISOR_RESTATEMENT_MAX = 400;
export const ADVISOR_CLARIFYING_QUESTION_MAX = 200;
export const ADVISOR_MAX_ASSUMED = 4;
export const ADVISOR_MIN_OPTIONS = 2;
export const ADVISOR_MAX_OPTIONS = 4;
export const ADVISOR_OPTION_LABEL_MAX = 80;
export const ADVISOR_PROSE_MAX = 400;
export const ADVISOR_PROSE_MAX_SENTENCES = 2;
export const ADVISOR_MAX_REFS = 6;
export const ADVISOR_MIN_PLAN_STEPS = 1;
export const ADVISOR_MAX_PLAN_STEPS = 6;
export const ADVISOR_PLAN_STEP_MAX = 240;
export const ADVISOR_JUDGE_REASON_MAX = 200;
/** The per-session token budget (12 §8 "Cost"): what the six calls together may spend. */
export const ADVISOR_SESSION_TOKEN_BUDGET = 60_000;
/** Figures per result in the context object the model steps are sent. */
export const ADVISOR_FIGURES_PER_RESULT = 24;

function manifest(input: {
  readonly id: string;
  readonly display: string;
  readonly purpose: string;
}): AdvisorManifest {
  return Object.freeze({
    advisor_id: input.id,
    version: ADVISOR_STEP_VERSION,
    contract_version: ADVISOR_CONTRACT_MAJOR,
    kind: 'local_model',
    display_name: input.display,
    purpose: input.purpose,
    requires_scopes: [...ADVISOR_SCOPES],
    triggers: [],
    capabilities: {
      deterministic: false,
      produces_impact: false,
      narrates_only: true,
      max_severity: 'info',
    },
    limits: { timeout_ms: 300_000, max_insights: 1, max_response_bytes: 16_384 },
    egress_allowlist: [],
  }) as AdvisorManifest;
}

export const ADVISOR_STEP_MANIFESTS: Readonly<Record<AdvisorStep, AdvisorManifest>> = Object.freeze(
  {
    clarify: manifest({
      id: ADVISOR_STEP_IDS.clarify,
      display: 'Advisor: the question restated (language model)',
      purpose:
        'Restates the question you start an advisor session with and asks at most two short ' +
        'questions about it. It sees your question, the names of the calculations you have ' +
        'granted and the names of your goals, and supplies no figure.',
    }),
    gather: manifest({
      id: ADVISOR_STEP_IDS.gather,
      display: 'Advisor: question to calculations (language model)',
      purpose:
        'Turns the clarified question into at most four calls from the closed list of calculations ' +
        'you have granted, exactly as Ask PersonalFi does. It never sees your data.',
    }),
    options: manifest({
      id: ADVISOR_STEP_IDS.options,
      display: 'Advisor: the options (language model)',
      purpose:
        'Names two to four options the calculated results support. Every option must rest on a ' +
        'result figure; one that does not is dropped.',
    }),
    tradeoffs: manifest({
      id: ADVISOR_STEP_IDS.tradeoffs,
      display: 'Advisor: what each option gains and costs (language model)',
      purpose:
        'States each option’s benefit and its cost from the calculated results. An option ' +
        'without a cost is refused.',
    }),
    plan: manifest({
      id: ADVISOR_STEP_IDS.plan,
      display: 'Advisor: the plan as steps (language model)',
      purpose:
        'Lists the steps for the option you picked, each a link to a screen of this app where you ' +
        'act yourself. Nothing is ever done for you.',
    }),
    judge: manifest({
      id: ADVISOR_STEP_IDS.judge,
      display: 'Advisor: the rubric check (language model)',
      purpose:
        'Scores the advisor’s wording against a fixed rubric (did it state the cost, say when the ' +
        'approach does not apply, stay in scope). It sees the wording with every figure masked, ' +
        'never your data. Its score is evidence and never stops a session.',
    }),
  },
);

// ---------------------------------------------------------------------------
// The consent text (versioned, sha256): what leaves the machine for a hosted provider
// ---------------------------------------------------------------------------

export const ADVISOR_CONSENT_VERSION = 'advisor-consent/1';

/** The exact words a holder ticks in Advisor management. Shipped unticked; ticking stores the sha256. */
export const ADVISOR_CONSENT_TEXT =
  'Advisor sessions on a hosted provider: when this is ticked, the advisor’s steps run on the ' +
  'hosted provider you chose for them, under your key, and what leaves this machine is: the ' +
  'question you typed and your answers to its clarifying questions; the names of your goals; the ' +
  'calculated results the advisor works from — aggregated figures over the data you granted, ' +
  'with merchants as pseudonyms and amounts as rounded as each scope rounds them; and the text of ' +
  'the reviewed playbook pages it cites. The rubric check sees the advisor’s wording with every ' +
  'figure masked. Never a transaction row, an account number or an institution name. Unticked, ' +
  'the advisor runs on the local model only. Withdraw this at any time.';

/** `sha256:` over the canonical consent record. */
export function advisorConsentSha256(): string {
  return `sha256:${configHash({ version: ADVISOR_CONSENT_VERSION, text: ADVISOR_CONSENT_TEXT })}`;
}

/**
 * The template hash an approval is keyed to: the adapter's own template hash
 * (prompt, format, options, provider and model) **and** the advisor's consent
 * text, so a reworded consent is a new shape that needs a new approval.
 */
export function advisorShapeTemplateHash(step: AdvisorStep, adapterTemplateHash: string): string {
  return `sha256:${configHash({
    step,
    template: adapterTemplateHash,
    consent_version: ADVISOR_CONSENT_VERSION,
    consent: advisorConsentSha256(),
  })}`;
}

/** The disclaimer every advisor surface carries (07 §7.2). The app's words. */
export const ADVISOR_DISCLAIMER =
  'PersonalFi is not a financial adviser. These options are arithmetic over your own figures and ' +
  'general rules, not a recommendation; every step is one you take yourself.';
