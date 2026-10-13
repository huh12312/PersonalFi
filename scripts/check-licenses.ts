#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * License gate (memo 06 §5.4, master plan D15, `just licenses` / CI's
 * `license-gate` job).
 *
 * Reads `licenses.policy.yaml` — the single source of truth shared by this
 * script and the humans reading it — and checks it against
 * `pnpm licenses list --json --prod` (the runtime dependency tree, across
 * every workspace project) and `--json --dev` (informational; devDependencies
 * are exempt from the copyleft checks but not from the UNKNOWN rule or the
 * named-package deny-list). Regenerates `THIRD_PARTY.md` from the prod tree
 * on every run, pass or fail, so a diff always reflects the current lockfile.
 *
 * No YAML/JSON-schema dependency: `.npmrc` disables install scripts and
 * nothing in this repo may re-enable them (D14), so this script hand-parses
 * the one flat-list shape `licenses.policy.yaml` actually uses rather than
 * pull in a parser as a new runtime dependency for a WP that is itself about
 * tightening the dependency surface.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const POLICY_PATH = join(REPO_ROOT, 'licenses.policy.yaml');
const THIRD_PARTY_PATH = join(REPO_ROOT, 'THIRD_PARTY.md');

interface Policy {
  readonly allow: string[];
  readonly reviewRequired: string[];
  readonly deny: string[];
  readonly denyPackages: string[];
}

interface LicensePackage {
  readonly name: string;
  readonly versions: string[];
  readonly license: string;
  readonly homepage?: string;
}

type LicenseReport = Record<string, LicensePackage[]>;

type Classification = 'allow' | 'review' | 'deny' | 'unknown';

interface Violation {
  readonly scope: 'prod' | 'dev';
  readonly packageName: string;
  readonly version: string;
  readonly license: string;
  readonly reason: string;
}

interface Review {
  readonly packageName: string;
  readonly version: string;
  readonly license: string;
}

/**
 * Parses exactly the shape `licenses.policy.yaml` uses: top-level
 * `key:` followed by `  - item` lines. Not a general YAML parser.
 */
function parseSimpleYamlLists(text: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  let currentKey: string | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (line.trim() === '') continue;

    const listItemMatch = /^\s*-\s*(.+)$/.exec(line);
    if (listItemMatch) {
      if (currentKey === null) {
        throw new Error(`licenses.policy.yaml: list item with no preceding key: "${rawLine}"`);
      }
      const value = listItemMatch[1]?.trim();
      if (value !== undefined && value.length > 0) {
        result[currentKey]?.push(value);
      }
      continue;
    }

    const keyMatch = /^([A-Za-z][\w-]*):\s*$/.exec(line);
    if (keyMatch?.[1] !== undefined) {
      currentKey = keyMatch[1];
      result[currentKey] = [];
      continue;
    }

    throw new Error(`licenses.policy.yaml: could not parse line: "${rawLine}"`);
  }

  return result;
}

function loadPolicy(path: string): Policy {
  const raw = parseSimpleYamlLists(readFileSync(path, 'utf8'));
  return {
    allow: raw['allow'] ?? [],
    reviewRequired: raw['reviewRequired'] ?? [],
    deny: raw['deny'] ?? [],
    denyPackages: raw['denyPackages'] ?? [],
  };
}

