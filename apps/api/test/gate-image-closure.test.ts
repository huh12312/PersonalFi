// SPDX-License-Identifier: MIT
/**
 * Phase 1 security gate — the api image actually contains everything
 * `apps/api` imports, and can actually import it.
 *
 * ## The incident this pins
 *
 * `docker/api.Dockerfile`'s deploy stage prunes workspace projects outside
 * `@app/api`'s production closure. It asked pnpm which projects to **keep** (the
 * Phase 0 security gate's own fix, after `@ctx/identity` was deleted out from
 * under the auth surface) but computed which to **delete** from a hardcoded
 * two-level glob, `apps/* packages/* packages/contexts/*`, with one hand-written
 * special case for the nested `packages/contexts`.
 *
 * WP 1.2 added `packages/connectors/{port,manual,csv,plaid}`. The grouping
 * directory `packages/connectors` matched `packages/*`, is not itself a
 * workspace project and so could never appear in the keep set, and was
 * `rm -rf`'d whole. From that commit until this gate, `docker compose up`
 * produced:
 *
 * ```
 * api-1 | Cannot find package '@connector/csv' imported from /app/apps/api/src/domain.ts
 * ```
 *
 * in a restart loop. Nothing noticed for a phase, because **nothing in
 * `just check`, `just verify` or CI ever starts the image** — `just build` and
 * CI's multi-arch build both exit 0 on an image that cannot boot.
 *
 * ## Why this test, and why it is shaped like this
 *
 * The Dockerfile fix makes the delete set computed too, so a grouping directory
 * at any nesting is safe. But "the build logic is now correct" is a claim about
 * a shell loop, and the only honest way to check it is to look in the artifact.
 * So this test asks pnpm for the production closure and asserts every project in
 * it is present in the built image, then asks Node *inside the image* to import
 * the composition root — the exact import that failed.
 *
 * It **skips** when Docker or the image is unavailable, so `pnpm test` on a
 * machine that has never run `just build` is unaffected. That makes it a
 * post-build gate rather than a unit test: it should run in CI's image-build
 * job, right after the build, which is condition C-1c of the gate review.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const IMAGE = process.env['PERSONALFI_API_IMAGE'] ?? 'personalfi/api:dev';

function run(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function imageAvailable(): boolean {
  try {
    run('docker', ['image', 'inspect', IMAGE]);
    return true;
  } catch {
    return false;
  }
}

/** Every workspace project in `@app/api`'s production closure, repo-relative. */
function productionClosure(): string[] {
  const raw = run('pnpm', ['list', '--filter', '@app/api...', '--depth', '-1', '--prod', '--json']);
  const projects = JSON.parse(raw) as { path: string }[];
  const root = process.cwd().replace(/\/apps\/api$/u, '');
  return projects
    .map((project) => project.path.replace(`${root}/`, ''))
    .filter((path) => path !== root && path !== '' && !path.startsWith('/'));
}

const SKIP = !imageAvailable();

describe.skipIf(SKIP)(`api image closure (${IMAGE})`, () => {
  it('contains every workspace project apps/api needs at runtime', () => {
    const expected = productionClosure();
    // Guard against the query returning nothing and the assertion below
    // vacuously passing over an empty list.
    expect(expected.length).toBeGreaterThanOrEqual(5);
    expect(expected).toContain('apps/api');

    const listed = run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      IMAGE,
      '-c',
      // One `ls` per path; print the path when it resolves, nothing when it does not.
      expected.map((path) => `[ -d /app/${path} ] && echo ${path}`).join('; ') + '; true',
    ])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const missing = expected.filter((path) => !listed.includes(path));
    expect(
      missing,
      `pruned out of the image but required at runtime: ${missing.join(', ')}`,
    ).toEqual([]);
    // `pnpm list` over the whole closure plus one container start: past the
    // 5 s default on CI's runner once Phase 3 added four more workspace
    // projects (red on 5cfb90b at exactly the default).
  }, 60_000);

  it('can import the composition root inside the image', () => {
    // The exact failure: `domain.ts` is what pulls in every connector and every
    // bounded context, and it is the first thing `main.ts` reaches.
    const output = run('docker', [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      IMAGE,
      '-e',
      "import('/app/apps/api/src/domain.ts').then(()=>console.log('IMPORT_OK'),e=>{console.log('IMPORT_FAIL '+e.message);process.exitCode=1;});",
    ]);
    expect(output).toContain('IMPORT_OK');
    expect(output).not.toContain('IMPORT_FAIL');
  }, 60_000);
});
