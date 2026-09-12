// SPDX-License-Identifier: MIT
/**
 * Argon2id benchmark for the KEK derivation (WP 0.2, evidence for D5/P0-2).
 *
 * Run: `node packages/secretbox/test/argon2-bench.ts`
 *
 * Not a test: it produces the numbers behind the parameter decision recorded in
 * `docs/evidence/phase-0/wp0.2-argon2-parameters.md`. It stays in the tree so the
 * decision is reproducible on the machine that will actually run the app.
 */
import { argon2id } from 'hash-wasm';

const PASSPHRASE = 'correct horse battery staple — benchmark only, not a real passphrase';
const SALT = new Uint8Array(32).fill(7);

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
  { memoryKiB: 2_097_152, timeCost: 4, parallelism: 4 },
];

console.log(`node ${process.version} · ${process.platform}/${process.arch}`);
console.log('| m (KiB) | m (MiB) | t | p | wall ms | result |');
console.log('| --- | --- | --- | --- | --- | --- |');

for (const c of CASES) {
  const started = process.hrtime.bigint();
  let outcome = 'ok';
  try {
    await argon2id({
      password: PASSPHRASE,
      salt: SALT,
      memorySize: c.memoryKiB,
      iterations: c.timeCost,
      parallelism: c.parallelism,
      hashLength: 32,
      outputType: 'binary',
    });
  } catch (error) {
    outcome = `FAILED: ${(error as Error).message}`;
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(
    `| ${c.memoryKiB} | ${Math.round(c.memoryKiB / 1024)} | ${c.timeCost} | ${c.parallelism} | ` +
      `${ms.toFixed(0)} | ${outcome} |`,
  );
}
