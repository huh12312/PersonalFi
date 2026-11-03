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
import { classifyExpression, loadPolicy, type Policy } from './license-policy.ts';
import { analyzePython, readPythonInputs, renderPythonSection } from './python-licenses.ts';

const REPO_ROOT = join(import.meta.dirname, '..');
const POLICY_PATH = join(REPO_ROOT, 'licenses.policy.yaml');
const THIRD_PARTY_PATH = join(REPO_ROOT, 'THIRD_PARTY.md');

interface LicensePackage {
  readonly name: string;
  readonly versions: string[];
  readonly license: string;
  readonly homepage?: string;
}

type LicenseReport = Record<string, LicensePackage[]>;

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

function renderThirdParty(
  prodReport: LicenseReport,
  generatedAt: string,
  pythonSection: readonly string[],
): string {
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
    'The web app also vendors the colour values of Radix Colors 3.0.0 (`@radix-ui/colors`,',
    'https://github.com/radix-ui/colors), MIT License, Copyright (c) 2021 Radix: the sRGB steps of the',
    '`sand` scale and thirteen hue scales, in `apps/web/src/styles/tokens/radix-colors.ts` (which',
    'reproduces the licence) and the generated `apps/web/src/styles/tokens.css` / `tokens.ts`. It is',
    'not an npm dependency, so it is not in the tree below.',
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

  // WP 12.6: the second tree, the yahoo sidecar's pinned Python closure.
  lines.push(...pythonSection);

  return `${lines.join('\n').trimEnd()}\n`;
}

function main(): number {
  const policy = loadPolicy(POLICY_PATH);
  const prodReport = runPnpmLicenses(['--prod']);
  const devReport = runPnpmLicenses(['--dev']);

  const prodResult = analyze(prodReport, policy, 'prod');
  const devResult = analyze(devReport, policy, 'dev');

  // WP 12.6: the yahoo sidecar's Python dependencies, held to the same policy.
  const python = readPythonInputs();
  const pythonResult = analyzePython(python.pins, python.map, policy);

  const thirdParty = renderThirdParty(
    prodReport,
    lockfileStamp(),
    renderPythonSection(pythonResult, python.map),
  );
  writeFileSync(THIRD_PARTY_PATH, thirdParty);

  const prodCount = Object.values(prodReport).reduce((sum, pkgs) => sum + pkgs.length, 0);
  const devCount = Object.values(devReport).reduce((sum, pkgs) => sum + pkgs.length, 0);
  console.log(
    `license gate: ${prodCount} prod package entries, ${devCount} dev package entries, ` +
      `${python.pins.length} Python packages (the yahoo sidecar) checked`,
  );
  if (pythonResult.reviews.length > 0) {
    console.log('\nPython allowed-with-review (recorded in THIRD_PARTY.md, not a failure):');
    for (const review of pythonResult.reviews) {
      console.log(
        `  - ${review.name}==${review.version} (${review.license}): ${review.review ?? ''}`,
      );
    }
  }

  if (prodResult.reviews.length > 0) {
    console.log('\nallowed-with-review (recorded in THIRD_PARTY.md, not a failure):');
    for (const review of prodResult.reviews) {
      console.log(`  - ${review.packageName}@${review.version} (${review.license})`);
    }
  }

  const allViolations = [...prodResult.violations, ...devResult.violations];
  if (allViolations.length > 0 || pythonResult.violations.length > 0) {
    console.error('\nlicense gate: FAIL\n');
    for (const violation of pythonResult.violations) console.error(`  [python] ${violation}`);
    for (const violation of allViolations) {
      console.error(
        `  [${violation.scope}] ${violation.packageName}@${violation.version} — ${violation.license}: ${violation.reason}`,
      );
    }
    console.error(
      `\n${allViolations.length + pythonResult.violations.length} violation(s). See licenses.policy.yaml.`,
    );
    return 1;
  }

  console.log('\nlicense gate: PASS');
  console.log(`THIRD_PARTY.md regenerated.`);
  return 0;
}

process.exit(main());
