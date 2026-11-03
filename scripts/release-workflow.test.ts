// SPDX-License-Identifier: MIT
/**
 * The release workflow's invariants (WP 12.2, D32, docs/research/13 §3 and §9).
 *
 * `.github/workflows/release.yml` only ever runs on a tag push, and the first
 * real run is the first public release: there is no way to watch it go red
 * here before it matters. So its shape is pinned instead, by parsing it:
 *
 *   - every `uses:` is pinned to a 40-hex commit SHA with a `# vX.Y.Z` comment
 *     (06 §5.1, the repository's action-pinning convention);
 *   - the publish job logs in to GHCR (GITHUB_TOKEN) and to Docker Hub
 *     (`masterhuh`, DOCKER_PAT), builds once for both architectures and pushes
 *     every tag `docker/metadata-action` makes for both image names — one
 *     build, one manifest list, one digest on both registries;
 *   - the four tag patterns: `{{version}}`, `{{major}}.{{minor}}`, `latest`,
 *     `sha-<7>`;
 *   - the publish job waits on the reviewed `release` environment, after the
 *     upgrade-test gate;
 *   - both references are signed (cosign) and attested;
 *   - a verify job checks cosign and the provenance attestation for BOTH
 *     references by digest, with the install-side verifier's identity, and
 *     the GitHub release `needs:` it — a verification failure stops the run
 *     before any release exists;
 *   - the Hub description is pushed from docker/DOCKERHUB_README.md;
 *   - four images (WP 12.6 added `yahoo`, the opt-in sidecar), every one of
 *     them in BOTH registries, signed, attested, verified and described — no
 *     step is conditioned on which image a leg builds, so none can be left
 *     out of one registry;
 *   - no secret but DOCKER_PAT and GITHUB_TOKEN; `persist-credentials: false`
 *     on every checkout; minimal permissions per job; a timeout on every job;
 *     concurrency on the tag.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorkflowYaml, type YamlValue } from './workflow-yaml.ts';

const PATH = join(import.meta.dirname, '..', '.github', 'workflows', 'release.yml');
const SOURCE = readFileSync(PATH, 'utf8');

type YMap = { [key: string]: YamlValue };
const isMap = (v: YamlValue | undefined): v is YMap =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const asMap = (v: YamlValue | undefined): YMap => (isMap(v) ? v : {});
const asList = (v: YamlValue | undefined): YamlValue[] => (Array.isArray(v) ? v : []);
const asText = (v: YamlValue | undefined): string => (typeof v === 'string' ? v : '');

const WORKFLOW = asMap(parseWorkflowYaml(SOURCE));
const JOBS = asMap(WORKFLOW['jobs']);

const GHCR_IMAGE = 'ghcr.io/huh12312/personalfi-${{ matrix.image }}';
const HUB_IMAGE = 'docker.io/masterhuh/personalfi-${{ matrix.image }}';
const IDENTITY =
  'https://github.com/huh12312/PersonalFi/.github/workflows/release.yml@refs/tags/v${version}';
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
/** Every published image, sorted. WP 12.6 made it four. */
const IMAGES = ['api', 'backup', 'proxy', 'yahoo'];

function steps(job: YMap): YMap[] {
  return asList(job['steps']).filter(isMap);
}
function usesOf(step: YMap): string {
  return asText(step['uses']).split('@')[0] ?? '';
}
function stepsUsing(job: YMap, action: string): YMap[] {
  return steps(job).filter((s) => usesOf(s) === action);
}
function needsOf(job: YMap): string[] {
  const needs = job['needs'];
  return typeof needs === 'string' ? [needs] : asList(needs).map(asText);
}
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}
/** The one job that runs docker/build-push-action: the publishing job. */
function publishJob(): [string, YMap] {
  const found = Object.entries(JOBS).filter(
    ([, job]) => stepsUsing(asMap(job), 'docker/build-push-action').length > 0,
  );
  expect(found.map(([name]) => name)).toHaveLength(1);
  const [name, job] = found[0] ?? ['', null];
  return [name, asMap(job)];
}
/** Every run script in the job, joined. */
function scripts(job: YMap): string {
  return steps(job)
    .map((s) => asText(s['run']))
    .join('\n');
}
/** The job whose run scripts call `cosign verify`: the pre-release verification. */
function verifyJob(): [string, YMap] {
  const found = Object.entries(JOBS).filter(([, job]) =>
    scripts(asMap(job)).includes('cosign verify'),
  );
  expect(found.map(([name]) => name)).toHaveLength(1);
  const [name, job] = found[0] ?? ['', null];
  return [name, asMap(job)];
}
function releaseJob(): [string, YMap] {
  const found = Object.entries(JOBS).filter(
    ([, job]) => stepsUsing(asMap(job), 'softprops/action-gh-release').length > 0,
  );
  expect(found.map(([name]) => name)).toHaveLength(1);
  const [name, job] = found[0] ?? ['', null];
  return [name, asMap(job)];
}

