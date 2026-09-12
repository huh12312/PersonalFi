// SPDX-License-Identifier: MIT
import { defineConfig } from '@hey-api/openapi-ts';

import { buildOpenApiConfig } from './openapi-ts.shared.mjs';

/**
 * `pnpm --filter @app/web gen` — regenerates `src/api/generated` from
 * `packages/contracts/openapi/openapi.json`. The output is gitignored
 * (Appendix A, docs/research/05-frontend-architecture.md): it is a pure
 * function of the OpenAPI document, and `scripts/check-openapi-drift.mjs`
 * is the CI check that a contract change didn't get generated-and-forgotten.
 *
 * Do not hand-write request/response types — that is the one constraint
 * apps/web/README.md called out as cheaper to honour now than to retrofit.
 */
export default defineConfig(buildOpenApiConfig('src/api/generated'));
