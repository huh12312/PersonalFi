// SPDX-License-Identifier: MIT

/**
 * The `/_app` auth guard (gate-remediation-web.md M-3/M-8) sends an
 * unauthenticated visitor to `/login?redirect=<intended path>` so a
 * successful sign-in can return them where they meant to go. That value
 * round-trips through the URL bar, so `/login` must never trust it blindly:
 * an absolute URL (`https://evil.example`) or a protocol-relative one
 * (`//evil.example`, which browsers resolve against the current scheme) would
 * turn a bookmarked or shared login link into an open redirect. Only a
 * root-relative, same-document path is safe to hand to `navigate({ to })`.
 */
export function isSafeRedirectPath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\');
}
