// SPDX-License-Identifier: MIT
/**
 * `merchant.name` — the narrowest `local_model` query type (WP 11.6; 11 §3.1's
 * "Merchant display name for noise descriptors — model suggestion, narrow" row,
 * §4's "the descriptor only → {display_name: substring-preserving, or
 * abstain}"): a display name for one merchant whose bank descriptor the
 * deterministic normaliser could only partly clean.
 *
 * Same contract, same controls as every query type (11 §2 rule 3): its own
 * payload shape and approval (`queryShape` over advisor id, version, kind,
 * scopes and a template hash that folds in the adapter's template **and** this
 * query type's consent text, so a reworded consent is a new approval), kill
 * level 2's `local_model` kind switch and the holder's narrator (Off is off),
 * level 3's `advisors.enabled` row and its quarantine, level 4's cancel and
 * deadline, and one `advisor_runs` row per call with the payload's digest.
 *
 * ## Scope: `transactions.residue`, and nothing else
 *
 * The payload is one merchant's descriptor residue — the normaliser's own
 * output, the merchant words a holder reads — plus the processor prefix the
 * normaliser stripped, if any. That is the class `transactions.residue`
 * already names (sensitivity 8, untokenised merchant words, `externalAllowed:
 * false`): the narrowest scope in the vocabulary that covers a descriptor. No
 * new scope, so no contract bump. `transactions.raw` is never sent, and no
 * amount, date, account, category or second merchant is in the payload.
 *
 * ## Local only (D22)
 *
 * A descriptor is a merchant string, which the narrator's hosted path
 * pseudonymises today. This query type sends it as it is, so it runs **only on
 * the local model**: with a hosted narrator no suggestion is made, and
 * `merchant_name_suggestions.llm_provider` is CHECK-pinned to `ollama`. The
 * consent text below says so; there is no hosted tick-box to tick.
 *
 * Not in the nightly `AdvisorRegistry`: it returns a name, not insights, and
 * runs only from the worker's `insights.merchant_names` job.
 */
import { configHash } from '@core/platform';
import type { AdvisorManifest } from '../../contract/manifest.ts';
import type { AdvisorScope } from '../../contract/scopes.ts';
import { ADVISOR_CONTRACT_MAJOR } from '../../contract/version.ts';

export const MERCHANT_NAME_ADVISOR_ID = 'merchant.name';
export const MERCHANT_NAME_VERSION = '1.0.0';
export const MERCHANT_NAME_SCOPES: readonly AdvisorScope[] = Object.freeze([
  'transactions.residue',
]);

/** The longest display name accepted, in characters. */
export const MERCHANT_NAME_MAX = 40;
/** The longest descriptor residue sent, in characters (the table's CHECK). */
export const MERCHANT_DESCRIPTOR_MAX = 200;

export const MERCHANT_NAME_MANIFEST: AdvisorManifest = Object.freeze({
  advisor_id: MERCHANT_NAME_ADVISOR_ID,
  version: MERCHANT_NAME_VERSION,
  contract_version: ADVISOR_CONTRACT_MAJOR,
  kind: 'local_model',
  display_name: 'Merchant name suggestions (local model)',
  purpose:
    'Suggests a cleaner name for a merchant whose bank text is still noise, using only words ' +
    'already in that text. It is shown beside the bank’s text and used only when you tap Accept.',
  requires_scopes: [...MERCHANT_NAME_SCOPES],
  triggers: [],
  capabilities: {
    deterministic: false,
    produces_impact: false,
    narrates_only: false,
    max_severity: 'info',
  },
  limits: {
    // The narrator's ceiling; one short reply. The adapter bounds the chat by
    // LOCAL_MODEL_TIMEOUT_MS on its own and warms a cold model in the headroom.
    timeout_ms: 300_000,
    max_insights: 1,
    max_response_bytes: 4_096,
  },
  egress_allowlist: [],
}) as AdvisorManifest;

// ---------------------------------------------------------------------------
// The consent text (versioned, sha256), folded into the approvable shape
// ---------------------------------------------------------------------------

export const MERCHANT_NAME_CONSENT_VERSION = 'merchant-name-consent/1';

/** Shown in the payload preview; its digest is inside the approvable shape. */
export const MERCHANT_NAME_CONSENT_TEXT =
  'Merchant name suggestions run on the local model on this machine only. For a merchant whose ' +
  'name the bank sent as noise, the bank’s text as the app cleaned it, and the payment ' +
  'processor’s prefix it removed (if any), are sent to that model: no amount, date, account or ' +
  'category, and no other merchant. Nothing leaves this machine; with a hosted narrator no ' +
  'suggestion is made. A suggestion may only reuse words from the bank’s text, is shown beside ' +
  'it, and renames nothing until you tap Accept.';

export function merchantNameConsentSha256(): string {
  return `sha256:${configHash({
    version: MERCHANT_NAME_CONSENT_VERSION,
    text: MERCHANT_NAME_CONSENT_TEXT,
  })}`;
}

/**
 * The template hash an approval is keyed to: the adapter's own (prompt,
 * format, options, model) and the consent text's, so a reworded consent is a
 * new shape that needs a new approval.
 */
export function merchantNameShapeTemplateHash(adapterTemplateHash: string): string {
  return `sha256:${configHash({
    template: adapterTemplateHash,
    consent_version: MERCHANT_NAME_CONSENT_VERSION,
    consent: merchantNameConsentSha256(),
  })}`;
}
