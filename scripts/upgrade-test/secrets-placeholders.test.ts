// SPDX-License-Identifier: MIT
/**
 * CF-4 (WP 9.4): `scripts/secrets-placeholders.sh` — the step of `just upgrade`
 * that makes `git pull && just upgrade` from v0.1 survive the eleven file
 * secrets added since.
 *
 * Two halves:
 *  - the script's own `--self-test` (synthetic project, no root): creates only
 *    missing optional secrets, empty; never overwrites; refuses a missing or
 *    empty required one; keeps the directory 0700;
 *  - a structural cross-check between the script's REQUIRED list, the secrets
 *    `compose.yml` actually declares, and `@core/config`'s `SECRET_SPECS`: a
 *    secret declared in compose that the app *requires* must be on REQUIRED, or
 *    the script would create it empty and the stack would refuse to boot after
 *    an "upgrade" that looked clean. 09 §5 risk row 3: every new secret is
 *    optional, or unattended upgrade breaks — this is where that rule is held.
 *
 * Both need `docker compose` (the declared set is computed from
 * `docker compose config`, as compose-hardening-check.sh does).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_SPECS } from '../../packages/config/src/schema.ts';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'secrets-placeholders.sh');

/** Read REQUIRED=(...) out of the script itself, so the test cannot drift from it. */
function requiredFromScript(): string[] {
  const match = /^REQUIRED=\(([^)]*)\)$/m.exec(readFileSync(SCRIPT, 'utf8'));
  if (match === null) throw new Error('REQUIRED=(...) not found in secrets-placeholders.sh');
  return (match[1] ?? '').trim().split(/\s+/);
}

function declaredInCompose(): string[] {
  const json = execFileSync(
    'docker',
    ['compose', '--project-directory', REPO_ROOT, '--profile', '*', 'config', '--format', 'json'],
    { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const doc = JSON.parse(json) as { secrets?: Record<string, { file?: string }> };
  return Object.entries(doc.secrets ?? {})
    .filter(([, spec]) => typeof spec.file === 'string')
    .map(([name]) => name)
    .sort();
}

/** Secrets read only by the backup container, never by `@core/config`. */
const BACKUP_ONLY_OPTIONAL = new Set(['b2_key_id', 'b2_application_key']);
/** Required, but read by postgres and backup, not by `@core/config`. */
const REQUIRED_OUTSIDE_CONFIG = new Set(['pg_password', 'age_recipient']);

describe('scripts/secrets-placeholders.sh (CF-4)', () => {
  it('creates only missing optional secrets, empty; never overwrites; refuses a missing required one', () => {
    const out = execFileSync('bash', [SCRIPT, '--self-test'], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(out).toContain('SELF-TEST PASS');
  }, 60_000);

  it('REQUIRED is exactly the declared secrets the app cannot boot without; every other declared secret is optional in @core/config', () => {
    const required = requiredFromScript();
    const declared = declaredInCompose();
    // Keyed by plain string: the names come from `docker compose config`, so
    // a declared name @core/config does not know must be a lookup miss (and a
    // failed expectation below), not a type error.
    const specs = new Map<string, (typeof SECRET_SPECS)[number]>(
      SECRET_SPECS.map((spec) => [spec.file, spec]),
    );

    // Every REQUIRED name is really declared (no stale entry hiding a rename).
    for (const name of required) expect(declared, name).toContain(name);

    for (const name of declared) {
      if (required.includes(name)) {
        // Required: either something outside @core/config reads it, or the app
        // requires it for some role, or it is the database URL (env fallback is
        // dev-only; compose never sets DATABASE_URL).
        const spec = specs.get(name);
        const appRequires =
          spec !== undefined && (spec.requiredForRoles.length > 0 || name === 'database_url');
        expect(REQUIRED_OUTSIDE_CONFIG.has(name) || appRequires, `${name} on REQUIRED`).toBe(true);
        continue;
      }
      // Optional: created empty by the script, so an empty file must boot.
      if (BACKUP_ONLY_OPTIONAL.has(name)) continue;
      const spec = specs.get(name);
      expect(spec, `${name} is declared in compose.yml but unknown to @core/config`).toBeDefined();
      expect(
        spec?.requiredForRoles,
        `${name} is required by @core/config for some role — add it to REQUIRED in secrets-placeholders.sh`,
      ).toEqual([]);
    }
  }, 60_000);
});
