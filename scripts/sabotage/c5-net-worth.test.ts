// SPDX-License-Identifier: MIT
/**
 * WP 9.11: C-5's committed route-level sabotage (`c5-net-worth.sh`) can only
 * rot one way — a route edit that moves an anchor, so the script refuses to
 * run at the next gate. This fails the build the day that happens instead.
 * (The full run needs Postgres and edits route files; it is a gate/agent step,
 * recorded in docs/evidence/phase-9/wp9.11-security-fixes.md.)
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./c5-net-worth.sh', import.meta.url));

describe('scripts/sabotage/c5-net-worth.sh', () => {
  it('every sabotage anchor still matches its route exactly once', () => {
    const out = execFileSync('bash', [SCRIPT, '--check'], { encoding: 'utf8', timeout: 30_000 });
    expect(out).toContain('CHECK PASS');
  }, 30_000);
});
