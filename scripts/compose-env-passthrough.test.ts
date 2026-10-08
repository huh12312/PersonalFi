// SPDX-License-Identifier: MIT
/**
 * WP 9.12 found, and WP 9.14 fixed, that Plaid Production could not be enabled
 * from the shipped compose file: `@core/config` refuses `plaid_env=production`
 * unless `PLAID_ALLOW_PRODUCTION` is also true, and `compose.yml` never passed
 * the variable to the containers, so a holder who set both in `.env` still ran
 * sandbox (or, worse, was refused at boot with a message pointing at a setting
 * they had made). Two independent settings must agree (D16); this pins that
 * both of the processes that read the config actually receive the second one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const COMPOSE = readFileSync(join(import.meta.dirname, '..', 'compose.yml'), 'utf8');

/** One service's text: from `  name:` to the next two-space-indented key. */
function service(name: string): string {
  const lines = COMPOSE.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`no service ${name}`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[a-z][a-z0-9-]*:/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

describe('compose passes the second Plaid Production setting through (D16)', () => {
  for (const name of ['api', 'worker']) {
    it(`${name} receives PLAID_ALLOW_PRODUCTION, defaulting to false`, () => {
      expect(service(name)).toMatch(
        /^ {6}PLAID_ALLOW_PRODUCTION: \$\{PLAID_ALLOW_PRODUCTION:-false\}$/m,
      );
    });
  }

  it('neither the proxy nor the migrator is given it (they never dial Plaid)', () => {
    expect(service('proxy')).not.toContain('PLAID_ALLOW_PRODUCTION');
    expect(service('migrator')).not.toContain('PLAID_ALLOW_PRODUCTION');
  });
});
