#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * The perf-skip check (WP 9.9, docs/plan/09-phase-9-dispatch.md §3 item (i)).
 *
 * A performance budget that quietly stops running is worse than no budget: the
 * suite is green, the number is not measured, and nobody can say why. Every way
 * a perf test can skip is therefore listed here, by name, and a skip with no
 * named reason fails the check.
 *
 * ## What counts as a perf file
 *
 * A `*.test.ts` under `apps/` or `packages/` (never `node_modules`) whose
 * basename contains `perf`, or whose text carries the repository's `[slow]`
 * title marker (the 50k-row growth bound is a scale test without "perf" in its
 * name).
 *
 * ## The three skip forms, and what each must carry
 *
 *   * `describe.skipIf(NAME)` / `it.skipIf(NAME)` — the condition must be a bare
 *     identifier (`NO_DATABASE`, `ON_SHARED_RUNNER`), never an inline
 *     expression: the identifier IS the name vitest's reader sees at the call.
 *   * `skipNamed(ctx, 'NAME', detail)` (apps/api/test/db/perf-support.ts) — a skip
 *     from inside a test body, for what only the body can know; NAME is a string
 *     literal and must be declared like a `skipIf` identifier.
 *   * `assertWithinBudget(…)` (apps/api/test/db/perf-support.ts) — a timing
 *     assertion that turns an over-budget reading into a skip when the host's
 *     load average is above the ceiling. Its name is fixed: `HOST_LOADED`.
 *   * `it.skip` / `describe.skip` / `.todo` / `ctx.skip(…)` — a skip with no
 *     condition at all. Always a failure: use `skipIf(NAME)`.
 *
 * Every NAME must be declared in the same file by a comment line
 *
 *     // perf-skip: NAME — the reason, in words a stranger can act on
 *
 * (an em dash, en dash or hyphen after the name; at least twelve characters of
 * reason). The check prints every site with its reason; CI writes that list into
 * `$GITHUB_STEP_SUMMARY` (`--summary`).
 *
 * ## The one rule about row counts
 *
 * A timing test over an empty table is a lie, so the row-count sanity check
 * beside every timing test never skips — for load, for CI, for anything. A
 * `skipIf` applied to an `it` whose title reads like a sanity check fails.
 *
 *   node scripts/check-perf-skips.ts              # list, exit 1 on a problem
 *   node scripts/check-perf-skips.ts --summary    # the same, as a markdown table
 *   node scripts/check-perf-skips.ts --self-test  # the rule against in-memory fixtures
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

export type SkipForm = 'skipIf' | 'skipNamed' | 'load-conditional' | 'unconditional';

export interface SkipSite {
  readonly file: string;
  readonly line: number;
  readonly form: SkipForm;
  /** The condition's name, or null when there is none to name. */
  readonly name: string | null;
  /** The declared reason, or null when the file declares none for `name`. */
  readonly reason: string | null;
  /** Why this site fails the check, or null when it passes. */
  readonly problem: string | null;
}

/** The name `assertWithinBudget` skips under: the host-load ceiling. */
export const HOST_LOADED = 'HOST_LOADED';

const ANNOTATION = /perf-skip:\s*([A-Za-z_$][\w$]*)\s*[—–-]+\s*(\S.*)$/;
const MIN_REASON_LENGTH = 12;
const SANITY_TITLE = /row.?count|sanity|actually in the database|empty table|dataset is/i;
const SKIP_CONTEXT_NAMES = new Set(['ctx', 'context', 'task', 't']);

function annotations(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = ANNOTATION.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const reason = match[2].trim();
    if (reason.length >= MIN_REASON_LENGTH && !found.has(match[1])) found.set(match[1], reason);
  }
  return found;
}

/**
 * `ctx.skip(…)` inside the definition of `assertWithinBudget` or `skipNamed` is
 * the implementation of a named skip, not a skip of its own: a package that may
 * not import the shared helper (the planning engine's perf test) mirrors it
 * locally under the same name, and its call sites are what get listed.
 */
function insideNamedSkipHelper(node: ts.Node): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined;
    current = current.parent
  ) {
    if (
      ts.isFunctionDeclaration(current) &&
      (current.name?.text === 'assertWithinBudget' || current.name?.text === 'skipNamed')
    ) {
      return true;
    }
  }
  return false;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** Every skip in one file's text, with the verdict on each. */
