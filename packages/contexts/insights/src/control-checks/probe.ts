// SPDX-License-Identifier: MIT
/**
 * The one request the controls self-test sends a model (WP 10.16).
 *
 * A fixed, synthetic finding — no personal data, nothing from the database —
 * in the narrator's own request shape (`evalRequest`: the narrator's
 * manifest, the laundering bound as granted scopes, an empty snapshot, the
 * findings envelope), with one figure placed in a slot the way the Brief
 * places every figure (contract 1.6.0). The adapter renders it through the
 * same `renderPrompt` a narration uses and appends one fixed control
 * instruction (`@advisor/local-model`'s `control.ts`); the reply comes back
 * through the same wrap, the narrator's own advisor and `validateResponse`.
 */
import type { Clock } from '@core/kernel';
import { evalRequest } from '../advisors/local/eval.ts';
import type { AdvisorRequest, NarratedFinding } from '../contract/request.ts';
import { inputDigest } from '../snapshot/tokens.ts';

export const CONTROL_PROBE_FINDING: NarratedFinding = Object.freeze({
  key: 'control_check.probe',
  period: '2026-01',
  type: 'control_check.probe',
  severity: 'info',
  title: 'A control check from the app, not a finding about your money',
  summary_md: 'This is a fixed control check. Its one figure is {{e1}}.',
  evidence: [
    {
      label: 'Control figure',
      value: '$10.00',
      source_ref: 'snapshot:control_check.figure',
      slot: 'e1',
    },
  ],
  derived: [],
  impact: { annualized: null, one_time: null, basis: '' },
  placed_figures: true,
}) as NarratedFinding;

/**
 * The probe request, with a deadline `deadlineMs` from now so a probe never
 * waits on the narrator's full 300 s (a local model given less than its
 * timeout skips the warm-up and answers on its own clock).
 */
export function controlProbeRequest(clock: Clock, deadlineMs = 140_000): AdvisorRequest {
  const findings = [CONTROL_PROBE_FINDING];
  const base = evalRequest(
    { id: inputDigest({ control_check: findings }), caseIds: [], findings },
    clock.now().toISOString().slice(0, 10),
  );
  return {
    ...base,
    generated_at: clock.now().toISOString(),
    limits: {
      ...base.limits,
      deadline: new Date(clock.nowMs() + deadlineMs).toISOString(),
    },
  };
}
