// SPDX-License-Identifier: MIT
/**
 * WP 4.11's golden-vector pair, server half — `docs/plan/04-phase-4-dispatch.md`
 * §3 "WP 4.11": "a golden-vector fixture asserted identical by both the client
 * worker and the server engine for one seed, committed once and read by both
 * suites."
 *
 * `test/fixtures/golden-vector.json` was produced **once**, by this engine,
 * running `runMonteCarlo` + `serialiseResult` over a lognormal-engine job with
 * no crypto and no Social Security/pension/other income (`policy:
 * 'constant_real'`) — exactly the subset `apps/web/src/workers/kernel/*.ts`'s
 * scoped port models (see that directory's `deterministic.ts` header). It is
 * **one file, read by both suites** (the dispatch's own words: "committed
 * once and read by both suites") — `apps/web/src/workers/projection.worker.test.ts`
 * reads this exact path from the web package by a relative `fs` read, not a
 * copy, so there is no second file to drift out of sync. This test is the
 * **server** half of the pair: it rebuilds the job from the fixture's own
 * committed inputs and asserts this engine reproduces the fixture's committed
 * digest byte-for-byte. The **client** half is that same file's
 * `'the client worker reproduces the committed golden vector for its seed'` —
 * neither test alone proves the two engines agree; both passing does.
 *
 * Regenerating the fixture (only if this engine's Monte Carlo kernel
 * deliberately changes — `MONTE_CARLO_VERSION`/`ENGINE_VERSION` should bump
 * too): re-run the job below through `runMonteCarlo` + `serialiseResult` and
 * recompute the SHA-256 into this one committed file — both suites pick up
 * the change automatically since both read it, so there is nothing else to
 * mirror.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  runMonteCarlo,
  serialiseResult,
  type EngineCorrelation,
  type MonteCarloJob,
} from '../src/engine/montecarlo.ts';
import type { EnginePlan } from '../src/engine/deterministic.ts';

interface GoldenVectorFixture {
  readonly seed: string;
  readonly paths: number;
  readonly plan: EnginePlan;
  readonly volatility: {
    readonly equity: number;
    readonly bond: number;
    readonly inflation: number;
  };
  readonly correlation: EngineCorrelation;
  readonly extra: { readonly annual: number; readonly untilAge: number };
  readonly expected: {
    readonly successCount: number;
    readonly bytesLength: number;
    readonly sha256: string;
    readonly bytesBase64: string;
  };
}

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/golden-vector.json', import.meta.url));

function loadFixture(): GoldenVectorFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GoldenVectorFixture;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * `no-restricted-imports` forbids `node:crypto` outside `@core/secretbox`
 * (`scripts/eslint-boundaries.js`'s "cryptography chokepoint"), and this
 * package does not declare `@core/secretbox` as a dependency — so this uses
 * the **global** Web Crypto `crypto.subtle` (a Node global since Node 19, no
 * import at all, so the restriction does not apply) instead, the same API
 * `apps/web/src/workers/projection.worker.test.ts`'s client half uses for the
 * identical reason (see that file's header).
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Same generic-`ArrayBufferLike`-vs-`ArrayBuffer` type-level gap as
  // `apps/web/src/workers/projection.worker.test.ts`'s identical helper (see that file's
  // comment) — `BufferSource` itself is not a name this package's DOM-less `lib` declares, so
  // the digest call's own second-parameter type stands in for it instead.
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes as unknown as Parameters<typeof crypto.subtle.digest>[1],
  );
  return toHex(digest);
}

function jobFrom(fixture: GoldenVectorFixture): MonteCarloJob {
  return {
    plan: fixture.plan,
    engine: 'lognormal',
    series: null,
    volatility: fixture.volatility,
    correlation: fixture.correlation,
    // The fixture's plan holds no crypto (`holding: 0`) — the client kernel
    // models no crypto sleeve at all, so this is the only crypto config the
    // pair can ever agree over.
    crypto: { holding: 0, expectedNominal: 0, volatility: 0, degreesOfFreedom: 3 },
    seed: BigInt(fixture.seed),
    paths: fixture.paths,
    extra: fixture.extra,
  };
}

describe('WP 4.11 golden vector — server half', () => {
  it('the server engine reproduces the same committed golden vector', async () => {
    const fixture = loadFixture();
    const job = jobFrom(fixture);

    const result = runMonteCarlo(job);
    const bytes = serialiseResult(result);
    const sha256 = await sha256Hex(bytes);

    // Print both digests — this is the pair the evidence doc's §1 table quotes.
    console.log(`server sha256:   ${sha256}`);
    console.log(`fixture sha256:  ${fixture.expected.sha256}`);

    expect(result.successCount).toBe(fixture.expected.successCount);
    expect(bytes.length).toBe(fixture.expected.bytesLength);
    expect(Buffer.from(bytes).toString('base64')).toBe(fixture.expected.bytesBase64);
    expect(sha256).toBe(fixture.expected.sha256);
  });

  it('a different seed produces a different digest (the check is not vacuous)', async () => {
    const fixture = loadFixture();
    const job = jobFrom(fixture);
    const mutated: MonteCarloJob = { ...job, seed: job.seed + 1n };

    const result = runMonteCarlo(mutated);
    const bytes = serialiseResult(result);
    const sha256 = await sha256Hex(bytes);

    expect(sha256).not.toBe(fixture.expected.sha256);
  });
});
