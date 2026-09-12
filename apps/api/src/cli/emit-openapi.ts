// SPDX-License-Identifier: MIT
/**
 * Emit `packages/contracts/openapi/openapi.json` from the live route schemas.
 *
 * The spec is generated, checked in, and verified in CI: a drifted spec means the
 * frontend's generated client no longer matches the server, which is a class of
 * bug nobody notices until it is in front of the user.
 *
 * Runs without a database: the pool is created but never connected.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@core/config';
import { createPool } from '@core/db';
import { buildApp } from '../app.ts';

const OUTPUT = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'contracts',
  'openapi',
  'openapi.json',
);

const config = loadConfig({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://openapi:openapi@127.0.0.1:1/openapi',
    SECRETS_DIR: '/nonexistent',
  },
  /**
   * `master_key` is a required secret (P0-2), and this command must run in CI on a
   * checkout with no `secrets/` directory. The stand-in is injected through
   * `readSecret` rather than written to a temp file so the generator touches no
   * filesystem it does not own — and it is never used, because emitting the spec
   * only walks the route schemas: `buildApp` constructs `SecurityRuntime` without
   * initialising it, so no KEK is ever derived here.
   */
  readSecret: (path) => {
    if (path.endsWith('master_key')) return 'openapi-generation-placeholder';
    const error = new Error('ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  },
});

const pool = createPool({ databaseUrl: config.databaseUrl.reveal() });
const { app } = await buildApp({ config, pool });
await app.ready();

const spec = app.swagger();
writeFileSync(OUTPUT, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
await app.close();
await pool.end();

process.stdout.write(`wrote ${OUTPUT}\n`);
