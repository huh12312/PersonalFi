// SPDX-License-Identifier: MIT
/**
 * The kill ladder — four independent ways to stop an advisor, the rule that
 * any one of them is enough, and the breaker that pulls level 3 on its own.
 *
 * | Level | Mechanism | Scope | Default | Who flips it | Survives restart |
 * | --- | --- | --- | --- | --- | --- |
 * | 1 Module | `ADVISORS_ENABLED` (config) **and** `module.insights` (flag) | every advisor | on | operator / user | yes |
 * | 2 Kind | `advisors.kind.local_model` (flag) **and** a configured endpoint | every `local_model` advisor | **off** | user, step-up / operator | yes |
 * | 3 Advisor | `advisors.enabled` **and** the breaker's `quarantined_at` | one advisor | off | user, step-up / the app | yes — rows |
 * | 4 Run | `advisor_runs.cancel_requested_at`; the deadline | one run | — | user, step-up / the clock | n/a |
 *
 * (05-phase-5-dispatch.md §3 WP 5.1. 08 §4.6's "drop the sidecar's compose
 * profile" sits under all four — `docker compose stop ollama` — and is not a
 * level: nothing records it.)
 *
 * ## Why "any one is enough" is written once, here
 *
 * The failure mode a kill switch has is not that it does not work — it is that
 * something checked *a* switch rather than *the* switches. So `decideRun`
 * returns one verdict from every input, and the three places a run asks —
 * before it starts (`service.ts` transaction 1), while the untrusted call is in
 * flight (`run-watch.ts`, at most once a second), and at the write barrier
 * (`service.ts` transaction 2, under a row lock on the `advisors` row) — all
 * ask through `decideRun`. `test/kill-switches.test.ts` is a `fast-check`
 * property over every input combination.
 *
 * Until Phase 5 the inputs of level 1 were literals: `advisorsEnabled: true,
 * moduleEnabled: true` at both places a run was assembled (Phase 4 gate G4-9).
 * They are now read through `RunSwitches`, a port the composition root binds
 * to `config.env.ADVISORS_ENABLED` and an uncached flag reader.
 *
 * ## The breaker is per kind
 *
 * 08 §4.4: "3 consecutive failures or 5 schema violations in 24h ⇒
 * auto-disable". That is the `local_model` (and `external`) threshold. The
 * built-ins keep the thresholds Phase 2 shipped — five consecutive failures,
 * or one run whose proposals the validator refused at ≥ 50% with ≥ 4 to judge
 * — because a deterministic rule that fails is a bug with a stack trace, not a
 * model having a bad night, and re-tuning a shipped breaker was not in scope.
 * The discrepancy with 08 for `builtin` is recorded, not silently resolved
 * (docs/evidence/phase-5/wp5.1-run-control.md §6).
 *
 * A quarantine is recorded with a reason and is cleared only by a human. It
 * does not decay.
 */
import type { AdvisorKind } from '../contract/scopes.ts';

/** The `module.insights` flag — level 1's user half. */
export const MODULE_FLAG_KEY = 'module.insights';

/**
 * Level 2's flag per kind. `builtin` has none: it is the kind that cannot be
 * switched off separately from the module. `external` has none *yet* — Phase
 * 6 adds it — and a kind with no flag is off (`createRunSwitches`).
 */
export const KIND_FLAG_KEYS: Readonly<Partial<Record<AdvisorKind, string>>> = Object.freeze({
  local_model: 'advisors.kind.local_model',
});

export type RunRefusal =
  | 'advisors_disabled'
  | 'module_disabled'
  | 'kind_disabled'
  | 'advisor_disabled'
  | 'advisor_quarantined'
  | 'payload_not_approved';

/** A refusal's vocabulary plus level 4, the holder's own per-run cancel. */
export type CancelReason = RunRefusal | 'run_cancelled';

/** Which ladder level a refusal or cancellation belongs to. The approval gate is not a level. */
export const LADDER_LEVEL: Readonly<Record<CancelReason, 1 | 2 | 3 | 4 | null>> = Object.freeze({
  advisors_disabled: 1,
  module_disabled: 1,
  kind_disabled: 2,
  advisor_disabled: 3,
  advisor_quarantined: 3,
  payload_not_approved: null,
  run_cancelled: 4,
});

export type RunDecision =
  { readonly run: true } | { readonly run: false; readonly refusal: RunRefusal };

