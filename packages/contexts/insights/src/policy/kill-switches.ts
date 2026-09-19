// SPDX-License-Identifier: MIT
/**
 * Kill switches 1–3 — three independent ways to stop an advisor, and the rule
 * that any one of them is enough.
 *
 * 08 §4.6 lists four levels; the plan assigns levels 1–3 to this work package
 * and leaves level 4 (drop the sidecar's compose profile) to Phase 5/6, where
 * there is a sidecar to drop.
 *
 * | # | Switch | Who turns it | Scope | Survives a restart |
 * | --- | --- | --- | --- | --- |
 * | 1 | `ADVISORS_ENABLED` | operator, config | every advisor | yes — it is config |
 * | 2 | `advisors.enabled` | the user, in the UI | one advisor | yes — it is a row |
 * | 3 | circuit breaker | the app, automatically | one advisor | yes — `quarantined_at` is a row |
 *
 * ## Why "any one is enough" is written once, here
 *
 * The failure mode a kill switch has is not that it does not work — it is that
 * something checked *a* switch rather than *the* switches. So `decideRun`
 * returns a single verdict from all three inputs, `service.ts` calls it once,
 * and there is no second place that asks "is this advisor enabled?". A test can
 * then flip each input independently and assert the same outcome, which is what
 * `test/db/kill-switches.test.ts` does.
 *
 * ## The breaker trips on rejections, not only on failures
 *
 * A sidecar that times out is obviously broken. An advisor that returns
 * beautifully-formed JSON in which every number is invented is *worse*, and it
 * never throws. So the breaker counts two things:
 *
 *   * **consecutive failed runs** — a transport error, a timeout, a response the
 *     envelope steps rejected. Five in a row quarantines.
 *   * **the rejection rate within a run** — if a run produced insights and the
 *     validator refused at least `REJECTION_QUARANTINE_RATE` of them, with at
 *     least `REJECTION_QUARANTINE_FLOOR` proposals to judge on, that single run
 *     quarantines. An advisor whose output is mostly unciteable is not having a
 *     bad day.
 *
 * A quarantine is recorded with a reason and is cleared only by a human. It
 * does not decay: an advisor that came back to life on its own after five bad
 * nights is an advisor nobody looked at.
 *
 * ## What a quarantined advisor may still do: nothing
 *
 * `decideRun` returns `run: false` *before* the snapshot is built, so a
 * quarantined advisor does not even receive data — which matters more for an
 * `external` one than for a built-in, and is the same code path for both.
 * `"a quarantined advisor's output never reaches pending_review"` is therefore
 * true for a stronger reason than "we drop its output": there is no output.
 */

/** Consecutive failed runs that trip the breaker. */
export const CONSECUTIVE_FAILURE_LIMIT = 5;
/** Fraction of a run's proposals the validator may refuse before quarantine. */
export const REJECTION_QUARANTINE_RATE = 0.5;
/** Below this many proposals, a rejection rate is not evidence of anything. */
export const REJECTION_QUARANTINE_FLOOR = 4;

export type RunRefusal =
  'advisors_disabled' | 'advisor_disabled' | 'advisor_quarantined' | 'module_disabled';

export type RunDecision =
  { readonly run: true } | { readonly run: false; readonly refusal: RunRefusal };

export interface KillSwitchInputs {
  /** Switch 1. `ADVISORS_ENABLED`, from config. */
  readonly advisorsEnabled: boolean;
  /** The `module.insights` feature flag. Off means the context is not running. */
  readonly moduleEnabled: boolean;
  /** Switch 2. `advisors.enabled` for this advisor. */
  readonly advisorEnabled: boolean;
  /** Switch 3. `advisors.quarantined_at`; non-null means tripped. */
  readonly quarantinedAt: Date | null;
}

/**
 * May this advisor run at all?
 *
 * The order of the checks is the order of blast radius — global, module, this
 * advisor, this advisor's health — so the reason recorded on `advisor_runs` is
 * the *broadest* one that applies. "Everything is off" and "this one advisor is
 * quarantined" are very different operational situations and the log should not
 * report the second when the first is true.
 */
export function decideRun(inputs: KillSwitchInputs): RunDecision {
  if (!inputs.advisorsEnabled) return { run: false, refusal: 'advisors_disabled' };
  if (!inputs.moduleEnabled) return { run: false, refusal: 'module_disabled' };
  if (!inputs.advisorEnabled) return { run: false, refusal: 'advisor_disabled' };
  if (inputs.quarantinedAt !== null) return { run: false, refusal: 'advisor_quarantined' };
  return { run: true };
}

export type QuarantineReason = 'consecutive_failures' | 'rejection_rate';

export interface BreakerInputs {
  /** Including the run just completed. Reset to 0 by a successful run. */
  readonly consecutiveFailures: number;
  /** Proposals the validator accepted in the run just completed. */
  readonly accepted: number;
  /** Proposals the validator refused in the run just completed. */
  readonly rejected: number;
}

/**
 * Should the breaker trip after this run? `null` means no.
 *
 * Pure, so the decision can be asserted without a database and re-derived from
 * an `advisor_runs` row after the fact — "why was this quarantined on the 4th?"
 * is answerable by feeding that row's counts back through this function.
 */
export function shouldQuarantine(inputs: BreakerInputs): QuarantineReason | null {
  if (inputs.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) return 'consecutive_failures';
  const total = inputs.accepted + inputs.rejected;
  if (total >= REJECTION_QUARANTINE_FLOOR && inputs.rejected / total >= REJECTION_QUARANTINE_RATE) {
    return 'rejection_rate';
  }
  return null;
}
