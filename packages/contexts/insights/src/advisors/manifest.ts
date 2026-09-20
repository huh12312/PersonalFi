// SPDX-License-Identifier: MIT
/**
 * One manifest builder, so that what a built-in declares is uniform by
 * construction rather than by twenty careful copies.
 *
 * Four fields are fixed for every rule in the catalogue and are **not**
 * parameters:
 *
 *   * `kind: 'builtin'` — the pipeline reserves `confidence_basis:
 *     'deterministic'` for this kind, and refuses the claim to anything else.
 *   * `capabilities.deterministic: true` — every rule here is a pure function of
 *     the snapshot. `advisors_deterministic_is_builtin` refuses the row
 *     otherwise, and `advisor-determinism.test.ts` is the proof rather than the
 *     assertion.
 *   * `capabilities.narrates_only: false` — a built-in *is* the thing that finds
 *     a finding. Narration is Phase 5's local model.
 *   * `egress_allowlist: []` — a built-in has no network path. `checkManifest`
 *     refuses a non-empty list for this kind, so an `open_url` action from a
 *     built-in cannot reach a host nobody put there deliberately (there is no
 *     such host, and no rule in this catalogue emits a URL).
 *
 * `requires_scopes` is the one field worth reading twice for each rule: it is
 * what the grant screen shows, what `SnapshotBuilder` iterates, and what limits
 * the blast radius of a rule that turns out to be wrong. A rule that reads
 * `cash.summary` and declares `transactions.raw` as well gets sent the raw
 * transactions whether it wants them or not, so the catalogue declares exactly
 * what each `evaluate` touches and `catalog.test.ts` checks that claim by
 * running every rule against a snapshot built from *only* its declared scopes.
 */
import { DEFAULT_ADVISOR_CRON } from '../jobs.ts';
import type { AdvisorManifest } from '../contract/manifest.ts';
import type { AdvisorScope } from '../contract/scopes.ts';
import type { Severity } from '../contract/response.ts';
import { ADVISOR_CONTRACT_MAJOR } from '../contract/version.ts';

/** Every built-in in this catalogue is version 1.0.0 of itself. */
export const BUILTIN_RULE_VERSION = '1.0.0';

export interface ManifestInput {
  readonly advisorId: string;
  readonly displayName: string;
  readonly purpose: string;
  readonly scopes: readonly AdvisorScope[];
  /** The ceiling. A rule never emits above it; the pipeline would clamp it. */
  readonly maxSeverity: Severity;
  readonly producesImpact: boolean;
  /** How many insights this rule may emit in one run. */
  readonly maxInsights: number;
}

export function builtinManifest(input: ManifestInput): AdvisorManifest {
  return {
    advisor_id: input.advisorId,
    version: BUILTIN_RULE_VERSION,
    contract_version: ADVISOR_CONTRACT_MAJOR,
    kind: 'builtin',
    display_name: input.displayName,
    purpose: input.purpose,
    requires_scopes: [...input.scopes],
    triggers: [{ type: 'schedule', cron: DEFAULT_ADVISOR_CRON }],
    capabilities: {
      deterministic: true,
      produces_impact: input.producesImpact,
      narrates_only: false,
      max_severity: input.maxSeverity,
    },
    limits: {
      // In-process and pure: a rule that has not finished in ten seconds is a
      // rule looping over something unbounded, and the platform ceiling of five
      // minutes is for a sidecar over a network, not for this.
      timeout_ms: 10_000,
      max_insights: input.maxInsights,
      max_response_bytes: 131_072,
    },
    egress_allowlist: [],
  };
}