export interface KillSwitchInputs {
  /** Level 1, operator: `ADVISORS_ENABLED`. */
  readonly advisorsEnabled: boolean;
  /** Level 1, user: the `module.insights` flag. */
  readonly moduleEnabled: boolean;
  /** Level 2: this advisor's kind is switched on and configured. Always true for `builtin`. */
  readonly kindEnabled: boolean;
  /** Level 3: `advisors.enabled` for this advisor. */
  readonly advisorEnabled: boolean;
  /** Level 3, automatic: `advisors.quarantined_at`; non-null means tripped. */
  readonly quarantinedAt: Date | null;
  /**
   * The payload preview gate: a live approval exists for the shape this run
   * would send. Always true for `builtin`, which sends nothing anywhere.
   */
  readonly payloadApproved: boolean;
}

/**
 * May this advisor run at all?
 *
 * The order is blast radius — global, module, kind, advisor, quarantine,
 * approval — so the reason recorded on `advisor_runs` is the *broadest* one
 * that applies. "Everything is off" and "this one advisor is quarantined" are
 * different operational situations, and the log must not report the second
 * when the first is true.
 */
export function decideRun(inputs: KillSwitchInputs): RunDecision {
  if (!inputs.advisorsEnabled) return { run: false, refusal: 'advisors_disabled' };
  if (!inputs.moduleEnabled) return { run: false, refusal: 'module_disabled' };
  if (!inputs.kindEnabled) return { run: false, refusal: 'kind_disabled' };
  if (!inputs.advisorEnabled) return { run: false, refusal: 'advisor_disabled' };
  if (inputs.quarantinedAt !== null) return { run: false, refusal: 'advisor_quarantined' };
  if (!inputs.payloadApproved) return { run: false, refusal: 'payload_not_approved' };
  return { run: true };
}

/**
 * The same verdict, for a run already in flight: every switch, then its own
 * cancel flag. A run the holder cancelled *and* whose module was switched off
 * is recorded as `module_disabled` — the broadest level that applied.
 */
export function decideContinue(
  inputs: KillSwitchInputs & { readonly cancelRequestedAt: Date | null },
): CancelReason | null {
  const decision = decideRun(inputs);
  if (!decision.run) return decision.refusal;
  if (inputs.cancelRequestedAt !== null) return 'run_cancelled';
  return null;
}

// ---------------------------------------------------------------------------
// Reading levels 1 and 2
// ---------------------------------------------------------------------------

/**
 * Levels 1 and 2, as a port. Rows (level 3, level 4, the approval) are this
 * context's own and are read by `store.ts`; these three live outside it —
 * one in config, two in `feature_flags` — so the composition root binds them.
 *
 * Every method is called on every check: before the run, once a second while
 * it is in flight, and at the write barrier. **An implementation must not
 * cache for longer than that.** `@core/platform`'s `FlagService` caches for 30
 * s by default, which would make "ends the run within two seconds" false for
 * levels 1 and 2; bind it with `ttlMs: 0` (or its NOTIFY invalidation plus a
 * short TTL) — see the evidence's "Wiring for the orchestrator".
 */
export interface RunSwitches {
  advisorsEnabled(): Promise<boolean>;
  moduleEnabled(userId: string): Promise<boolean>;
  kindEnabled(userId: string, kind: AdvisorKind): Promise<boolean>;
}

/** The one method of a flag service this needs. `FlagService` satisfies it. */
export interface FlagReader {
  isEnabled(userId: string, key: string): Promise<boolean>;
}

export interface RunSwitchSources {
  /** `config.env.ADVISORS_ENABLED`. Static per process: a change is a restart. */
  readonly advisorsEnabled: boolean;
  /** An uncached reader over `feature_flags` (see `RunSwitches`). */
  readonly flags: FlagReader;
  /**
   * Level 2's operator half, per kind: is anything configured to serve it?
   * For `local_model`, `config.localModel !== undefined` (an endpoint, a name
   * and a digest). A kind that is not configured is off whatever its flag says.
   */
  readonly configuredKinds: ReadonlySet<AdvisorKind>;
}

export function createRunSwitches(sources: RunSwitchSources): RunSwitches {
  return {
    advisorsEnabled: () => Promise.resolve(sources.advisorsEnabled),
    moduleEnabled: (userId) => sources.flags.isEnabled(userId, MODULE_FLAG_KEY),
    async kindEnabled(userId, kind) {
      if (kind === 'builtin') return true;
      const key = KIND_FLAG_KEYS[kind];
      if (key === undefined || !sources.configuredKinds.has(kind)) return false;
      return sources.flags.isEnabled(userId, key);
    },
  };
}

