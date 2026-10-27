// SPDX-License-Identifier: MIT
/**
 * `categorize.suggest` — the second `local_model` query type (WP 11.2; 11 §4's
 * first row): a category suggestion for a transaction the six deterministic
 * tiers abstained on.
 *
 * It is a manifest in the same contract as every advisor, so the controls the
 * narrator lives under apply to it by construction: its own scope
 * (`transactions.residue`, granted per advisor), its own payload shape and
 * approval (`queryShape` over advisor id, version, kind, scopes and the
 * suggestion template hash), kill level 2's `local_model` kind switch, level
 * 3's `advisors.enabled` row — which the precision gate holds closed until the
 * holder's history shows ≥ 85 % — level 4's cancel and deadline, and a row in
 * `advisor_runs` with the batch's digest for the run inspector.
 *
 * It is **not** in the `AdvisorRegistry` the nightly fan-out iterates: it
 * returns suggestions, not insights, and runs only from the worker's
 * `categorization.suggest` job after a sync's categorisation pass. Its
 * capabilities say so — no impact, no narration, info at most — and it has no
 * trigger of its own.
 */
import type { AdvisorManifest } from '../../contract/manifest.ts';
import type { AdvisorScope } from '../../contract/scopes.ts';
import { ADVISOR_CONTRACT_MAJOR } from '../../contract/version.ts';

export const CATEGORY_SUGGEST_ADVISOR_ID = 'categorize.suggest';
export const CATEGORY_SUGGEST_VERSION = '1.0.0';
export const CATEGORY_SUGGEST_SCOPES: readonly AdvisorScope[] = Object.freeze([
  'transactions.residue',
]);

export const CATEGORY_SUGGEST_MANIFEST: AdvisorManifest = Object.freeze({
  advisor_id: CATEGORY_SUGGEST_ADVISOR_ID,
  version: CATEGORY_SUGGEST_VERSION,
  contract_version: ADVISOR_CONTRACT_MAJOR,
  kind: 'local_model',
  display_name: 'Category suggestions (local model)',
  purpose:
    'Suggests a category from your own list for a transaction the rules could not place, with a ' +
    'reason. Nothing is filed until you tap Confirm.',
  requires_scopes: [...CATEGORY_SUGGEST_SCOPES],
  triggers: [],
  capabilities: {
    deterministic: false,
    produces_impact: false,
    narrates_only: false,
    max_severity: 'info',
  },
  limits: {
    // The narrator's ceiling (the platform's 300 s): fifty short rows on a
    // warm local model is far less, and the adapter bounds the chat by
    // LOCAL_MODEL_TIMEOUT_MS on its own.
    timeout_ms: 300_000,
    max_insights: 1,
    max_response_bytes: 65_536,
  },
  egress_allowlist: [],
}) as AdvisorManifest;
