// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { isSafeRedirectPath } from './safe-redirect.ts';

/**
 * G-09 (WP 9.10, ASVS V3.7.2): the post-login redirect guard had no test, so a loosening of it would have
 * passed CI. `/login?redirect=` round-trips through the URL bar, and a browser resolves several shapes that
 * look in-app to another origin: `//host` (scheme-relative), `/\host` (`\` is `/` in a special URL), and any
 * path with a tab, newline or carriage return, which the URL parser DELETES before resolving, turning
 * `/<TAB>/host` into `//host`.
 */
describe('isSafeRedirectPath', () => {
  it.each(['/', '/budget', '/accounts/abc?tab=1#top', '/plan?scenario=baseline'])(
    'accepts the in-app path %s',
    (path) => {
      expect(isSafeRedirectPath(path)).toBe(true);
    },
  );

  it.each([
    ['https://evil.example', 'an absolute URL'],
    ['http://evil.example/x', 'an absolute http URL'],
    ['//evil.example', 'a scheme-relative URL'],
    ['/\\evil.example', 'a backslash after the slash'],
    ['/a\\..\\evil', 'a backslash anywhere'],
    ['javascript:alert(1)', 'a javascript: URL'],
    ['data:text/html,<script>', 'a data: URL'],
    ['', 'the empty string'],
    ['budget', 'a relative path with no leading slash'],
    ['/\t/evil.example', 'a tab the URL parser strips, leaving //'],
    ['/\n/evil.example', 'a newline the URL parser strips, leaving //'],
    ['/\r/evil.example', 'a carriage return the URL parser strips, leaving //'],
    ['/\u0000/evil.example', 'a NUL'],
    ['/\u007f/x', 'a DEL'],
  ])('refuses %j (%s)', (path) => {
    expect(isSafeRedirectPath(path)).toBe(false);
  });
});
