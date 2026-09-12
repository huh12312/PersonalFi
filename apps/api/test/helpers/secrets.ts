// SPDX-License-Identifier: MIT
/**
 * A real `SECRETS_DIR` for tests.
 *
 * `master_key` became a **required** secret with WP 0.2, so every test that calls
 * `loadConfig` has to supply one. It is written to a temp directory rather than
 * injected through `loadConfig`'s `readSecret` hook because the thing under test
 * is partly the file-secret path itself: 03 §2.2 is explicit that the passphrase
 * arrives as a file and never as an environment variable, and a suite that stubs
 * the reader would pass just as happily against a build that had quietly grown an
 * `envFallback`.
 *
 * The directory is created 0700 and removed in `dispose()`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempSecrets {
  readonly dir: string;
  readonly masterKey: string;
  dispose(): void;
}

/**
 * A passphrase that is obviously a test fixture.
 *
 * Deliberately distinctive: the log-hygiene test (P0-12) greps captured output for
 * this exact string, and a generic value like `test` would match a hundred
 * innocent log lines and make the assertion meaningless.
 */
export const TEST_MASTER_KEY = 'pfi-test-master-key-9f3c2a71d4e84b06-do-not-use';

export function createTempSecrets(secrets: Readonly<Record<string, string>> = {}): TempSecrets {
  const dir = mkdtempSync(join(tmpdir(), 'personalfi-secrets-'));
  const masterKey = secrets['master_key'] ?? TEST_MASTER_KEY;
  writeFileSync(join(dir, 'master_key'), `${masterKey}\n`, { mode: 0o400 });
  for (const [name, value] of Object.entries(secrets)) {
    if (name === 'master_key') continue;
    writeFileSync(join(dir, name), `${value}\n`, { mode: 0o400 });
  }
  return {
    dir,
    masterKey,
    dispose(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
