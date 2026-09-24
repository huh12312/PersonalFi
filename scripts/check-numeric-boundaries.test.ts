// SPDX-License-Identifier: MIT
/**
 * The numeric-boundary check's own suite (WP 3.14 exit test).
 *
 * Two halves, in the order the dispatch names them: **the fixtures first**, so
 * the rule is observed catching a float at a price boundary and observed *not*
 * catching a count of prices, and **then the real tree**, which must be clean.
 * A check that has only ever been run against a green tree is a check nobody
 * has watched fail (memory: gate-lessons, and the reason
 * `check-ci-projects.ts`, `compose-hardening-check.sh` and
 * `check-secret-ownership.sh` all carry a `--self-test`).
 *
 * The script carries a `--self-test` of its own as well, and that is not a
 * duplicate: `just lint` and the `lint` CI job run the script, not vitest, so
 * the fixtures are exercised on both paths.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BAD_FIXTURE,
  EXPECTED_BAD_IDENTIFIERS,
  GOOD_FIXTURE,
  MAGNITUDE_PATTERN,
  checkSource,
  checkTree,
  runSelfTest,
} from './check-numeric-boundaries.ts';

const REPO_ROOT = join(import.meta.dirname, '..');

function checkFixture(name: string): ReturnType<typeof checkSource> {
  return checkSource(name, readFileSync(join(REPO_ROOT, name), 'utf8'));
}

describe('check-numeric-boundaries, against fixtures', () => {
  it('a float assigned to a price fails the check', () => {
    const result = checkSource(
      'fixture.ts',
      ['export const price = 268.4;', 'export interface Q { readonly quantity: number }'].join(
        '\n',
      ),
    );

    expect(result.violations.map((violation) => violation.identifier)).toEqual([
      'price',
      'quantity',
    ]);
    expect(result.violations[0]?.kind).toBe('number-at-a-magnitude-boundary');
    expect(result.violations[0]?.line).toBe(1);
    // The message has to name the alternative, or a reader learns only that
    // something is forbidden.
    expect(result.violations[0]?.detail).toContain('bigint');
  });

  it('catches every shape in the bad fixture, not merely the first', () => {
    const caught = new Set(checkFixture(BAD_FIXTURE).violations.map((v) => v.identifier));
    for (const identifier of EXPECTED_BAD_IDENTIFIERS) {
      expect(caught, `expected a violation on \`${identifier}\``).toContain(identifier);
    }
  });

  it('flags toFixed on a magnitude — the Phase 1 toFixed(18) bug', () => {
    const result = checkSource('fixture.ts', 'export const s = rawQuantity.toFixed(18);');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('tofixed-on-a-magnitude');
  });

  it('leaves the good fixture clean — a count of prices is not a price', () => {
    const result = checkFixture(GOOD_FIXTURE);
    expect(result.violations).toEqual([]);
    // And it got there by exempting, not by failing to look.
    expect(result.exemptions.length).toBeGreaterThan(0);
  });

  it('exempts `value` as a parameter but never as a property', () => {
    const asParameter = checkSource('fixture.ts', 'export function clamp(value: number) { }');
    expect(asParameter.violations).toEqual([]);

    const asProperty = checkSource('fixture.ts', 'export interface H { readonly value: number }');
    expect(asProperty.violations.map((violation) => violation.identifier)).toEqual(['value']);
  });

  it('is 08 §6.5s pattern plus the dispatchs `quantity`', () => {
    for (const word of ['amount', 'balance', 'price', 'value', 'cost', 'quantity']) {
      expect(MAGNITUDE_PATTERN.test(`some${word[0]?.toUpperCase() ?? ''}${word.slice(1)}X`)).toBe(
        true,
      );
    }
    expect(MAGNITUDE_PATTERN.test('retryDelayMs')).toBe(false);
  });

  it('runs its own --self-test clean', () => {
    expect(runSelfTest(REPO_ROOT)).toEqual([]);
  });
});

describe('check-numeric-boundaries, against the real tree', () => {
  it('packages/** and apps/api/src/** hold no float at a magnitude boundary', () => {
    const result = checkTree(REPO_ROOT);
    // Printed rather than only asserted: a reviewer wants the list, not a count.
    const detail = result.violations
      .map((violation) => `${violation.file}:${String(violation.line)} ${violation.identifier}`)
      .join('\n');
    expect(detail).toBe('');
    expect(result.filesScanned).toBeGreaterThan(500);
  });
});
