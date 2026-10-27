// SPDX-License-Identifier: MIT
/**
 * `insight.explain` — the third `local_model` query type (WP 11.3; 11 §4's
 * "Explain this" row): a short, grounded explanation of one insight or one
 * health pillar — why it fired (or scores as it does), what it is built from,
 * and what would change it.
 *
 * Same contract, same controls as the narrator and `categorize.suggest`
 * (11 §2 rule 3): its own payload shape and approval (`queryShape` over
 * advisor id, version, kind, scopes and the explain template hash), kill level
 * 2's `local_model` kind switch and the holder's narrator (Off is off), level
 * 3's `advisors.enabled` row and its quarantine, level 4's cancel and
 * deadline, and a row in `advisor_runs` with the payload's digest for the run
 * inspector.
 *
 * ## Scopes: the narrator's laundering bound, narrowed per explanation
 *
 * `requires_scopes` is the narrator's list (`NARRATOR_SCOPES`) — every scope a
 * built-in reads except `transactions.raw`. It is a **bound**, not what a
 * request carries: an explanation's `granted_scopes` is exactly the scopes
 * its own entity was built from (an insight's source run's `emitted_scopes`;
 * a pillar's snapshot blocks), and it is sent only when every one of them is
 * in the holder's live grant to the narrator. Nothing beyond the narrator's
 * payload class leaves the machine, which is why a hosted provider needs no
 * consent of its own here: the narrator's (WP 10.6) covers it.
 *
 * It is **not** in the `AdvisorRegistry` the nightly fan-out iterates: it
 * returns wording, not insights, and runs only from the worker's
 * `insights.explain` job — on the holder's tap, or the Brief's prefetch of
 * its ranked items (at most five a week).
 */
import type { AdvisorManifest } from '../../contract/manifest.ts';
import type { AdvisorScope } from '../../contract/scopes.ts';
import { ADVISOR_CONTRACT_MAJOR } from '../../contract/version.ts';
import { NARRATOR_SCOPES } from '../local/manifest.ts';

export const INSIGHT_EXPLAIN_ADVISOR_ID = 'insight.explain';
export const INSIGHT_EXPLAIN_VERSION = '1.0.0';

/** The bound: the narrator's own list. `transactions.raw` is never in it. */
export const INSIGHT_EXPLAIN_SCOPES: readonly AdvisorScope[] = Object.freeze([...NARRATOR_SCOPES]);

/** At most this many explanations the Brief prefetches a week: its ranked items, never the backlog. */
export const EXPLAIN_PREFETCH_MAX = 5;

export const INSIGHT_EXPLAIN_MANIFEST: AdvisorManifest = Object.freeze({
  advisor_id: INSIGHT_EXPLAIN_ADVISOR_ID,
  version: INSIGHT_EXPLAIN_VERSION,
  contract_version: ADVISOR_CONTRACT_MAJOR,
  kind: 'local_model',
  display_name: 'Explain this (local model)',
  purpose:
    'Explains in plain words why one finding or one health pillar reads as it does, what it is ' +
    'built from and what would change it, using only the figures in its evidence. It changes nothing.',
  requires_scopes: [...INSIGHT_EXPLAIN_SCOPES],
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