function runPnpmLicenses(extraArgs: string[]): LicenseReport {
  const result = spawnSync('pnpm', ['licenses', 'list', '--json', ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(
      `pnpm licenses list ${extraArgs.join(' ')} exited with ${String(result.status)}`,
    );
  }
  return JSON.parse(result.stdout) as LicenseReport;
}

/** Splits an SPDX-ish compound expression ("MIT AND ISC", "(MIT OR CC0-1.0)") into parts. */
function splitLicenseExpression(expression: string): string[] {
  return expression
    .replace(/[()]/g, ' ')
    .split(/\s+(?:AND|OR|and|or)\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Prefix match so a deny entry like `GPL-2.0` also catches `GPL-2.0-only` / `GPL-2.0-or-later`. */
function matchesAny(id: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => id === candidate || id.startsWith(candidate));
}

function classifyExpression(expression: string, policy: Policy): Classification {
  const parts = splitLicenseExpression(expression);
  if (parts.length === 0) return 'unknown';

  const classifications = parts.map((part): Classification => {
    if (matchesAny(part, policy.deny)) return 'deny';
    if (matchesAny(part, policy.allow)) return 'allow';
    if (matchesAny(part, policy.reviewRequired)) return 'review';
    return 'unknown';
  });

  if (classifications.includes('deny')) return 'deny';
  if (classifications.includes('unknown')) return 'unknown';
  if (classifications.includes('review')) return 'review';
  return 'allow';
}

function analyze(
  report: LicenseReport,
  policy: Policy,
  scope: 'prod' | 'dev',
): { violations: Violation[]; reviews: Review[] } {
  const violations: Violation[] = [];
  const reviews: Review[] = [];

  for (const [licenseExpr, packages] of Object.entries(report)) {
    for (const pkg of packages) {
      const version = pkg.versions[0] ?? 'unknown';

      if (policy.denyPackages.includes(pkg.name)) {
        violations.push({
          scope,
          packageName: pkg.name,
          version,
          license: licenseExpr,
          reason:
            'package name is on the license-policy deny-list (licenses.policy.yaml denyPackages)',
        });
        continue;
      }

      const classification = classifyExpression(licenseExpr, policy);

      if (scope === 'dev') {
        // devDependencies are exempt from the allow/review/deny copyleft
        // scoping (we do not distribute them) but never from UNKNOWN.
        if (classification === 'unknown') {
          violations.push({
            scope,
            packageName: pkg.name,
            version,
            license: licenseExpr,
            reason:
              'license is UNKNOWN/unparseable (devDependencies are not exempt from this rule)',
          });
        }
        continue;
      }

      if (classification === 'deny') {
        violations.push({
          scope,
          packageName: pkg.name,
          version,
          license: licenseExpr,
          reason: 'license is on the deny list',
        });
      } else if (classification === 'unknown') {
        violations.push({
          scope,
          packageName: pkg.name,
          version,
          license: licenseExpr,
          reason: 'license is UNKNOWN/unparseable in the runtime tree',
        });
      } else if (classification === 'review') {
        reviews.push({ packageName: pkg.name, version, license: licenseExpr });
      }
    }
  }

  return { violations, reviews };
}

/**
 * Provenance stamp for the generated artifact.
 *
 * Deliberately NOT a wall-clock date. It used to be
 * `new Date().toISOString().slice(0, 10)`, and CI regenerates this file and
 * runs `git diff --exit-code` on it — so from the day after it was committed,
 * every PR failed the license gate on a one-line date diff whether or not a
 * single dependency had changed (M-6). The fastest way out of that is deleting
 * the drift check, which is the control; the right way is to stamp the input
 * instead of the moment.
 *
 * The lockfile hash is exactly the right input: it changes if and only if the
 * dependency tree changed, which is the only thing that can change this file's
 * contents. A drift now means real drift.
 */
function lockfileStamp(): string {
  const lockfile = readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'));
  const digest = createHash('sha256').update(lockfile).digest('hex');
  return `pnpm-lock.yaml sha256:${digest.slice(0, 16)}`;
}

function renderThirdParty(prodReport: LicenseReport, generatedAt: string): string {
  const lines: string[] = [
    '<!-- SPDX-License-Identifier: MIT -->',
    '<!-- Generated by scripts/check-licenses.ts (`just licenses`). Do not hand-edit: -->',
    '<!-- a diff here means the lockfile changed and this file did not; regenerate it. -->',
    '',
    '# Third-Party Notices',
    '',
    'PersonalFi is MIT-licensed. This file lists the runtime (production) dependency tree —',
    `\`pnpm licenses list --prod\` across the whole workspace — generated from ${generatedAt}.`,
    'devDependencies (build tooling, test frameworks) are not distributed and are not listed',
    'here; see `licenses.policy.yaml` for the policy that governs both.',
    '',
    'The optional `vibe-trading` sidecar (Phase 6, not yet built) is a separately-licensed',
    'upstream project (MIT) distributed as its own container image; its dependencies are not',
    'part of PersonalFi’s dependency tree and are not listed here.',
    '',
    'The optional `ollama` local-model runtime (Phase 5, profile `local-llm`) is the upstream',
    '`ollama/ollama` image (MIT), pinned by digest in `compose.yml`',
    '(`ollama/ollama:0.34.2@sha256:da6e0dc5651df159e45686fd663c4dbe1624a52c44d7280eeac1551d8f865532`),',
    'distributed as its own container image; its dependencies are not part of PersonalFi’s',
    'dependency tree and are not listed here. The model weights it serves are data the operator',
    'pulls (`local-llm-pull`), not something this repository redistributes; the reference model,',
    '`qwen2.5:7b-instruct-q4_K_M`, is Apache-2.0.',
    '',
    'The web app vendors two typefaces, not npm packages, so they are not in the tree below:',
    'Geist and Geist Mono (variable woff2, Google Fonts `latin` subset), Copyright 2024 The Geist',
    'Project Authors (https://github.com/vercel/geist-font), SIL Open Font License 1.1. They are',
    'served from `apps/web/public/fonts/`, which also holds the licence text (`OFL-Geist.txt`) and a',
    'README with the source URLs and sha256 of each file.',
    '',
  ];

  const entries = Object.entries(prodReport).sort(([a], [b]) => a.localeCompare(b));
  for (const [license, packages] of entries) {
    lines.push(`## ${license}`, '');
    const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name));
    for (const pkg of sorted) {
      const version = pkg.versions.join(', ');
      const homepage =
        pkg.homepage !== undefined && pkg.homepage.length > 0 ? ` — ${pkg.homepage}` : '';
      lines.push(`- \`${pkg.name}\`@${version}${homepage}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function main(): number {
  const policy = loadPolicy(POLICY_PATH);
  const prodReport = runPnpmLicenses(['--prod']);
  const devReport = runPnpmLicenses(['--dev']);

  const prodResult = analyze(prodReport, policy, 'prod');
  const devResult = analyze(devReport, policy, 'dev');

  const thirdParty = renderThirdParty(prodReport, lockfileStamp());
  writeFileSync(THIRD_PARTY_PATH, thirdParty);

  const prodCount = Object.values(prodReport).reduce((sum, pkgs) => sum + pkgs.length, 0);
  const devCount = Object.values(devReport).reduce((sum, pkgs) => sum + pkgs.length, 0);
  console.log(
    `license gate: ${prodCount} prod package entries, ${devCount} dev package entries checked`,
  );

  if (prodResult.reviews.length > 0) {
    console.log('\nallowed-with-review (recorded in THIRD_PARTY.md, not a failure):');
    for (const review of prodResult.reviews) {
      console.log(`  - ${review.packageName}@${review.version} (${review.license})`);
    }
  }

  const allViolations = [...prodResult.violations, ...devResult.violations];
  if (allViolations.length > 0) {
    console.error('\nlicense gate: FAIL\n');
    for (const violation of allViolations) {
      console.error(
        `  [${violation.scope}] ${violation.packageName}@${violation.version} — ${violation.license}: ${violation.reason}`,
      );
    }
    console.error(`\n${allViolations.length} violation(s). See licenses.policy.yaml.`);
    return 1;
  }

  console.log('\nlicense gate: PASS');
  console.log(`THIRD_PARTY.md regenerated.`);
  return 0;
}

process.exit(main());
