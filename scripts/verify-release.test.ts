// SPDX-License-Identifier: MIT
/**
 * WP 12.3: what `scripts/verify-release.sh` does, against stubs.
 *
 * The real script, run as a process; only `docker`, `cosign` and `gh` are
 * stubs on PATH, all three writing one shared transcript so the ORDER of
 * calls is visible. The stub cosign accepts exactly one identity and issuer
 * (the ones release.yml's keyless signature carries), so a verifier that asks
 * for anything looser fails here, not in production. The real cosign, against
 * real signatures, is `--self-test`'s job (needs the network; WP 12.3
 * evidence §2).
 *
 * - the identity is this repository's release.yml at refs/tags/v<release>,
 *   issued by GitHub Actions, and `--commit` adds the workflow sha;
 * - `--source` picks the registry (GHCR by default, `masterhuh` = Docker Hub);
 * - nothing is pulled until EVERY image has verified, and then by digest
 *   first; a tag that moved after verification is refused and removed;
 * - `gh` logged out: the attestation half is skipped with a warning, and
 *   `--strict` refuses before anything is resolved;
 * - `latest`, `x.y` and the removed `--registry`/`--version` are refused.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./verify-release.sh', import.meta.url));
const ISSUER = 'https://token.actions.githubusercontent.com';
const identity = (release: string): string =>
  `https://github.com/huh12312/PersonalFi/.github/workflows/release.yml@refs/tags/v${release}`;
const DIGEST: Record<string, string> = {
  api: `sha256:${'a'.repeat(64)}`,
  backup: `sha256:${'b'.repeat(64)}`,
  proxy: `sha256:${'c'.repeat(64)}`,
  yahoo: `sha256:${'d'.repeat(64)}`,
};
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

let dir: string;
let log: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp123-verify-'));
  log = join(dir, 'calls.log');
  // docker: digests by image name; `image inspect` gives the digest as the id,
  // except for a tag named in FAKE_TAG_MOVED, which then names other bytes.
  writeFileSync(
    join(dir, 'docker'),
    `#!/usr/bin/env bash
echo "docker $*" >> "${log}"
digest_of() { case "$1" in *personalfi-api*) echo "sha256:${'a'.repeat(64)}" ;; *personalfi-backup*) echo "sha256:${'b'.repeat(64)}" ;; *personalfi-proxy*) echo "sha256:${'c'.repeat(64)}" ;; *personalfi-yahoo*) echo "sha256:${'d'.repeat(64)}" ;; esac; }
if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then
  case " \${FAKE_UNRESOLVED:-} " in *" $4 "*) exit 1 ;; esac
  printf '"%s"\\n' "$(digest_of "$4")"; exit 0
fi
if [ "$1" = pull ]; then exit 0; fi
if [ "$1 $2" = "image inspect" ]; then
  ref="\${@: -1}"
  if [[ "$ref" == *@* ]]; then echo "\${ref#*@}"; exit 0; fi
  case " \${FAKE_TAG_MOVED:-} " in *" $ref "*) echo "sha256:${'f'.repeat(64)}"; exit 0 ;; esac
  digest_of "$ref"; exit 0
fi
if [ "$1 $2" = "image rm" ]; then exit 0; fi
exit 1
`,
  );
  // cosign: verifies only the exact identity + issuer, and only signed refs.
  writeFileSync(
    join(dir, 'cosign'),
    `#!/usr/bin/env bash
echo "cosign $*" >> "${log}"
[ "$1" = verify ] || exit 1
shift
id="" iss="" sha="" ref=""
while [ $# -gt 0 ]; do
  case "$1" in
    --certificate-identity) id="$2"; shift ;;
    --certificate-oidc-issuer) iss="$2"; shift ;;
    --certificate-github-workflow-sha) sha="$2"; shift ;;
    --*) echo "unexpected flag $1" >&2; exit 1 ;;
    *) ref="$1" ;;
  esac
  shift
done
case " \${FAKE_UNSIGNED:-} " in *" $ref "*) echo "Error: no signatures found" >&2; exit 10 ;; esac
[ "$id" = "$EXPECT_IDENTITY" ] || { echo "Error: no matching CertificateIdentity: got $id" >&2; exit 1; }
[ "$iss" = "${ISSUER}" ] || { echo "Error: wrong issuer $iss" >&2; exit 1; }
[ -z "$sha" ] || [ "$sha" = "\${EXPECT_SHA:-}" ] || { echo "Error: workflow sha $sha" >&2; exit 1; }
exit 0
`,
  );
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env bash
echo "gh $*" >> "${log}"
if [ "$1 $2" = "auth status" ]; then [ "\${FAKE_GH:-in}" = in ]; exit; fi
if [ "$1 $2" = "attestation verify" ]; then exit 0; fi
exit 1
`,
  );
  for (const tool of ['docker', 'cosign', 'gh']) chmodSync(join(dir, tool), 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function verify(
  args: readonly string[],
  env: Record<string, string> = {},
): { status: number; out: string; calls: string[] } {
  writeFileSync(log, '');
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: `${dir}:${process.env['PATH'] ?? ''}`,
      HOME: dir,
      EXPECT_IDENTITY: identity('0.10.0'),
      ...env,
    },
  });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status ?? -1,
    out: `${result.stdout}${result.stderr}`,
    calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

const cosignCalls = (calls: string[]): string[] =>
  calls.filter((c) => c.startsWith('cosign verify'));
const pulls = (calls: string[]): string[] => calls.filter((c) => c.startsWith('docker pull'));

describe('verify-release.sh: what it checks', () => {
  it("checks every image by digest against release.yml's exact identity and GitHub's issuer, from GHCR by default", () => {
    const run = verify(['--release', '0.10.0']);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('PASS: 3 image(s) verified for v0.10.0 from ghcr.io/huh12312');
    expect(cosignCalls(run.calls)).toEqual(
      ['api', 'backup', 'proxy'].map(
        (image) =>
          `cosign verify --certificate-identity ${identity('0.10.0')} --certificate-oidc-issuer ${ISSUER} ghcr.io/huh12312/personalfi-${image}@${DIGEST[image]}`,
      ),
    );
    expect(run.calls.filter((c) => c.startsWith('gh attestation verify'))).toEqual(
      ['api', 'backup', 'proxy'].map(
        (image) =>
          `gh attestation verify oci://ghcr.io/huh12312/personalfi-${image}@${DIGEST[image]} --repo huh12312/PersonalFi`,
      ),
    );
    expect(pulls(run.calls)).toEqual([]);
  });

  it('WP 12.6: the opt-in yahoo image is verified only with --with-yahoo, and then like the rest', () => {
    const without = verify(['--release', '0.10.0']);
    expect(without.status, without.out).toBe(0);
    expect(without.calls.some((c) => c.includes('personalfi-yahoo'))).toBe(false);
    const withYahoo = verify(['--release', '0.10.0', '--with-yahoo']);
    expect(withYahoo.status, withYahoo.out).toBe(0);
    expect(withYahoo.out).toContain('PASS: 4 image(s) verified');
    expect(cosignCalls(withYahoo.calls).at(-1)).toBe(
      `cosign verify --certificate-identity ${identity('0.10.0')} --certificate-oidc-issuer ${ISSUER} ghcr.io/huh12312/personalfi-yahoo@${DIGEST['yahoo'] ?? ''}`,
    );
    // An unsigned sidecar refuses the whole release: nothing at all is pulled.
    const unsigned = verify(['--release', '0.10.0', '--with-yahoo', '--pull'], {
      FAKE_UNSIGNED: `ghcr.io/huh12312/personalfi-yahoo@${DIGEST['yahoo'] ?? ''}`,
    });
    expect(unsigned.status).not.toBe(0);
    expect(unsigned.out).toContain('FAIL yahoo: cosign verify refused');
    expect(pulls(unsigned.calls)).toEqual([]);
  });

  it('--commit adds the workflow sha; a signature from another commit is refused', () => {
    const ok = verify(['--release', '0.10.0', '--commit', COMMIT], { EXPECT_SHA: COMMIT });
    expect(ok.status, ok.out).toBe(0);
    expect(
      cosignCalls(ok.calls).every((c) => c.includes(`--certificate-github-workflow-sha ${COMMIT}`)),
    ).toBe(true);
    const other = verify(['--release', '0.10.0', '--commit', COMMIT], {
      EXPECT_SHA: 'f'.repeat(40),
    });
    expect(other.status).not.toBe(0);
    expect(other.out).toContain('REFUSED: not every image verified; nothing was pulled');
  });

  it('--source masterhuh reads the Docker Hub mirror; another source is read the same way, with a note', () => {
    const hub = verify(['--release', '0.10.0', '--source', 'masterhuh']);
    expect(hub.status, hub.out).toBe(0);
    expect(cosignCalls(hub.calls).map((c) => c.split(' ').at(-1))).toEqual(
      ['api', 'backup', 'proxy'].map(
        (image) => `docker.io/masterhuh/personalfi-${image}@${DIGEST[image]}`,
      ),
    );
    const local = verify(['--release', '0.10.0', '--source', '127.0.0.1:5001']);
    expect(local.out).toContain("note: 127.0.0.1:5001 is not one of this project's registries");
    expect(cosignCalls(local.calls)[0]).toContain(' 127.0.0.1:5001/personalfi-api@');
  });

  it('a signature for another identity (another release, another repository) is refused', () => {
    const run = verify(['--release', '0.10.0'], { EXPECT_IDENTITY: identity('0.9.0') });
    expect(run.status).not.toBe(0);
    expect(run.out).toContain('FAIL api: cosign verify refused');
    expect(run.out).toContain('REFUSED: not every image verified; nothing was pulled');
  });
});

describe('verify-release.sh --pull: verify everything, then pull by digest', () => {
  it('pulls nothing until every image has verified, then each by digest before its tag', () => {
    const run = verify(['--release', '0.10.0', '--pull']);
    expect(run.status, run.out).toBe(0);
    const firstPull = run.calls.findIndex((c) => c.startsWith('docker pull'));
    const lastVerify = run.calls.map((c) => c.startsWith('cosign verify')).lastIndexOf(true);
    const lastAttest = run.calls.map((c) => c.startsWith('gh attestation')).lastIndexOf(true);
    expect(firstPull).toBeGreaterThan(lastVerify);
    expect(firstPull).toBeGreaterThan(lastAttest);
    expect(pulls(run.calls)).toEqual(
      ['api', 'backup', 'proxy'].flatMap((image) => [
        `docker pull --quiet ghcr.io/huh12312/personalfi-${image}@${DIGEST[image]}`,
        `docker pull --quiet ghcr.io/huh12312/personalfi-${image}:0.10.0`,
      ]),
    );
    // One name per image: no local re-tag.
    expect(run.calls.some((c) => c.startsWith('docker tag'))).toBe(false);
    expect(run.out).toContain(
      `pulled ghcr.io/huh12312/personalfi-api@${DIGEST['api']} as ghcr.io/huh12312/personalfi-api:0.10.0`,
    );
  });

  it('one image that does not verify: nothing at all is pulled', () => {
    const run = verify(['--release', '0.10.0', '--pull'], {
      FAKE_UNSIGNED: `ghcr.io/huh12312/personalfi-proxy@${DIGEST['proxy']}`,
    });
    expect(run.status).not.toBe(0);
    expect(run.out).toContain('FAIL proxy: cosign verify refused');
    expect(pulls(run.calls)).toEqual([]);
  });

  it('a tag that moved after verification is refused, and the name it brought is removed', () => {
    const tag = 'ghcr.io/huh12312/personalfi-backup:0.10.0';
    const run = verify(['--release', '0.10.0', '--pull'], { FAKE_TAG_MOVED: tag });
    expect(run.status).not.toBe(0);
    expect(run.out).toContain(`REFUSED backup: ${tag} no longer names the verified`);
    expect(run.calls).toContain(`docker image rm ${tag}`);
  });
});

describe('verify-release.sh: gh optional, --strict, and the refusals', () => {
  it('gh logged out: the attestation half is skipped with a warning, and the signatures still decide', () => {
    const run = verify(['--release', '0.10.0'], { FAKE_GH: 'out' });
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain('WARNING: `gh` is not on PATH or not logged in');
    expect(run.out).toContain('(attestations not checked)');
    expect(run.calls.some((c) => c.startsWith('gh attestation'))).toBe(false);
    expect(cosignCalls(run.calls)).toHaveLength(3);
  });

  it('--strict without gh refuses before anything is resolved', () => {
    const run = verify(['--release', '0.10.0', '--strict', '--pull'], { FAKE_GH: 'out' });
    expect(run.status).not.toBe(0);
    expect(run.out).toContain('REFUSED (--strict)');
    expect(run.calls.filter((c) => c.startsWith('docker') || c.startsWith('cosign'))).toEqual([]);
  });

  it('refuses latest, a minor line and a v-prefixed tag, and the removed local-tag flags', () => {
    for (const release of ['latest', '0.10', 'v0.10.0']) {
      const run = verify(['--release', release, '--pull']);
      expect(run.status, release).not.toBe(0);
      expect(run.out, release).toContain('is not x.y.z');
      expect(
        run.calls.filter((c) => !c.startsWith('gh auth')),
        release,
      ).toEqual([]);
    }
    for (const flag of ['--registry', '--version']) {
      const run = verify(['--release', '0.10.0', flag, 'x']);
      expect(run.status, flag).not.toBe(0);
      expect(run.out, flag).toContain('was removed in v0.10.0');
    }
  });
});
