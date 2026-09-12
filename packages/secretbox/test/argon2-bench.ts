// SPDX-License-Identifier: MIT
/**
 * Argon2id benchmark for the KEK derivation (WP 0.2, evidence for D5/P0-2).
 *
 * Run: `node packages/secretbox/test/argon2-bench.ts`
 *
 * Not a test: it produces the numbers behind the parameter decision recorded in
 * `docs/evidence/phase-0/wp0.2-argon2-parameters.md`. It stays in the tree so the
 * decision is reproducible on the machine that will actually run the app.
 *
 * It calls `deriveKek` rather than `hash-wasm` directly, and that is not a
 * formality. The chokepoint rule says `hash-wasm` may be imported in exactly one
 * file (`src/primitives.ts`) and `eslint.config.js` enforces it with no exemption
 * for tests — deliberately, because "it is only a benchmark" is how a second call
 * site gets in. Going through `deriveKek` also means the numbers below measure the
 * code path the application actually runs, salt validation included, rather than a
 * parallel invocation that could drift from it.
 */
import { deriveKek, KEK_MAX_MEMORY_KIB, KEK_SALT_BYTES } from '../src/kek.ts';
import { wipe } from '../src/primitives.ts';

const PASSPHRASE = 'correct horse battery staple — benchmark only, not a real passphrase';
const SALT = new Uint8Array(KEK_SALT_BYTES).fill(7);

interface Case {
  readonly memoryKiB: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

const CASES: Case[] = [
  { memoryKiB: 19_456, timeCost: 2, parallelism: 1 }, // OWASP password-storage minimum
  { memoryKiB: 65_536, timeCost: 3, parallelism: 4 },
  { memoryKiB: 131_072, timeCost: 4, parallelism: 4 },
  { memoryKiB: 262_144, timeCost: 4, parallelism: 4 },
  { memoryKiB: 524_288, timeCost: 4, parallelism: 4 },
  { memoryKiB: 1_048_576, timeCost: 4, parallelism: 4 }, // 03 §2.2 target: 1 GiB
  { memoryKiB: KEK_MAX_MEMORY_KIB, timeCost: 4, parallelism: 4 }, // 1.75 GiB ceiling
  { memoryKiB: 2_097_152, timeCost: 4, parallelism: 4 }, // expected to fail on wasm32
];

console.log(`node ${process.version} · ${process.platform}/${process.arch}`);
console.log('| m (KiB) | m (MiB) | t | p | wall ms | result |');
console.log('| --- | --- | --- | --- | --- | --- |');

for (const c of CASES) {
  const started = performance.now();
  let outcome = 'ok';
  try {
    const derived = await deriveKek(PASSPHRASE, SALT, c, () => performance.now());
    // The bench holds a real 32-byte key for the length of one loop iteration.
    // Zero it like any other: a benchmark is not an excuse to leave key material
    // on the heap.
    wipe(derived.key);
  } catch (error) {
    outcome = `FAILED: ${(error as Error).message}`;
  }
  const ms = performance.now() - started;
  console.log(
    `| ${c.memoryKiB} | ${Math.round(c.memoryKiB / 1024)} | ${c.timeCost} | ${c.parallelism} | ` +
      `${ms.toFixed(0)} | ${outcome} |`,
  );
}
