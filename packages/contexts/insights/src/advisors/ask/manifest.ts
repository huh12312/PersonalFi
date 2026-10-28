// SPDX-License-Identifier: MIT
/**
 * Ask PersonalFi, reporting mode (WP 11.5c; 11 §3.2's "Ask PersonalFi" row,
 * §4's `ask.compile` then `ask.narrate`; 12 §2.1–§2.3, §4, §5) — the fifth and
 * sixth `local_model` query types. **The model is a compiler, never an
 * oracle**: it never reads the ledger and never supplies a figure.
 *
 *   * `ask.compile` turns the holder's question into zero to four calls from
 *     the closed advisory catalogue (WP 11.5b), with typed arguments, or says
 *     the question is out of scope or not computable and names the nearest
 *     screen. Its payload is the question, today's date and the description of
 *     the catalogue functions **this holder's grants allow** (`listCatalogue`):
 *     no holder data at all beyond what the holder typed.
 *   * The app runs the calls deterministically, in process (`callCatalogue`,
 *     under the same grant gate).
 *   * `ask.narrate` words the results in at most four sentences: its payload is
 *     the question, the results' figures (as the app renders them, with their
 *     `source_ref`s) and the context date. Every figure in the answer must be
 *     one of the results' (`validate/numerals.ts`), a knowledge-base citation
 *     must resolve to something sent (`knowledge/citations.ts` — no playbook
 *     page is sendable until Chris reviews it), and the copy linter applies.
 *     The "I looked at: …" line beside it is the app's, not the model's.
 *
 * Same controls as the narrator, `insight.explain` and `brief.narrate`
 * (11 §2 rule 3): each its own payload shape and approval in Advisor
 * management (`queryShape` over advisor id, version, kind, the scope bound and
 * a template hash that also covers this query type's consent text, so a new
 * consent wording is a new approval), kill level 2's `local_model` kind switch
 * and the holder's narrator (Off is off), level 3's `advisors.enabled` row and
 * its quarantine, level 4's cancel and deadline, and one `advisor_runs` row per
 * model call with the payload's digest for the run inspector.
 *
 * Not in the nightly `AdvisorRegistry`: they return wording and call lists,
 * not insights, and run only from the worker's `insights.ask` job.
 */
import { configHash } from '@core/platform';
import type { AdvisorManifest } from '../../contract/manifest.ts';
import type { AdvisorScope } from '../../contract/scopes.ts';
import { ADVISOR_CONTRACT_MAJOR } from '../../contract/version.ts';
import { NARRATOR_SCOPES } from '../local/manifest.ts';

export const ASK_COMPILE_ADVISOR_ID = 'ask.compile';
export const ASK_NARRATE_ADVISOR_ID = 'ask.narrate';
export const ASK_COMPILE_VERSION = '1.0.0';
export const ASK_NARRATE_VERSION = '1.0.0';

export type AskStep = 'compile' | 'narrate';

/** The bound: the narrator's own list. `transactions.raw` is never in it. */
export const ASK_SCOPES: readonly AdvisorScope[] = Object.freeze([...NARRATOR_SCOPES]);

/** The longest question accepted, in characters. */
export const ASK_QUESTION_MAX = 500;
/** At most this many catalogue calls per question. */
export const ASK_MAX_CALLS = 4;
/** The longest answer accepted, in characters, and its sentence cap. */
export const ASK_ANSWER_MAX = 900;
export const ASK_ANSWER_MAX_SENTENCES = 4;
/** Figures per result sent to `ask.narrate` (top-level first); more are kept for the screen, not sent. */
export const ASK_NARRATE_FIGURES_PER_CALL = 24;
/** Figures per result kept on the session row for the screen's evidence line and the fallback. */
export const ASK_STORED_FIGURES_PER_CALL = 120;
/** Non-figure facts (labels, orders, asset classes) per result sent to `ask.narrate`. */
export const ASK_NARRATE_FACTS_PER_CALL = 12;

function manifest(input: {
  readonly id: string;
  readonly version: string;
  readonly display: string;
  readonly purpose: string;
}): AdvisorManifest {
  return Object.freeze({
    advisor_id: input.id,
    version: input.version,
    contract_version: ADVISOR_CONTRACT_MAJOR,
    kind: 'local_model',
    display_name: input.display,
    purpose: input.purpose,
    requires_scopes: [...ASK_SCOPES],
    triggers: [],
    capabilities: {
      deterministic: false,
      produces_impact: false,
      narrates_only: true,
      max_severity: 'info',
    },
    limits: {
      // The narrator's ceiling: one short reply. The adapter bounds the chat by
      // LOCAL_MODEL_TIMEOUT_MS on its own and warms a cold model in the headroom.
      timeout_ms: 300_000,
      max_insights: 1,
      max_response_bytes: 16_384,
    },
    egress_allowlist: [],
  }) as AdvisorManifest;
}

export const ASK_COMPILE_MANIFEST: AdvisorManifest = manifest({
  id: ASK_COMPILE_ADVISOR_ID,
  version: ASK_COMPILE_VERSION,
  display: 'Ask PersonalFi: question to calculations (language model)',
  purpose:
    'Turns a question you type into at most four calls from the closed list of calculations you ' +
    'have granted, or says it cannot be answered here. It sees your question and the list, never ' +
    'your data, and supplies no figure.',
});

export const ASK_NARRATE_MANIFEST: AdvisorManifest = manifest({
  id: ASK_NARRATE_ADVISOR_ID,
  version: ASK_NARRATE_VERSION,
  display: 'Ask PersonalFi: the answer in words (language model)',
  purpose:
    'Words the results of the calculations the app ran for your question in a few sentences, ' +
    'using only the figures those results carry. It changes nothing.',
});

// ---------------------------------------------------------------------------
// The consent texts (versioned, sha256): what leaves the machine for a hosted provider
// ---------------------------------------------------------------------------

export const ASK_CONSENT_VERSION = 'ask-consent/1';

/** Shown in the payload preview; its digest is inside the approvable shape. */
export const ASK_CONSENT_TEXTS: Readonly<Record<AskStep, string>> = Object.freeze({
  compile:
    'When your language model is a hosted provider, what leaves this machine for "question to ' +
    'calculations" is: the question exactly as you typed it, today’s date, and the description ' +
    'of the calculations you have granted (their names, what they do and their parameters). Never ' +
    'a transaction, an account, an institution name or a figure from your data. The approval below ' +
    'covers exactly this shape.',
  narrate:
    'When your language model is a hosted provider, what leaves this machine for "the answer in ' +
    'words" is: your question, the date, and the results of the calculations the app ran for it ' +
    '— aggregated figures as the app writes them, each with the reference to where it came ' +
    'from. Never a transaction row, an account number or an institution name. The approval below ' +
    'covers exactly this shape.',
});

/** `sha256:` over the canonical consent record for one step. */
export function askConsentSha256(step: AskStep): string {
  return `sha256:${configHash({ version: ASK_CONSENT_VERSION, text: ASK_CONSENT_TEXTS[step] })}`;
}

/**
 * The template hash an approval is keyed to: the adapter's own template hash
 * (prompt, format, options, provider and model) **and** this step's consent
 * text, so a reworded consent is a new shape that needs a new approval.
 */
export function askShapeTemplateHash(step: AskStep, adapterTemplateHash: string): string {
  return `sha256:${configHash({
    template: adapterTemplateHash,
    consent_version: ASK_CONSENT_VERSION,
    consent: askConsentSha256(step),
  })}`;
}