describe('release.yml: parsed', () => {
  it('reads as a workflow with jobs', () => {
    expect(Object.keys(JOBS).length).toBeGreaterThan(0);
  });

  it('runs on a vX.Y.Z tag push only', () => {
    const on = asMap(WORKFLOW['on']);
    expect(Object.keys(on)).toEqual(['push']);
    expect(asMap(on['push'])).toEqual({ tags: ['v[0-9]+.[0-9]+.[0-9]+'] });
  });
});

describe('release.yml: pinning (06 §5.1)', () => {
  const usesLines = SOURCE.split('\n').filter((l) => /^\s*(?:-\s+)?uses:/.test(l));

  it('every `uses:` is a local workflow or pinned to a 40-hex SHA with a # vX.Y.Z comment', () => {
    expect(usesLines.length).toBeGreaterThan(0);
    const bad = usesLines.filter(
      (l) =>
        !/^\s*(?:-\s+)?uses: \.\/\.github\/workflows\/[\w.-]+\.ya?ml$/.test(l) &&
        !/^\s*(?:-\s+)?uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(l),
    );
    expect(bad).toEqual([]);
  });

  it('the parsed `uses:` count matches the raw lines (none is hidden from the pin check)', () => {
    const parsed = Object.values(JOBS).flatMap((job) => {
      const j = asMap(job);
      return [
        ...(typeof j['uses'] === 'string' ? [j['uses']] : []),
        ...steps(j).map((s) => s['uses']),
      ];
    });
    expect(parsed.filter((u) => typeof u === 'string')).toHaveLength(usesLines.length);
  });
});

describe('release.yml: secrets and credentials', () => {
  it('references no secret but DOCKER_PAT and GITHUB_TOKEN, and never inherits secrets', () => {
    const named = new Set([...SOURCE.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));
    expect([...named].sort()).toEqual(['DOCKER_PAT', 'GITHUB_TOKEN']);
    expect(SOURCE).not.toMatch(/secrets\s*\[/);
    expect(SOURCE).not.toMatch(/secrets:\s*inherit/);
    expect(SOURCE).not.toMatch(/toJSON\(\s*secrets\s*\)/);
  });

  it('every checkout sets persist-credentials: false', () => {
    const checkouts = Object.values(JOBS).flatMap((job) =>
      stepsUsing(asMap(job), 'actions/checkout'),
    );
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) expect(asMap(step['with'])['persist-credentials']).toBe('false');
  });
});

