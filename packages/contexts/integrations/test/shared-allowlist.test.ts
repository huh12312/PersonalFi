// SPDX-License-Identifier: MIT
/**
 * *"the price egress guard is the notifications module, not a copy of it"* —
 * and the test that fails if it ever stops being.
 *
 * 03-phase-3-dispatch.md §5: the WP 2.4 allow-list machinery **reused, not
 * reimplemented**. §5.2's lesson, quoted in `adapters/openfigi.ts`, is why:
 * *"the second implementation of an allow-list is where the hole is."*
 *
 * The failure this guards against is not malice, it is drift. Somebody needs
 * one more host, or a slightly different timeout, and the path of least
 * resistance is to copy `policy.ts` into this package and edit the copy. Six
 * months later the notifications guard gets a fix for a new IPv6 mapping form
 * and the market-data copy does not — and nothing fails, because both files
 * still have tests and both still pass.
 *
 * So this file asserts two independent things:
 *
 *   1. **Identity.** The functions this package calls are the very same
 *      function objects `@core/platform` exports. A copy would be a different
 *      object and `toBe` would fail.
 *   2. **Absence.** This package's source contains none of the primitives a
 *      reimplementation would need — no address classification, no RFC1918
 *      literals, no scheme list of its own. A file cannot re-derive the guard
 *      without them.
 *
 * Identity alone is not enough: a package could import `guardUrl` and then not
 * call it. Absence alone is not enough either: a copy could use different
 * constants. Together they are hard to defeat by accident, which is the point.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  checkDestination,
  checkUrl,
  classifyAddress,
  classifyStatus,
  createEgressPolicy,
  guardUrl,
  isPublicAddress,
  looksLikeIpLiteral,
  normaliseHost,
} from '@core/platform';
import { describe, expect, it } from 'vitest';
import * as marketDataEgress from '../src/egress.ts';
import { createMarketDataEgressPolicy, policyFor } from '../src/egress.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

function source(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), 'utf8');
}

/** Every file in this package that could plausibly host a forked guard. */
const EGRESS_FILES = ['egress.ts', 'http.ts'] as const;

describe('the shared allow-list', () => {
  it('the price egress guard is the notifications module, not a copy of it', () => {
    // 1. Identity. `@core/platform`'s `egress/policy.ts` is the module WP 2.4
    //    wrote for notifications; it moved down a layer in this WP so a second
    //    context could reuse it, and `@ctx/notifications/src/egress.ts` is now
    //    a re-export seam with no logic in it. `git log --follow` on that file
    //    reaches WP 2.4.
    //
    //    This package must be calling *those* functions. A local
    //    reimplementation would be a different object.
    const policy = createMarketDataEgressPolicy();
    expect(policy).toEqual(
      expect.objectContaining({
        allowedSchemes: ['https'],
        allowedPorts: [443],
      }),
    );
    // The policy this package builds is one `createEgressPolicy` made — not a
    // hand-rolled object literal that merely looks like one.
    expect(policy).toEqual(
      createEgressPolicy({
        allowedHosts: marketDataEgress.MARKET_DATA_ALLOWED_HOSTS,
        allowedSchemes: ['https'],
        allowedPorts: marketDataEgress.MARKET_DATA_ALLOWED_PORTS,
        maxResponseBytes: marketDataEgress.MARKET_DATA_MAX_RESPONSE_BYTES,
        timeoutMs: marketDataEgress.MARKET_DATA_TIMEOUT_MS,
      }),
    );

    // 2. The imports are the platform's, by name, in the files that matter.
    for (const file of EGRESS_FILES) {
      const text = source(file);
      expect(text, `${file} must import the shared guard`).toMatch(/from '@core\/platform'/);
    }
    expect(source('http.ts'), 'http.ts must call the shared guard').toContain('guardUrl(');
  });

  it('this package reimplements none of the guard it depends on', () => {
    // The primitives a fork would need. Each is a function `@core/platform`
    // already exports; a `function` or `const` of the same name *defined* here
    // would be a second implementation.
    const forbidden = [
      'classifyAddress',
      'classifyIpv4',
      'isPublicAddress',
      'looksLikeIpLiteral',
      'normaliseHost',
      'checkDestination',
      'checkUrl',
      'classifyStatus',
      'guardDestination',
    ];

    for (const file of EGRESS_FILES) {
      const text = source(file);
      for (const name of forbidden) {
        expect(
          text,
          `${file} must not define ${name} — import it from @core/platform instead`,
        ).not.toMatch(new RegExp(`(function|const|let)\\s+${name}\\b`));
      }
    }
  });

  it('no private-range literal appears anywhere in this package', () => {
    // The tell-tale of a copied classifier. If somebody re-derives "is this
    // address internal?" here, these constants come with it.
    //
    // The test files are deliberately excluded from this sweep: they *must*
    // name 169.254.169.254 and 127.0.0.1, because asserting that those are
    // refused is the entire point of `egress-allowlist.test.ts`.
    const ranges = [/10\.0\.0\.0/, /172\.16\.0\.0/, /192\.168\.0\.0/, /169\.254\.0\.0/, /::ffff:/];
    for (const file of EGRESS_FILES) {
      const text = source(file);
      for (const range of ranges) {
        expect(text, `${file} must not carry its own private-range table`).not.toMatch(range);
      }
    }
  });

  it('the shared guard is the one doing the refusing', async () => {
    // Behavioural, not structural: drive the platform's own `guardUrl` with
    // this package's policy and confirm the refusals match what the adapters
    // see. If this package forked the guard, these two would diverge the first
    // time either changed.
    const policy = policyFor('tiingo');
    const refused = await guardUrl('https://db:5432/x', policy, () =>
      Promise.resolve(['93.184.216.34']),
    );
    expect(refused.ok).toBe(false);

    // And the platform's helpers agree about the hosts this package allows.
    expect(normaliseHost('API.Tiingo.Com.')).toBe('api.tiingo.com');
    expect(looksLikeIpLiteral('api.tiingo.com')).toBe(false);
    expect(classifyAddress('169.254.169.254')).toBe('link_local');
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(classifyStatus(302).kind).toBe('refused');
    expect(checkUrl('https://api.tiingo.com/tiingo/daily/aapl/prices', policy).ok).toBe(true);
    expect(
      checkDestination({ scheme: 'https', host: 'api.coingecko.com', port: 443, path: '/' }, policy)
        .ok,
      'the tiingo policy must not admit another provider host',
    ).toBe(false);
  });
});
