// SPDX-License-Identifier: MIT
/**
 * `@advisor/local-model` — the Ollama adapter for the `local_model` advisor
 * kind (docs/plan/05-phase-5-dispatch.md WP 5.2).
 *
 * This is a stub, landed ahead of Wave A so `pnpm-workspace.yaml`,
 * `vitest.config.ts`'s `advisor-local-model` project, the
 * `scripts/eslint-boundaries.js` layer and `.github/workflows/ci.yml` all
 * exist before WP 5.1 and WP 5.2 start, rather than being built by the same
 * agent that has to prove the sandbox. **WP 5.2 fills this package**:
 * `renderPrompt`, the untrusted-block sanitisation, the `POST /api/chat`
 * client over `@core/platform`'s local-endpoint egress policy, and the
 * digest pin described in 05 §3 WP 5.2. Until then, this file exports
 * nothing but its own name, so the vitest project it belongs to is never
 * empty and the package is never unimportable.
 *
 * Declared but not yet imported: `@core/kernel`, `@core/platform` and
 * `@core/contracts` are this package's `dependencies` (05 §4 item 10 — no
 * external dependency, ever; the Ollama client is `@core/platform`'s
 * transport, not the `ollama` npm package). They are not imported from this
 * file yet on purpose — the orchestrator updates the lockfile
 * (`pnpm install --offline`) after this batch lands, and this package must
 * type-check and test green without it in the meantime.
 */
export const PACKAGE_NAME = '@advisor/local-model';