/**
 * The switches as they were before WP 5.1: two booleans, fixed at
 * construction. Used only when a composition root supplies no `RunSwitches`
 * (the worker's `modules.ts` until the W-A wiring batch). Fails closed: an
 * absent boolean is `false`, and no kind but `builtin` is ever on.
 */
export function staticRunSwitches(settings: {
  readonly advisorsEnabled?: boolean;
  readonly moduleEnabled?: boolean;
}): RunSwitches {
  return {
    advisorsEnabled: () => Promise.resolve(settings.advisorsEnabled ?? false),
    moduleEnabled: () => Promise.resolve(settings.moduleEnabled ?? false),
    kindEnabled: (_userId, kind) => Promise.resolve(kind === 'builtin'),
  };
}

// ---------------------------------------------------------------------------
// The breaker
// ---------------------------------------------------------------------------

export interface BreakerThresholds {
  /** Consecutive failed runs that trip it. */
  readonly consecutiveFailures: number;
  /** One run refusing at least this fraction of its proposals trips it (`null`: rule off). */
  readonly rejectionRate: number | null;
  /** Below this many proposals a run's rate is not evidence. */
  readonly rejectionFloor: number;
  /** Validator rejections in a rolling 24 h that trip it (`null`: rule off). */
  readonly rejectionsIn24h: number | null;
}

/**
 * `builtin`: Phase 2's numbers, unchanged. `local_model` and `external`: 08
 * §4.4's. See this file's header for why they differ.
 */
export const BREAKER_THRESHOLDS: Readonly<Record<AdvisorKind, BreakerThresholds>> = Object.freeze({
  builtin: Object.freeze({
    consecutiveFailures: 5,
    rejectionRate: 0.5,
    rejectionFloor: 4,
    rejectionsIn24h: null,
  }),
  local_model: Object.freeze({
    consecutiveFailures: 3,
    rejectionRate: null,
    rejectionFloor: 0,
    rejectionsIn24h: 5,
  }),
  external: Object.freeze({
    consecutiveFailures: 3,
    rejectionRate: null,
    rejectionFloor: 0,
    rejectionsIn24h: 5,
  }),
});

/** Kept for existing importers: the `builtin` numbers. */
export const CONSECUTIVE_FAILURE_LIMIT = BREAKER_THRESHOLDS.builtin.consecutiveFailures;
export const REJECTION_QUARANTINE_RATE = BREAKER_THRESHOLDS.builtin.rejectionRate ?? 0.5;
export const REJECTION_QUARANTINE_FLOOR = BREAKER_THRESHOLDS.builtin.rejectionFloor;

export type QuarantineReason = 'consecutive_failures' | 'rejection_rate';

export interface BreakerInputs {
  /** Defaults to `builtin` — the only kind that existed before WP 5.1. */
  readonly kind?: AdvisorKind;
  /** Including the run just completed. Reset to 0 by a successful run. */
  readonly consecutiveFailures: number;
  /** Proposals the validator accepted in the run just completed. */
  readonly accepted: number;
  /** Proposals the validator refused in the run just completed. */
  readonly rejected: number;
  /**
   * Validator rejections in the rolling 24 h ending now, this run included:
   * refused insights plus whole responses refused at steps 1–3. Only read by
   * a kind whose `rejectionsIn24h` is set.
   */
  readonly rejectionsIn24h?: number;
}

/**
 * Should the breaker trip after this run? `null` means no.
 *
 * Pure, so the decision can be re-derived from `advisor_runs` rows after the
 * fact — "why was this quarantined on the 4th?" is answerable by feeding
 * those counts back through this function.
 */
export function shouldQuarantine(inputs: BreakerInputs): QuarantineReason | null {
  const limits = BREAKER_THRESHOLDS[inputs.kind ?? 'builtin'];
  if (inputs.consecutiveFailures >= limits.consecutiveFailures) return 'consecutive_failures';
  if (limits.rejectionRate !== null) {
    const total = inputs.accepted + inputs.rejected;
    if (
      total >= limits.rejectionFloor &&
      total > 0 &&
      inputs.rejected / total >= limits.rejectionRate
    ) {
      return 'rejection_rate';
    }
  }
  if (limits.rejectionsIn24h !== null && (inputs.rejectionsIn24h ?? 0) >= limits.rejectionsIn24h) {
    return 'rejection_rate';
  }
  return null;
}
