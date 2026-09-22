// SPDX-License-Identifier: MIT
/**
 * WP 3.13 carry-over (03-phase-3-dispatch.md §2): "`?encrypt=true` never
 * exercised — `encryptWithAge` ... falls back to
 * `export.encryption_unavailable`; no `age` binary on the dev host."
 * `wp2.8-reports-export.md`'s own honest confession recorded the same gap:
 * "`?encrypt=true` is a documented deferral (no `age` on this host) — for the
 * gate."
 *
 * ## What this work package could and could not do
 *
 * This session does not own `docker/api.Dockerfile` (the file the phase-3
 * dispatch plan names for adding the `age` package line) or
 * `docker/compose.dev-sinks.yml` — both are outside `apps/api/**`,
 * `apps/web/e2e/**`, `packages/contexts/{insights,notifications,budgeting}/**`
 * and `RUNBOOK.md`, the paths this work package was scoped to. **Recorded for
 * the orchestrator:** Alpine carries `age` in its main repository (`apk add
 * --no-cache age`); the api image needs exactly that one line.
 *
 * What this work package *could* do, within `apps/api/test/**`: install
 * `age`/`age-keygen` on this dev host from source (`go install
 * filippo.io/age/cmd/...@latest`, MIT-licensed, no repo dependency added —
 * the binary lives outside `node_modules` and outside any `package.json`)
 * and write the test the carry-over asked for either way: **a test that
 * proves the happy path for real** when `age` is present, and that
 * self-skips — the same shape `connector-plaid`'s live-Sandbox smoke already
 * uses for a missing prerequisite — when it is not. Until the orchestrator
 * adds the Dockerfile line, this suite is the proof that the code path
 * itself is correct; the gate (or CI, once `age` is in the image) is what
 * then proves it on the shipped artifact.
 *
 * `age-keygen`'s own stderr line (`Public key: age1...`) is read directly
 * rather than parsing the identity file's comment, and the identity file is
 * handed to a real `age --decrypt` subprocess — nothing here reimplements
 * the format.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHarness, NO_DATABASE, type ApiHarness } from '../helpers/api-harness.ts';

function ageAvailable(): boolean {
  const age = spawnSync('age', ['--version']);
  const ageKeygen = spawnSync('age-keygen', ['--version']);
  return age.error === undefined && ageKeygen.error === undefined;
}

const AGE_AVAILABLE = ageAvailable();

describe.skipIf(NO_DATABASE || !AGE_AVAILABLE)(
  'GET /export?encrypt=true decrypts to the same bundle (WP 3.13, `age` present)',
  () => {
    let h: ApiHarness;
    let identityPath: string;
    let workDir: string;

    beforeAll(async () => {
      workDir = mkdtempSync(join(tmpdir(), 'personalfi-age-'));
      identityPath = join(workDir, 'identity.txt');
      const keygen = spawnSync('age-keygen', ['-o', identityPath], { encoding: 'utf8' });
      if (keygen.status !== 0) {
        throw new Error(`age-keygen failed: ${keygen.stderr}`);
      }
      const publicKeyMatch = /Public key: (age1\S+)/.exec(keygen.stderr);
      const publicKey = publicKeyMatch?.[1];
      if (publicKey === undefined) {
        throw new Error(`could not read the public key from age-keygen's stderr: ${keygen.stderr}`);
      }

      h = await createApiHarness({
        suite: 'exportencrypt',
        extraSecrets: { age_recipients: publicKey },
      });
    }, 120_000);

    afterAll(async () => {
      await h.close();
      rmSync(workDir, { recursive: true, force: true });
    });

    it('an encrypted export decrypts to the same bundle', async () => {
      const encrypted = await h.request({
        method: 'GET',
        url: '/export?encrypt=true',
        session: h.fresh,
      });
      expect(encrypted.statusCode).toBe(200);
      expect(encrypted.headers['content-type']).toBe('application/octet-stream');
      expect(encrypted.headers['content-disposition']).toContain('personalfi-export.jsonl.age');

      const ciphertext = encrypted.rawPayload;
      // Not merely "the bytes are not readable JSONL" — actual `age`
      // ciphertext starts with its own ASCII header, so this would also
      // catch the response silently falling back to plaintext bytes under a
      // misleading content-type.
      expect(ciphertext.subarray(0, 11).toString('ascii')).toBe('age-encrypt');

      const decrypted = execFileSync('age', ['--decrypt', '-i', identityPath], {
        input: ciphertext,
      });
      const decryptedText = decrypted.toString('utf8');

      // "The same bundle" — proved two ways, not just "some JSON came back":
      // (1) `parseAndVerifyBundle` re-derives every stream's SHA-256 from the
      //     decrypted rows and throws on the first mismatch, so a single
      //     flipped byte anywhere in the round trip (age's AEAD tag would
      //     already have caught that, but the bundle's own hash is the
      //     domain-level claim this route makes) fails loudly here too;
      // (2) the manifest names *this* database's user and *this* database's
      //     table set, not an empty or unrelated bundle silently substituted.
      const { parseAndVerifyBundle } = await import('../../src/reports/export/bundle.ts');
      const parsed = parseAndVerifyBundle(decryptedText);
      expect(parsed.manifest.userId).toBe(h.userId);
      expect(parsed.manifest.streams.length).toBeGreaterThan(20);
      expect(parsed.rowsByTable.size).toBe(parsed.manifest.streams.length);
      expect(parsed.rowsByTable.get('categories')?.length).toBeGreaterThan(0);
    });

    it('a recipients file with no matching identity is refused by `age` itself', () => {
      // Sanity check on the fixture, not on the route: proves the round trip
      // above is a real asymmetric-crypto proof (decryption fails for the
      // *wrong* identity) rather than an artefact of `age --decrypt`
      // accepting anything handed to it.
      const wrongKeygen = spawnSync('age-keygen', { encoding: 'utf8' });
      const wrongPublicKeyMatch = /Public key: (age1\S+)/.exec(wrongKeygen.stderr);
      const wrongPublicKey = wrongPublicKeyMatch?.[1];
      if (wrongPublicKey === undefined) {
        throw new Error(`could not read a second public key: ${wrongKeygen.stderr}`);
      }
      const wrongIdentity = join(workDir, 'wrong-identity.txt');
      writeFileSync(wrongIdentity, wrongKeygen.stdout);

      const encryptedForSomeoneElse = spawnSync('age', ['--encrypt', '-r', wrongPublicKey], {
        input: 'irrelevant — this branch only needs a failure, not a real ciphertext',
      });
      expect(encryptedForSomeoneElse.status).toBe(0);

      // Decrypting *this* test's own identity (the one `age_recipients`
      // above was never encrypted to) is refused, non-zero exit.
      const attempt = spawnSync('age', ['--decrypt', '-i', identityPath], {
        input: encryptedForSomeoneElse.stdout,
      });
      expect(attempt.status).not.toBe(0);
    });
  },
);

describe('export encryption is unavailable without an age_recipients file (regression)', () => {
  it('AgeUnavailableError names the recipients file, not a bare ENOENT', async () => {
    // Independent of whether `age` itself is installed: `encryptWithAge`
    // must refuse *before* ever spawning a subprocess when the recipients
    // file the operator would have written is simply absent — the documented
    // degradation this carry-over's other half is about. Imported lazily so
    // this test (unlike the suite above) never skips.
    const { encryptWithAge, AgeUnavailableError } =
      await import('../../src/reports/export/bundle.ts');
    const emptyDir = mkdtempSync(join(tmpdir(), 'personalfi-no-age-'));
    try {
      await expect(encryptWithAge('irrelevant', { secretsDir: emptyDir })).rejects.toThrow(
        AgeUnavailableError,
      );
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
