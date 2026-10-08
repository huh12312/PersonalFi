// SPDX-License-Identifier: MIT
/**
 * G-14 (WP 9.10; fixed in WP 9.14): properties that were verified only by a probe, with no committed test.
 * HSTS, nosniff, framing, referrer, cross-origin policies, a locked-down CSP and `-Server` are the shipped
 * `docker/Caddyfile`'s `(security_headers)` snippet; this pins each value, and that no site block weakens TLS,
 * turns on directory listing or answers without the snippet. It is structural by design: the live
 * before/after is in `wp9.10-security-review.md` (ZAP, curl) and `wp9.11-security-fixes.md` (G-06), and the
 * headers' ordering against `handle_errors` is `caddy-error-headers.test.ts`'s. A live-listener suite
 * (every header on every response class, TLS versions on the wire) needs a running stack and stays the
 * gate's walk and `e2e/csp.spec.ts`, which parses this same file.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const RAW = readFileSync(new URL('../docker/Caddyfile', import.meta.url), 'utf8');
const CADDYFILE = RAW.split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/** The `header { … }` block inside `(security_headers)`. */
function headerBlock(): string {
  const snippet = /^\(security_headers\) \{\n([\s\S]*?)^\}/m.exec(CADDYFILE)?.[1] ?? '';
  const header = /^\theader \{\n([\s\S]*?)^\t\}/m.exec(snippet)?.[1];
  if (header === undefined) throw new Error('no header block in (security_headers)');
  return header;
}

function headerValue(name: string): string {
  const match = new RegExp(`^\\s*${name}\\s+"([^"]*)"\\s*$`, 'm').exec(headerBlock());
  if (match === null) throw new Error(`no ${name} header`);
  return match[1] ?? '';
}

describe('G-14: the security headers every response carries', () => {
  it('HSTS: at least a year, with subdomains', () => {
    const value = headerValue('Strict-Transport-Security');
    const age = Number(/max-age=(\d+)/.exec(value)?.[1]);
    expect(age).toBeGreaterThanOrEqual(31_536_000);
    expect(value).toContain('includeSubDomains');
  });

  it.each([
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'no-referrer'],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    ['Cross-Origin-Resource-Policy', 'same-origin'],
  ])('%s is exactly %s', (name, expected) => {
    expect(headerValue(name)).toBe(expected);
  });

  it('Cross-Origin-Embedder-Policy follows the Plaid switch and defaults to require-corp', () => {
    expect(headerValue('Cross-Origin-Embedder-Policy')).toBe('{coep_policy}');
    expect(CADDYFILE).toMatch(/default "require-corp"/);
  });

  it('Permissions-Policy denies the powerful features', () => {
    const value = headerValue('Permissions-Policy');
    for (const feature of ['geolocation', 'camera', 'microphone', 'payment', 'usb']) {
      expect(value).toContain(`${feature}=()`);
    }
  });

  it('the Server header is removed', () => {
    expect(headerBlock()).toMatch(/^\s*-Server\s*$/m);
  });

  it('the CSP is closed: self-only, no eval, no inline script, no framing, no base tag, no plugins', () => {
    const csp = headerValue('Content-Security-Policy');
    const directive = (name: string): string =>
      new RegExp(`(?:^|; )${name} ([^;]*)`).exec(csp)?.[1] ?? '';
    expect(directive('default-src')).toBe("'self'");
    expect(directive('script-src')).toBe("'self'");
    expect(directive('script-src-elem')).toMatch(/^'self'/);
    expect(directive('object-src')).toBe("'none'");
    expect(directive('frame-ancestors')).toBe("'none'");
    expect(directive('base-uri')).toBe("'none'");
    expect(directive('form-action')).toBe("'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    // The only 'unsafe-inline' allowed is the style ATTRIBUTE one (layout values set from JS) and the Plaid
    // style-src-elem switch; never script.
    for (const scriptDirective of ['script-src', 'script-src-elem', 'default-src']) {
      expect(directive(scriptDirective)).not.toContain('unsafe-inline');
    }
    expect(csp).not.toMatch(/\bhttp:/);
    expect(csp).not.toMatch(/\*/);
  });
});

describe('G-14: the listeners', () => {
  it('weaken neither TLS nor the file server', () => {
    // Caddy's defaults are TLS 1.2+ with AEAD suites; an override is the only way to lower them.
    expect(CADDYFILE).not.toMatch(/\bprotocols\b/);
    expect(CADDYFILE).not.toMatch(/\bciphers\b/);
    expect(CADDYFILE).not.toMatch(/\bfile_server\b[^\n]*\bbrowse\b/);
    expect(CADDYFILE).not.toMatch(/\bbrowse\b/);
    expect(CADDYFILE).not.toMatch(/\bhttp_port\b|\bauto_https\s+off\b/);
  });

  it('the TLS listener uses the internal CA and the API is only reachable through /api/', () => {
    expect(CADDYFILE).toMatch(/:8443 \{\n\ttls internal\n/);
    const proxies = [...CADDYFILE.matchAll(/reverse_proxy (\S+)/g)].map((match) => match[1]);
    expect(proxies).toEqual(['api:8080']);
    expect(CADDYFILE).toMatch(/handle_path \/api\/\*/);
  });

  it('admin is off', () => {
    expect(CADDYFILE).toMatch(/^\tadmin off$/m);
  });
});

describe('G-14: nothing a probe found is shipped in the image', () => {
  const caddyDockerfile = readFileSync(
    new URL('../docker/caddy.Dockerfile', import.meta.url),
    'utf8',
  );
  const dockerignore = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');

  it('source maps are deleted from the web build and the image build fails if one remains', () => {
    expect(caddyDockerfile).toMatch(/find apps\/web\/dist -name '\*\.map' -delete/);
    expect(caddyDockerfile).toMatch(
      /\[ -z "\$\(find \/srv\/web -name '\*\.map' -print -quit\)" \]/,
    );
  });

  it('.git is outside the build context', () => {
    expect(dockerignore.split('\n')).toContain('.git');
  });
});