describe('release.yml: the publish job', () => {
  it('waits on the reviewed `release` environment, after the upgrade-test gate', () => {
    const [, job] = publishJob();
    expect(job['environment']).toBe('release');
    const gate = Object.entries(JOBS).find(
      ([, j]) => asMap(j)['uses'] === './.github/workflows/upgrade-test.yml',
    );
    expect(gate).toBeDefined();
    expect(needsOf(job)).toContain(gate?.[0]);
  });

  it('builds the four images (WP 12.6: the opt-in yahoo sidecar is the fourth)', () => {
    const [, job] = publishJob();
    const include = asList(asMap(asMap(job['strategy'])['matrix'])['include']).map(asMap);
    expect(include.map((m) => m['image']).sort()).toEqual(IMAGES);
    const yahoo = include.find((m) => m['image'] === 'yahoo');
    expect(yahoo?.['dockerfile']).toBe('docker/yahoo.Dockerfile');
    expect(yahoo?.['context']).toBe('docker');
  });

  it('no step is conditioned on the image, so no image can skip a registry', () => {
    const [, job] = publishJob();
    for (const step of steps(job)) {
      expect(asText(step['if']), asText(step['name'])).not.toMatch(/matrix\.image/);
    }
  });

  it('logs in to GHCR with GITHUB_TOKEN and to Docker Hub as masterhuh with DOCKER_PAT', () => {
    const [, job] = publishJob();
    const logins = stepsUsing(job, 'docker/login-action').map((s) => asMap(s['with']));
    expect(logins).toHaveLength(2);
    const ghcr = logins.find((w) => w['registry'] === 'ghcr.io');
    expect(ghcr?.['password']).toBe('${{ secrets.GITHUB_TOKEN }}');
    const hub = logins.find((w) => w['registry'] === undefined || w['registry'] === 'docker.io');
    expect(hub?.['username']).toBe('masterhuh');
    expect(hub?.['password']).toBe('${{ secrets.DOCKER_PAT }}');
  });

  it('names both images in one metadata-action `images:` list, with the four tag patterns', () => {
    const [, job] = publishJob();
    const meta = stepsUsing(job, 'docker/metadata-action');
    expect(meta).toHaveLength(1);
    const withs = asMap(meta[0]?.['with']);
    expect(lines(asText(withs['images'])).sort()).toEqual([HUB_IMAGE, GHCR_IMAGE].sort());
    const tags = lines(asText(withs['tags']));
    expect(tags).toEqual(
      expect.arrayContaining([
        'type=semver,pattern={{version}}',
        'type=semver,pattern={{major}}.{{minor}}',
        'type=raw,value=latest',
        'type=sha,prefix=sha-,format=short',
      ]),
    );
    expect(tags).toHaveLength(4);
  });

  it('pushes every metadata tag from one multi-arch build with provenance and an SBOM', () => {
    const [, job] = publishJob();
    const meta = stepsUsing(job, 'docker/metadata-action')[0];
    const build = stepsUsing(job, 'docker/build-push-action');
    expect(build).toHaveLength(1);
    const withs = asMap(build[0]?.['with']);
    expect(withs['tags']).toBe(`\${{ steps.${asText(meta?.['id'])}.outputs.tags }}`);
    expect(withs['push']).toBe('true');
    const platforms = asText(withs['platforms']).split(',');
    expect(platforms).toEqual(expect.arrayContaining(['linux/amd64', 'linux/arm64']));
    expect(withs['provenance']).toBe('mode=max');
    expect(withs['sbom']).toBe('true');
    expect(asText(withs['cache-from'])).toMatch(/^type=gha,/);
  });

  it('signs both references by digest with cosign', () => {
    const [, job] = publishJob();
    const build = asText(stepsUsing(job, 'docker/build-push-action')[0]?.['id']);
    const digest = `\${{ steps.${build}.outputs.digest }}`;
    // Each step's own `env:` expanded into its script, so `${IMAGE}@${DIGEST}`
    // reads as the expressions it stands for.
    const signs = steps(job).flatMap((s) => {
      const env = asMap(s['env']);
      return asText(s['run'])
        .replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (whole, name: string) => {
          const value = env[name];
          return typeof value === 'string' ? value : whole;
        })
        .split('\n')
        .filter((l) => /^cosign sign --yes /.test(l.trim()));
    });
    expect(signs).toEqual(
      expect.arrayContaining([
        `cosign sign --yes "${GHCR_IMAGE}@${digest}"`,
        `cosign sign --yes "${HUB_IMAGE}@${digest}"`,
      ]),
    );
  });

  it('attests provenance for both references, pushed to each registry', () => {
    const [, job] = publishJob();
    const attests = stepsUsing(job, 'actions/attest-build-provenance');
    const byName = new Map(attests.map((s) => [asText(asMap(s['with'])['subject-name']), s]));
    expect([...byName.keys()].sort()).toEqual([HUB_IMAGE, GHCR_IMAGE].sort());
    for (const step of attests) expect(asMap(step['with'])['push-to-registry']).toBe('true');
    // The GHCR attestation is a hard requirement; a Hub refusal of the referrer
    // push is caught, warned about by registry name, and not fatal.
    expect(byName.get(GHCR_IMAGE)?.['continue-on-error']).toBeUndefined();
    const hub = byName.get(HUB_IMAGE);
    expect(hub?.['continue-on-error']).toBe('true');
    const warn = steps(job).find((s) =>
      asText(s['if']).includes(`steps.${asText(hub?.['id'])}.outcome == 'failure'`),
    );
    expect(asText(warn?.['run'])).toMatch(/::warning[^\n]*docker\.io/);
  });

  it('holds the only packages / id-token / attestations write permissions', () => {
    const [name, job] = publishJob();
    expect(asMap(job['permissions'])).toEqual({
      contents: 'read',
      packages: 'write',
      'id-token': 'write',
      attestations: 'write',
    });
    for (const [other, j] of Object.entries(JOBS)) {
      if (other === name) continue;
      const perms = asMap(asMap(j)['permissions']);
      for (const scope of ['packages', 'id-token', 'attestations']) {
        expect(perms[scope], `${other}.permissions.${scope}`).not.toBe('write');
      }
    }
  });
});

