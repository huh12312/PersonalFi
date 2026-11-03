// SPDX-License-Identifier: MIT
/**
 * WP 12.6: the Python licence gate (the yahoo sidecar's pinned closure).
 *
 * The real `docker/yahoo/requirements.txt` and `licenses.json` against the
 * real `licenses.policy.yaml` pass; every way the record could go wrong — a
 * GPL entry, a package with no recorded licence, an LGPL entry with no reason,
 * a deny-listed name, a stale entry — fails, through the same classifier the
 * npm gate uses.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPolicy } from './license-policy.ts';
import {
  analyzePython,
  normaliseName,
  parseRequirements,
  readPythonInputs,
  renderPythonSection,
  type PythonLicenseMap,
} from './python-licenses.ts';

const POLICY = loadPolicy(join(import.meta.dirname, '..', 'licenses.policy.yaml'));
const REAL = readPythonInputs();

function withEntry(map: PythonLicenseMap, name: string, license: string): PythonLicenseMap {
  return { ...map, packages: { ...map.packages, [name]: license } };
}

describe('the Python licence gate (WP 12.6)', () => {
  it('the pinned closure as recorded passes, with certifi (MPL-2.0) listed for review', () => {
    const result = analyzePython(REAL.pins, REAL.map, POLICY);
    expect(result.violations).toEqual([]);
    expect(REAL.pins.find((pin) => pin.name === 'yfinance')).toEqual({
      name: 'yfinance',
      version: '1.7.0',
    });
    expect(result.entries).toHaveLength(REAL.pins.length);
    expect(result.reviews.map((entry) => entry.name)).toEqual(['certifi']);
    expect(REAL.pins.some((pin) => pin.name === 'frozendict')).toBe(false);
    expect(REAL.map.reviews['frozendict']).toMatch(/separate package.*separate container/);
  });

  it('a GPL entry fails the gate', () => {
    for (const license of ['GPL-3.0-only', 'GPL-2.0-or-later', 'AGPL-3.0', 'MIT AND GPL-3.0']) {
      const result = analyzePython(REAL.pins, withEntry(REAL.map, 'pandas', license), POLICY);
      expect(result.violations, license).toEqual([
        `pandas==3.1.0 — ${license}: license is on the deny list`,
      ]);
    }
  });

  it('a pinned package with no recorded licence is UNKNOWN, and fails', () => {
    const pins = [...REAL.pins, { name: 'mystery-lib', version: '0.1.0' }];
    const result = analyzePython(pins, REAL.map, POLICY);
    expect(result.violations).toEqual([
      'mystery-lib==0.1.0: UNKNOWN — no licence recorded in docker/yahoo/licenses.json',
    ]);
  });

  it('LGPL is allowed only with its recorded reason', () => {
    const pins = [...REAL.pins, { name: 'frozendict', version: '2.4.6' }];
    const lgpl = withEntry(REAL.map, 'frozendict', 'LGPL-3.0-only');
    expect(analyzePython(pins, lgpl, POLICY).violations).toEqual([]);
    const noReason = { ...lgpl, reviews: {} };
    expect(analyzePython(pins, noReason, POLICY).violations).toEqual([
      'certifi==2026.10.23 — MPL-2.0: allowed with review, but no reason is recorded under "reviews"',
      'frozendict==2.4.6 — LGPL-3.0-only: allowed with review, but no reason is recorded under "reviews"',
    ]);
  });

  it('a deny-listed name, an unparseable licence and a stale entry each fail', () => {
    const pins = [...REAL.pins, { name: 'python-Levenshtein', version: '0.1' }];
    const map = withEntry(withEntry(REAL.map, 'python-levenshtein', 'GPL-2.0'), 'ghost', 'MIT');
    const result = analyzePython(
      pins.map((pin) => ({ ...pin, name: normaliseName(pin.name) })),
      map,
      POLICY,
    );
    expect(result.violations).toEqual(
      expect.arrayContaining([
        'python-levenshtein==0.1: on the licence-policy deny-list (denyPackages)',
        'python-levenshtein==0.1 — GPL-2.0: license is on the deny list',
        'ghost: a licence is recorded for a package requirements.txt does not pin',
      ]),
    );
    const odd = analyzePython(
      REAL.pins,
      withEntry(REAL.map, 'pytz', 'Some Custom Licence'),
      POLICY,
    );
    expect(odd.violations).toEqual([
      'pytz==2026.6 — Some Custom Licence: license is UNKNOWN/unparseable',
    ]);
  });

  it('requirements.txt is parsed by pin, hashes and comments ignored, and a loose line refused', () => {
    expect(
      parseRequirements(
        '# c\nYfinance==1.7.0 \\\n    --hash=sha256:00\nTyping_Extensions==4.16.0\n',
      ),
    ).toEqual([
      { name: 'yfinance', version: '1.7.0' },
      { name: 'typing-extensions', version: '4.16.0' },
    ]);
    expect(() => parseRequirements('yfinance>=1.7\n')).toThrow(/not a name==version pin/);
  });

  it('THIRD_PARTY.md gets a "Python (the yahoo sidecar)" section listing every pin', () => {
    const lines = renderPythonSection(analyzePython(REAL.pins, REAL.map, POLICY), REAL.map);
    expect(lines[0]).toBe('# Python (the yahoo sidecar)');
    for (const pin of REAL.pins) {
      expect(lines, pin.name).toContain(`- \`${pin.name}\`==${pin.version}`);
    }
    expect(lines.join('\n')).toContain('## Python: allowed with review (06 §5.4)');
  });
});
