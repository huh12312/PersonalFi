// SPDX-License-Identifier: MIT
/**
 * The perf-skip check's own suite (WP 9.9 exit test).
 *
 * Fixtures first, in the order the dispatch asks for: a perf test that skips
 * without a named reason must be seen to fail the check, and only then does the
 * real tree get run through it — where every skip must be listed by name.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BARE_SKIP_FIXTURE,
  HOST_LOADED,
  NAMED_SKIP_FIXTURE,
  checkSource,
  checkTree,
  formatList,
  formatSummary,
  isPerfFile,
  runSelfTest,
} from './check-perf-skips.ts';

const REPO_ROOT = join(import.meta.dirname, '..');

describe('check-perf-skips, against fixtures', () => {
  it('a perf test that skips without a named reason fails the check', () => {
    const sites = checkSource('apps/api/test/db/bare-perf.test.ts', BARE_SKIP_FIXTURE);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.form).toBe('skipIf');
    expect(sites[0]?.name).toBeNull();
    expect(sites[0]?.problem).toContain('no named condition');
  });

  it('a named skipIf with no perf-skip comment also fails: a name alone is not a reason', () => {
    const undeclared = NAMED_SKIP_FIXTURE.replace(/^\/\/ perf-skip:.*\n/m, '');
    const sites = checkSource('x-perf.test.ts', undeclared);
    expect(sites[0]?.name).toBe('ON_SHARED_RUNNER');
    expect(sites[0]?.problem).toContain('perf-skip: ON_SHARED_RUNNER');
  });

  it('a one-word reason is not a reason', () => {
    const terse = NAMED_SKIP_FIXTURE.replace(/(perf-skip: ON_SHARED_RUNNER — ).*/, '$1ci');
    expect(checkSource('x-perf.test.ts', terse)[0]?.problem).not.toBeNull();
  });

  it('a named, annotated skipIf passes and carries its reason', () => {
    const sites = checkSource('x-perf.test.ts', NAMED_SKIP_FIXTURE);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.problem).toBeNull();
    expect(sites[0]?.reason).toContain('shared CI runner');
  });

  it('it.skip, describe.skip, .todo and a bare ctx.skip() are unconditional skips and always fail', () => {
    const source = [
      "it.skip('a', () => {});",
      "describe.skip('b', () => {});",
      "it.todo('c');",
      "it('d', (ctx) => { ctx.skip('slow today'); });",
    ].join('\n');
    const sites = checkSource('y-perf.test.ts', source);
    expect(sites.map((site) => site.form)).toEqual([
      'unconditional',
      'unconditional',
      'unconditional',
      'unconditional',
    ]);
    expect(sites.every((site) => site.problem !== null)).toBe(true);
  });

  it('ctx.skip inside the definition of assertWithinBudget is the helper itself, not a skip; the same call elsewhere still fails', () => {
    const mirror = [
      '// perf-skip: HOST_LOADED — an over-budget reading at a 1-minute load of 3 or more is not believed',
      'function assertWithinBudget(ctx, checks) { ctx.skip("HOST_LOADED: over budget"); }',
      "it('p95', (ctx) => { assertWithinBudget(ctx, []); });",
    ].join('\n');
    const sites = checkSource('mirror-perf.test.ts', mirror);
    expect(sites.map((site) => site.form)).toEqual(['load-conditional']);
    expect(sites[0]?.problem).toBeNull();

    const elsewhere = "it('p95', (ctx) => { ctx.skip('slow today'); });";
    expect(checkSource('mirror-perf.test.ts', elsewhere)[0]?.problem).not.toBeNull();
  });

  it('assertWithinBudget is a load-conditional skip named HOST_LOADED, and needs that name declared', () => {
    const body = "it('p95', (ctx) => { assertWithinBudget(ctx, { label: 'x' }); });";
    const bare = checkSource('z-perf.test.ts', body);
    expect(bare[0]?.form).toBe('load-conditional');
    expect(bare[0]?.name).toBe(HOST_LOADED);
    expect(bare[0]?.problem).not.toBeNull();

    const declared = `// perf-skip: ${HOST_LOADED} — an over-budget reading at load above the ceiling is not believed (rule 4)\n${body}`;
    expect(checkSource('z-perf.test.ts', declared)[0]?.problem).toBeNull();
  });

  it("skipNamed(ctx, 'NAME', …) is a named skip: it needs a literal name and a declared reason", () => {
    const declared = [
      '// perf-skip: NO_RETURN_SERIES — the Monte Carlo timing needs the fetched return series',
      "it('p95', (ctx) => { skipNamed(ctx, 'NO_RETURN_SERIES', 'not fetched'); });",
    ].join('\n');
    const [site] = checkSource('m-perf.test.ts', declared);
    expect(site?.form).toBe('skipNamed');
    expect(site?.name).toBe('NO_RETURN_SERIES');
    expect(site?.problem).toBeNull();

    const undeclared = declared.split('\n')[1] ?? '';
    expect(checkSource('m-perf.test.ts', undeclared)[0]?.problem).not.toBeNull();
    expect(
      checkSource(
        'm-perf.test.ts',
        "it('p', (ctx) => { skipNamed(ctx, reasonVariable, 'x'); });",
      )[0]?.problem,
    ).toContain('string literal');
  });

  it('a skipIf on a row-count sanity check fails: a perf number over an empty table is a lie', () => {
    const source = [
      '// perf-skip: ON_SHARED_RUNNER — a shared runner is not the target hardware',
      "it.skipIf(ON_SHARED_RUNNER)('the seeded dataset is actually in the database', () => {});",
    ].join('\n');
    expect(checkSource('s-perf.test.ts', source)[0]?.problem).toContain('never skip');
  });

  it('ignores skip-looking text in comments and strings', () => {
    const source = [
      '// describe.skipIf(process.env.X)(...) would be a bare skip',
      "const note = 'it.skip(this)';",
    ].join('\n');
    expect(checkSource('c-perf.test.ts', source)).toEqual([]);
  });

  it('knows a perf file by its name or by the [slow] title marker, and nothing else', () => {
    expect(isPerfFile('apps/api/test/db/investments-perf.test.ts', '')).toBe(true);
    expect(isPerfFile('packages/x/src/engine/perf.test.ts', '')).toBe(true);
    expect(isPerfFile('packages/x/test/growth-bound.test.ts', "describe('[slow] R-5'")).toBe(true);
    expect(isPerfFile('packages/x/test/ordinary.test.ts', "describe('ordinary'")).toBe(false);
    expect(isPerfFile('packages/x/test/perf-helper.ts', '')).toBe(false);
  });

  it('its own self-test is clean', () => {
    expect(runSelfTest()).toEqual([]);
  });
});

