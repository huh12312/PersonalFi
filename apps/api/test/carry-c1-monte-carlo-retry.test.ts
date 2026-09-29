// SPDX-License-Identifier: MIT
/**
 * C-1 (G4-1(c)) / `docs/evidence/phase-4/gate-security-review.md` §3.5, §6
 * row **C-1**: "`createMonteCarloRunnerFromCache` reads the series once at
 * process start, so a successful fetch has no effect until a restart."
 *
 * That is a statement about `app.ts` and `worker.ts` (each calls the function
 * exactly once, at boot, and holds the result for the life of the process —
 * neither is this WP's file to change), not about the function itself:
 * `createMonteCarloRunnerFromCache` has never cached anything internally —
 * it is `loadReturnSeries(options.cacheDir)` wrapped in a try/catch, and
 * `loadReturnSeries` always reads the filesystem fresh. This suite proves
 * that half directly: the miss case (empty cache, `null`, the exact warning
 * logged) and that two independent calls against the same directory never
 * share state. The other half — "drops the series in, and sees the next
 * call succeed" against a *matching* checksum — is proved in
 * `packages/contexts/planning/test/returns-cache-rewrite.test.ts` against
 * `loadReturnSeries` directly (the function this one delegates to), because
 * only there can a throwaway pin be injected without widening this WP's
 * ownership of `createMonteCarloRunnerFromCache`'s public options.
 *
 * **Why no re-read fix landed in `createMonteCarloRunnerFromCache` itself**
 * (recorded here because this is the test that would have proved it): a
 * design returning one non-null, self-retrying runner from the single boot
 * call was built and rejected. `defaultMethodFor` (`routes/plan.ts`) and
 * `refreshBaseline`'s own method choice (`packages/contexts/planning/src/
 * projection-service.ts:973`) both decide deterministic-vs-Monte-Carlo from
 * a bare `=== null` check on the exact value this function returns, with no
 * seam this WP's ownership can reach to tell "attempt Monte Carlo eagerly"
 * apart from "gracefully run deterministic until fetched" — so a never-`null`
 * return made the nightly `planning.projection_refresh` job stop writing any
 * baseline run at all on an un-fetched install, proved red against
 * `apps/api/test/db/phase4-wiring.test.ts`'s own existing coverage (not this
 * WP's file; its assertions are unchanged in this tree). C-1's exit
 * condition allows a second path instead — "a successful fetch is picked up
 * without a restart (re-read on a miss, **or a documented restart step**)" —
 * and RUNBOOK.md's new "Monte Carlo return series" section takes the second.
 *
 * No database is needed (`test/*.test.ts`, the `api` project).
 */
import { recordingLogger } from '@core/testkit';
import { describe, expect, it } from 'vitest';
import { createMonteCarloRunnerFromCache } from '../src/domain.ts';

describe('createMonteCarloRunnerFromCache (carry-c1)', () => {
  it('an absent cache directory answers null and logs the exact reason, every call fresh', () => {
    const cacheDir = `/tmp/personalfi-carry-c1-no-such-cache-${String(process.pid)}-${String(Date.now())}`;

    const firstLogger = recordingLogger();
    const first = createMonteCarloRunnerFromCache({ cacheDir, logger: firstLogger });
    expect(first).toBeNull();
    const firstWarnings = firstLogger.lines.filter((line) => line.level === 'warn');
    expect(firstWarnings).toHaveLength(1);
    expect(firstWarnings[0]?.obj['code']).toBe('planning.returns_series_unavailable');
    expect(firstWarnings[0]?.msg).toContain('Monte Carlo is bound to null');
    expect(firstWarnings[0]?.msg).toContain('deterministic');

    // A second, independent call against the same still-empty directory: a
    // fresh read, not a cached `null` from the first call's logger carrying
    // over — each call gets its own logger here specifically so a bug that
    // reused state across calls (e.g. a module-level cache) would show up as
    // the second logger seeing nothing, or the first logger seeing a second
    // warning it should not.
    const secondLogger = recordingLogger();
    const second = createMonteCarloRunnerFromCache({ cacheDir, logger: secondLogger });
    expect(second).toBeNull();
    expect(secondLogger.lines.filter((line) => line.level === 'warn')).toHaveLength(1);
    expect(firstLogger.lines).toHaveLength(1);
  });
});
