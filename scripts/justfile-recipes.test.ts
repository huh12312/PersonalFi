// SPDX-License-Identifier: MIT
/**
 * Structural pins on justfile recipes whose failure is a host-level event rather
 * than a code path a unit test can reach (WP 9.14).
 *
 * The recipes are read as text; what they DO is proven by running them on a
 * scratch stack (docs/evidence/phase-9/wp9.14-quality.md). These pins stop the
 * shape that was wrong from coming back.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const JUSTFILE = readFileSync(join(import.meta.dirname, '..', 'justfile'), 'utf8');

/** A recipe's text: its header line to the next recipe/comment block at column 0. */
function recipe(name: string): string {
  const lines = JUSTFILE.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${name}[ :]`).test(line));
  if (start < 0) throw new Error(`no recipe ${name}`);
  const body: string[] = [lines[start] ?? ''];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith(' ') && !line.startsWith('\t')) break;
    body.push(line);
  }
  return body.join('\n');
}

describe('just bootstrap-user (P-5)', () => {
  const text = recipe('bootstrap-user');

  it('derives the KEK in its own one-shot container, never by exec into the running api', () => {
    // The api container's 1536M cgroup already holds the api's own Argon2
    // derivation (90 % measured by WP 9.9); a second one inside it was OOM-killed
    // (exit 137) on the stranger install, after the user row was written.
    expect(text).not.toMatch(/compose\s+exec\b[^\n]*\bapi\b/);
    expect(text).toMatch(/compose\s+run\s+--rm\s+--no-deps\b/);
    expect(text).toMatch(/--entrypoint\s+node\s+api\b/);
    expect(text).toContain('/app/apps/api/src/bin/bootstrap-user.ts');
  });

  it('still falls back to the local dev database when the stack is not up', () => {
    expect(text).toMatch(/pnpm exec node apps\/api\/src\/bin\/bootstrap-user\.ts/);
  });
});
