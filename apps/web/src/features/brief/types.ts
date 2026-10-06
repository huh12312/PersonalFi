// SPDX-License-Identifier: MIT
import type { BriefItem } from '../../api/generated/types.gen.ts';

/**
 * What `GET /insights/brief/*` carries on each item since WP 9.6 (items 3 and
 * 4). The generated `BriefItem` has both fields (required, since the contract
 * was regenerated); the intersection below makes them tolerant of a response or
 * a mock that predates them, so an item without them reads as "no narration"
 * and "no action recorded" rather than throwing.
 *
 * **Narration (Phase 5 gate R-2).** `status` and the badge are always on the
 * wire. The narrator's TEXT is on the wire only when the deployment sets
 * `NARRATION_TEXT_SHOWN` (`textShown`); until WP 9.5's figure slots have landed
 * and been measured, or Chris accepts the residual in writing, `summaryMd` is
 * `null` and this screen shows the built-in wording alone, with a note.
 */
export interface BriefItemNarration {
  /** `narrated`: wording is linked to this item's finding. `pending`: one is expected. `none`. */
  readonly status: 'narrated' | 'pending' | 'none';
  /** The AI-assisted badge: true exactly when `status` is `narrated`. */
  readonly aiAssisted: boolean;
  /** Whether this deployment shows narration text at all. */
  readonly textShown: boolean;
  /** The narrator's alternative wording; `null` unless narrated and `textShown`. */
  readonly summaryMd: string | null;
}

/** CF-24: the action as the Brief said it at publication. `null` on the item: published before 0038. */
export interface BriefItemAction {
  readonly kind: 'suggest_only' | 'open_url' | 'create_goal_draft' | 'create_rule_draft';
  readonly label: string;
  readonly rationaleMd: string;
  readonly url: string | null;
}

export type BriefItemWithNarration = BriefItem & {
  readonly narration?: BriefItemNarration;
  readonly primaryAction?: BriefItemAction | null;
};

export function narrationOf(item: BriefItemWithNarration): BriefItemNarration | null {
  return item.narration ?? null;
}

/** `undefined` (an item from a client that predates the field) reads as no action recorded. */
export function primaryActionOf(item: BriefItemWithNarration): BriefItemAction | null {
  return item.primaryAction ?? null;
}
