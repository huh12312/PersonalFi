// SPDX-License-Identifier: MIT
/**
 * WP 4.2 — assumptions: one file, versioned, cited.
 *
 * The four named tests are the dispatch's exit tests (docs/plan/04-phase-4-dispatch.md
 * §3 "WP 4.2"). The walk in the first one reads the **raw** data module, not
 * the zod-validated copy, so it is a second, independent statement of the
 * citation rule rather than a restatement of the schema.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDateOnly } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ASSUMPTIONS_FILE } from '../data/assumptions.ts';
import { RETAINED_ASSUMPTIONS_FILES } from '../data/assumptions-retained.ts';
import {
  AssumptionOverrideRefused,
  AssumptionsYearUnavailable,
  CITED_KINDS,
  DECIMAL_PATTERN,
  OVERRIDABLE_PATHS,
  UnknownAssumptionsVersion,
  applyOverrides,
  assumptionsVersion,
  canonicalDecimal,
  compareDecimal,
  computableVersions,
  currentRegistry,
  diffOverrides,
  guardrailReferenceRate,
  hashAssumptionsFile,
  isAssumptionsRefusal,
  isRetainedVersion,
  loadAssumptions,
  parseAssumptions,
  resolveOverrides,
  retainedAssumptions,
  taxYear,
  type Assumptions,
  type OverridablePath,
} from '../src/assumptions.ts';
import { toMonteCarloJob } from '../src/engine/worker-host.ts';
import { runMonteCarlo, serialiseResult } from '../src/engine/montecarlo.ts';
import { retiredStaleness } from '../src/projection-service.ts';
import { BASE, usd } from './engine/support.ts';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..', '..');
const DATA_FILES = ['assumptions.ts', 'us-2026.ts'] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CITED = new Set<string>(CITED_KINDS);

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

interface CitedNodeAt {
  readonly path: string;
  readonly node: Record<string, unknown>;
}

function isCitedNode(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    CITED.has(String((value as { kind?: unknown }).kind))
  );
}

/**
 * Every number in `value` must sit inside a cited node whose `source` is a
 * non-empty string and whose `asOf` is a real calendar date. A number is a JS
 * `number`, a `bigint` (every Money literal), or a string that is a decimal.
 */
function citationFindings(value: unknown, path = '$', found: CitedNodeAt[] = []): string[] {
  if (isCitedNode(value)) {
    found.push({ path, node: value });
    const problems: string[] = [];
    const { source, asOf } = value as { source?: unknown; asOf?: unknown };
    if (typeof source !== 'string' || source.trim() === '') problems.push(`${path}: no source`);
    let dated = false;
    if (typeof asOf === 'string' && ISO_DATE.test(asOf)) {
      try {
        dated = parseDateOnly(asOf) === asOf;
      } catch {
        dated = false;
      }
    }
    if (!dated) problems.push(`${path}: no as_of date`);
    return problems;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return [`${path}: an uncited number`];
  if (typeof value === 'string') {
    return DECIMAL_PATTERN.test(value) ? [`${path}: an uncited number "${value}"`] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      citationFindings(item, `${path}[${String(index)}]`, found),
    );
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      citationFindings(item, `${path}.${key}`, found),
    );
  }
  return [];
}

function citedNodes(value: unknown): CitedNodeAt[] {
  const found: CitedNodeAt[] = [];
  citationFindings(value, '$', found);
  return found;
}

// ---------------------------------------------------------------------------
// Mutation, for the hash test
// ---------------------------------------------------------------------------

function extendDecimal(decimal: string): string {
  return decimal.includes('.') ? `${decimal}1` : `${decimal}.1`;
}

