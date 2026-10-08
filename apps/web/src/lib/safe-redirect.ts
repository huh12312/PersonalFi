// SPDX-License-Identifier: MIT

/**
 * The `/_app` auth guard sends an
 * unauthenticated visitor to `/login?redirect=<intended path>` so a
 * successful sign-in can return them where they meant to go. That value
 * round-trips through the URL bar, so `/login` must never trust it blindly:
 * an absolute URL (`https://evil.example`) or a protocol-relative one
 * (`//evil.example`, which browsers resolve against the current scheme) would
 * turn a bookmarked or shared login link into an open redirect. Only a
 * root-relative, same-document path is safe to hand to `navigate({ to })`.
 */
export function isSafeRedirectPath(path: string): boolean {
  // Any backslash or C0/DEL control character is refused wherever it sits, not only after the leading
  // slash: a URL parser treats `\` as `/` and DELETES tab, newline and carriage return before resolving,
  // so `/<TAB>/host` becomes `//host` (G-09, WP 9.14).
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return false;
  return path.startsWith('/') && !path.startsWith('//');
}
