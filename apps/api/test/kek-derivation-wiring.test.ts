// SPDX-License-Identifier: MIT
/**
 * WP 9.11 (09 §6 Q9): every shipped place that derives the KEK does it inside
 * `@ctx/identity`'s `withKekDerivationLock`, so a cold `up` never runs the
 * api's and the worker's 1 GiB Argon2 derivations at the same moment (WP 9.9:
 * 2.31–2.43 GiB for ~3.4 s, the only window over 2 GiB).
 *
 * A source assertion, for the reason `assumptions-boot.test.ts` gives: the
 * claim is about what each composition root says, and reproducing a real boot
 * needs a 1 GiB derivation per process. The lock itself is proved against
 * Postgres in `@ctx/identity`'s `kek-derivation-lock.test.ts`; the memory peak
 * on a real cold boot is in docs/evidence/phase-9/wp9.11-security-fixes.md.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repoFile = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

/** Code only: comments are where a removed call would still be "mentioned". */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const DERIVING_FILES = [
  'apps/api/src/auth/runtime.ts',
  'apps/api/src/worker.ts',
  'apps/api/src/bin/bootstrap-user.ts',
] as const;

describe('every KEK derivation in shipped code runs under the derivation lock', () => {
  for (const file of DERIVING_FILES) {
    it(`${file}: each .unlock( is the body of withKekDerivationLock(`, () => {
      const source = code(repoFile(file));
      const unlocks = [...source.matchAll(/\.unlock\(/g)].map((match) => match.index ?? 0);
      expect(unlocks.length, `${file} no longer derives the KEK?`).toBeGreaterThan(0);
      for (const at of unlocks) {
        const before = source.slice(Math.max(0, at - 240), at);
        expect(before, `${file}: an unlock( outside withKekDerivationLock(`).toMatch(
          /withKekDerivationLock\([^;]*$/,
        );
      }
    });
  }

  it('no other shipped api file derives the KEK', () => {
    // The composition roots that may derive are named above; a new one must
    // join the list (and the lock), not appear silently.
    const candidates = [
      'apps/api/src/main.ts',
      'apps/api/src/app.ts',
      'apps/api/src/domain.ts',
      'apps/api/src/modules.ts',
      'apps/api/src/platform.ts',
    ];
    for (const file of candidates) {
      expect(code(repoFile(file)), file).not.toMatch(/\bSecretBox\b[\s\S]*\.unlock\(/);
    }
  });
});
