// SPDX-License-Identifier: MIT
/**
 * WP 12.3: one name per image, and what each image says about itself.
 *
 * The same bytes used to carry three names: `personalfi/api:<sha>` built
 * locally, `ghcr.io/huh12312/personalfi-api:<version>` published, and the
 * verifier's re-tag back to the local name. Now the name compose runs is the
 * name release.yml publishes. Read as text, these pins keep the places that
 * name an image from drifting apart again:
 *
 * - compose.yml runs `${REGISTRY:-ghcr.io/huh12312}/personalfi-<image>:${PERSONALFI_VERSION:-dev}`
 *   for every PersonalFi service, and `<image>` is exactly release.yml's
 *   matrix (`personalfi-${{ matrix.image }}` on both registries);
 * - each Dockerfile's `org.opencontainers.image.title` is that published
 *   name, its `source` and `url` are this repository, and its licence MIT;
 * - CI's scan job and the upgrade test's scan name images the same way;
 * - docker/caddy.Dockerfile's module floors are each wired through all four
 *   places a floor needs (ARG under a renovate comment, `--with`, the
 *   build-info check, the Renovate group), chi among them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const COMPOSE = read('compose.yml');
const RELEASE = read('.github/workflows/release.yml');
const CI = read('.github/workflows/ci.yml');
const UPGRADE_TEST = read('.github/workflows/upgrade-test.yml');
const IMAGES = ['api', 'backup', 'proxy', 'yahoo'] as const;
const DOCKERFILE: Record<(typeof IMAGES)[number], string> = {
  api: 'docker/api.Dockerfile',
  backup: 'docker/backup.Dockerfile',
  proxy: 'docker/caddy.Dockerfile',
  // WP 12.6: the opt-in Yahoo Finance sidecar, the fourth published image.
  yahoo: 'docker/yahoo.Dockerfile',
};
const REPO_URL = 'https://github.com/huh12312/PersonalFi';

/** `LABEL k="v" \ k="v"` → map (the one LABEL instruction each Dockerfile has). */
function labels(dockerfile: string): Record<string, string> {
  const text = read(dockerfile);
  const start = text.indexOf('\nLABEL ');
  if (start < 0) throw new Error(`${dockerfile}: no LABEL instruction`);
  const lines: string[] = [];
  for (const line of text.slice(start + 1).split('\n')) {
    lines.push(line);
    if (!/\\\s*$/.test(line)) break;
  }
  const out: Record<string, string> = {};
  for (const match of lines.join('\n').matchAll(/([a-z0-9.-]+)="([^"]*)"/g)) {
    out[match[1] ?? ''] = match[2] ?? '';
  }
  return out;
}

