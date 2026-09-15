// SPDX-License-Identifier: MIT
/**
 * Phase 1 security gate — "a file-only secret is never readable from the
 * environment", asserted for *every* file-only secret rather than for the one
 * that happened to get a test.
 *
 * ## Why this file exists
 *
 * `master_key` has had this test since WP 0.2 (`load.test.ts`, "never read from
 * the environment"). WP 1.3b then added three more file-only secrets —
 * `plaid_client_id`, `plaid_secret`, `plaid_env` — each carrying
 * `envFallback: undefined` and a doc comment explaining, correctly and at
 * length, that an env-var escape hatch is "exactly the leak surface 01 §1.10
 * warns about (`docker inspect`, crash dumps, child processes)".
 *
 * The gate sabotaged that claim by giving `plaid_secret` an
 * `envFallback: 'PLAID_SECRET'` and running the whole `config` project:
 *
 * ```
 * $ pnpm exec vitest run --project config
 *       Tests  67 passed (67)
 * ```
 *
 * Sixty-seven green tests while a Plaid API secret was readable from the
 * process environment. The rule was documentation, not a control.
 *
 * ## What it asserts, and why it is data-driven
 *
 * A per-secret test would have to be remembered for secret number five. This
 * derives its cases from `SECRET_SPECS` itself, so a new file-only secret is
 * covered the moment it is declared, and a future `envFallback` added to one of
 * them fails here rather than shipping.
 *
 * Two independent layers, because either alone is weak:
 *
 *  1. **Structural** — the spec says `envFallback: undefined`. Catches the
 *     declaration changing.
 *  2. **Behavioural** — `loadConfig` with the value *only* in `env`, under the
 *     obvious variable name, does not pick it up. Catches the loader growing a
 *     second, spec-independent path to the environment (a `process.env` read in
 *     `resolvePlaid`, say), which the structural check alone cannot see.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from './load.ts';
import { SECRET_SPECS } from './schema.ts';

const VALID_URL = 'postgres://app:hunter2@db:5432/personalfi';
const MASTER_KEY = 'pfi-gate-custody-kek-9d2a4f71-do-not-use';
/** Distinctive enough that finding it anywhere in the config means something. */
const PLANTED = 'pfi-gate-planted-from-env-5e8c1b2d-do-not-use';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', DATABASE_URL: VALID_URL, SECRETS_DIR: '/nonexistent', ...overrides };
}

function secretsFrom(files: Record<string, string | undefined>): (path: string) => string {
  const resolved: Record<string, string | undefined> = { master_key: MASTER_KEY, ...files };
  return (path: string) => {
    const name = path.split('/').pop() ?? '';
    const value = resolved[name];
    if (value === undefined) {
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return value;
  };
}

/** Every secret the schema declares as file-only. */
const FILE_ONLY = SECRET_SPECS.filter((spec) => spec.envFallback === undefined);

describe('file-only secret custody (D5 / 01 §1.10)', () => {
  it('has file-only secrets to check, and they include every plaid_* one', () => {
    // Guards against the list silently becoming empty and the suite below
    // turning into zero assertions that report as green.
    const names = FILE_ONLY.map((spec) => spec.name);
    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(names).toContain('master_key');
    expect(names).toContain('plaid_client_id');
    expect(names).toContain('plaid_secret');
    expect(names).toContain('plaid_env');
  });

  describe.each(FILE_ONLY.map((spec) => [spec.name] as const))('%s', (name) => {
    it('declares no env fallback', () => {
      const spec = SECRET_SPECS.find((candidate) => candidate.name === name);
      expect(spec).toBeDefined();
      expect(spec?.envFallback).toBeUndefined();
    });

    it('is not picked up from the environment under its own upper-cased name', () => {
      // `PLAID_SECRET`, `MASTER_KEY`, ... — the name an operator would reach for
      // first, and the one `envFallback` would have used.
      const variable = name.toUpperCase();
      let config: ReturnType<typeof loadConfig> | undefined;
      try {
        config = loadConfig({
          env: env({ [variable]: PLANTED }),
          // Nothing on disk for this secret. `master_key` keeps its file so the
          // other cases are about the secret they name and not about the KEK.
          readSecret: secretsFrom(name === 'master_key' ? { master_key: undefined } : {}),
        });
      } catch {
        // Refusing to boot is a correct outcome for a *required* file-only
        // secret whose file is absent (master_key). What must never happen is
        // booting with the environment's value in hand.
        return;
      }

      const serialised = JSON.stringify(config);
      expect(serialised).not.toContain(PLANTED);
      // Plaid specifically: the env value must not have been enough to make the
      // connector configurable. `config.plaid` is the feature-detect flag the
      // composition root registers the adapter on.
      if (name.startsWith('plaid_')) expect(config?.plaid).toBeNull();
    });
  });

  it('does not configure Plaid from a full set of environment variables', () => {
    // The end-to-end shape of the mistake: an operator (or a compose file that
    // took the easy route out of the missing-secrets gap this gate found in
    // §2.2 of the review) sets all three as env vars. Plaid must stay off.
    const config = loadConfig({
      env: env({
        PLAID_CLIENT_ID: PLANTED,
        PLAID_SECRET: PLANTED,
        PLAID_ENV: 'production',
        PLAID_ALLOW_PRODUCTION: 'true',
      }),
      readSecret: secretsFrom({}),
    });
    expect(config.plaid).toBeNull();
    expect(JSON.stringify(config)).not.toContain(PLANTED);
  });
});