describe('release.yml: verify before the release is cut', () => {
  it('a verify job runs after the publish job', () => {
    const [publish] = publishJob();
    const [, verify] = verifyJob();
    expect(needsOf(verify)).toContain(publish);
  });

  it('checks cosign with the install-side identity and issuer, and the attestation, for both registries', () => {
    const [, verify] = verifyJob();
    const run = scripts(verify);
    expect(run).toContain(`identity="${IDENTITY}"`);
    expect(run).toContain(`issuer="${OIDC_ISSUER}"`);
    expect(run).toMatch(
      /cosign verify --certificate-identity "\$identity" --certificate-oidc-issuer "\$issuer"/,
    );
    expect(run).toMatch(/gh attestation verify "oci:\/\/\$\{ref\}" --repo huh12312\/PersonalFi/);
    expect(run).toContain('"ghcr.io/huh12312/personalfi-${image}"');
    expect(run).toContain('"docker.io/masterhuh/personalfi-${image}"');
    expect(run).toMatch(/for image in api backup proxy yahoo; do/);
    expect(run).toContain('verify: PASS — 4 images x 2 registries');
    expect(run).toMatch(/exit 1/);
  });

  it('the GitHub release needs the verify job', () => {
    const [verifyName] = verifyJob();
    const [, release] = releaseJob();
    expect(needsOf(release)).toContain(verifyName);
  });

  it('only the GitHub-release job may write contents', () => {
    const [releaseName, release] = releaseJob();
    expect(asMap(release['permissions'])).toEqual({ contents: 'write' });
    expect(asMap(WORKFLOW['permissions'])).toEqual({ contents: 'read' });
    for (const [other, j] of Object.entries(JOBS)) {
      if (other === releaseName) continue;
      expect(asMap(asMap(j)['permissions'])['contents'], other).not.toBe('write');
    }
  });
});

describe('release.yml: the Docker Hub description', () => {
  it('pushes docker/DOCKERHUB_README.md to each Hub repository after verification', () => {
    const job = Object.values(JOBS)
      .map(asMap)
      .find((j) => stepsUsing(j, 'peter-evans/dockerhub-description').length > 0);
    expect(job).toBeDefined();
    const [verifyName] = verifyJob();
    expect(needsOf(job ?? {})).toContain(verifyName);
    const withs = asMap(stepsUsing(job ?? {}, 'peter-evans/dockerhub-description')[0]?.['with']);
    expect(withs['username']).toBe('masterhuh');
    expect(withs['password']).toBe('${{ secrets.DOCKER_PAT }}');
    expect(withs['repository']).toBe('masterhuh/personalfi-${{ matrix.image }}');
    expect(withs['readme-filepath']).toBe('docker/DOCKERHUB_README.md');
    expect(asText(withs['short-description'])).toBe(
      'PersonalFi — self-hosted, single-user personal finance and advisory (${{ matrix.image }} image)',
    );
    const images = asList(asMap(asMap(job?.['strategy'])['matrix'])['image']).map(asText);
    expect(images.sort()).toEqual(IMAGES);
  });
});

describe('release.yml: hygiene', () => {
  it('every job that runs steps has a timeout', () => {
    for (const [name, job] of Object.entries(JOBS)) {
      if (typeof asMap(job)['uses'] === 'string') continue; // a reusable workflow sets its own
      expect(asMap(job)['timeout-minutes'], name).toMatch(/^\d+$/);
    }
  });

  it('runs one release per tag at a time, never cancelling one in flight', () => {
    const concurrency = asMap(WORKFLOW['concurrency']);
    expect(asText(concurrency['group'])).toContain('${{ github.ref }}');
    expect(concurrency['cancel-in-progress']).toBe('false');
  });
});
