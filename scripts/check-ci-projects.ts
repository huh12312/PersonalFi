#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * CI parity check (docs/plan/02-phase-2-dispatch.md §5, item 5).
 *
 * `vitest.config.ts` defines a `test.projects[]` entry per package. Nothing
 * mechanically ties that list to `.github/workflows/ci.yml`'s two hand-typed
 * `--project` flag lists (the `test` job's no-Postgres run and the
 * `migration-test` job's real-Postgres run) — so a new project can exist,
 * pass locally under `just check`/`just test` (which run the *whole* root
 * config, no `--project` filter), and never once run in CI. This exact
 * failure mode has happened twice at increasing scale before this script
 * existed: 4 of 13 projects (Phase 0's gate), then 10 of 23 (Phase 1's own
 * quality pass, `docs/evidence/phase-1/wp1.7-quality.md` §1) — both times on
 * the projects the phase itself had just added. It is, in the Phase 1 quality
 * pass's own words, "the single highest-yield check available."
 *
 * What this asserts, given the parsed project names:
 *
 *   1. Every project `vitest.config.ts` declares appears in at least one of
 *      the two `ci.yml` `--project` lists (the Phase 0/1 failure mode,
 *      directly).
 *   2. Every project named in either `ci.yml` list actually exists in
 *      `vitest.config.ts` — catches a rename or a typo that would otherwise
 *      make CI silently skip the real project under its old name while
 *      `--project` filters to nothing for it (vitest does not error on an
 *      unmatched `--project` name).
 *   3. Every "db-shaped" project (named exactly `db`, or ending in `-db` —
 *      the two conventions every `*-db` project in this repo actually uses,
 *      per `docs/TESTING.md`) is in the `migration-test` job's list, because
 *      it needs the real Postgres service only that job runs.
 *   4. Every non-db-shaped project is in the `test` job's list. `testkit` is
 *      the one project allowed in *both* lists on purpose (its own file mixes
 *      plain unit tests with `describe.skipIf(ADMIN_URL === undefined)`
 *      blocks — see `ci.yml`'s own header comment, R-3) — rule 4 does not
 *      forbid a non-db project from *also* appearing in `migration-test`, it
 *      only requires it appear in `test`.
 *
 * `--self-test` runs the same four rules against small in-memory fixtures
 * first (a clean pair, then one broken each of the four ways above) and
 * fails loudly if any fixture's expected verdict does not match — the
 * compose-hardening-check.sh / check-secret-ownership.sh pattern: a check
 * that has never been observed catching the thing it exists for is not
 * evidence (memory: gate-lessons). Run directly:
 *
 *   node scripts/check-ci-projects.ts             # the real files
 *   node scripts/check-ci-projects.ts --self-test  # fixtures only
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const VITEST_CONFIG_PATH = join(REPO_ROOT, 'vitest.config.ts');
const CI_YAML_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

const PROJECT_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Every `name: '<project>'` inside `test.projects[]`. Deliberately not a real
 * TS/AST parse — this is the same "small, human-maintained, checked-in file"
 * tradeoff `check-proxy-routes.ts` makes for `docker/Caddyfile`, and the
 * shape (`name: '...'` as an object literal property inside `defineConfig`)
 * has been stable since WP 0.1. Excludes the top-level `coverage` block by
 * construction: that block has no `name:` property at all.
 */
export function parseVitestProjectNames(vitestConfigText: string): string[] {
  const names = new Set<string>();
  const pattern = /name:\s*'([^']+)'/g;
  for (const match of vitestConfigText.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

/**
 * The `--project <name>` flags inside one top-level job's block in
 * `ci.yml`. A job's block runs from its own `  <jobName>:` header (exactly
 * two-space indented, GitHub Actions' own `jobs:` nesting) to the next line
 * at that same indentation (the next job, or EOF) — so a `--project` string
 * that happens to appear in another job's `run:` block, or in the header
 * comment above the `jobs:` key, is never counted here.
 */
export function parseCiProjectList(ciYamlText: string, jobName: string): string[] {
  const lines = ciYamlText.split('\n');
  const headerPattern = new RegExp(`^  ${jobName}:\\s*$`);
  const anyJobHeader = /^ {2}\S.*:\s*$/;

  const startIndex = lines.findIndex((line) => headerPattern.test(line));
  if (startIndex === -1) {
    throw new Error(`check-ci-projects: no '${jobName}:' job found in ${CI_YAML_PATH}`);
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && anyJobHeader.test(line)) {
      endIndex = i;
      break;
    }
  }

  const block = lines.slice(startIndex, endIndex).join('\n');
  const names = new Set<string>();
  for (const match of block.matchAll(/--project\s+([a-z0-9-]+)/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

function isDbShaped(project: string): boolean {
  return project === 'db' || project.endsWith('-db');
}

export interface CiProjectsInput {
  readonly vitestProjects: readonly string[];
  readonly testJobProjects: readonly string[];
  readonly migrationJobProjects: readonly string[];
}

/** Every problem found; empty means the four rules in the header all hold. */
export function checkCiProjects(input: CiProjectsInput): string[] {
  const problems: string[] = [];
  const vitestSet = new Set(input.vitestProjects);
  const testSet = new Set(input.testJobProjects);
  const migrationSet = new Set(input.migrationJobProjects);
  const ciUnion = new Set([...testSet, ...migrationSet]);

  for (const project of input.vitestProjects) {
    if (!PROJECT_NAME.test(project)) {
      problems.push(
        `vitest.config.ts declares project '${project}', which does not match the ` +
          "lowercase-hyphenated naming this check assumes ('kernel', 'ledger-db', ...) — " +
          'the parse may be silently wrong for it.',
      );
    }
    if (!ciUnion.has(project)) {
      problems.push(
        `'${project}' is declared in vitest.config.ts but appears in neither ci.yml ` +
          "job's --project list ('test' or 'migration-test') — it has never run in CI.",
      );
      continue; // the db/non-db rules below would just repeat this finding.
    }
    if (isDbShaped(project) && !migrationSet.has(project)) {
      problems.push(
        `'${project}' looks like a database-backed project (named 'db' or ending '-db') ` +
          "but is missing from the 'migration-test' job's --project list, which is the " +
          'only job with a real Postgres service.',
      );
    }
    if (!isDbShaped(project) && !testSet.has(project)) {
      problems.push(
        `'${project}' is not database-shaped but is missing from the 'test' job's ` +
          "--project list (it may still also appear in 'migration-test', as 'testkit' does).",
      );
    }
  }

  for (const project of ciUnion) {
    if (!vitestSet.has(project)) {
      problems.push(
        `ci.yml names '--project ${project}' but vitest.config.ts declares no such project ` +
          '— a stale or misspelled name silently runs zero tests (vitest does not error on an ' +
          'unmatched --project filter).',
      );
    }
  }

  return problems.sort();
}

// ---------------------------------------------------------------------------
// --self-test: fixtures only, never the real files.
// ---------------------------------------------------------------------------

interface Fixture {
  readonly name: string;
  readonly input: CiProjectsInput;
  /** true: expect checkCiProjects(input) to return zero problems. */
  readonly expectClean: boolean;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: 'a clean, minimal pair (one unit project, one db project, testkit in both)',
    input: {
      vitestProjects: ['kernel', 'ledger-db', 'testkit'],
      testJobProjects: ['kernel', 'testkit'],
      migrationJobProjects: ['ledger-db', 'testkit'],
    },
    expectClean: true,
  },
  {
    name: 'a project missing from ci.yml fails the check (the Phase 0/1 failure mode)',
    input: {
      vitestProjects: ['kernel', 'ledger-db', 'brand-new-context'],
      testJobProjects: ['kernel'],
      migrationJobProjects: ['ledger-db'],
    },
    expectClean: false,
  },
  {
    name: 'a stale ci.yml project name (not in vitest.config.ts) fails the check',
    input: {
      vitestProjects: ['kernel'],
      testJobProjects: ['kernel', 'kernel-old-name'],
      migrationJobProjects: [],
    },
    expectClean: false,
  },
  {
    name: 'a db-shaped project only in the test job (wrong job) fails the check',
    input: {
      vitestProjects: ['kernel', 'ledger-db'],
      testJobProjects: ['kernel', 'ledger-db'],
      migrationJobProjects: [],
    },
    expectClean: false,
  },
  {
    name: 'a non-db project only in migration-test (wrong job) fails the check',
    input: {
      vitestProjects: ['kernel', 'ledger-db'],
      testJobProjects: [],
      migrationJobProjects: ['kernel', 'ledger-db'],
    },
    expectClean: false,
  },
];

const VITEST_CONFIG_FIXTURE = `
export default defineConfig({
  test: {
    projects: [
      { root: './packages/kernel', test: { name: 'kernel', include: ['src/**/*.test.ts'] } },
      { root: './packages/db', test: { name: 'db', include: ['test/**/*.test.ts'] } },
    ],
    coverage: { provider: 'v8' },
  },
});
`;

const CI_YAML_FIXTURE = `
jobs:
  typecheck:
    steps:
      - run: pnpm run typecheck
  test:
    steps:
      - run: |
          pnpm exec vitest run --project kernel
  migration-test:
    steps:
      - run: |
          pnpm exec vitest run --project db
  web:
    steps:
      - run: pnpm --filter @app/web test
`;

/** Returns a list of self-test failures; empty means every fixture behaved as expected. */
function runSelfTest(): string[] {
  const failures: string[] = [];

  for (const fixture of FIXTURES) {
    const problems = checkCiProjects(fixture.input);
    const isClean = problems.length === 0;
    if (isClean !== fixture.expectClean) {
      failures.push(
        `fixture "${fixture.name}": expected ${fixture.expectClean ? 'clean' : 'problems'}, ` +
          `got ${isClean ? 'clean' : `problems: ${problems.join('; ')}`}`,
      );
    }
  }

  // The parsers themselves, against small fixture *text* (not the real files):
  // proves parseVitestProjectNames/parseCiProjectList actually extract names
  // rather than the fixtures above only exercising checkCiProjects directly.
  const parsedVitest = parseVitestProjectNames(VITEST_CONFIG_FIXTURE);
  if (parsedVitest.join(',') !== 'db,kernel') {
    failures.push(
      `parseVitestProjectNames fixture: expected ['db','kernel'], got ${JSON.stringify(parsedVitest)}`,
    );
  }
  const parsedTest = parseCiProjectList(CI_YAML_FIXTURE, 'test');
  if (parsedTest.join(',') !== 'kernel') {
    failures.push(
      `parseCiProjectList('test') fixture: expected ['kernel'], got ${JSON.stringify(parsedTest)}`,
    );
  }
  const parsedMigration = parseCiProjectList(CI_YAML_FIXTURE, 'migration-test');
  if (parsedMigration.join(',') !== 'db') {
    failures.push(
      `parseCiProjectList('migration-test') fixture: expected ['db'], got ${JSON.stringify(parsedMigration)}`,
    );
  }
  // A job block must not leak into its neighbour: 'web' names no --project at
  // all, so the boundary detection is what keeps 'migration-test's db out of it.
  const parsedWeb = parseCiProjectList(CI_YAML_FIXTURE, 'web');
  if (parsedWeb.length !== 0) {
    failures.push(
      `parseCiProjectList('web') fixture: expected [], got ${JSON.stringify(parsedWeb)}`,
    );
  }

  return failures;
}

function main(): number {
  const selfTestOnly = process.argv.includes('--self-test');

  const selfTestFailures = runSelfTest();
  if (selfTestFailures.length > 0) {
    console.error('check-ci-projects: SELF-TEST FAILED');
    for (const failure of selfTestFailures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log(
    `check-ci-projects: self-test PASS (${String(FIXTURES.length)} fixtures + 3 parser checks, ` +
      'correct state clean, every broken shape caught)',
  );

  if (selfTestOnly) return 0;

  const vitestConfigText = readFileSync(VITEST_CONFIG_PATH, 'utf8');
  const ciYamlText = readFileSync(CI_YAML_PATH, 'utf8');

  const vitestProjects = parseVitestProjectNames(vitestConfigText);
  const testJobProjects = parseCiProjectList(ciYamlText, 'test');
  const migrationJobProjects = parseCiProjectList(ciYamlText, 'migration-test');

  if (vitestProjects.length === 0) {
    console.error(
      `check-ci-projects: FAIL — parsed zero projects from ${VITEST_CONFIG_PATH}; parser is broken.`,
    );
    return 1;
  }

  const problems = checkCiProjects({ vitestProjects, testJobProjects, migrationJobProjects });

  if (problems.length > 0) {
    console.error(`check-ci-projects: FAIL — ${String(problems.length)} problem(s)\n`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  console.log(
    `check-ci-projects: PASS — all ${String(vitestProjects.length)} vitest.config.ts project(s) ` +
      `are covered by ci.yml (${String(testJobProjects.length)} in 'test', ` +
      `${String(migrationJobProjects.length)} in 'migration-test'), and every name ci.yml lists exists.`,
  );
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exit(main());
}
