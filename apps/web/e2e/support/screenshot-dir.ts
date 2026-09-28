// SPDX-License-Identifier: MIT
import { fileURLToPath } from 'node:url';

/**
 * Where evidence screenshots go (C-16, O-3 —
 * `docs/evidence/phase-3/gate-security-review.md`'s finding: "running
 * `just verify`/Playwright rewrites committed evidence screenshots" — it
 * dirtied wp3.11's and wp3.12's committed PNGs, and the orchestrator
 * restored them three times in one week because every ordinary test run
 * regenerated them in place).
 *
 * Defaults to a **gitignored** output directory
 * (`apps/web/test-results/evidence-screenshots/`, covered by the existing
 * `apps/web/test-results/` line in the root `.gitignore` — no new ignore
 * entry needed) so an ordinary `playwright test`/`just verify` run can never
 * touch a committed file. `evidenceDir` names the real evidence directory
 * (e.g. `docs/evidence/phase-3/screenshots`) for a deliberate regeneration —
 * the one case where overwriting the committed set is the point.
 *
 * Takes the resolved value rather than reading `PLAYWRIGHT_EVIDENCE_DIR`
 * itself: the repo-wide `process.env` ban (`docs/CONVENTIONS.md`) exempts
 * `test/` and `playwright.config.ts`, not `e2e/` —
 * `cold-start.spec.ts`'s own header states the same rule for
 * `COLD_START_BASE_URL`. `playwright.config.ts` reads the variable and
 * hands it down as the `evidenceDir` test option; each spec's own
 * `test.extend` reads that option and passes it here.
 */
export function screenshotDir(evidenceDir: string | undefined): string {
  if (evidenceDir !== undefined) {
    return evidenceDir.endsWith('/') ? evidenceDir : `${evidenceDir}/`;
  }
  return fileURLToPath(new URL('../../test-results/evidence-screenshots/', import.meta.url));
}
