// SPDX-License-Identifier: MIT
/**
 * `scripts/soak/check-isolation.sh --self-test` as a vitest case (WP 9.1 exit
 * test: "refuses project `personalfi`, version `dev`, and this checkout's
 * directory"), plus the three refusals and the acceptance run against the real
 * script, as a process -- never a re-implementation of its rules (C5-11).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'soak', 'check-isolation.sh');
const WRAPPER = join(REPO_ROOT, 'scripts', 'soak', 'run-report.sh');
const SHA = '0123456789abcdef0123456789abcdef01234567';

function run(args: readonly string[], env: Record<string, string> = {}) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
    timeout: 20_000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('scripts/soak/check-isolation.sh (WP 9.1 part 1)', () => {
  it("--self-test: refuses project personalfi, version dev, and this checkout's directory", () => {
    const { status, out } = run(['--self-test']);
    expect(status, out).toBe(0);
    expect(out).toContain("project 'personalfi' refused");
    expect(out).toContain("version 'dev' refused");
    expect(out).toContain("this checkout's directory refused");
    expect(out).toContain('a genuinely isolated invocation is accepted');
  }, 30_000);

  it('refuses each violation by name, all of them at once, and accepts only the isolated tuple', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'wp91-isolation-'));
    try {
      const dev = run(['personalfi', 'dev', REPO_ROOT]);
      expect(dev.status).toBe(1);
      expect(dev.out).toContain("the compose project is 'personalfi', not 'personalfi-prod'");
      expect(dev.out).toContain("PERSONALFI_VERSION is 'dev', not a 40-hex commit SHA");
      expect(dev.out).toContain('is the agent/gate checkout');

      // A scratch project is refused too: the guard is for production, and nothing else passes it.
      expect(run(['pf-prodlike', SHA, scratch]).status).toBe(1);
      // A short SHA, an upper-case SHA and an empty version are not 40 lowercase hex.
      for (const version of ['0123456', SHA.toUpperCase(), '']) {
        expect(run(['personalfi-prod', version, scratch]).status, version).toBe(1);
      }
      // Env fallbacks, as `docker compose` itself would have set them: unset means refused.
      expect(run([], { COMPOSE_PROJECT_NAME: 'personalfi-prod' }).status).toBe(1);

      const ok = run(['personalfi-prod', SHA, scratch]);
      expect(ok.status, ok.out).toBe(0);
      expect(ok.out).toContain('check-isolation: ok');
      expect(
        run([], { COMPOSE_PROJECT_NAME: 'personalfi-prod', PERSONALFI_VERSION: SHA }).status,
      ).toBe(1); // cwd is not forced: spawnSync inherits ours, which is this checkout
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
  it('run-report.sh refuses before it touches Docker: no guard pass, no --scratch outside pf-*, never personalfi or personalfi-prod', () => {
    const wrapper = (args: readonly string[], env: Record<string, string>) => {
      const result = spawnSync('bash', [WRAPPER, ...args], {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '', ...env },
        timeout: 20_000,
      });
      return { status: result.status, out: `${result.stdout}${result.stderr}` };
    };
    // Not --scratch: the production guard runs, and a scratch project is not production.
    const guarded = wrapper([], { COMPOSE_PROJECT_NAME: 'pf-prodlike', PERSONALFI_VERSION: SHA });
    expect(guarded.status).toBe(1);
    expect(guarded.out).toContain('check-isolation: REFUSED');
    // --scratch is only for pf-* projects; the dev/gate project and production are refused in this mode too.
    for (const project of ['personalfi', 'personalfi-prod', '', 'pf_x']) {
      const refused = wrapper(['--scratch'], { COMPOSE_PROJECT_NAME: project });
      expect(refused.status, project).toBe(1);
      expect(refused.out).toContain('--scratch needs COMPOSE_PROJECT_NAME matching');
    }
  }, 30_000);
});
