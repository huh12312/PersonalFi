// SPDX-License-Identifier: MIT
/**
 * The licence gate for the yahoo sidecar's Python dependencies (WP 12.6).
 *
 * `check-licenses.ts` covers the npm tree through `pnpm licenses list`. The
 * sidecar (`docker/yahoo.Dockerfile`) installs a second tree, from PyPI, pinned
 * by version and sha256 in `docker/yahoo/requirements.txt`. Its licences are
 * recorded in `docker/yahoo/licenses.json` (each read from the pinned wheel's
 * own METADATA), and this module holds that record to the same policy as the
 * npm tree — `licenses.policy.yaml`, through the one classifier in
 * `license-policy.ts`:
 *
 *   - every pinned package has a recorded licence (none recorded ⇒ UNKNOWN,
 *     a failure, as 06 §5.4 says: "a dependency with no declared licence is
 *     … all-rights-reserved by default");
 *   - every recorded licence is allowed, or allowed-with-review (MPL-2.0,
 *     LGPL-*: listed, with the one-line reason from `reviews`, which must be
 *     present), never denied (GPL, AGPL, SSPL, …);
 *   - no package on `denyPackages`;
 *   - no recorded licence for a package that is not pinned (a stale map is
 *     how the record stops describing the image).
 *
 * The sidecar runs as its own container from its own image, so these are
 * "runtime" dependencies in the policy's sense: the copyleft rules apply.
 * `check-licenses.ts` runs this as part of `just licenses` and CI's license
 * gate, and renders `renderPythonSection` into THIRD_PARTY.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyExpression, type Policy } from './license-policy.ts';

const REPO_ROOT = join(import.meta.dirname, '..');
export const REQUIREMENTS_PATH = join(REPO_ROOT, 'docker', 'yahoo', 'requirements.txt');
export const LICENSE_MAP_PATH = join(REPO_ROOT, 'docker', 'yahoo', 'licenses.json');

export interface PythonPin {
  readonly name: string;
  readonly version: string;
}

export interface PythonLicenseMap {
  readonly packages: Readonly<Record<string, string>>;
  readonly reviews: Readonly<Record<string, string>>;
}

export interface PythonEntry extends PythonPin {
  readonly license: string;
  readonly review: string | null;
}

export interface PythonResult {
  readonly entries: readonly PythonEntry[];
  readonly violations: readonly string[];
  readonly reviews: readonly PythonEntry[];
}

/** PEP 503 normalisation: `Typing_Extensions` and `typing-extensions` are one package. */
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** `name==version` from each requirement line; hashes, comments and continuations ignored. */
export function parseRequirements(text: string): PythonPin[] {
  const pins: PythonPin[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '' || line.startsWith('--')) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\;]+)/.exec(line);
    if (match === null) throw new Error(`requirements.txt: not a name==version pin: "${raw}"`);
    pins.push({ name: normaliseName(match[1] ?? ''), version: match[2] ?? '' });
  }
  return pins;
}

export function parseLicenseMap(text: string): PythonLicenseMap {
  const parsed = JSON.parse(text) as { packages?: unknown; reviews?: unknown };
  const record = (value: unknown): Record<string, string> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') out[normaliseName(key)] = entry;
    }
    return out;
  };
  return { packages: record(parsed.packages), reviews: record(parsed.reviews) };
}

export function analyzePython(
  pins: readonly PythonPin[],
  map: PythonLicenseMap,
  policy: Policy,
): PythonResult {
  const entries: PythonEntry[] = [];
  const violations: string[] = [];
  const reviews: PythonEntry[] = [];
  const pinned = new Set(pins.map((pin) => pin.name));
  const denied = new Set(policy.denyPackages.map(normaliseName));

  for (const pin of pins) {
    const license = map.packages[pin.name];
    if (denied.has(pin.name)) {
      violations.push(
        `${pin.name}==${pin.version}: on the licence-policy deny-list (denyPackages)`,
      );
    }
    if (license === undefined || license.trim() === '') {
      violations.push(
        `${pin.name}==${pin.version}: UNKNOWN — no licence recorded in docker/yahoo/licenses.json`,
      );
      continue;
    }
    const review = map.reviews[pin.name] ?? null;
    const entry: PythonEntry = { ...pin, license, review };
    entries.push(entry);
    switch (classifyExpression(license, policy)) {
      case 'deny':
        violations.push(`${pin.name}==${pin.version} — ${license}: license is on the deny list`);
        break;
      case 'unknown':
        violations.push(`${pin.name}==${pin.version} — ${license}: license is UNKNOWN/unparseable`);
        break;
      case 'review':
        if (review === null) {
          violations.push(
            `${pin.name}==${pin.version} — ${license}: allowed with review, but no reason is recorded under "reviews"`,
          );
        }
        reviews.push(entry);
        break;
      case 'allow':
        break;
    }
  }
  for (const name of Object.keys(map.packages)) {
    if (!pinned.has(name)) {
      violations.push(`${name}: a licence is recorded for a package requirements.txt does not pin`);
    }
  }
  return { entries, violations, reviews };
}

export function readPythonInputs(): { pins: PythonPin[]; map: PythonLicenseMap } {
  return {
    pins: parseRequirements(readFileSync(REQUIREMENTS_PATH, 'utf8')),
    map: parseLicenseMap(readFileSync(LICENSE_MAP_PATH, 'utf8')),
  };
}

/** The THIRD_PARTY.md section, from the pins and the record. Deterministic. */
export function renderPythonSection(result: PythonResult, map: PythonLicenseMap): string[] {
  const lines: string[] = [
    '# Python (the yahoo sidecar)',
    '',
    'The optional `yahoo` sidecar (WP 12.6, compose profile `yahoo`: Yahoo Finance through',
    '`yfinance`, opt-in, unofficial, best effort) is PersonalFi’s own image, `personalfi-yahoo`,',
    'and installs this Python tree from `docker/yahoo/requirements.txt`, every package pinned by',
    'version and sha256. Licences are recorded in `docker/yahoo/licenses.json` from each wheel’s',
    'own metadata and checked against `licenses.policy.yaml` by `scripts/python-licenses.ts`.',
    'The data Yahoo serves is not covered by any of these licences: Yahoo publishes none',
    '(docs/research/14 §2).',
    '',
    'Bundled native libraries, recorded rather than gated (the gate reads each package’s declared',
    'licence): numpy’s and pandas’s musllinux wheels carry the GCC runtime (libgcc_s, libstdc++;',
    'numpy also libgfortran, libquadmath and OpenBLAS), which numpy’s own LICENSE.txt records as',
    '`GPL-3.0-or-later WITH GCC-exception-3.1`, dynamically linked — the exception that lets any',
    'program ship it, and the same runtime Alpine’s libgcc and libstdc++ packages carry in every',
    'image here.',
    '',
  ];
  const byLicense = new Map<string, PythonEntry[]>();
  for (const entry of result.entries) {
    const list = byLicense.get(entry.license) ?? [];
    list.push(entry);
    byLicense.set(entry.license, list);
  }
  for (const [license, entries] of [...byLicense].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## Python: ${license}`, '');
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- \`${entry.name}\`==${entry.version}`);
    }
    lines.push('');
  }
  const reviewNames = Object.keys(map.reviews).sort();
  if (reviewNames.length > 0) {
    lines.push('## Python: allowed with review (06 §5.4)', '');
    for (const name of reviewNames) lines.push(`- \`${name}\`: ${map.reviews[name] ?? ''}`);
    lines.push('');
  }
  return lines;
}
