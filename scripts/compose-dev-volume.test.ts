// SPDX-License-Identifier: MIT
/**
 * WP 10.5: `compose.dev.yml`'s data volume is scoped to the compose project.
 *
 * The WP 10.4 incident: the file pinned `pgdata` to the literal name
 * `personalfi_dev_pgdata`, so an agent's `docker compose -p wp104 -f
 * compose.dev.yml …` stack mounted the running dev database's data directory and
 * two postmasters shared it for an hour. These renders are what `docker compose`
 * would create, read with `config` only (no container, volume or network is
 * touched), from an environment with the two interpolation variables removed so
 * a developer's shell cannot decide the answer.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const DEV_VOLUME = 'personalfi_dev_pgdata';

function composeAvailable(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The name `docker compose` would give the db's data volume under this project. */
function renderedVolumeName(project: string | null): string {
  const env = { ...process.env };
  delete env['COMPOSE_PROJECT_NAME'];
  delete env['PERSONALFI_DEV_PGDATA_VOLUME'];
  const args = ['compose', ...(project === null ? [] : ['-p', project])];
  args.push('-f', 'compose.dev.yml', 'config', '--format', 'json');
  const rendered = JSON.parse(
    execFileSync('docker', args, { cwd: ROOT, env, encoding: 'utf8' }),
  ) as {
    volumes?: Record<string, { name?: string }>;
    services: Record<string, { volumes?: { source?: string; target?: string }[] }>;
  };
  const mount = rendered.services['db']?.volumes?.find(
    (entry) => entry.target === '/var/lib/postgresql',
  );
  if (mount?.source === undefined) throw new Error('the db service mounts no data volume');
  const name = rendered.volumes?.[mount.source]?.name;
  if (name === undefined) throw new Error(`volume ${mount.source} has no rendered name`);
  return name;
}

describe.skipIf(!composeAvailable())(
  'compose.dev.yml scopes its data volume to the project (WP 10.5)',
  () => {
    it('the dev project keeps the volume that already holds its data', () => {
      expect(renderedVolumeName(null)).toBe(DEV_VOLUME);
      expect(renderedVolumeName('personalfi-dev')).toBe(DEV_VOLUME);
    }, 30_000);

    // `personalfi_dev` is the case that matters: with Compose's own `<project>_pgdata`
    // spelling it rendered the dev volume's name exactly.
    it('any other project gets a volume named for itself, never the dev one', () => {
      for (const project of ['wp999', 'wp105', 'personalfi_dev', 'dev']) {
        const name = renderedVolumeName(project);
        expect(name).toBe(`${project}-pgdata`);
        expect(name).not.toBe(DEV_VOLUME);
      }
    }, 60_000);
  },
);
