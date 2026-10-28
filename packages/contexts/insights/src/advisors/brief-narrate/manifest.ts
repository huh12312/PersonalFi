// SPDX-License-Identifier: MIT
/**
 * `brief.narrate` — the fourth `local_model` query type (WP 11.4; 11 §3.2's
 * "Narrating one finding — keep; extend to the Brief as a whole" row and the
 * Phase 5 gate's G5-15, "the Brief's narration does not narrate the Brief").
 *
 * Once per published Brief, after its per-item narrations, one short
 * composition of **the week as a whole**: two or three sentences that go
 * through the week's ranked actions in the Brief's own order (by the dollar
 * impact the Brief computed, the largest first), and the one-paragraph
 * "Your week" recap over the overview the Brief already carries (the week,
 * the counts, the health score line, milestones). **The two outputs are one
 * query type**: the recap's payload (the V8 overview blocks) is a subset of
 * the narration's (those blocks plus the ranked items and last week's
 * outcomes), so one payload, one approval, one call and one reply
 * `{ narration, recap }` carry both — `recap.narrate` was not built as a
 * second id because it would send the same data twice.
 *
 * Same contract, same controls as the narrator, `categorize.suggest` and
 * `insight.explain` (11 §2 rule 3): its own payload shape and approval
 * (`queryShape` over advisor id, version, kind, the scope bound and the
 * brief-narrate template hash), kill level 2's `local_model` kind switch and
 * the holder's narrator (Off is off), level 3's `advisors.enabled` row and its
 * quarantine, level 4's cancel and deadline, and a row in `advisor_runs` with
 * the payload's digest for the run inspector.
 *
 * ## Scopes: the narrator's bound, narrowed to the Brief's items
 *
 * `requires_scopes` is the narrator's list (`NARRATOR_SCOPES`, never
 * `transactions.raw`). It is a **ceiling**, not what a request carries: a
 * request's `granted_scopes` is exactly the union of its items' own source
 * runs' `emitted_scopes`, and it is sent only when that union is inside the
 * holder's live grant to the narrator. An item whose scopes are outside the
 * ceiling is left out of the composition (it would never be sent); the
 * overview's figures (counts, a score line, round milestones) are the Brief's
 * own display values and add no data category. Nothing beyond the narrator's
 * payload class leaves the machine, which is why a hosted provider needs no
 * consent of its own: the narrator's (WP 10.6) covers it.
 *
 * Not in the nightly `AdvisorRegistry`: it returns wording, not insights,
 * and runs only from the worker's `insights.brief_narrate` job, which the
 * weekly Brief job enqueues once per published Brief.
 */
import type { AdvisorManifest } from '../../contract/manifest.ts';
import type { AdvisorScope } from '../../contract/scopes.ts';
import { ADVISOR_CONTRACT_MAJOR } from '../../contract/version.ts';
import { NARRATOR_SCOPES } from '../local/manifest.ts';

export const BRIEF_NARRATE_ADVISOR_ID = 'brief.narrate';
export const BRIEF_NARRATE_VERSION = '1.0.0';

/** The ceiling: the narrator's own list. `transactions.raw` is never in it. */
export const BRIEF_NARRATE_SCOPES: readonly AdvisorScope[] = Object.freeze([...NARRATOR_SCOPES]);

/** The Brief's ranked items a composition covers: the Brief's own five-card cap. */
export const BRIEF_NARRATE_MAX_ITEMS = 5;
/** The overview's milestones a composition reads: the newest three, as the overview shows. */
export const BRIEF_NARRATE_MAX_MILESTONES = 3;

export const BRIEF_NARRATE_MANIFEST: AdvisorManifest = Object.freeze({
  advisor_id: BRIEF_NARRATE_ADVISOR_ID,
  version: BRIEF_NARRATE_VERSION,
  contract_version: ADVISOR_CONTRACT_MAJOR,
  kind: 'local_model',
  display_name: 'The Brief in a few sentences (language model)',
  purpose:
    "Words the week's Brief as a whole: its ranked actions in the Brief's own order and a short " +
    'recap of the week, using only the figures the Brief already shows. It changes nothing.',
  requires_scopes: [...BRIEF_NARRATE_SCOPES],
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
