// SPDX-License-Identifier: MIT
/**
 * Phase 3 gate C-12 (LOW; `docs/evidence/phase-3/gate-security-review.md`,
 * gate input (2), "WP 3.4's `allowedSchemes` honest gap"): `checkUrl` refuses
 * any channel URL whose scheme is not literally `'https'`, then handed
 * `checkDestination` the **literal** `'https'` rather than the `scheme` it
 * had just parsed and validated — inert today (the two values always agree,
 * because nothing reaches that line with any other scheme), and the exact
 * shape 03-phase-3-dispatch.md names: "a second implementation of a check
 * that is where the hole would be if the first one ever moved."
 *
 * Two proofs, because the fix makes no difference to *today's* behaviour (a
 * hardcoded `'https'` and a parsed-and-validated `'https'` are the same
 * string) and only matters to a *future* edit:
 *
 *   1. a source-shape assertion, the same style `worker-account-holder-poll.test.ts`
 *      uses for C-1 — `checkUrl`'s call to `checkDestination` must pass the
 *      `scheme` it parsed, never a literal string, so a future scheme joining
 *      the channel-URL allowance is decided by `checkDestination`'s own
 *      `allowedSchemes` policy rather than silently substituted;
 *   2. a real behavioural proof that `allowedSchemes` is consulted at all
 *      for this call path: a policy that has had `https` removed from
 *      `allowedSchemes` (an operator error nobody would make on purpose, the
 *      same "defence in depth is only real when independently misconfigured"
 *      standard `egress-allowlist.test.ts` states) still refuses an
 *      `https://` channel URL with `scheme_not_allowed` — which only happens
 *      if the value reaching `checkDestination` is actually checked against
 *      the policy, not merely echoed back.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkUrl, createEgressPolicy } from './policy.ts';

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)), 'utf8');

describe('checkUrl passes its parsed scheme to checkDestination (Phase 3 gate C-12)', () => {
  it("checkUrl's call to checkDestination carries the variable scheme, never the literal 'https'", () => {
    const source = repoFile('packages/platform/src/egress/policy.ts');
    const start = source.indexOf('export function checkUrl(');
    const end = source.indexOf('export async function guardDestination(');
    expect(start, 'checkUrl not found').toBeGreaterThan(-1);
    expect(end, 'guardDestination not found').toBeGreaterThan(start);
    const body = source.slice(start, end);
    const call = /checkDestination\(\s*\{([\s\S]*?)\}/u.exec(body)?.[1] ?? '';
    expect(
      /\bscheme\s*,/u.test(call) || /\bscheme:\s*scheme\b/u.test(call),
      'checkUrl must pass its own parsed `scheme` variable to checkDestination, not the literal ' +
        "'https' — that is the inert line C-12 closes.",
    ).toBe(true);
    expect(
      /scheme:\s*'https'/u.test(call),
      "checkUrl must not hardcode the literal string 'https' in the checkDestination call.",
    ).toBe(false);
  });

  it(
    'a policy with https removed from allowedSchemes refuses an https:// channel URL via ' +
      'checkDestination — proof the parsed scheme is actually checked, not merely echoed',
    () => {
      const policy = createEgressPolicy({
        allowedHosts: ['ntfy.notify.test'],
        allowedSchemes: ['smtps', 'smtp+starttls'], // https deliberately absent
      });
      const decision = checkUrl('https://ntfy.notify.test/topic', policy);
      expect(decision.ok).toBe(false);
      if (decision.ok) throw new Error('unreachable');
      expect(decision.code).toBe('scheme_not_allowed');
    },
  );
});
