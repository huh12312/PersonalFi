// SPDX-License-Identifier: MIT
/**
 * `@core/contracts` — the versioned wire contracts.
 *
 * Two artefacts live here, both generated or hand-maintained as *data*, never as
 * TypeScript that a consumer must run:
 *
 * - `openapi/openapi.json` — emitted from the Fastify route schemas by
 *   `pnpm openapi`. The frontend's client is generated from this file, so it is
 *   checked in and CI fails if it is stale.
 * - `advisor/advisor.schema.json` plus `advisor/v1/{request,response,manifest}.schema.json`
 *   — the Advisor contract (08 §4). Built-in rules, a local LLM, and the
 *   Vibe-Trading sidecar all deliver through it, which is why it is versioned
 *   independently of the HTTP API.
 *
 * ## Why the Advisor schemas are still only data here
 *
 * This package's boundary-lint layer allows `@core/kernel` and nothing else
 * ("wire contracts are data; they must not depend on an implementation"), so the
 * runtime definitions — the zod mirrors the validator actually runs — live in
 * `@ctx/insights/src/contract/`. The three files under `advisor/v1/` are emitted
 * from those definitions and `packages/contexts/insights/test/contract-parity.test.ts`
 * asserts byte equality in both directions, so the published artefact and the
 * running validator cannot drift. That test also asserts the constants below
 * against the emitted documents, which is what keeps this file honest.
 */

/** Bumped when the HTTP surface changes shape. `/v1` in the path is separate. */
export const OPENAPI_CONTRACT_VERSION = '0.1.0';

/**
 * Bumped when the Advisor request/response shape changes. Consumers pin a major.
 *
 * `1.0.0` from WP 2.6: the placeholder became the real contract —
 * `AdvisorSnapshot` with the 08 §4.2 scope catalogue and its minimisation rules,
 * `AdvisorRequest`, the `Insight[]` response with evidence refs, derivations,
 * confidence, a severity ceiling and `requires_review`, and `AdvisorManifest`.
 */
export const ADVISOR_CONTRACT_VERSION = '1.0.0';

/**
 * The integer that crosses the wire, as distinct from the artefact version
 * above. 08 §4.4: "`contract_version` is a single integer, negotiated at
 * registration … we support N and N-1 simultaneously." A patch to the published
 * schema must never force a sidecar redeploy, which putting `'1.0.0'` on the
 * wire would do.
 */
export const ADVISOR_CONTRACT_MAJOR = 1;

/** Majors this build speaks, newest first. One entry until there is an N-1. */
export const ADVISOR_SUPPORTED_MAJORS: readonly number[] = Object.freeze([ADVISOR_CONTRACT_MAJOR]);

/** `$id`s of the three normative documents, for a registration handshake. */
export const ADVISOR_SCHEMA_IDS = Object.freeze({
  request: 'https://personalfi.local/contracts/advisor/v1/request.schema.json',
  response: 'https://personalfi.local/contracts/advisor/v1/response.schema.json',
  manifest: 'https://personalfi.local/contracts/advisor/v1/manifest.schema.json',
} as const);

export const CONTRACT_VERSIONS = {
  openapi: OPENAPI_CONTRACT_VERSION,
  advisor: ADVISOR_CONTRACT_VERSION,
} as const;