describe('check-perf-skips, over the real tree', () => {
  const result = checkTree(REPO_ROOT);

  it('finds the repository perf files', () => {
    for (const expected of [
      'apps/api/test/db/investments-perf.test.ts',
      'apps/api/test/db/phase2-reports-http-perf.test.ts',
      'apps/api/test/db/projection-perf.test.ts',
      'apps/api/test/db/transactions-http-perf.test.ts',
      'apps/api/test/db/nightly-perf.test.ts',
      'apps/api/test/db/holdings-scale-perf.test.ts',
      'packages/contexts/ledger/test/perf.test.ts',
      'packages/contexts/ledger/test/growth-bound.test.ts',
      'packages/contexts/planning/src/engine/perf.test.ts',
    ]) {
      expect(result.perfFiles, expected).toContain(expected);
    }
  });

  it('lists every skip by name, with its reason, and none lacks one', () => {
    expect(result.sites.length).toBeGreaterThan(0);
    const unnamed = result.sites.filter((site) => site.problem !== null);
    expect(
      unnamed.map((site) => `${site.file}:${String(site.line)} ${site.problem ?? ''}`),
    ).toEqual([]);
    for (const site of result.sites) {
      expect(site.name, `${site.file}:${String(site.line)}`).not.toBeNull();
      expect(site.reason?.length ?? 0, `${site.file}:${String(site.line)}`).toBeGreaterThan(11);
    }
    const listing = formatList(result);
    for (const site of result.sites) expect(listing).toContain(`${site.file}:${String(site.line)}`);
  });

  it('the shared-runner skip in projection-perf and the no-database skips are on the list', () => {
    const names = new Set(result.sites.map((site) => `${site.file}#${site.name ?? ''}`));
    expect(names).toContain('apps/api/test/db/projection-perf.test.ts#ON_SHARED_RUNNER');
    expect(names).toContain('apps/api/test/db/investments-perf.test.ts#NO_DATABASE');
  });

  it('writes a markdown table for $GITHUB_STEP_SUMMARY', () => {
    const summary = formatSummary(result);
    expect(summary).toContain('| Site | Form | Name | Reason |');
    expect(summary).toContain('0 without a named reason');
  });
});
