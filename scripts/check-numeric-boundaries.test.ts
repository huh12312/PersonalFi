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
  checkSources,
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

  it('a float reaching a Brief amount outside a named boundary fails the check', () => {
    // WP 5.14 / C-11 (gate input 6, NB3/NB4): the alias-aware extension
    // closes the hole the Phase 4 gate found, which was not "a local alias is
    // invisible" (WP 4.14 already fixed that) but "an *imported* alias is
    // invisible" — `import type { EngineDollars } from './engine/boundary.ts'`
    // read as `GREEN` where a local `type GateDollars = number` read `FAIL`.
    // This is the same shape over the Brief's own money, proving the fix is
    // general rather than a one-file patch for `boundary.ts`: one file
    // exports a number alias, a second file imports it across a relative
    // path, and a third imports it through a package-style specifier — all
    // three must still be caught without `checkSources` ever resolving
    // either import path (it resolves by the *exported name*, tree-wide).
    const moneyFile = {
      file: 'packages/contexts/insights/src/brief/money.ts',
      text: 'export type BriefDollars = number;',
    };
    const relativeImporter = {
      file: 'packages/contexts/insights/src/brief/assembly.ts',
      text: [
        "import type { BriefDollars } from './money.ts';",
        'export interface BriefLine { readonly briefAmount: BriefDollars }',
      ].join('\n'),
    };
    const barrelImporter = {
      file: 'apps/api/src/routes/brief.ts',
      text: [
        "import type { BriefDollars } from '@ctx/insights';",
        'export function headlineAmount(): BriefDollars { return 1_899; }',
      ].join('\n'),
    };

    const result = checkSources([moneyFile, relativeImporter, barrelImporter]);
    const byFile = new Map(
      result.violations.map((violation) => [violation.file, violation.identifier]),
    );
    expect(byFile.get(relativeImporter.file)).toBe('briefAmount');
    expect(byFile.get(barrelImporter.file)).toBe('headlineAmount');
    // `money.ts` itself declares the alias but never hangs a magnitude
    // identifier off it, so it contributes no violation of its own — the
    // point is the two *importers*, not the declaration site.
    expect(byFile.has(moneyFile.file)).toBe(false);
  });

  it('an exported number alias is visible across files; a non-exported one is not', () => {
    // The other half of the same mechanism: `collectExportedTypeAliases`
    // only ever collects `export type X = …`. A *local*, non-exported alias
    // of the same name in a second file must not borrow the first file's
    // export — the tree-wide map is genuinely name-keyed by what a module
    // actually exports, not by every type alias anyone ever wrote.
    const exported = {
      file: 'packages/contexts/insights/src/brief/exported.ts',
      text: 'export type BriefDollars2 = number;',
    };
    const unrelatedLocal = {
      file: 'packages/contexts/insights/src/brief/unrelated.ts',
      text: [
        // Not exported, and not the same name — this file's own `value` is
        // typed `string`, so it must never be flagged by the other file's
        // unrelated export.
        'type Scratch = string;',
        'export interface Note { readonly value: Scratch }',
      ].join('\n'),
    };

    const result = checkSources([exported, unrelatedLocal]);
    expect(result.violations).toEqual([]);
  });

  it('a float assigned to a value inside the engine but outside the named boundary fails the check', () => {
    // The dispatch's own exit test (§3 WP 4.14) for the alias-aware extension:
    // `boundary.ts`'s `EngineDollars = number` is legal only at the one named
    // crossing (the ALLOW_LIST entry added above for `toEngineAmount`). A
    // second file under `engine/` that declares the same kind of alias and
    // hangs a `value` off it — never itself allow-listed — must still fail,
    // proving the alias resolution added for `boundary.ts` does not amount to
    // a blanket exemption for the file's *shape*, only for the one named file
    // and identifier `checkTree` actually allow-lists.
    const result = checkSource(
      'packages/contexts/planning/src/engine/fake-crossing.ts',
      ['type EngineDollars = number;', 'export interface Q { readonly value: EngineDollars }'].join(
        '\n',
      ),
    );
    expect(result.violations.map((violation) => violation.identifier)).toEqual(['value']);
    expect(result.violations[0]?.kind).toBe('number-at-a-magnitude-boundary');
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
    // A whole-tree AST scan: ~2 s alone at 686 files (WP 3.14), ~5.5 s at 766
    // files under a full parallel `just check` — over the 5 s default, which
    // is what turned `just check` red twice on 2026-09-27 with zero
    // violations. The budget is for the scan, not the assertion.
  }, 60_000);
});
