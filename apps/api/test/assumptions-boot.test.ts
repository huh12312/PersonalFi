// SPDX-License-Identifier: MIT
/**
 * WP 4.2 §9 item 5, closed by the Wave B wiring batch: `loadAssumptions()`
 * (`@ctx/planning`) is lazy by design — its own doc comment says the
 * composition root should call it at boot so a malformed 07 §5.5/§6.4/
 * Appendix A file refuses to start the process, rather than surfacing as a
 * 500 on whichever request happens to read it first.
 *
 * ## Why this is a source-text assertion, not a spawned boot
 *
 * `loadAssumptions()` memoises its result in a module-level `current` variable
 * (`packages/contexts/planning/src/assumptions.ts`: `current ??=
 * parseAssumptions(ASSUMPTIONS_FILE)`) and `ASSUMPTIONS_FILE` is a compiled
 * TypeScript data module (`packages/contexts/planning/data/assumptions.ts`),
 * not a path read off disk at runtime — there is no file for this test to
 * corrupt and restore the way `withTempSecretsDir` does for a secrets file.
 * Actually malforming it means editing that data module's source, which is
 * `@ctx/planning`'s own file (out of this batch's ownership) and already has
 * its validator exercised directly by that package's own
 * `test/assumptions.test.ts` (`parseAssumptions` against a battery of bad
 * inputs). What is *this* batch's claim, and what was never checked before it,
 * is narrower: that `apps/api/src/main.ts` and `apps/api/src/worker.ts` each
 * call `loadAssumptions()` themselves, at boot, **unconditionally** — not
 * behind a flag, not inside a `try` that would log it and continue the way
 * this same file's config-snapshot write deliberately does a few lines later.
 *
 * `apps/api/test/regate-worker-boot.test.ts` (N-4/N-5) already establishes the
 * pattern this test follows for exactly this reason: "these assertions are
 * deliberately made against the source and the compose file as committed, not
 * against a rebuilt runtime... a test that boots a worker would need a
 * database, a KEK and 1 GiB of RAM to say the same thing." Both entry points
 * here need a live database, a KEK and an unlocked box before `app.listen`/
 * the scheduler start, for reasons this batch does not own; the source is
 * where the claim actually lives.
 *
 * **Sabotage, run by hand while this file was written**: commenting out either
 * `loadAssumptions();` call turns its own `it` red immediately
 * (`docs/evidence/phase-4/wp4.w-wave-b-wiring.md` records the exact output);
 * restored byte-identical afterwards.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8');

/** The exact call, as `main.ts`/`worker.ts` write it — not a substring of a comment. */
const CALL = /^\s*loadAssumptions\(\);\s*$/m;

function assertCallsLoadAssumptionsAtBoot(path: string, source: string): void {
  expect(
    source.includes("import { loadAssumptions } from '@ctx/planning';") ||
      /import\s*\{[^}]*\bloadAssumptions\b[^}]*\}\s*from\s*'@ctx\/planning'/.test(source),
    `${path} must import loadAssumptions from @ctx/planning`,
  ).toBe(true);

  const match = CALL.exec(source);
  expect(match, `${path} must call loadAssumptions() as its own statement`).not.toBeNull();
  if (match === null) return;

  // Unconditional: nothing between the top of `main()`'s body and this call
  // may be a guard that could swallow its throw. `try {` is the one this
  // file's own config-snapshot write uses a few lines below, deliberately, for
  // a *different*, non-fatal failure — the sabotage this test is built to
  // catch is exactly that shape applied to this call instead.
  const mainStart = source.indexOf('async function main(');
  expect(mainStart, `${path} must define an async main()`).toBeGreaterThanOrEqual(0);
  const beforeCall = source.slice(mainStart, match.index);
  expect(
    beforeCall.includes('try {') || beforeCall.includes('try{'),
    `${path}: loadAssumptions() is preceded by a try block inside main() — a bad file would ` +
      'be caught and logged rather than refusing to boot',
  ).toBe(false);
  expect(
    /^\s*(if|catch)\b/m.test(beforeCall.slice(beforeCall.lastIndexOf('\n'))),
    `${path}: loadAssumptions() must not be conditional`,
  ).toBe(false);

  // Early: before the database pool and before the socket opens. `createPool`
  // is the first genuinely stateful step in both files today.
  const poolAt = source.indexOf('createPool(');
  expect(poolAt, `${path} must call createPool(...)`).toBeGreaterThanOrEqual(0);
  expect(
    match.index,
    `${path}: loadAssumptions() must run before createPool(...), not after`,
  ).toBeLessThan(poolAt);
}

describe('WP 4.2 §9 item 5 — a malformed assumptions file must refuse to boot', () => {
  it('apps/api/src/main.ts calls loadAssumptions() unconditionally, before the database pool', () => {
    assertCallsLoadAssumptionsAtBoot('apps/api/src/main.ts', repoFile('apps/api/src/main.ts'));
  });

  it('apps/api/src/worker.ts calls loadAssumptions() unconditionally, before the database pool', () => {
    assertCallsLoadAssumptionsAtBoot('apps/api/src/worker.ts', repoFile('apps/api/src/worker.ts'));
  });

  it("main.ts's top-level catch exits non-zero on an uncaught error, so loadAssumptions()'s throw cannot be swallowed on its way out", () => {
    const source = repoFile('apps/api/src/main.ts');
    const tail = source.slice(source.lastIndexOf('try {\n  await main();'));
    expect(tail, 'main.ts must end with a top-level try/catch around main()').not.toBe('');
    expect(tail.includes('process.exit(')).toBe(true);
    // Every catch branch exits non-zero: `ConfigError` at EX_CONFIG (78),
    // anything else at 1. Neither branch may fall through to a normal return.
    for (const match of tail.matchAll(/process\.exit\((\d+)\)/g)) {
      expect(Number(match[1]), 'main.ts must never exit 0 from the boot catch').not.toBe(0);
    }
  });

  it("worker.ts's top-level catch exits non-zero on an uncaught error, so loadAssumptions()'s throw cannot be swallowed on its way out", () => {
    const source = repoFile('apps/api/src/worker.ts');
    const catchAt = source.lastIndexOf('} catch (error) {');
    expect(catchAt, 'worker.ts must have a top-level catch around its boot').toBeGreaterThan(0);
    const tail = source.slice(catchAt);
    expect(tail.includes('process.exit(')).toBe(true);
    for (const match of tail.matchAll(/process\.exit\((\d+)\)/g)) {
      expect(Number(match[1]), 'worker.ts must never exit 0 from the boot catch').not.toBe(0);
    }
  });
});
