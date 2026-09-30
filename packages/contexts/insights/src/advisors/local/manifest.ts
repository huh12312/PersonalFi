// SPDX-License-Identifier: MIT
/**
 * `local.narrator` — the first `local_model` advisor (05-phase-5-dispatch.md
 * §3 WP 5.3).
 *
 * Every capability below is one WP 2.6's capability step checks rather than
 * trusts, and WP 5.3 adds the narrator-specific half (`validate/pipeline.ts`,
 * step 4): a narration may not claim `deterministic`, carry an impact figure,
 * declare a derivation, propose an action, name a finding the built-ins did
 * not make, or sit above its finding's severity.
 *
 * ## The scopes it asks for, and the one it does not
 *
 * The narrator reads no snapshot (its request's snapshot is empty — see
 * `contract/request.ts`'s header), so `requires_scopes` is not a list of
 * blocks it is sent. It is the **laundering bound**: a finding enters its
 * request only if every scope the finding's source run emitted is one the
 * holder granted it here. The list is every scope a built-in reads, less one:
 *
 *   * **`transactions.raw` is not requested.** It is the only row-level
 *     transaction scope, and a narrator has no use for a row a built-in
 *     already summarised. Not asking for it means the laundering rule keeps
 *     every finding built from raw rows (the duplicate-service, uncategorised
 *     and duplicate-charge rules) out of the model's prompt for good — a
 *     holder cannot grant it by accident, because the manifest does not ask.
 *     It is also what fits the manifest's thirteen-scope ceiling: the
 *     built-ins read fourteen.
 */
import type { AdvisorManifest } from '../../contract/manifest.ts';
import type { AdvisorScope } from '../../contract/scopes.ts';
import { ADVISOR_CONTRACT_MAJOR } from '../../contract/version.ts';

export const NARRATOR_ADVISOR_ID = 'local.narrator';
export const NARRATOR_VERSION = '1.0.0';

/** The laundering bound. Catalogue order; `transactions.raw` deliberately absent. */
export const NARRATOR_SCOPES: readonly AdvisorScope[] = Object.freeze([
  'networth.summary',
  'cash.summary',
  'cashflow.monthly',
  'recurring.list',
  'goals.list',
  'holdings.aggregate',
  'holdings.detail',
  'transactions.summary',
  'liabilities.terms',
  'market.rates',
  'plan.projection',
  'transactions.anomalies',
  'fees.summary',
]);

export const NARRATOR_MANIFEST: AdvisorManifest = Object.freeze({
  advisor_id: NARRATOR_ADVISOR_ID,
  version: NARRATOR_VERSION,
  contract_version: ADVISOR_CONTRACT_MAJOR,
  kind: 'local_model',
  display_name: 'Plain-English wording (local model)',
  purpose:
    'Rewords findings the built-in rules already made, on this machine. It adds no figure, ' +
    'no advice and no action; the built-in wording is always one click away.',
  requires_scopes: [...NARRATOR_SCOPES],
  // No trigger of its own: the weekly Brief enqueues it on `insights.run_local`
  // after publication (WP 5.6 / W-C), so the Brief never waits on the model.
  triggers: [],
  capabilities: {
    deterministic: false,
    produces_impact: false,
    narrates_only: true,
    // The ceiling is a backstop. The binding limit is per narration: at or
    // below its own finding's severity (step 4), which is stricter.
    max_severity: 'urgent',
  },
  limits: {
    // WP 5.1's lane and LOCAL_MODEL_TIMEOUT_MS's default: 180 s, never the
    // platform's 300 s ceiling. The adapter takes the earlier of this and its
    // own configured timeout.
    timeout_ms: 180_000,
    max_insights: 5,
    max_response_bytes: 65_536,
  },
  egress_allowlist: [],
}) as AdvisorManifest;
