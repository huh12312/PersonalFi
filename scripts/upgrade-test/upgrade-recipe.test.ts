// SPDX-License-Identifier: MIT
/**
 * WP 9.11, G-21 (c) and (d): what the shipped `just upgrade` recipe
 * (`scripts/upgrade-test/upgrade.just`, imported by the root justfile) does
 * before it builds or starts anything.
 *
 * The real `just`, the real recipe, the real `check-isolation.sh`,
 * `secrets-placeholders.sh` and `verify-release.sh` — only `docker` is a stub
 * on PATH that logs every invocation and answers `compose config` with the
 * project name the case needs. Each case stops at the first step that needs a
 * real daemon, which is exactly the point it proves:
 *
 * - production (`personalfi-prod`) runs the isolation guard first, and the
 *   guard's refusal stops the upgrade before any placeholder, build or `up`;
 * - every other project (the upgrade test's, a gate's, a scratch install's)
 *   never runs the guard — it refuses every project but production by design;
 * - `PERSONALFI_PULL=1` verifies before anything else touches images: no
 *   release named → refused; a release that does not verify → refused, and
 *   no `compose build`, no `compose up`, no `docker pull`.
 * - WP 12.3, one image name: pull mode refuses unless compose runs exactly
 *   `<REGISTRY>/personalfi-<image>:<release>` for every PersonalFi service,
 *   and passes REGISTRY to the verifier as `--source`; `just install-release`
 *   refuses `latest` before anything runs; the build path refuses to build a
 *   published release's name.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

let dir: string;
let log: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp911-upgrade-'));
  log = join(dir, 'docker.log');
  const stub = join(dir, 'docker');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
if [ "$1 $2" = "compose version" ]; then echo "Docker Compose version v5.0.0"; exit 0; fi
if [ "$1" = compose ] && [[ " $* " == *" config "* ]]; then
  printf '{"name":"%s","services":{"api":{"image":"%s"}},"secrets":{}}\\n' "$FAKE_PROJECT" "$FAKE_IMAGE"; exit 0
fi
exit 1
`,
  );
  chmodSync(stub, 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function upgrade(env: Record<string, string>): { status: number; out: string; docker: string[] } {
  writeFileSync(log, '');
  const result = spawnSync('just', ['upgrade'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${dir}:${process.env['PATH'] ?? ''}`,
      HOME: process.env['HOME'] ?? dir,
      PERSONALFI_VERSION: 'dev',
      PERSONALFI_DEV_CHECKOUT: REPO_ROOT, // see the .env case below
      ...env,
    },
  });
  if (result.error !== undefined) {
    // A missing `just` must read as a missing `just`, never as an empty
    // transcript that fails every assertion (CI's unit-tests job did not
    // install it until 2026-10-07).
    throw new Error(`could not run \`just upgrade\`: ${result.error.message}`);
  }
  return {
    status: result.status ?? -1,
    out: `${result.stdout}${result.stderr}`,
    docker: readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

const touchedImages = (docker: string[]): string[] =>
  docker.filter((line) => /^(compose (build|up|pull)|pull |tag )/.test(line));

describe('just upgrade (G-21)', () => {
  it('production runs the isolation guard first, and its refusal stops everything', () => {
    const run = upgrade({ FAKE_PROJECT: 'personalfi-prod' });
    expect(run.status).not.toBe(0);
    expect(run.out).toContain('check-isolation: REFUSED');
    expect(run.out).not.toContain('secrets-placeholders');
    expect(touchedImages(run.docker)).toEqual([]);
  }, 60_000);

  it('the guard sees the version compose resolves (.env), not only the shell', () => {
    const run = spawnSync('just', ['upgrade'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        HOME: process.env['HOME'] ?? dir,
        FAKE_PROJECT: 'personalfi-prod',
        FAKE_IMAGE: `ghcr.io/huh12312/personalfi-api:${'b'.repeat(40)}`,
        // The guard's default "agent checkout" is this host's path; on a CI
        // runner the checkout lives elsewhere and the guard would ACCEPT it.
        // The refusal under test is the mechanism, so pin it to this checkout.
        PERSONALFI_DEV_CHECKOUT: REPO_ROOT,
      },
    });
    const out = `${run.stdout}${run.stderr}`;
    // Still refused — this is the agent checkout — but not for the version,
    // which came from compose's own resolution, not from the shell.
    expect(out).toContain('check-isolation: REFUSED');
    expect(out).not.toContain('not a 40-hex commit SHA');
    expect(out).toContain('is the agent/gate checkout');
  }, 60_000);

  it('any other project never runs the guard (the upgrade test, a gate, a scratch install)', () => {
    for (const project of ['pf-upgrade-direct', 'personalfi', 'pf-sec']) {
      const run = upgrade({ FAKE_PROJECT: project });
      expect(run.out, project).not.toContain('check-isolation');
      // It went on to the next step (which this stub cannot satisfy).
      expect(run.out, project).toContain('secrets-placeholders');
    }
  }, 60_000);
});

describe('just upgrade pull-and-verify, past the placeholders', () => {
  let secretsDir: string;
  beforeAll(() => {
    secretsDir = mkdtempSync(join(tmpdir(), 'wp911-upgrade-secrets-'));
    chmodSync(secretsDir, 0o700);
    // A stub that also answers `compose config` with one optional secret, so
    // secrets-placeholders passes and the recipe reaches the pull step, and
    // with the services' images as compose would resolve them from REGISTRY
    // and PERSONALFI_VERSION (FAKE_PROXY_IMAGE overrides one, to disagree).
    writeFileSync(
      join(dir, 'docker'),
      `#!/usr/bin/env bash
echo "$*" >> "${log}"
if [ "$1 $2" = "compose version" ]; then echo "Docker Compose version v5.0.0"; exit 0; fi
if [ "$1" = compose ] && [[ " $* " == *" config "* ]]; then
  r="\${REGISTRY:-ghcr.io/huh12312}" v="\${PERSONALFI_VERSION:-dev}"
  api="$r/personalfi-api:$v" backup="$r/personalfi-backup:$v" proxy="\${FAKE_PROXY_IMAGE:-$r/personalfi-proxy:$v}"
  yahoo=""
  # WP 12.6: the opt-in sidecar is in compose's model only with the \`yahoo\` profile on.
  if [ -n "\${FAKE_YAHOO:-}" ]; then yahoo=",\\"yahoo\\":{\\"image\\":\\"\${FAKE_YAHOO_IMAGE:-$r/personalfi-yahoo:$v}\\"}"; fi
  printf '{"name":"%s","services":{"api":{"image":"%s"},"worker":{"image":"%s"},"migrator":{"image":"%s"},"proxy":{"image":"%s"},"backup":{"image":"%s"},"pre-migrate-backup":{"image":"%s"},"db":{"image":"postgres:18"}%s},"secrets":{"opt":{"file":"%s/opt"}}}\\n' "$FAKE_PROJECT" "$api" "$api" "$api" "$proxy" "$backup" "$backup" "$yahoo" "${secretsDir}"; exit 0
fi
exit 1
`,
    );
  });
  afterAll(() => {
    rmSync(secretsDir, { recursive: true, force: true });
  });

  it('no release named: refused by name, nothing built, pulled or started', () => {
    const run = upgrade({ FAKE_PROJECT: 'pf-sec', PERSONALFI_PULL: '1' });
    expect(run.status).not.toBe(0);
    expect(run.out).toContain('PERSONALFI_PULL=1 needs PERSONALFI_RELEASE');
    expect(touchedImages(run.docker)).toEqual([]);
  }, 60_000);

  it('a release that does not verify: refused, nothing built, pulled or started', () => {
    const run = upgrade({
      FAKE_PROJECT: 'pf-sec',
      PERSONALFI_PULL: '1',
      PERSONALFI_RELEASE: '0.9.0',
      PERSONALFI_VERSION: '0.9.0',
    });
    expect(run.status).not.toBe(0);
    expect(run.out).toContain('verify-release: REFUSED');
    expect(touchedImages(run.docker)).toEqual([]);
    // Building from source is the default, never the fallback.
    expect(run.docker.some((line) => line.startsWith('compose build'))).toBe(false);
  }, 60_000);

  it('passes REGISTRY to the verifier as --source: the Docker Hub mirror is read from docker.io/masterhuh', () => {
    const run = upgrade({
      FAKE_PROJECT: 'pf-sec',
      PERSONALFI_PULL: '1',
      PERSONALFI_RELEASE: '0.9.0',
      PERSONALFI_VERSION: '0.9.0',
      REGISTRY: 'masterhuh',
    });
    expect(run.status).not.toBe(0);
    expect(run.out).toContain('pull-and-verify v0.9.0 from masterhuh');
    expect(run.docker).toContain(
      'buildx imagetools inspect docker.io/masterhuh/personalfi-api:0.9.0 --format {{json .Manifest.Digest}}',
    );
    expect(touchedImages(run.docker)).toEqual([]);
  }, 60_000);

  it('one image name: compose must run <REGISTRY>/personalfi-<image>:<release>, or nothing is verified, pulled or started', () => {
    // PERSONALFI_VERSION not the release: compose would start other bytes than the verified pull.
    const stale = upgrade({
      FAKE_PROJECT: 'pf-sec',
      PERSONALFI_PULL: '1',
      PERSONALFI_RELEASE: '0.9.0',
      PERSONALFI_VERSION: '0.8.9',
    });
    expect(stale.status).not.toBe(0);
    expect(stale.out).toContain(
      "compose runs 'ghcr.io/huh12312/personalfi-api:0.8.9', not <REGISTRY>/personalfi-api:0.9.0",
    );
    expect(stale.out).not.toContain('verify-release');
    expect(touchedImages(stale.docker)).toEqual([]);
    // One service under another name (an older compose.yml, or a typo): refused by name.
    const renamed = upgrade({
      FAKE_PROJECT: 'pf-sec',
      PERSONALFI_PULL: '1',
      PERSONALFI_RELEASE: '0.9.0',
      PERSONALFI_VERSION: '0.9.0',
      FAKE_PROXY_IMAGE: 'ghcr.io/huh12312/proxy:0.9.0',
    });
    expect(renamed.status).not.toBe(0);
    expect(renamed.out).toContain(
      "compose names 'ghcr.io/huh12312/proxy:0.9.0' for proxy; release 0.9.0 publishes 'ghcr.io/huh12312/personalfi-proxy:0.9.0'",
    );
    expect(renamed.out).not.toContain('verify-release');
    expect(touchedImages(renamed.docker)).toEqual([]);
  }, 60_000);

  it('WP 12.6: the yahoo sidecar is verified with the rest exactly when its profile is on', () => {
    const base = {
      FAKE_PROJECT: 'pf-sec',
      PERSONALFI_PULL: '1',
      PERSONALFI_RELEASE: '0.10.1',
      PERSONALFI_VERSION: '0.10.1',
    };
    const inspected = (docker: string[]): string[] =>
      docker
        .filter((line) => line.startsWith('buildx imagetools inspect '))
        .map((line) => line.split(' ')[3] ?? '');
    // Profile off: six services, three images; the sidecar is never asked for.
    const off = upgrade(base);
    expect(off.status).not.toBe(0); // the stub registry has nothing to verify
    expect(inspected(off.docker)).toEqual([
      'ghcr.io/huh12312/personalfi-api:0.10.1',
      'ghcr.io/huh12312/personalfi-backup:0.10.1',
      'ghcr.io/huh12312/personalfi-proxy:0.10.1',
    ]);
    // Profile on: the seventh service, under its published name, verified too —
    // never handed to `docker compose pull` as one of the "others".
    const on = upgrade({ ...base, FAKE_YAHOO: '1' });
    expect(on.status).not.toBe(0);
    expect(inspected(on.docker)).toContain('ghcr.io/huh12312/personalfi-yahoo:0.10.1');
    expect(on.out).toContain('FAIL yahoo: could not resolve');
    expect(touchedImages(on.docker)).toEqual([]);
    // And under another name it is refused by name, before anything is verified.
    const renamed = upgrade({ ...base, FAKE_YAHOO: '1', FAKE_YAHOO_IMAGE: 'python:3-alpine' });
    expect(renamed.status).not.toBe(0);
    expect(renamed.out).toContain(
      "compose names 'python:3-alpine' for yahoo; release 0.10.1 publishes 'ghcr.io/huh12312/personalfi-yahoo:0.10.1'",
    );
    expect(renamed.out).not.toContain('verify-release');
  }, 120_000);

  it('`just install-release latest` (or x.y) is refused before anything runs', () => {
    for (const version of ['latest', 'v0.10.0']) {
      writeFileSync(log, '');
      const result = spawnSync('just', ['install-release', version], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          HOME: process.env['HOME'] ?? dir,
          FAKE_PROJECT: 'pf-sec',
        },
      });
      const out = `${result.stdout}${result.stderr}`;
      expect(result.status, version).not.toBe(0);
      expect(out, version).toContain(
        `install-release: REFUSED: '${version}' is not a release x.y.z`,
      );
      expect(readFileSync(log, 'utf8'), version).toBe('');
    }
  }, 60_000);

  it('`just install-release x.y.z` is the pull-mode upgrade: placeholders, then the verifier, from REGISTRY', () => {
    writeFileSync(log, '');
    const result = spawnSync('just', ['install-release', '0.9.0'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        HOME: process.env['HOME'] ?? dir,
        FAKE_PROJECT: 'pf-sec',
        PERSONALFI_VERSION: '0.9.0',
        PERSONALFI_DEV_CHECKOUT: REPO_ROOT,
      },
    });
    const out = `${result.stdout}${result.stderr}`;
    const docker = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(result.status).not.toBe(0); // the stub registry has nothing to verify
    expect(out).toContain('secrets-placeholders');
    expect(out).toContain('pull-and-verify v0.9.0 from ghcr.io/huh12312');
    expect(out).toContain('verify-release: REFUSED');
    expect(touchedImages(docker)).toEqual([]);
  }, 60_000);

  it('the build path refuses to build a published release under its published name', () => {
    const run = upgrade({ FAKE_PROJECT: 'pf-sec', PERSONALFI_VERSION: '0.9.0' });
    expect(run.status).not.toBe(0);
    expect(run.out).toContain('build-name-guard: REFUSED');
    expect(run.out).toContain('ghcr.io/huh12312/personalfi-api:0.9.0');
    expect(run.docker.some((line) => line.startsWith('compose build'))).toBe(false);
  }, 60_000);

  it('without PERSONALFI_PULL the build path is unchanged', () => {
    const run = upgrade({ FAKE_PROJECT: 'pf-sec' });
    expect(run.docker.some((line) => line.startsWith('compose build'))).toBe(true);
    expect(run.out).not.toContain('verify-release');
  }, 60_000);
});
