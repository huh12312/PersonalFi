// SPDX-License-Identifier: MIT
/**
 * `AdvisorRequest` v1 — the envelope the snapshot travels in.
 *
 * One-way. The advisor receives this and returns an `AdvisorResponse`; there is
 * no callback, no handle, no token and no second call. 08 §4.1: "an advisor
 * cannot *do* anything … the worst a fully-compromised advisor can do is propose
 * bad advice into a review queue."
 *
 * Four fields do work beyond carrying data:
 *
 *   * **`request_id`** must be echoed. A response that does not echo it is
 *     dropped (08 §4.4 step 4) — that is what makes a late response from a
 *     previous run unable to land in this one's review queue.
 *   * **`input_digest`** is `sha256:` over the canonical JSON of `snapshot`,
 *     computed by us and stored on `advisor_runs` and on every insight. It is
 *     what makes "show me exactly what we sent when this was proposed"
 *     answerable a month later without keeping the payload.
 *   * **`granted_scopes`** is the *effective* grant after the per-kind ceiling
 *     (`scopes.ts`'s `scopesPermittedForKind`), so it describes what is actually
 *     in `snapshot` rather than what the user once ticked. An advisor may
 *     therefore trust it, and the validator uses it when resolving evidence.
 *   * **`limits.deadline`** is enforced by us with an `AbortSignal`, never by
 *     the advisor's own settings (08 §4.4, "Hard timeout, enforced by us").
 *
 * ## `findings` — the narration envelope (contract 1.5.0, WP 5.3)
 *
 * A `narrates_only` advisor cannot narrate a finding it never sees, and until
 * 1.5.0 the request carried scopes only. `findings` is **optional and present
 * only for a `narrates_only` advisor**: per finding, what a built-in already
 * said and the figures it said it with — key, type, period, severity, title,
 * summary, its evidence rows (label, value, `source_ref`), the values of its
 * derivations as we re-computed them, and its impact as display strings. It is
 * an envelope field and not a scope: it adds no data category, so it needs a
 * contract minor and no `snapshot_grants` migration. Three rules travel with it,
 * each enforced by the service or the validator, not by this schema:
 *
 *   * **Laundering.** A finding enters only if the scopes its source run
 *     emitted are a subset of the narrator's own effective grant
 *     (`advisors/local/findings.ts`). Otherwise a narrator granted
 *     `cash.summary` could read `holdings.detail` through a finding built from
 *     it.
 *   * **The snapshot is empty and `granted_scopes` is the laundering bound.**
 *     For a `narrates_only` advisor the service sends `snapshot: {}`: the
 *     narrator may use only its finding's own figures (below), so every
 *     snapshot figure would be exposure with no purpose, and on the seed the
 *     full snapshot is larger than the local model's whole prompt budget.
 *     `granted_scopes` still names the effective grant, because that is what
 *     each finding was laundered against.
 *   * **The narrow trace and the `finding:` namespace.** A narration carries
 *     its finding's `key`, `type` and `period` (1:1); its `snapshot:` refs
 *     must be a subset of the finding's own evidence refs and are resolved
 *     through the finding (`finding:<key>`, `validate/evidence.ts`); and every
 *     numeral it writes must be one its finding rendered, verbatim
 *     (`validate/numerals.ts`'s `findingTraceContext`).
 */
import { z } from 'zod';
import { SEVERITIES, SourceRefSchema } from './response.ts';
import { ADVISOR_KINDS, ADVISOR_SCOPES } from './scopes.ts';
import { AdvisorSnapshotSchema } from './snapshot.ts';
import { ADVISOR_CONTRACT_MAJOR } from './version.ts';

export const AdvisorScopeSchema = z.enum(ADVISOR_SCOPES);
export const AdvisorKindSchema = z.enum(ADVISOR_KINDS);

/** `sha256:` + 64 lowercase hex. The only digest form v1 speaks. */
export const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/, 'ISO-8601 UTC instant');

/**
 * At most five findings per narration request — 05 §1 cut line 1: the local
 * model narrates the Brief's items, not every nightly proposal.
 */
export const MAX_NARRATED_FINDINGS = 5;

/** One finding a built-in made, as a narrator is shown it. Contract 1.5.0. */
export const NarratedFindingSchema = z.strictObject({
  /** The built-in insight's own key. A narration must carry it (1:1). */
  key: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  period: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/),
  type: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_.-]+$/),
  /** The finding's stored severity. A narration may sit at or below it, never above. */
  severity: z.enum(SEVERITIES),
  title: z.string().min(1).max(160),
  summary_md: z.string().min(1).max(2000),
  /** The finding's evidence rows. A narration may cite only these `source_ref`s. */
  evidence: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(160),
        value: z.string().max(160).nullable(),
        source_ref: SourceRefSchema.nullable(),
      }),
    )
    .min(1)
    .max(32),
  /**
   * The values of the finding's derivations as **we** re-computed them —
   * values only. Their ids are deliberately not sent: a narrator declares no
   * derivation of its own, and on the live calibration the pinned model wrote
   * a derivation id where the finding's `key` belonged (wp5.3 evidence §8).
   */
  derived: z.array(z.string().regex(/^-?\d+(\.\d+)?$/)).max(32),
  /** The finding's impact as the UI displays it (`$227.88`), or `null`. */
  impact: z.strictObject({
    annualized: z.string().max(64).nullable(),
    one_time: z.string().max(64).nullable(),
    basis: z.string().max(240),
  }),
});

export type NarratedFinding = z.infer<typeof NarratedFindingSchema>;

export const AdvisorRequestSchema = z
  .strictObject({
    /** The wire major. A single integer; see `version.ts`. */
    contract_version: z.literal(ADVISOR_CONTRACT_MAJOR),
    /** UUIDv7. MUST be echoed in the response. */
    request_id: z.uuid(),
    advisor_id: z.string().min(1).max(64),
    advisor_version: z.string().min(1).max(32),
    kind: AdvisorKindSchema,
    generated_at: instant,
    base_currency: z.string().regex(/^[A-Z]{3}$/),
    /** IANA zone. Every "today" in the snapshot was computed in it. */
    time_zone: z.string().min(1).max(64),
    /** `todayIn(clock, time_zone)`. The advisor must not read a clock. */
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    granted_scopes: z.array(AdvisorScopeSchema).max(ADVISOR_SCOPES.length),
    input_digest: DigestSchema,
    limits: z.strictObject({
      max_insights: z.number().int().min(1).max(100),
      max_response_bytes: z.number().int().min(1024).max(4_194_304),
      deadline: instant,
    }),
    snapshot: AdvisorSnapshotSchema,
    /**
     * Contract 1.5.0. Present only for a `narrates_only` advisor; absent for
     * every other kind of run. See the header for the three rules it carries.
     */
    findings: z.array(NarratedFindingSchema).min(1).max(MAX_NARRATED_FINDINGS).optional(),
  })
  .describe('What crosses the boundary to an advisor. Read-only; there is no return channel.');

export type AdvisorRequest = z.infer<typeof AdvisorRequestSchema>;
