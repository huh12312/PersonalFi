// SPDX-License-Identifier: MIT
/**
 * WP 4.4 — the engine's numeric boundary (dispatch §3 exit tests; §5 risk 1).
 *
 *   * `'Money survives a round trip through the engine boundary for every
 *     amount up to 1e15 minor units'` — fast-check, both directions: Money →
 *     engine → Money is the identity, and an exact-cent engine figure → Money →
 *     engine is the identity; an arbitrary float is rounded **once**, to within
 *     half a minor unit, and re-rounding changes nothing.
 *   * `'the engine interior is reachable only through toEngineAmount and
 *     fromEngineAmount'` — the 3.5 `no-trade-surface` pattern: a grep over
 *     `src/engine/**` (comments stripped) that no file but `boundary.ts` calls
 *     the pair, reads `.minor`, calls `Number()`/`parseFloat`/`BigInt()`/
 *     `toFixed`, value-imports the kernel or spells an identifier like a
 *     magnitude — and a planted violation proves the grep is not vacuous.
 *
 * Lives in `src/engine/` rather than `test/engine/` only because the `planning`
 * vitest project's `include` is `src/**` + `test/*.test.ts` (see the WP 4.4
 * evidence, "For the orchestrator").
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Money, currency } from '@core/kernel';
import { loadAssumptions } from '../assumptions.ts';
import {
  ProjectionInputRefused,
  fromEngineAmount,
  fromEngineRatio,
  toEngineAmount,
  toEngineRate,
  toProjectionResult,
  toEnginePlan,
  type ProjectionPlan,
} from './boundary.ts';
import { preparePlan, runDeterministic } from './deterministic.ts';
import { referencePlan } from '../../test/engine/support.ts';

const USD = currency('USD');
const JPY = currency('JPY');
const KWD = currency('KWD');
const LIMIT = 1_000_000_000_000_000n; // 1e15 minor units

describe('the named pair', () => {
  it('Money survives a round trip through the engine boundary for every amount up to 1e15 minor units', () => {
    // Direction 1: Money → engine → Money, for three minor-unit scales (2, 0, 3).
    fc.assert(
      fc.property(
        fc.bigInt({ min: -LIMIT, max: LIMIT }),
        fc.constantFrom(USD, JPY, KWD),
        (minor, code) => {
          const original = Money.of(minor, code);
          const back = fromEngineAmount(toEngineAmount(original, code), code);
          expect(back.minor).toBe(minor);
          expect(back.currency).toBe(code);
        },
      ),
      { numRuns: 2000 },
    );
    // …including the edges exactly.
    for (const minor of [LIMIT, -LIMIT, 0n, 1n, -1n, 5n, 99n]) {
      expect(fromEngineAmount(toEngineAmount(Money.of(minor, USD), USD), USD).minor).toBe(minor);
    }

    // Direction 2: an exact-cent engine figure → Money → engine is the identity.
    fc.assert(
      fc.property(fc.bigInt({ min: -LIMIT, max: LIMIT }), (cents) => {
        const dollars = Number(cents) / 100;
        const money = fromEngineAmount(dollars, USD);
        expect(money.minor).toBe(cents);
        expect(toEngineAmount(money, USD)).toBe(dollars);
      }),
      { numRuns: 2000 },
    );

    // Any float in range is rounded ONCE: within half a cent, and idempotent.
    fc.assert(
      fc.property(fc.double({ min: -1e13, max: 1e13, noNaN: true }), (dollars) => {
        const once = fromEngineAmount(dollars, USD);
        expect(Math.abs(Number(once.minor) - dollars * 100)).toBeLessThanOrEqual(0.5);
        const twice = fromEngineAmount(toEngineAmount(once, USD), USD);
        expect(twice.minor).toBe(once.minor);
      }),
      { numRuns: 2000 },
    );
  });

  it('rounds half to even, exactly once, on exactly representable halves', () => {
    // 0.125, 0.375, 0.625 are exact binary fractions, so ×100 is an exact .5.
    expect(fromEngineAmount(0.125, USD).minor).toBe(12n);
    expect(fromEngineAmount(0.375, USD).minor).toBe(38n);
    expect(fromEngineAmount(0.625, USD).minor).toBe(62n);
    expect(fromEngineAmount(-0.125, USD).minor).toBe(-12n);
    expect(fromEngineAmount(2.5, JPY).minor).toBe(2n);
    expect(fromEngineAmount(3.5, JPY).minor).toBe(4n);
  });

  it('refuses what cannot cross exactly, and never clamps it', () => {
    const tooBig = Money.of(BigInt(Number.MAX_SAFE_INTEGER) + 1n, USD);
    for (const attempt of [
      () => toEngineAmount(tooBig, USD),
      () => toEngineAmount(Money.of(1n, 'EUR'), USD),
      () => fromEngineAmount(Number.NaN, USD),
      () => fromEngineAmount(Number.POSITIVE_INFINITY, USD),
      () => fromEngineAmount(1e14, USD),
      () => toEngineRate('0.065%'),
      () => toEngineRate('1e-3'),
      () => fromEngineRatio(Number.NaN),
    ]) {
      expect(attempt).toThrow(ProjectionInputRefused);
    }
    expect(() => toEngineAmount(Money.of(1n, 'EUR'), USD)).toThrow(/currency|EUR/);
  });

  it('a result re-enters as Money rounded once from its float, never re-summed from rounded parts', () => {
    const plan: ProjectionPlan = referencePlan('B');
    const assumptions = loadAssumptions();
    const prepared = preparePlan(toEnginePlan(plan, assumptions));
    const path = runDeterministic(prepared);
    const result = toProjectionResult(path, prepared, plan, assumptions, 'real');
    path.records.forEach((record, index) => {
      const total = record.endWealth.reduce((sum, bucket) => sum + bucket, 0);
      expect(result.years[index]?.endWealth).toEqual(fromEngineAmount(total, USD));
      // Year t's end and year t+1's start are the same float, so the same Money.
      const next = result.years[index + 1];
      if (next !== undefined) expect(next.startWealth).toEqual(result.years[index]?.endWealth);
    });
  });
});

// ---------------------------------------------------------------------------
// The structural half
// ---------------------------------------------------------------------------

const ENGINE = dirname(fileURLToPath(import.meta.url));

/** Every non-test `.ts` under `src/engine/`. */
function engineSources(): readonly { readonly name: string; readonly code: string }[] {
  return readdirSync(ENGINE)
    .filter((name) => name.endsWith('.ts') && !name.includes('.test'))
    .sort()
    .map((name) => ({ name, code: codeOnly(readFileSync(join(ENGINE, name), 'utf8')) }));
}

