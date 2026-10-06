// SPDX-License-Identifier: MIT
import type {
  AdvisorHealth,
  AdvisorKindState,
  AdvisorModuleState,
  AdvisorRunSummary,
} from '../../api/generated/types.gen.ts';

/**
 * Words for the four-level kill ladder (`docs/plan/05-phase-5-dispatch.md`
 * §3 WP 5.1, evidenced in `docs/evidence/phase-5/wp5.1-run-control.md` §3).
 * Pure, no network call. Since WP 9.6 levels 1 and 2 have reads
 * (`GET /advisors/module/enabled`, `GET /advisors/kinds/{kind}/enabled`) and
 * `moduleStateWords` / `kindStateWords` say what those routes answered;
 * `MODULE_LEVEL_WORDS` and `kindLevelWords` still say only what each level
 * *is*. Nothing here prints a value that was not read.
 */

export const MODULE_LEVEL_WORDS =
  'Level 1 — Module: the operator’s ADVISORS_ENABLED setting and your module.insights flag. ' +
  'Off in either place stops every advisor of every kind, everywhere in this deployment. ' +
  'Default: on.';

/**
 * Level 1 as it stands, in words: both halves, and which one is responsible
 * when it is off (G5-14 — the holder's half used to be a line of SQL).
 */
export function moduleStateWords(state: AdvisorModuleState): string {
  const { advisorsEnabled } = state.operator;
  const userEnabled = state.user.enabled;
  if (advisorsEnabled && userEnabled) {
    return (
      'Level 1 is on: the operator allows advisors (ADVISORS_ENABLED) and you have not ' +
      'switched the insights module off.'
    );
  }
  const reasons: string[] = [];
  if (!advisorsEnabled) {
    reasons.push(
      'the operator has turned advisors off (ADVISORS_ENABLED is false — only a change to the ' +
        'deployment’s settings and a restart can turn it back on; nothing on this screen can)',
    );
  }
  if (!userEnabled) {
    reasons.push('you have switched the insights module off (the switch below turns it back on)');
  }
  return `Level 1 is off, so no advisor runs: ${reasons.join(', and ')}.`;
}

/** Level 2 as it stands, in words: the flag, the model configuration, and both together. */
export function kindStateWords(state: AdvisorKindState): string {
  const name = state.kind;
  if (state.effective) {
    return `Level 2 is on: the ${name} flag is on and a model is configured, so ${name} advisors may run.`;
  }
  if (state.enabled && !state.configured) {
    return (
      `Level 2 is on but nothing can run: the ${name} flag is on, and this deployment has no ` +
      'model configured for it (the operator sets that), so no advisor of this kind runs.'
    );
  }
  if (!state.enabled && state.configured) {
    return `Level 2 is off: the ${name} flag is off (its default), so no ${name} advisor runs, though a model is configured.`;
  }
  return (
    `Level 2 is off: the ${name} flag is off (its default), and this deployment has no model ` +
    'configured for it either.'
  );
}

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