export function checkSource(file: string, text: string): readonly SkipSite[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declared = annotations(text);
  const sites: SkipSite[] = [];

  function named(name: string): { reason: string | null; problem: string | null } {
    const reason = declared.get(name) ?? null;
    return {
      reason,
      problem:
        reason === null
          ? `no \`// perf-skip: ${name} — <reason>\` comment declares why ${name} skips`
          : null,
    };
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (method === 'skipIf') {
          const [argument] = node.arguments;
          const line = lineOf(source, node);
          const parent = node.parent;
          const titled =
            ts.isCallExpression(parent) && parent.expression === node ? parent.arguments[0] : null;
          const title =
            titled !== null && titled !== undefined && ts.isStringLiteralLike(titled)
              ? titled.text
              : null;
          const appliesToIt =
            ts.isCallExpression(parent) &&
            parent.expression === node &&
            ts.isPropertyAccessExpression(callee.expression) === false &&
            ts.isIdentifier(callee.expression) &&
            (callee.expression.text === 'it' || callee.expression.text === 'test');
          if (argument === undefined || !ts.isIdentifier(argument)) {
            sites.push({
              file,
              line,
              form: 'skipIf',
              name: null,
              reason: null,
              problem:
                'skipIf has no named condition: pass a bare identifier (a const declared in this ' +
                'file or imported), never an inline expression',
            });
          } else {
            const verdict = named(argument.text);
            const sanity =
              appliesToIt && title !== null && SANITY_TITLE.test(title)
                ? `the row-count sanity check ("${title}") must never skip`
                : null;
            sites.push({
              file,
              line,
              form: 'skipIf',
              name: argument.text,
              reason: verdict.reason,
              problem: sanity ?? verdict.problem,
            });
          }
        } else if (
          method === 'todo' ||
          (method === 'skip' &&
            ts.isIdentifier(callee.expression) &&
            ['it', 'test', 'describe'].includes(callee.expression.text))
        ) {
          sites.push({
            file,
            line: lineOf(source, node),
            form: 'unconditional',
            name: null,
            reason: null,
            problem: `\`${callee.expression.getText(source)}.${method}\` skips with no condition and no name: use skipIf(NAME) with a perf-skip comment`,
          });
        } else if (
          method === 'skip' &&
          ts.isIdentifier(callee.expression) &&
          SKIP_CONTEXT_NAMES.has(callee.expression.text) &&
          !insideNamedSkipHelper(node)
        ) {
          sites.push({
            file,
            line: lineOf(source, node),
            form: 'unconditional',
            name: null,
            reason: null,
            problem:
              `\`${callee.expression.text}.skip(…)\` skips from inside a test body with no ` +
              'declared name: use skipNamed(ctx, "NAME", detail), assertWithinBudget, or skipIf(NAME)',
          });
        }
      } else if (ts.isIdentifier(callee) && callee.text === 'skipNamed') {
        const [, nameArgument] = node.arguments;
        const line = lineOf(source, node);
        if (nameArgument === undefined || !ts.isStringLiteralLike(nameArgument)) {
          sites.push({
            file,
            line,
            form: 'skipNamed',
            name: null,
            reason: null,
            problem: "skipNamed's second argument must be a string literal naming the skip",
          });
        } else {
          const verdict = named(nameArgument.text);
          sites.push({
            file,
            line,
            form: 'skipNamed',
            name: nameArgument.text,
            reason: verdict.reason,
            problem: verdict.problem,
          });
        }
      } else if (ts.isIdentifier(callee) && callee.text === 'assertWithinBudget') {
        const verdict = named(HOST_LOADED);
        sites.push({
          file,
          line: lineOf(source, node),
          form: 'load-conditional',
          name: HOST_LOADED,
          reason: verdict.reason,
          problem: verdict.problem,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return sites;
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'coverage', '.turbo']);

export function isPerfFile(path: string, text: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (!base.endsWith('.test.ts')) return false;
  return /perf/i.test(base) || text.includes('[slow]');
}

function walk(directory: string, out: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(join(directory, entry.name), out);
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(join(directory, entry.name));
    }
  }
}

export interface TreeResult {
  readonly perfFiles: readonly string[];
  readonly sites: readonly SkipSite[];
}

