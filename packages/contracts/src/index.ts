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
 * - `advisor/advisor.schema.json` — the Advisor contract (08 §4). Built-in rules,
 *   a local LLM, and the Vibe-Trading sidecar all deliver through it, which is why
 *   it is versioned independently of the HTTP API.
 */

/** Bumped when the HTTP surface changes shape. `/v1` in the path is separate. */
export const OPENAPI_CONTRACT_VERSION = '0.1.0';

/** Bumped when the Advisor request/response shape changes. Consumers pin a major. */
export const ADVISOR_CONTRACT_VERSION = '0.1.0';

export const CONTRACT_VERSIONS = {
  openapi: OPENAPI_CONTRACT_VERSION,
  advisor: ADVISOR_CONTRACT_VERSION,
} as const;
