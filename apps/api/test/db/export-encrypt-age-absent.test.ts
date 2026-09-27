// SPDX-License-Identifier: MIT
/**
 * Phase 3 gate C-5 (G3-4, MEDIUM; `docs/evidence/phase-3/gate-security-review.md`
 * §2.6 T13-5b, §3.8, §6): the `age`-not-on-`PATH` branch of `encryptWithAge`
 * had no isolated test. WP 3.13's own `export-encrypt.test.ts` (regression
 * describe block) covers the *recipients-file-absent* refusal, and its
 * `age`-present describe block needs the real binary — neither exercises
 * "the recipients file exists, but `age` itself is missing", which is
 * **the exact branch the production api image took** before this condition:
 * `docker/api.Dockerfile`'s runtime stage installed `tini` only, no `age`
 * package.
 *
 * The gate's sabotage (T13-5b): `bundle.ts`'s `child.on('error', ...)`
 * handler, ENOENT case only, changed from `reject(new AgeUnavailableError(...))`
 * to `resolve(Buffer.from(plaintext))` — i.e. "`age` is missing" silently
 * downgrades to returning the plaintext bytes instead of refusing. All three
 * tests in `export-encrypt.test.ts` stayed green under that sabotage, because
 * none of them calls `encryptWithAge` with a recipients file present *and*
 * `age` absent from `PATH` in the same call — the age-present suite always
 * has `age` on `PATH` (it self-skips otherwise) and the regression test never
 * writes a recipients file at all, so `existsSync` refuses before `spawn` is
 * ever reached. This file is that missing isolation: a recipients file is
 * written, then `PATH` is emptied for the one call under test, so
 * `spawn('age', …)` genuinely cannot find the binary and the `ENOENT` branch
 * — not the "file absent" branch — is what actually runs.
 *
 * No database is needed: `encryptWithAge` touches only the filesystem and a
 * subprocess. `test/db/` only because this condition's other tests live
 * there and `apps/api/test/db/export-encrypt.test.ts` already sets the
 * precedent of testing this module from here.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('encryptWithAge refuses, never falls back to plaintext, when `age` is not on PATH (T13-5b)', () => {
  let dir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'personalfi-age-absent-'));
    // The recipients file this condition's rename settled on — see
    // `bundle.ts`'s `AgeEncryptOptions` header and `compose.yml`'s
    // `age_recipient` secret (singular, matching `docker/backup/backup.sh`'s
    // `AGE_RECIPIENTS_FILE` and every other mention in RUNBOOK.md/justfile).
    // Content is irrelevant to this test: the refusal under test happens
    // before `age` ever reads it.
    writeFileSync(join(dir, 'age_recipient'), 'age1notarealrecipientkeyforthistestonly0000000000000000000000');
    originalPath = process.env['PATH'];
    // Empty, not merely "missing age's directory": a test host that happens
    // to have `age` installed system-wide must not accidentally pass this by
    // finding a real binary anyway.
    process.env['PATH'] = '';
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects with AgeUnavailableError naming the binary, not a bare ENOENT', async () => {
    const { encryptWithAge, AgeUnavailableError } = await import('../../src/reports/export/bundle.ts');
    const plaintext = 'this must never be returned — the whole point of ?encrypt=true is that it is not';

    await expect(encryptWithAge(plaintext, { secretsDir: dir })).rejects.toThrow(AgeUnavailableError);
    await expect(encryptWithAge(plaintext, { secretsDir: dir })).rejects.toThrow(/PATH/);
  });

  it('never resolves with the plaintext bytes — the exact downgrade T13-5b sabotaged in', async () => {
    const { encryptWithAge } = await import('../../src/reports/export/bundle.ts');
    const plaintext = 'this must never be returned — the whole point of ?encrypt=true is that it is not';

    let resolved: Buffer | undefined;
    let rejected: unknown;
    try {
      resolved = await encryptWithAge(plaintext, { secretsDir: dir });
    } catch (error) {
      rejected = error;
    }
    expect(resolved, 'encryptWithAge resolved instead of rejecting — the T13-5b downgrade').toBeUndefined();
    expect(rejected).toBeDefined();
  });
});
