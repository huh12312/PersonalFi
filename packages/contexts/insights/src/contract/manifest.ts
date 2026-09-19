// SPDX-License-Identifier: MIT
/**
 * `AdvisorManifest` v1 — what an advisor declares before it is ever invoked.
 *
 * Checked into the repo for `builtin` advisors (WP 2.7's catalogue); a row in
 * `advisors` for everything else. It is the registration record, so it is also
 * the review artefact: the scopes it wants, the capabilities it claims, the
 * severity it is allowed to reach, the hosts it may talk to, and the limits we
 * will enforce on it.
 *
 * ## Capabilities are claims we check, not permissions we grant
 *
 * `capabilities.deterministic` is the interesting one. An advisor that claims it
 * may use `confidence_basis: 'deterministic'`; one that does not, may not, and
 * the pipeline rejects the insight rather than downgrading it silently. 08 §4.3
 * reserves `deterministic` for advisors that are provably rule-based, and the
 * pipeline additionally refuses the claim to anything whose `kind` is not
 * `builtin` — a manifest cannot assert its way into determinism.
 *
 * `capabilities.max_severity` is the ceiling. The validator **clamps** rather
 * than rejects, because degradation is a first-class requirement (08 §4.4) and
 * dropping a real finding because it shouted is worse than showing it quietly —
 * but the clamp is recorded in the run's diagnostics and in
 * `insights.severity_clamped`, so "this advisor keeps trying to shout" is a
 * question with an answer.
 *
 * `limits` are enforced by us. A manifest may ask for less than the platform
 * ceiling and never for more: `resolveLimits` takes the minimum of the two, so a
 * registration row edited to `max_insights: 10000` buys nothing.
 */
import { z } from 'zod';
import { AdvisorKindSchema, AdvisorScopeSchema } from './request.ts';
import { SEVERITIES } from './response.ts';
import { ADVISOR_CONTRACT_MAJOR } from './version.ts';

/**
 * Platform ceilings. A manifest is min'd against these and never exceeds them.
 *
 * `max_response_bytes` is enforced at *read* time, streaming, not after
 * buffering (08 §4.4 step 1): a 4 GiB response must fail while it is arriving.
 */
export const PLATFORM_LIMITS = Object.freeze({
  timeoutMs: 300_000,
  maxInsights: 50,
  maxResponseBytes: 262_144,
});

export const TriggerSchema = z.union([
  z.strictObject({
    type: z.literal('schedule'),
    /** Five-field cron, fired in the user's zone by `@core/platform`'s scheduler. */
    cron: z.string().min(1).max(64),
  }),
  z.strictObject({
    type: z.literal('event'),
    /** A domain event type, as a string. Contexts do not import each other. */
    event_type: z.string().min(1).max(96),
  }),
]);

export const AdvisorManifestSchema = z
  .strictObject({
    advisor_id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_.-]*$/),
    version: z.string().min(1).max(32),
    contract_version: z.literal(ADVISOR_CONTRACT_MAJOR),
    kind: AdvisorKindSchema,
    display_name: z.string().min(1).max(96),
    /** One line the scope-grant screen shows next to the request. */
    purpose: z.string().min(1).max(240),
    requires_scopes: z.array(AdvisorScopeSchema).min(1).max(13),
    triggers: z.array(TriggerSchema).max(8),
    capabilities: z.strictObject({
      /** May claim `confidence_basis: 'deterministic'`. Checked, not trusted. */
      deterministic: z.boolean(),
      /** Produces `impact.annualized` / `one_time` figures at all. */
      produces_impact: z.boolean(),
      /**
       * Narration only: it may restate a finding another advisor made and may
       * not introduce a new one. Phase 5's `local_model` advisor is the first
       * of these; the flag exists now so the contract does not have to move
       * when it arrives.
       */
      narrates_only: z.boolean(),
      /** The ceiling. Anything above it is clamped and recorded. */
      max_severity: z.enum(SEVERITIES),
    }),
    limits: z.strictObject({
      timeout_ms: z.number().int().min(100).max(PLATFORM_LIMITS.timeoutMs),
      max_insights: z.number().int().min(1).max(PLATFORM_LIMITS.maxInsights),
      max_response_bytes: z.number().int().min(1024).max(PLATFORM_LIMITS.maxResponseBytes),
    }),
    /**
     * Hostnames this advisor may reach, and the only hosts an `external:` URL in
     * its output may name. Empty for `builtin` and `local_model`: neither has
     * egress, and an `open_url` action from one of them can only link to a host
     * somebody put here deliberately.
     */
    egress_allowlist: z.array(z.string().min(1).max(253)).max(32),
  })
  .describe('What an advisor declares at registration: scopes, capabilities, limits, egress.');

export type AdvisorManifest = z.infer<typeof AdvisorManifestSchema>;
export type AdvisorTrigger = z.infer<typeof TriggerSchema>;

export interface ResolvedLimits {
  readonly timeoutMs: number;
  readonly maxInsights: number;
  readonly maxResponseBytes: number;
}

/** The manifest's limits, floored by the platform's. Never the other way. */
export function resolveLimits(manifest: AdvisorManifest): ResolvedLimits {
  return {
    timeoutMs: Math.min(manifest.limits.timeout_ms, PLATFORM_LIMITS.timeoutMs),
    maxInsights: Math.min(manifest.limits.max_insights, PLATFORM_LIMITS.maxInsights),
    maxResponseBytes: Math.min(
      manifest.limits.max_response_bytes,
      PLATFORM_LIMITS.maxResponseBytes,
    ),
  };
}
