// SPDX-License-Identifier: MIT
import type { AdvisorHealth, AdvisorRunSummary } from '../../api/generated/types.gen.ts';

/**
 * Words for the four-level kill ladder (`docs/plan/05-phase-5-dispatch.md`
 * §3 WP 5.1, evidenced in `docs/evidence/phase-5/wp5.1-run-control.md` §3).
 * Pure, no network call and no guessed live value: levels 1 and 2 have no
 * `GET` route exposing their current boolean to the browser today (the
 * catalogue's own `advisors` row covers level 3, and a run covers level 4),
 * so this file only ever states what each level *is* and what it affects —
 * never a value nobody can read. See `AdvisorManagementScreen.tsx`'s "Needs
 * the orchestrator" note in the WP's evidence for the missing reads.
 */

export const MODULE_LEVEL_WORDS =
  'Level 1 — Module: the operator’s ADVISORS_ENABLED setting and the module.insights flag. ' +
  'Off stops every advisor of every kind, everywhere in this deployment. Default: on. ' +
  'No route in this build reports its current value to the browser.';

export function kindLevelWords(kind: string): string {
  if (kind === 'local_model') {
    return (
      'Level 2 — Kind: the advisors.kind.local_model flag. Off by default; stops every ' +
      'local-model advisor while leaving builtin advisors untouched. Flip it with the switch ' +
      'below (needs a fresh passkey assertion).'
    );
  }
  return (
    `Level 2 — Kind: ${kind} advisors have no separate kind switch today — only ` +
    'local_model does. This advisor is stopped only by level 1, level 3, or (while a run is ' +
    'in flight) level 4.'
  );
}

export function advisorLevelWords(
  advisor: Pick<AdvisorHealth, 'enabled' | 'quarantinedAt' | 'quarantineReason'>,
): string {
  if (advisor.quarantinedAt !== null) {
    return (
      `Level 3 — Advisor: quarantined at ${advisor.quarantinedAt} ` +
      `(${advisor.quarantineReason ?? 'reason not recorded'}). The app did this automatically ` +
      'after too many failures or rejections; it stops only this advisor.'
    );
  }
  return (
    `Level 3 — Advisor: ${advisor.enabled ? 'enabled' : 'disabled'}. ` +
    'Flips with the switch on this row (needs a fresh passkey assertion) and stops only this ' +
    'advisor; it survives a restart.'
  );
}

export function isRunInFlight(status: string): boolean {
  return status === 'started';
}

export function runLevelWords(latestRun: Pick<AdvisorRunSummary, 'status'> | null): string {
  if (latestRun === null) {
    return 'Level 4 — Run: no run has started yet. This level only ever applies to one run in flight.';
  }
  if (isRunInFlight(latestRun.status)) {
    return (
      'Level 4 — Run: a run is in flight right now. Cancel it from the run inspector below; the ' +
      'watcher notices within about a second and nothing is written after the kill.'
    );
  }
  return `Level 4 — Run: the latest run already finished (${latestRun.status}). Nothing to cancel.`;
}

const CANCEL_REASON_LEVEL: Record<string, string> = {
  module_disabled: 'Level 1 (module)',
  advisors_disabled: 'Level 1 (module)',
  kind_disabled: 'Level 2 (kind)',
  advisor_disabled: 'Level 3 (advisor)',
  advisor_quarantined: 'Level 3 (advisor, automatic)',
  run_cancelled: 'Level 4 (this run)',
};

/**
 * Names which level a finished run's `cancelReason` names, in words — or
 * `null` when the run was never cancelled (including a plain timeout, which
 * `advisor_timeout` deliberately does not map here: the deadline is not a
 * kill level, and the breaker counts it differently, wp5.1-run-control.md §3).
 */
export function cancellationLevelLabel(cancelReason: string | null): string | null {
  if (cancelReason === null) return null;
  return CANCEL_REASON_LEVEL[cancelReason] ?? `Unrecognised reason (${cancelReason})`;
}