export function checkTree(root: string): TreeResult {
  const candidates: string[] = [];
  for (const top of ['apps', 'packages']) {
    try {
      walk(join(root, top), candidates);
    } catch {
      // A checkout without that directory has nothing to scan there.
    }
  }
  candidates.sort();
  const perfFiles: string[] = [];
  const sites: SkipSite[] = [];
  for (const path of candidates) {
    const text = readFileSync(path, 'utf8');
    const rel = relative(root, path).split('\\').join('/');
    if (!isPerfFile(rel, text)) continue;
    perfFiles.push(rel);
    sites.push(...checkSource(rel, text));
  }
  return { perfFiles, sites };
}

export function formatList(result: TreeResult): string {
  const lines = [
    `check-perf-skips: ${String(result.perfFiles.length)} perf file(s), ${String(result.sites.length)} skip site(s)`,
  ];
  for (const site of result.sites) {
    const where = `${site.file}:${String(site.line)}`;
    const what = site.name === null ? `(${site.form})` : `${site.form} ${site.name}`;
    lines.push(
      site.problem === null
        ? `  ${where}  ${what} — ${site.reason ?? ''}`
        : `  ${where}  ${what} — FAIL: ${site.problem}`,
    );
  }
  return lines.join('\n');
}

export function formatSummary(result: TreeResult): string {
  const failing = result.sites.filter((site) => site.problem !== null).length;
  const rows = result.sites.map(
    (site) =>
      `| \`${site.file}:${String(site.line)}\` | ${site.form} | ${site.name === null ? '—' : `\`${site.name}\``} | ` +
      `${site.problem === null ? (site.reason ?? '') : `**FAIL: ${site.problem}**`} |`,
  );
  return [
    '### Perf skips (WP 9.9)',
    '',
    `${String(result.perfFiles.length)} perf file(s); ${String(result.sites.length)} skip site(s); ${String(failing)} without a named reason.`,
    '',
    '| Site | Form | Name | Reason |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The check, checked: fixtures first (a rule nobody has watched fail is a claim)
// ---------------------------------------------------------------------------

export const BARE_SKIP_FIXTURE = [
  "import { describe, it } from 'vitest';",
  "describe.skipIf(process.env['CI'] !== undefined)('[slow] budget', () => {",
  "  it('is fast', () => {});",
  '});',
].join('\n');

export const NAMED_SKIP_FIXTURE = [
  "import { describe, it } from 'vitest';",
  '// perf-skip: ON_SHARED_RUNNER — a shared CI runner is not the target hardware (09 §6 Q1)',
  "const ON_SHARED_RUNNER = process.env['CI'] !== undefined;",
  "describe('[slow] budget', () => {",
  "  it.skipIf(ON_SHARED_RUNNER)('p95 < 200 ms', () => {});",
  '});',
].join('\n');

export function runSelfTest(): readonly string[] {
  const failures: string[] = [];
  const bare = checkSource('bare.test.ts', BARE_SKIP_FIXTURE);
  if (bare.length !== 1 || bare[0]?.problem === null) {
    failures.push('a bare skipIf(<expression>) was not flagged');
  }
  const named = checkSource('named.test.ts', NAMED_SKIP_FIXTURE);
  if (named.length !== 1 || named[0]?.problem !== null) {
    failures.push('a named, annotated skipIf was flagged');
  }
  const undeclared = checkSource(
    'undeclared.test.ts',
    NAMED_SKIP_FIXTURE.replace(/^\/\/ perf-skip:.*\n/m, ''),
  );
  if (undeclared[0]?.problem === null || undeclared[0] === undefined) {
    failures.push('a named skipIf with no perf-skip comment was not flagged');
  }
  const sanity = checkSource(
    'sanity.test.ts',
    NAMED_SKIP_FIXTURE.replace('p95 < 200 ms', 'the row count is actually in the database'),
  );
  if (sanity[0]?.problem === null || sanity[0] === undefined) {
    failures.push('a skipIf on a row-count sanity check was not flagged');
  }
  return failures;
}

function main(): number {
  if (process.argv.includes('--self-test')) {
    const failures = runSelfTest();
    if (failures.length > 0) {
      for (const failure of failures) console.error(`check-perf-skips self-test FAIL: ${failure}`);
      return 1;
    }
    console.log('check-perf-skips: SELF-TEST PASS');
    return 0;
  }
  const root = join(import.meta.dirname, '..');
  const result = checkTree(root);
  const failing = result.sites.filter((site) => site.problem !== null);
  console.log(process.argv.includes('--summary') ? formatSummary(result) : formatList(result));
  if (failing.length > 0) {
    console.error(
      `check-perf-skips: FAIL — ${String(failing.length)} skip(s) without a named reason`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exit(main());
}
