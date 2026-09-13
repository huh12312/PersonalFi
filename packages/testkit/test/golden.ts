// SPDX-License-Identifier: MIT
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Golden-fixture assertions for detection algorithms and reference-calculator
 * comparisons (07 Testing Strategy §7.3; 00-master-implementation-plan.md §6.1,
 * "the labeled recurring/merchant golden set").
 *
 * Deliberately takes `dir` from the caller rather than guessing it from
 * `import.meta.url` or `process.cwd()`: a golden fixture belongs to the package
 * that owns the behaviour it pins, and guessing the directory is how a fixture
 * ends up written next to `testkit`'s own source instead of the caller's.
 *
 * ```ts
 * const golden = { dir: fileURLToPath(new URL('./golden', import.meta.url)) };
 * expectGolden('recurring-monthly', detected, {
 *   ...golden,
 *   update: goldenUpdateRequested(process.env),
 * });
 * ```
 */
export interface GoldenLocation {
  readonly dir: string;
}

export interface ExpectGoldenOptions extends GoldenLocation {
  /** Write `value` as the new golden instead of comparing. */
  readonly update?: boolean;
}

function goldenPath(name: string, dir: string): string {
  return join(dir, `${name}.json`);
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * `UPDATE_GOLDEN=1` reads as an env var by convention (`docs/TESTING.md`), but
 * this package cannot read `process.env` itself — CONVENTIONS.md restricts that
 * to `@core/config`, and a lint rule enforces it for every other package's
 * shipped `src/`. Call this from your own `*.test.ts` file, which the same rule
 * exempts, and pass the result to `expectGolden`'s `update` option.
 */
export function goldenUpdateRequested(env: NodeJS.ProcessEnv): boolean {
  return env['UPDATE_GOLDEN'] === '1';
}

/** Read a fixture's raw text, or explain how to create it. */
function readGolden(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(
      `no golden fixture at ${path}. Run the suite once with UPDATE_GOLDEN=1 to create it.`,
      { cause },
    );
  }
}

/** Read a golden fixture. Throws with a `UPDATE_GOLDEN=1` hint if it is missing. */
export function loadGolden<T = unknown>(name: string, location: GoldenLocation): T {
  return JSON.parse(readGolden(goldenPath(name, location.dir))) as T;
}

/**
 * Compare `value` against the stored golden fixture (`<dir>/<name>.json`),
 * or write it as the new golden when `update` is true.
 *
 * Compares the canonical JSON text, not `JSON.parse` output, on purpose: a
 * fixture whose key order or number formatting silently drifts between two
 * runs that are supposedly deterministic is exactly the bug a seed generator
 * or a detection algorithm's determinism test exists to catch.
 */
export function expectGolden(name: string, value: unknown, options: ExpectGoldenOptions): void {
  const path = goldenPath(name, options.dir);
  const serialized = serialize(value);

  if (options.update === true) {
    mkdirSync(options.dir, { recursive: true });
    writeFileSync(path, serialized);
    return;
  }

  if (readGolden(path) !== serialized) {
    throw new Error(
      `golden fixture "${name}" at ${path} does not match.\n` +
        'Re-run with UPDATE_GOLDEN=1 if this change is intentional, and review the diff before committing it.',
    );
  }
}
