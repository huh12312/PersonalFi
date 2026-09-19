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
 */
import { z } from 'zod';
import { ADVISOR_KINDS, ADVISOR_SCOPES } from './scopes.ts';
import { AdvisorSnapshotSchema } from './snapshot.ts';
import { ADVISOR_CONTRACT_MAJOR } from './version.ts';

export const AdvisorScopeSchema = z.enum(ADVISOR_SCOPES);
export const AdvisorKindSchema = z.enum(ADVISOR_KINDS);

/** `sha256:` + 64 lowercase hex. The only digest form v1 speaks. */
export const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/, 'ISO-8601 UTC instant');

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
  })
  .describe('What crosses the boundary to an advisor. Read-only; there is no return channel.');

export type AdvisorRequest = z.infer<typeof AdvisorRequestSchema>;