describe('one name per image (WP 12.3)', () => {
  it('release.yml publishes personalfi-<image> on GHCR and Docker Hub for exactly api, backup, proxy and yahoo', () => {
    expect(RELEASE).toContain('ghcr.io/huh12312/personalfi-${{ matrix.image }}');
    expect(RELEASE).toContain('docker.io/masterhuh/personalfi-${{ matrix.image }}');
    // The publish job's matrix (`- image: <name>` entries).
    expect([...RELEASE.matchAll(/^\s*- image: (\w+)\s*$/gm)].map((m) => m[1])).toEqual([
      'api',
      'backup',
      'proxy',
      'yahoo',
    ]);
    // CI scans the same four.
    expect([...CI.matchAll(/^\s*- image: (\w+)\s*$/gm)].map((m) => m[1])).toEqual([...IMAGES]);
  });

  it('compose.yml runs every PersonalFi service under the published name, with GHCR as the default registry', () => {
    const lines = [...COMPOSE.matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1] ?? '');
    const ours = lines.filter((image) => image.includes('PERSONALFI_VERSION'));
    expect(ours.sort()).toEqual(
      [
        '${REGISTRY:-ghcr.io/huh12312}/personalfi-api:${PERSONALFI_VERSION:-dev}',
        '${REGISTRY:-ghcr.io/huh12312}/personalfi-backup:${PERSONALFI_VERSION:-dev}',
        '${REGISTRY:-ghcr.io/huh12312}/personalfi-backup:${PERSONALFI_VERSION:-dev}',
        '${REGISTRY:-ghcr.io/huh12312}/personalfi-proxy:${PERSONALFI_VERSION:-dev}',
        '${REGISTRY:-ghcr.io/huh12312}/personalfi-yahoo:${PERSONALFI_VERSION:-dev}',
      ].sort(),
    );
    // No service is left on the pre-12.3 names.
    expect(COMPOSE).not.toMatch(/\}\/(api|backup|proxy|yahoo):\$\{PERSONALFI_VERSION/);
  });

  it.each(IMAGES)(
    "%s: the Dockerfile's labels name the published image, this repository and MIT",
    (image) => {
      const l = labels(DOCKERFILE[image]);
      expect(l['org.opencontainers.image.title']).toBe(`personalfi-${image}`);
      expect(l['org.opencontainers.image.source']).toBe(REPO_URL);
      expect(l['org.opencontainers.image.url']).toBe(REPO_URL);
      expect(l['org.opencontainers.image.licenses']).toBe('MIT');
      expect(l['org.opencontainers.image.description'] ?? '').toMatch(/^PersonalFi /);
    },
  );

  it("CI's scan job and the upgrade test's scan name images as compose does", () => {
    expect(CI).toContain('tags: ghcr.io/huh12312/personalfi-${{ matrix.image }}:ci');
    expect(CI).not.toMatch(/personalfi\/(\$\{\{ matrix\.image \}\}|api):ci/);
    expect(UPGRADE_TEST).toContain('img="pf-upgrade/personalfi-${svc}:${tag}"');
  });
});

describe("docker/caddy.Dockerfile's module floors (WP 12.1, chi since WP 12.3)", () => {
  const text = read('docker/caddy.Dockerfile');
  const renovate = JSON.parse(read('renovate.json')) as {
    packageRules: { groupName?: string; matchPackageNames?: string[] }[];
  };
  const group = renovate.packageRules.find((rule) => rule.groupName === 'proxy: Caddy from source');
  const floors = [
    ...text.matchAll(/# renovate: datasource=go depName=(\S+)\nARG ([A-Z_]+_VERSION)=(\S+)/g),
  ]
    .map((m) => ({ module: m[1] ?? '', arg: m[2] ?? '', version: m[3] ?? '' }))
    .filter((f) => !['CADDY_VERSION', 'XCADDY_VERSION'].includes(f.arg));

  it('pins golang.org/x/net, go-jose/v4 and go-chi/chi/v5 (v5.4.0 or later)', () => {
    expect(floors.map((f) => f.module)).toEqual([
      'golang.org/x/net',
      'github.com/go-jose/go-jose/v4',
      'github.com/go-chi/chi/v5',
    ]);
    const chi = floors.find((f) => f.module === 'github.com/go-chi/chi/v5');
    const [major, minor] = (chi?.version ?? 'v0.0.0').replace(/^v/, '').split('.').map(Number);
    expect((major ?? 0) * 1000 + (minor ?? 0)).toBeGreaterThanOrEqual(5004);
  });

  it.each([
    ['golang.org/x/net', 'XNET_VERSION', 'golang.org/x/net/http2'],
    ['github.com/go-jose/go-jose/v4', 'GOJOSE_VERSION', 'github.com/go-jose/go-jose/v4'],
    ['github.com/go-chi/chi/v5', 'CHI_VERSION', 'github.com/go-chi/chi/v5'],
  ])(
    '%s: ARG in the build stage, --with on xcaddy, read back from the binary, in the Renovate group',
    (module, arg, pkg) => {
      const build = text.slice(text.indexOf('AS caddy-build'), text.indexOf('AS web-build'));
      expect(build).toMatch(new RegExp(`^ARG ${arg}$`, 'm'));
      expect(build).toContain(`--with "${pkg}@\${${arg}}"`);
      expect(build).toContain(`"${module}=\${${arg}}"`);
      expect(group?.matchPackageNames).toContain(module);
    },
  );
});