/** Change one number (or the text of a fact) inside a cited node, keeping the file valid. */
function mutateNode(node: Record<string, unknown>): void {
  const value = node['value'] as never;
  switch (node['kind']) {
    case 'money':
      (value as { minor: bigint }).minor += 1n;
      return;
    case 'moneyRange':
      (value as { to: { minor: bigint } }).to.minor += 1n;
      return;
    case 'rate':
    case 'index':
      node['value'] = extendDecimal(value as string);
      return;
    case 'rateRange':
      (value as { to: string }).to = extendDecimal((value as { to: string }).to);
      return;
    case 'integer':
      node['value'] = String(BigInt(value as string) + 1n);
      return;
    case 'fraction':
      (value as { numerator: string }).numerator = String(
        BigInt((value as { numerator: string }).numerator) + 1n,
      );
      return;
    case 'fact':
      node['value'] = `${value as string} (probe)`;
      return;
    case 'brackets': {
      const rows = value as { rate: string }[];
      const last = rows[rows.length - 1] as { rate: string };
      last.rate = extendDecimal(last.rate);
      return;
    }
    case 'ageSchedule': {
      const rows = value as { age: string }[];
      const last = rows[rows.length - 1] as { age: string };
      last.age = String(BigInt(last.age) + 1n);
      return;
    }
    case 'correlation': {
      const matrix = (value as { matrix: string[][] }).matrix;
      const row0 = matrix[0] as string[];
      const row1 = matrix[1] as string[];
      row0[1] = extendDecimal(row0[1] as string);
      row1[0] = row0[1];
      return;
    }
    default:
      throw new Error(`no mutation for kind ${String(node['kind'])}`);
  }
}

function nodeByPath(root: unknown, path: string): Record<string, unknown> {
  const node = citedNodes(root).find((candidate) => candidate.path === path)?.node;
  if (node === undefined) throw new Error(`no cited node at ${path}`);
  return node;
}

