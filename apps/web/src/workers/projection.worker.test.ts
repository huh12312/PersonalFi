// SPDX-License-Identifier: MIT
/**
 * WP 4.11's golden-vector pair, client half —
 * `docs/plan/04-phase-4-dispatch.md` §3 "WP 4.11": "a golden-vector fixture
 * asserted identical by both the client worker and the server engine for one
 * seed, committed once and read by both suites."
 *
 * The fixture is `packages/contexts/planning/test/fixtures/golden-vector.json`
 * — **one committed file**, produced once by the server engine
 * (`packages/contexts/planning/test/golden-vector.test.ts`'s own header has
 * the detail), imported here as a plain JSON module rather than copied
 * (`apps/web` does not depend on `@ctx/planning` — see `./kernel/prng.ts`'s
 * header for why the kernel is a port, not an import) so there is exactly one
 * file to keep in sync, not two. A `node:fs` read of the same path was tried
 * first and reverted: `apps/web/tsconfig.app.json` deliberately carries no
 * Node ambient types (`types: ["vite/client"]` only — this project is
 * browser code), so `node:fs`/`node:crypto`/`Buffer` fail `tsc -b --noEmit`
 * here even though they run fine under `vitest`. A JSON import needs none of
 * that, and Web Crypto (`crypto.subtle`) plus `btoa` below replace
 * `node:crypto` and `Buffer` with the same browser-native APIs
 * `./projection.worker.ts` itself is restricted to.
 *
 * This test runs `./kernel/montecarlo.ts` — the same kernel
 * `./projection.worker.ts`'s `run`/`warmUp` call — directly against the
 * fixture's committed job and asserts the serialised bytes and their SHA-256
 * match the fixture's committed digest exactly. It does not go through a real
 * `Worker`/Comlink round trip (`happy-dom` has no `Worker` implementation to
 * drive one in-process); that boundary is exercised for real by
 * `apps/web/e2e/plan-sliders.spec.ts` in an actual browser. What matters for
 * byte-identity is the kernel this file runs, which is exactly what the
 * worker calls.
 */
import { describe, expect, it } from 'vitest';

import type { EnginePlan, ExtraContribution } from './kernel/deterministic.ts';
import { runMonteCarlo, serialiseResult, type EngineCorrelation } from './kernel/montecarlo.ts';
import { toBands } from './projection.worker.ts';
// The one committed golden-vector fixture, read (not copied) by both suites; see this file's header.
import fixtureJson from '../../../../packages/contexts/planning/test/fixtures/golden-vector.json';

interface GoldenVectorFixture {
  readonly seed: string;
  readonly paths: number;
  readonly plan: EnginePlan & {
    // Present in the fixture (the server's `EnginePlan` carries them) but not
    // part of the client kernel's own `EnginePlan` type — harmless extra
    // properties on the parsed JSON, simply unread here.
    readonly socialSecurity?: unknown;
    readonly socialSecurityRules?: unknown;
    readonly pensions?: unknown;
    readonly otherIncome?: unknown;
  };
  readonly volatility: {
    readonly equity: number;
    readonly bond: number;
    readonly inflation: number;
  };
  readonly correlation: EngineCorrelation;
  readonly extra: ExtraContribution;
  readonly expected: {
    readonly successCount: number;
    readonly bytesLength: number;
    readonly sha256: string;
    readonly bytesBase64: string;
  };
}

const fixture = fixtureJson as unknown as GoldenVectorFixture;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `serialiseResult`'s `Uint8Array` is generic over `ArrayBufferLike` (TS's current DOM lib);
  // `SubtleCrypto.digest` wants one backed specifically by `ArrayBuffer`, which this one always
  // is in practice (never a `SharedArrayBuffer`) — a type-level gap, not a runtime one.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return toHex(digest);
}

describe('WP 4.11 golden vector — client half', () => {
  it('the client worker reproduces the committed golden vector for its seed', async () => {
    const job = {
      plan: fixture.plan,
      volatility: fixture.volatility,
      correlation: fixture.correlation,
      seed: BigInt(fixture.seed),
      paths: fixture.paths,
      extra: fixture.extra,
    };

    const result = runMonteCarlo(job);
    const bytes = serialiseResult(result);
    const sha256 = await sha256Hex(bytes);

    // Both digests, printed — the evidence doc's §1 table quotes this line and the server test's.
    console.log(`client sha256:   ${sha256}`);
    console.log(`fixture sha256:  ${fixture.expected.sha256}`);

    expect(result.successCount).toBe(fixture.expected.successCount);
    expect(bytes.length).toBe(fixture.expected.bytesLength);
    expect(toBase64(bytes)).toBe(fixture.expected.bytesBase64);
    expect(sha256).toBe(fixture.expected.sha256);
  });

  it('a different seed produces a different digest (the check is not vacuous)', async () => {
    const job = {
      plan: fixture.plan,
      volatility: fixture.volatility,
      correlation: fixture.correlation,
      seed: BigInt(fixture.seed) + 1n,
      paths: fixture.paths,
      extra: fixture.extra,
    };

    const result = runMonteCarlo(job);
    const bytes = serialiseResult(result);
    const sha256 = await sha256Hex(bytes);

    expect(sha256).not.toBe(fixture.expected.sha256);
  });

  it("the worker's own reply carries bands sized levels × years, never a per-path array", () => {
    // `toBands` is the exact function `./projection.worker.ts`'s `run`/`warmUp` call — this is
    // dispatch §3's "never paths across the boundary", made a direct, sabotage-testable claim
    // about the worker's own reply shape rather than an inference from the kernel's own tests.
    const job = {
      plan: fixture.plan,
      volatility: fixture.volatility,
      correlation: fixture.correlation,
      seed: BigInt(fixture.seed),
      paths: fixture.paths,
      extra: fixture.extra,
    };

    const bands = toBands(job);

    expect(bands.bands).toBeInstanceOf(Float32Array);
    expect(bands.bands.length).toBe(bands.levels.length * bands.years);
    // A per-path leak would be paths × years (or paths × years × levels) doubles — orders of
    // magnitude larger than levels × years here (7 × 35 = 245 vs. 1000 × 35 = 35,000).
    expect(bands.bands.length).toBeLessThan(bands.paths * bands.years);
  });
});
