// SPDX-License-Identifier: MIT
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Write a scratch `SECRETS_DIR` and hand its path to `fn`, cleaning up
 * afterwards whether `fn` throws or not.
 *
 * `@core/config` reads secrets from files under `SECRETS_DIR` on principle
 * (CONVENTIONS.md — "secrets from files... No secret value ever appears in an
 * error message"), never from an env var except `DATABASE_URL`'s documented
 * local-dev fallback. A test that boots the real API against `loadConfig`
 * therefore needs real files on disk, mode 0600, in a directory nothing else
 * will ever read — this is that directory.
 *
 * ```ts
 * await withTempSecretsDir({ master_key: 'unit test passphrase' }, async (secretsDir) => {
 *   const config = loadConfig({ secretsDir, env: { ...baseEnv, DATABASE_URL: url } });
 *   // ...
 * });
 * ```
 */
export async function withTempSecretsDir<T>(
  secrets: Readonly<Record<string, string>>,
  fn: (secretsDir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'personalfi-secrets-'));
  try {
    for (const [name, value] of Object.entries(secrets)) {
      await writeFile(join(dir, name), value, { mode: 0o600 });
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
