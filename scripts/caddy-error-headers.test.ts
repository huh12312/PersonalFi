// SPDX-License-Identifier: MIT
/**
 * WP 9.11, G-06 (ZAP 10035, WP 9.10): Caddy's own error responses carry the
 * same security headers as everything else. `header` does not reach a
 * `file_server` 404, so every listener must also import `error_responses`,
 * whose `handle_errors` route imports `security_headers`. Structural, against
 * the shipped `docker/Caddyfile`; the live before/after (curl on the pf-sec
 * stack) is in docs/evidence/phase-9/wp9.11-security-fixes.md.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CADDYFILE = readFileSync(new URL('../docker/Caddyfile', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/** Top-level blocks: `label {` at column 0 through the matching `}` at column 0. */
function blocks(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^(\S[^\n{]*?)\s*\{\n([\s\S]*?)^\}/gm;
  for (const match of CADDYFILE.matchAll(re)) out.set((match[1] ?? '').trim(), match[2] ?? '');
  return out;
}

describe('G-06: security headers on Caddy error responses', () => {
  const all = blocks();

  it('the error_responses snippet runs security_headers inside handle_errors', () => {
    const snippet = all.get('(error_responses)');
    expect(snippet, 'no (error_responses) snippet').toBeDefined();
    expect(snippet).toMatch(/handle_errors\s*\{[\s\S]*import security_headers[\s\S]*\}/);
  });

  it('every site listener imports both security_headers and error_responses', () => {
    const sites = [...all.keys()].filter((label) => !label.startsWith('(') && label !== '');
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const site of sites) {
      const body = all.get(site) ?? '';
      expect(body, site).toMatch(/^\s*import security_headers\s*$/m);
      expect(body, site).toMatch(/^\s*import error_responses\s*$/m);
    }
  });
});