/** Copy the two data modules to a fresh directory, transform them, import the copy. */
async function hashOfCopy(transform: (file: string, text: string) => string): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'wp42-hash-probe-'));
  try {
    for (const file of DATA_FILES) {
      const original = readFileSync(join(PACKAGE_ROOT, 'data', file), 'utf8');
      const changed = transform(file, original);
      writeFileSync(join(directory, file), changed);
    }
    const module = (await import(pathToFileURL(join(directory, 'assumptions.ts')).href)) as {
      ASSUMPTIONS_FILE: unknown;
    };
    return hashAssumptionsFile(module.ASSUMPTIONS_FILE);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function currentDefault(assumptions: Assumptions, path: OverridablePath): string {
  const node = nodeByPath(assumptions.file, `$.${path}`);
  return node['value'] as string;
}

// ---------------------------------------------------------------------------

describe('WP 4.2 — the assumptions file', () => {
  it('every number in the assumptions file carries a non-empty source and an as_of date', () => {
    // The walker is observed catching all three failures before it is trusted.
    const probe = {
      unsourced: { kind: 'rate', value: '0.1', source: ' ', asOf: '2026-01-01' },
      undated: {
        kind: 'money',
        value: { minor: 1n, currency: 'USD' },
        source: 'x',
        asOf: '2026-02-30',
      },
      bare: '0.5',
      nested: { deeper: [{ limit: 7_500n }] },
    };
    expect(citationFindings(probe)).toEqual([
      '$.unsourced: no source',
      '$.undated: no as_of date',
      '$.bare: an uncited number "0.5"',
      '$.nested.deeper[0].limit: an uncited number',
    ]);

    // The raw module, exactly as a reviewer reads it.
    expect(citationFindings(ASSUMPTIONS_FILE)).toEqual([]);
    // And the loaded copy — Money turned into kernel Money must not lose a citation.
    expect(citationFindings(loadAssumptions().file)).toEqual([]);

    // Not vacuous: the walk reached the numbers the file exists to hold.
    const paths = citedNodes(ASSUMPTIONS_FILE).map((entry) => entry.path);
    // 92 cited nodes at WP 4.2 — one row each in the evidence's parameter table.
    expect(paths.length).toBeGreaterThanOrEqual(92);
    for (const expected of [
      '$.capitalMarket.usEquity.expectedReturn',
      '$.capitalMarket.crypto.volatility',
      '$.capitalMarket.crypto.disclaimer',
      '$.correlation',
      '$.macro.treasury10YearYield',
      '$.taxYears.2026.retirement.electiveDeferral',
      '$.taxYears.2026.incomeTax.brackets.mfj',
      '$.taxYears.2026.incomeTax.longTermCapitalGains.single',
      '$.taxYears.2026.socialSecurity.bendPoints.second',
      '$.taxYears.2026.rmd.startAge',
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it('the content hash changes when any value changes and not when a comment does', async () => {
    const baseline = assumptionsVersion();
    expect(baseline).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashAssumptionsFile(ASSUMPTIONS_FILE)).toBe(baseline);

    // Any value: every cited node, one at a time, in a fresh copy.
    const nodes = citedNodes(ASSUMPTIONS_FILE);
    const seen = new Set<string>([baseline]);
    for (const { path } of nodes) {
      const copy = structuredClone(ASSUMPTIONS_FILE);
      mutateNode(nodeByPath(copy, path));
      const mutated = hashAssumptionsFile(copy);
      expect(mutated, `changing ${path} must change the version`).not.toBe(baseline);
      seen.add(mutated);
    }
    expect(seen.size).toBe(nodes.length + 1);

    // A citation is content too: it is what the UI prints beside the number.
    const resourced = structuredClone(ASSUMPTIONS_FILE);
    nodeByPath(resourced, '$.capitalMarket.cash.volatility')['source'] = 'a different source';
    expect(hashAssumptionsFile(resourced)).not.toBe(baseline);

    // Not when a comment does: the modules' own source text, comments rewritten.
    const recommented = await hashOfCopy((file, text) => {
      const changed = text
        .replace(
          '// SPDX-License-Identifier: MIT\n',
          '// SPDX-License-Identifier: MIT\n// probe: a comment is not a value\n',
        )
        .replace(/\/\*\*[\s\S]*?\*\//, '/** The header, rewritten entirely by the hash probe. */')
        .concat(`\n/* trailing probe comment in ${file} */\n`);
      expect(changed, `${file} was actually rewritten`).not.toBe(text);
      return changed;
    });
    expect(recommented).toBe(baseline);

    // ...and the same copy mechanism does see a value edit in the source text.
    const edited = await hashOfCopy((file, text) => {
      if (file !== 'us-2026.ts') return text;
      expect(text.split('24_500n').length, 'the elective deferral literal is unique').toBe(2);
      return text.replace('24_500n', '24_501n');
    });
    expect(edited).not.toBe(baseline);
  });

  it('the content hash is identical across two separate node processes', () => {
    const script =
      "import { assumptionsVersion } from './packages/contexts/planning/src/assumptions.ts';" +
      'process.stdout.write(JSON.stringify({ pid: process.pid, version: assumptionsVersion() }));';
    const run = (): { pid: number; version: string } =>
      JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '-e', script], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
        }),
      ) as { pid: number; version: string };
    const first = run();
    const second = run();
    expect(first.pid).not.toBe(second.pid);
    expect(first.version).toBe(second.version);
    expect(first.version).toBe(assumptionsVersion());
    // Two cold node processes each import the whole data module; ~2.5 s
    // apiece on an idle machine and over the 5 s default when other suites
    // share the box (WP 4.3's run saw 5.2 s and 5.4 s). The budget is for the
    // process spawns, not the hash.
  }, 30_000);

  it('an override stores a delta and never a copy of the default', () => {
    const assumptions = loadAssumptions();

    // One genuine change, three restatements of defaults (one spelled differently).
    const delta = diffOverrides(assumptions, {
      'capitalMarket.usEquity.expectedReturn': '0.055',
      'capitalMarket.intlDevelopedEquity.expectedReturn': '0.07',
      'capitalMarket.inflation.mean': '0.0250',
      'capitalMarket.crypto.volatility': '0.70',
    });
    expect(delta).toEqual({ 'capitalMarket.usEquity.expectedReturn': '0.055' });
    expect(Object.isFrozen(delta)).toBe(true);

    // Restating every default is not an override at all.
    const everyDefault = Object.fromEntries(
      OVERRIDABLE_PATHS.map((path) => [path, currentDefault(assumptions, path)]),
    );
    expect(diffOverrides(assumptions, everyDefault)).toEqual({});

    // The stored shape is flat path → decimal string: nothing nested, no Money, no citation.
    const stored = JSON.parse(JSON.stringify(delta)) as Record<string, unknown>;
    for (const [path, entry] of Object.entries(stored)) {
      expect(OVERRIDABLE_PATHS as readonly string[]).toContain(path);
      expect(typeof entry).toBe('string');
    }

    // Why it matters: the next file version moves a default the user never touched.
    const next = structuredClone(ASSUMPTIONS_FILE);
    nodeByPath(next, '$.capitalMarket.intlDevelopedEquity.expectedReturn')['value'] = '0.072';
    const nextVersion = parseAssumptions(next);
    expect(nextVersion.version).not.toBe(assumptions.version);
    const resolved = applyOverrides(nextVersion, delta, parseDateOnly('2026-09-26'));
    expect(
      nodeByPath(resolved.file, '$.capitalMarket.intlDevelopedEquity.expectedReturn')['value'],
    ).toBe('0.072');
    expect(nodeByPath(resolved.file, '$.capitalMarket.usEquity.expectedReturn')['value']).toBe(
      '0.055',
    );
    expect(resolved.overrides.map((override) => override.path)).toEqual([
      'capitalMarket.usEquity.expectedReturn',
    ]);

    // As a property: the delta holds exactly the paths that differ, and applying
    // it reproduces every desired value while leaving every other path on its default.
    const pathArbitrary = fc.constantFrom(...OVERRIDABLE_PATHS);
    // 0 ≤ d ≤ 1 at six places, built as a string: in bounds for every path, and no float formed.
    const decimalArbitrary = fc
      .integer({ min: 0, max: 1_000_000 })
      .map((millionths) =>
        canonicalDecimal(
          `${String(Math.trunc(millionths / 1_000_000))}.${String(millionths % 1_000_000).padStart(6, '0')}`,
        ),
      );
    fc.assert(
      fc.property(
        fc.dictionary(pathArbitrary, fc.oneof(decimalArbitrary, fc.constant('default')), {
          maxKeys: 17,
        }),
        (choices) => {
          const desired: Record<string, string> = {};
          for (const [path, choice] of Object.entries(choices)) {
            const overridable = path as OverridablePath;
            desired[path] =
              choice === 'default' || !DECIMAL_PATTERN.test(choice)
                ? currentDefault(assumptions, overridable)
                : choice;
          }
          const sparse = diffOverrides(assumptions, desired);
          const differing = Object.entries(desired)
            .filter(
              ([path, wanted]) =>
                compareDecimal(wanted, currentDefault(assumptions, path as OverridablePath)) !== 0,
            )
            .map(([path]) => path)
            .sort();
          expect(Object.keys(sparse).sort()).toEqual(differing);
          const applied = applyOverrides(assumptions, sparse, parseDateOnly('2026-09-26'));
          for (const path of OVERRIDABLE_PATHS) {
            const effective = nodeByPath(applied.file, `$.${path}`)['value'] as string;
            const expected = desired[path] ?? currentDefault(assumptions, path);
            expect(compareDecimal(effective, expected)).toBe(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a 2027 lookup fails loudly rather than silently reusing 2026', () => {
    const assumptions = loadAssumptions();
    expect(Object.keys(assumptions.file.taxYears)).toEqual(['2026']);
    expect(taxYear(assumptions, 2026).retirement.electiveDeferral.value.minor).toBe(2_450_000n);

    let refusal: unknown;
    try {
      taxYear(assumptions, 2027);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(AssumptionsYearUnavailable);
    expect(isAssumptionsRefusal(refusal)).toBe(true);
    expect((refusal as AssumptionsYearUnavailable).year).toBe(2027);
    expect((refusal as AssumptionsYearUnavailable).available).toEqual(['2026']);
    expect((refusal as Error).message).toContain('2027');

    // Nor backwards: there is no nearest-year search in either direction.
    expect(() => taxYear(assumptions, 2025)).toThrow(AssumptionsYearUnavailable);
  });
});

describe('WP 4.2 — the file is well-formed beyond citation', () => {
  it('the loaded file is frozen all the way down', () => {
    const { file } = loadAssumptions();
    expect(Object.isFrozen(file)).toBe(true);
    expect(Object.isFrozen(file.taxYears['2026']?.incomeTax.brackets.single.value[0])).toBe(true);
    expect(() => {
      (file.capitalMarket.usEquity.expectedReturn as { value: string }).value = '0.5';
    }).toThrow(TypeError);
  });

  it('the correlation matrix is positive definite, so a Cholesky factor exists', () => {
    const { matrix } = loadAssumptions().file.correlation.value;
    const size = matrix.length;
    const lower: number[][] = Array.from({ length: size }, () => Array<number>(size).fill(0));
    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j <= i; j += 1) {
        let sum = Number(matrix[i]?.[j]);
        for (let k = 0; k < j; k += 1) sum -= (lower[i]?.[k] ?? 0) * (lower[j]?.[k] ?? 0);
        if (i === j) {
          expect(sum, `pivot ${String(i)}`).toBeGreaterThan(0);
          (lower[i] as number[])[i] = Math.sqrt(sum);
        } else {
          (lower[i] as number[])[j] = sum / (lower[j]?.[j] ?? Number.NaN);
        }
      }
    }
  });

  it('an unknown path, a non-decimal and an out-of-range override are refused', () => {
    const assumptions = loadAssumptions();
    const refused = (desired: Record<string, string>): AssumptionOverrideRefused => {
      try {
        diffOverrides(assumptions, desired);
      } catch (error) {
        if (error instanceof AssumptionOverrideRefused) return error;
        throw error;
      }
      throw new Error('expected a refusal');
    };
    expect(refused({ 'taxYears.2026.retirement.electiveDeferral': '30000' }).code).toBe(
      'planning.assumptions_path_unknown',
    );
    expect(refused({ 'capitalMarket.usEquity.expectedReturn': '6.5%' }).code).toBe(
      'planning.assumptions_value_invalid',
    );
    expect(refused({ 'capitalMarket.usEquity.volatility': '-0.1' }).code).toBe(
      'planning.assumptions_value_invalid',
    );
  });
});

describe('WP 5.5 — the guardrail reference rate, the retained predecessor, REIT', () => {
  const GUARDRAIL = 'withdrawalPolicy.guardrailReferenceRate';
  const PREDECESSOR = 'sha256:d294715e0094c8862c84c278a457656bb6bb68915feb61087d3d7422442ed67f';

  it('the guardrail reference rate is a cited, overridable assumption', () => {
    const assumptions = loadAssumptions();
    // Cited, in the file, where the walk finds it: a source naming 07 §5.6 and an as_of date.
    const node = nodeByPath(ASSUMPTIONS_FILE, `$.${GUARDRAIL}`);
    expect(node['kind']).toBe('rate');
    expect(node['value']).toBe('0.045');
    expect(String(node['source'])).toContain('07 §5.6');
    expect(node['asOf']).toMatch(ISO_DATE);
    expect(citationFindings(ASSUMPTIONS_FILE)).toEqual([]);
    // The accessor the composition root reads instead of its literal.
    expect(guardrailReferenceRate(assumptions)).toEqual(
      assumptions.file.withdrawalPolicy?.guardrailReferenceRate,
    );
    expect(guardrailReferenceRate(assumptions).value).toBe('0.045');

    // Overridable: a delta, applied with the holder as its source, the default kept beside it.
    expect(OVERRIDABLE_PATHS as readonly string[]).toContain(GUARDRAIL);
    const delta = diffOverrides(assumptions, { [GUARDRAIL]: '0.04' });
    expect(delta).toEqual({ [GUARDRAIL]: '0.04' });
    const resolved = applyOverrides(assumptions, delta, parseDateOnly('2026-09-30'));
    const overridden = guardrailReferenceRate(resolved);
    expect(overridden.value).toBe('0.04');
    expect(overridden.source).toContain('Your override (the default is 0.045');
    expect(resolved.overrides.map((override) => override.path)).toEqual([GUARDRAIL]);
    // Restating the default stores nothing; an out-of-range rate is refused.
    expect(diffOverrides(assumptions, { [GUARDRAIL]: '0.0450' })).toEqual({});
    expect(() => diffOverrides(assumptions, { [GUARDRAIL]: '1.5' })).toThrow(
      AssumptionOverrideRefused,
    );
    // And it moved the version: a file without it is not this file.
    const without = structuredClone(ASSUMPTIONS_FILE) as Record<string, unknown>;
    delete without['withdrawalPolicy'];
    expect(hashAssumptionsFile(without)).not.toBe(assumptionsVersion());
    expect(() => parseAssumptions(without)).toThrow(/withdrawalPolicy\.guardrailReferenceRate/);
  });

  it('an override stored against the previous file version still resolves and its runs read stale with that version named', () => {
    const registry = currentRegistry();
    const current = assumptionsVersion();
    expect(current).not.toBe(PREDECESSOR);
    // The predecessor is held, frozen, and still hashes to the version every pre-WP 5.5 override
    // and run was saved against — the value WP 4.2's evidence §4 recorded.
    expect(RETAINED_ASSUMPTIONS_FILES.map((entry) => entry.version)).toEqual([PREDECESSOR]);
    expect(hashAssumptionsFile(RETAINED_ASSUMPTIONS_FILES[0]?.file)).toBe(PREDECESSOR);
    expect(retainedAssumptions().map((entry) => entry.version)).toEqual([PREDECESSOR]);
    expect(isRetainedVersion(registry, PREDECESSOR)).toBe(true);
    expect(computableVersions(registry)).toEqual([current]);

    // An override saved last week, against the predecessor, as `plan_assumptions` holds it.
    const stored = {
      assumptionsVersion: PREDECESSOR,
      deltas: { 'capitalMarket.usEquity.expectedReturn': '0.06' },
    };
    const resolved = resolveOverrides(stored, parseDateOnly('2026-09-29'));
    expect(resolved.version).toBe(PREDECESSOR);
    expect(resolved.file.capitalMarket.usEquity.expectedReturn.value).toBe('0.06');
    expect(resolved.overrides.map((override) => [override.path, override.value])).toEqual([
      ['capitalMarket.usEquity.expectedReturn', '0.06'],
    ]);
    // The predecessor predates the guardrail node; its runs used the literal, recorded beside it.
    expect(resolved.file.withdrawalPolicy).toBeUndefined();
    expect(guardrailReferenceRate(resolved).value).toBe('0.045');
    expect(guardrailReferenceRate(resolved).source).toContain('GUARDRAIL_REFERENCE_RATE');
    // No override of a path the predecessor never had can be resolved against it.
    expect(() =>
      resolveOverrides(
        { assumptionsVersion: PREDECESSOR, deltas: { [GUARDRAIL]: '0.04' } },
        parseDateOnly('2026-09-29'),
      ),
    ).toThrow(AssumptionOverrideRefused);

    // Its runs read stale, the predecessor named — the decision readProjection and
    // prepareProjection both make — and a current-version run does not.
    expect(retiredStaleness(PREDECESSOR, registry)).toEqual({
      reason: 'assumptions_version_retired',
      assumptionsVersion: PREDECESSOR,
      known: [current],
    });
    expect(retiredStaleness(current, registry)).toBeNull();

    // A version this build never held still refuses by name, exactly as before WP 5.5.
    let refusal: unknown;
    try {
      resolveOverrides(
        { assumptionsVersion: `sha256:${'0'.repeat(64)}`, deltas: {} },
        parseDateOnly('2026-09-29'),
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(UnknownAssumptionsVersion);
    expect((refusal as UnknownAssumptionsVersion).known).toEqual([current]);
  });

  it("REIT is never refused and never given its own draw: a holding is projected at its bucket's blend", () => {
    // Decided (05 §2's REIT row): the engines take tax buckets with glidepaths, not asset classes,
    // so a REIT position is summed into its account's bucket and projected at that bucket's
    // equity/bond blend. The REIT correlation row enters only the lognormal Cholesky's
    // positive-definiteness check. Pinned: moving every REIT correlation (keeping the matrix
    // positive definite) changes not one byte of a lognormal run, crypto held.
    const assumptions = loadAssumptions();
    expect(Object.keys(assumptions.file.capitalMarket)).not.toContain('reit');
    expect(assumptions.file.correlation.value.assets).toContain('REIT');
    expect(assumptions.file.correlation.note).toContain('never moves a draw');

    const plan = {
      ...BASE,
      buckets: [
        {
          bucket: 'TAXABLE' as const,
          startingBalance: usd('400000'),
          annualContribution: usd('12000'),
        },
      ],
      contributionGrowth: 'flat' as const,
      glidepath: { kind: 'static' as const, equityShare: '0.6' },
      annualSpending: usd('50000'),
    };
    const bytesWith = (file: typeof assumptions.file) => {
      const job = toMonteCarloJob({
        plan,
        assumptions: { version: assumptions.version, file },
        seed: 20_260_930n,
        paths: 400,
        engine: 'lognormal',
        cryptoHolding: usd('20000'),
      });
      return Buffer.from(serialiseResult(runMonteCarlo(job))).toString('base64');
    };
    const reit = assumptions.file.correlation.value.assets.indexOf('REIT');
    const moved = structuredClone(assumptions.file) as {
      correlation: { value: { matrix: string[][] } };
    };
    moved.correlation.value.matrix = moved.correlation.value.matrix.map((row, i) =>
      row.map((cell, j) => (i === j ? cell : i === reit || j === reit ? '0.10' : cell)),
    );
    expect(bytesWith(moved as unknown as typeof assumptions.file)).toBe(
      bytesWith(assumptions.file),
    );
  });
});