/** Strip comments and string/template literals, keeping code (the coinbase test's rule, plus strings). */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

const MAGNITUDE = /amount|balance|price|value|cost|quantity/i;

/** What a file other than `boundary.ts` may not contain. Each rule returns the offending text. */
const INTERIOR_RULES: readonly (readonly [string, (code: string) => readonly string[]])[] = [
  [
    'calls toEngineAmount/fromEngineAmount',
    (code) => [...code.matchAll(/\b(?:to|from)EngineAmount\s*\(/g)].map((m) => m[0]),
  ],
  ['reads .minor', (code) => [...code.matchAll(/\.minor\b/g)].map((m) => m[0])],
  [
    'converts with Number()/parseFloat/parseInt/BigInt()/toFixed',
    (code) =>
      [...code.matchAll(/\b(?:Number|parseFloat|parseInt|BigInt)\s*\(|\.toFixed\s*\(/g)].map(
        (m) => m[0],
      ),
  ],
  [
    'spells an identifier like a magnitude',
    (code) =>
      [...code.matchAll(/\b[A-Za-z_$][\w$]*\b/g)]
        .map((m) => m[0])
        .filter((word) => MAGNITUDE.test(word) && word !== 'EngineDollars'),
  ],
];

/** Raw-text rule: no non-type import from the kernel or the assumptions file outside boundary.ts. */
function valueImports(raw: string): readonly string[] {
  return [
    ...raw.matchAll(/import\s+(?!type\s)([^;]*?)from\s*'(@core\/kernel|\.\.\/assumptions\.ts)'/g),
  ]
    .filter((match) => {
      // `import { type A, type B } from …` is type-only in effect.
      const names = (match[1] ?? '')
        .replace(/[{}\s]/g, '')
        .split(',')
        .filter(Boolean);
      return names.some((name) => !name.startsWith('type'));
    })
    .map((match) => match[0]);
}

function violationsOf(name: string, code: string, raw: string): string[] {
  const found: string[] = [];
  if (name === 'boundary.ts') return found;
  for (const [rule, check] of INTERIOR_RULES) {
    for (const hit of check(code)) found.push(`${name}: ${rule}: ${hit}`);
  }
  for (const hit of valueImports(raw)) found.push(`${name}: value-imports: ${hit}`);
  return found;
}

describe('the interior', () => {
  it('the engine interior is reachable only through toEngineAmount and fromEngineAmount', () => {
    const sources = engineSources();
    const names = sources.map((source) => source.name);
    // The files this WP owns are all here — a rename cannot quietly drop one from the scan.
    for (const expected of [
      'boundary.ts',
      'deterministic.ts',
      'glidepath.ts',
      'guardrails.ts',
      'index.ts',
      'pension.ts',
      'project.ts',
      'social-security.ts',
      'solve.ts',
    ]) {
      expect(names).toContain(expected);
    }

    const violations = sources.flatMap(({ name, code }) =>
      violationsOf(
        name,
        name === 'index.ts' ? code.replace(/\b(?:to|from)EngineAmount\b(?!\s*\()/g, '') : code,
        readFileSync(join(ENGINE, name), 'utf8'),
      ),
    );
    expect(violations).toEqual([]);

    // The pair is defined in boundary.ts, exactly once each, and called there.
    const boundary = sources.find((source) => source.name === 'boundary.ts')?.code ?? '';
    expect(boundary.match(/export function toEngineAmount\(/g)).toHaveLength(1);
    expect(boundary.match(/export function fromEngineAmount\(/g)).toHaveLength(1);
    expect((boundary.match(/\bfromEngineAmount\s*\(/g) ?? []).length).toBeGreaterThan(1);
    expect((boundary.match(/\btoEngineAmount\s*\(/g) ?? []).length).toBeGreaterThan(1);

    // index.ts only re-exports.
    const index = sources.find((source) => source.name === 'index.ts')?.code ?? '';
    expect(index).not.toMatch(/\bfunction\b|=>|\bconst\b|\blet\b/);
  });

  it('the grep is not vacuous: each planted violation is caught', () => {
    const planted: readonly (readonly [string, string])[] = [
      ['const x = toEngineAmount(m, USD);', 'calls toEngineAmount'],
      ['const cents = m.minor;', 'reads .minor'],
      ['const f = Number(m.minor);', 'Number()'],
      ['const f = parseFloat(text);', 'parseFloat'],
      ['const portfolioValue: number = 3;', 'magnitude'],
      ['let endBalance = 0;', 'magnitude'],
    ];
    for (const [snippet, why] of planted) {
      const found = violationsOf('planted.ts', codeOnly(snippet), snippet);
      expect(found.length, `${why} was not caught in: ${snippet}`).toBeGreaterThan(0);
    }
    expect(
      violationsOf('planted.ts', '', "import { Money } from '@core/kernel';").length,
    ).toBeGreaterThan(0);
    expect(violationsOf('planted.ts', '', "import type { Money } from '@core/kernel';")).toEqual(
      [],
    );
  });
});
