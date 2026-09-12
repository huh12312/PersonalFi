// SPDX-License-Identifier: MIT
/**
 * Schema-ownership check.
 *
 * Exactly one package may own a table. This script is the mechanism behind that
 * sentence: it reads every `OWNERSHIP.md`, every Drizzle `pgTable(...)` call, and
 * every `CREATE TABLE` in the migration history, and fails if
 *
 *   * a table is claimed by two packages,
 *   * a table is defined or created without being claimed,
 *   * a table is defined in a package that does not own it, or
 *   * a package's SQL reads or writes a table another package owns.
 *
 * Import lint (`personalfi/layer-imports`) stops one context calling into
 * another's *code*. This stops it reaching around the side and into another
 * context's *tables*, which is the failure mode that actually happens: it starts
 * as one innocent JOIN and ends with two packages that can never be changed
 * independently again.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SCAN_ROOTS = ['packages', 'apps'];
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages', 'db', 'migrations');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.drizzle']);

/** Packages that wire things together and are not expected to own tables. */
const NON_OWNING_PREFIXES = ['apps/'];

interface Claim {
  readonly table: string;
  readonly packageName: string;
  readonly packageDir: string;
  readonly source: string;
}

interface Finding {
  readonly file: string;
  readonly message: string;
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function walk(dir: string, onFile: (path: string) => void): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, onFile);
    else onFile(path);
  }
}

function packageDirOf(absolutePath: string): string | null {
  let current = dirname(absolutePath);
  while (current.startsWith(REPO_ROOT) && current !== REPO_ROOT) {
    try {
      statSync(join(current, 'package.json'));
      return current;
    } catch {
      current = dirname(current);
    }
  }
  return null;
}

function packageNameOf(packageDir: string): string {
  const raw = readFileSync(join(packageDir, 'package.json'), 'utf8');
  return (JSON.parse(raw) as { name?: string }).name ?? toPosix(relative(REPO_ROOT, packageDir));
}

/** Table names listed under the `## Tables` heading of an OWNERSHIP.md. */
function parseOwnership(path: string): string[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const tables: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inSection = line.trim().toLowerCase() === '## tables';
      continue;
    }
    if (!inSection) continue;
    const match = /^-\s+`([a-z0-9_]+)`/.exec(line.trim());
    if (match?.[1] !== undefined) tables.push(match[1]);
  }
  return tables;
}

const PG_TABLE = /pgTable\(\s*['"`]([a-z0-9_]+)['"`]/gi;
const CREATE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z0-9_]+)"?/gi;
const SQL_REFERENCE =
  /\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z][a-z0-9_]*)"?/gi;

function main(): number {
  const claims = new Map<string, Claim>();
  const findings: Finding[] = [];

  // 1. Collect claims.
  for (const root of SCAN_ROOTS) {
    walk(join(REPO_ROOT, root), (path) => {
      if (!path.endsWith(`${sep}OWNERSHIP.md`)) return;
      const packageDir = packageDirOf(path);
      if (packageDir === null) return;
      const packageName = packageNameOf(packageDir);
      const source = toPosix(relative(REPO_ROOT, path));
      for (const table of parseOwnership(path)) {
        const existing = claims.get(table);
        if (existing !== undefined) {
          findings.push({
            file: source,
            message:
              `table '${table}' is claimed by both ${existing.packageName} (${existing.source}) ` +
              `and ${packageName}. Exactly one package may own a table; decide which, and give ` +
              'the other a read model or an event.',
          });
          continue;
        }
        claims.set(table, { table, packageName, packageDir, source });
      }
    });
  }

  const ownerOf = (table: string): Claim | undefined => claims.get(table);

  // 2. Drizzle table definitions must live in the owning package.
  const definedIn = new Map<string, string>();
  for (const root of SCAN_ROOTS) {
    walk(join(REPO_ROOT, root), (path) => {
      if (!path.endsWith('.ts') || path.endsWith('.d.ts')) return;
      const contents = readFileSync(path, 'utf8');
      const file = toPosix(relative(REPO_ROOT, path));
      const packageDir = packageDirOf(path);
      const packageName = packageDir === null ? file : packageNameOf(packageDir);

      for (const match of contents.matchAll(PG_TABLE)) {
        const table = match[1];
        if (table === undefined) continue;
        const previous = definedIn.get(table);
        if (previous !== undefined && previous !== file) {
          findings.push({
            file,
            message: `table '${table}' is also defined in ${previous}. One table, one definition.`,
          });
        }
        definedIn.set(table, file);

        const owner = ownerOf(table);
        if (owner === undefined) {
          findings.push({
            file,
            message:
              `table '${table}' is defined but no OWNERSHIP.md claims it. ` +
              `Add it to ${packageName}'s OWNERSHIP.md under '## Tables'.`,
          });
        } else if (owner.packageName !== packageName) {
          findings.push({
            file,
            message:
              `table '${table}' is owned by ${owner.packageName} (${owner.source}) but is defined ` +
              `here in ${packageName}. Move the definition, or move the claim.`,
          });
        }
      }

      // 3. Raw SQL must not reach into another package's tables.
      //
      // Tests are exempt: a migration test has to assert that `users` exists, and
      // a test fixture that seeds another context's table creates no runtime
      // coupling. Table *ownership* above is still enforced in test files.
      if (file.endsWith('.test.ts') || /(^|\/)test\//.test(rel)) return;
      if (NON_OWNING_PREFIXES.some((prefix) => file.startsWith(prefix))) return;
      for (const match of contents.matchAll(SQL_REFERENCE)) {
        const table = match[1];
        if (table === undefined) continue;
        const owner = ownerOf(table);
        if (owner === undefined || owner.packageName === packageName) continue;
        findings.push({
          file,
          message:
            `raw SQL references '${table}', which is owned by ${owner.packageName}. ` +
            "Go through that context's reader or consume its events instead.",
        });
      }
    });
  }

  // 4. Every table the migrations create must be claimed.
  for (const entry of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!entry.endsWith('.sql')) continue;
    const file = toPosix(relative(REPO_ROOT, join(MIGRATIONS_DIR, entry)));
    const sql = readFileSync(join(MIGRATIONS_DIR, entry), 'utf8');
    for (const match of sql.matchAll(CREATE_TABLE)) {
      const table = match[1];
      if (table === undefined) continue;
      if (ownerOf(table) === undefined) {
        findings.push({
          file,
          message:
            `migration creates table '${table}' but no OWNERSHIP.md claims it. ` +
            'Every table has exactly one owning package; say which.',
        });
      }
    }
  }

  if (findings.length > 0) {
    process.stderr.write(`schema-ownership: ${findings.length} problem(s)\n\n`);
    for (const finding of findings) {
      process.stderr.write(`  ${finding.file}\n    ${finding.message}\n\n`);
    }
    process.stderr.write('See docs/CONVENTIONS.md, "Table ownership".\n');
    return 1;
  }

  process.stdout.write(
    `schema-ownership: ok — ${claims.size} table(s) claimed across ` +
      `${new Set([...claims.values()].map((c) => c.packageName)).size} package(s), ` +
      `${definedIn.size} defined.\n`,
  );
  return 0;
}

process.exit(main());
