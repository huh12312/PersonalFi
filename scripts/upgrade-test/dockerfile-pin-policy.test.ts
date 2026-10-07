// SPDX-License-Identifier: MIT
/**
 * WP 9.11, G-22 / F-94-8: the image pin policy, as ruled (WP 9.10 §6, Chris's
 * default): **the base image is pinned by digest; apk packages are not pinned
 * to an exact build.**
 *
 * Alpine's index serves only the current build of each package, so an
 * `apk add pkg=1.2.3-r0` is a build that expires: the first clean-host
 * `upgrade-test.yml` run could not build v0.1 at all, and HEAD had the same
 * expired pins (9.4 §9 F-94-8). Version-exactness bought nothing — apk checks
 * package signatures with keys shipped in the digest-pinned base, and
 * `trivy image` (CI, and the weekly no-cache build in `upgrade-test.yml`) is
 * the control on what versions arrive.
 *
 * Asserted against every shipped Dockerfile (`docker/*.Dockerfile`):
 * - every `FROM` resolves (through its `ARG` default if it names one) to an
 *   image pinned `@sha256:`, or to an earlier build stage;
 * - no `apk add` line carries `name=version`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DOCKER_DIR = fileURLToPath(new URL('../../docker/', import.meta.url));

const dockerfiles = readdirSync(DOCKER_DIR)
  .filter((name) => name.endsWith('.Dockerfile'))
  .sort();

/** Logical lines: backslash continuations joined, comments dropped. */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const raw of text.split('\n')) {
    if (/^\s*#/.test(raw)) continue;
    const continued = /\\\s*$/.test(raw);
    current += ` ${raw.replace(/\\\s*$/, '')}`;
    if (!continued) {
      if (current.trim() !== '') out.push(current.trim());
      current = '';
    }
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

describe('G-22: base images pinned by digest, apk packages not pinned to an expiring build', () => {
  it('there are Dockerfiles to check', () => {
    expect(dockerfiles).toEqual(
      expect.arrayContaining(['api.Dockerfile', 'backup.Dockerfile', 'caddy.Dockerfile']),
    );
  });

  for (const name of dockerfiles) {
    const lines = logicalLines(readFileSync(join(DOCKER_DIR, name), 'utf8'));

    it(`${name}: every FROM is digest-pinned or an earlier stage`, () => {
      const args = new Map<string, string>();
      const stages = new Set<string>();
      const unpinned: string[] = [];
      for (const line of lines) {
        const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)/.exec(line);
        if (arg !== null) args.set(arg[1] ?? '', arg[2] ?? '');
        const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
        if (from === null) continue;
        let image = from[1] ?? '';
        const ref = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(image);
        if (ref !== null) image = args.get(ref[1] ?? '') ?? image;
        if (!stages.has(image) && !/@sha256:[0-9a-f]{64}$/.test(image)) unpinned.push(image);
        if (from[2] !== undefined) stages.add(from[2]);
      }
      expect(unpinned).toEqual([]);
    });

    it(`${name}: no apk package is pinned to an exact build`, () => {
      const pinned = lines
        .filter((line) => /\bapk (add|upgrade)\b/.test(line))
        .flatMap((line) => line.match(/\b[a-z][a-z0-9.+-]*=\d[^\s&;]*/g) ?? []);
      expect(pinned).toEqual([]);
    });
  }
});
