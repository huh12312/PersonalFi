// SPDX-License-Identifier: MIT
/**
 * Where an advisor is allowed to point.
 *
 * An insight carries two kinds of outbound link: an `external:https://…`
 * `source_ref` on an evidence row, and a `url` on an `open_url` proposed action.
 * Neither is fetched by us — nothing here opens a socket, and that is worth
 * saying because the shape of this file looks like the notifications egress
 * guard and is solving a different problem. WP 2.4's guard exists because the
 * *worker* connects. This one exists because the *user's browser* will, on a
 * click, from a page that holds their session.
 *
 * So the rules are the ones that make a click safe rather than the ones that
 * make a request safe:
 *
 *   * **`https` only.** No `http`, and certainly none of the schemes
 *     `markdown.ts` refuses in prose (`javascript:`, `data:`); a link is the
 *     one place in an insight where a scheme reaches a browser's navigation.
 *   * **The host must be in the advisor's own `egress_allowlist`.** Not a
 *     global list: the allow-list is a property of the registration a human
 *     reviewed, so "which sites can this advisor send me to?" is answered by
 *     the manifest a reviewer read and not by a constant somewhere in the app.
 *     A `builtin` advisor ships with an empty list and therefore cannot link
 *     out at all, which is the correct default and not an oversight.
 *   * **No credentials, no non-default port, no IP literal.** `https://user:
 *     pass@host` renders as `host` in most link previews; a port is how a link
 *     reaches something that is not the web server the host name implies; an IP
 *     literal is how an allow-list is bypassed by a host that is not a name.
 *   * **A subdomain match must be a subdomain.** `evil-example.com` does not
 *     match `example.com`; `docs.example.com` does. The check is on a label
 *     boundary, because `endsWith` on a bare suffix is the classic version of
 *     this bug.
 *
 * Everything is compared after `URL` parsing rather than against the raw
 * string, so percent-encoding, unicode host names and a stray backslash all
 * normalise before the decision instead of after it.
 */

export type LinkRefusal =
  | 'unparsable'
  | 'scheme_not_https'
  | 'has_credentials'
  | 'explicit_port'
  | 'host_is_ip_literal'
  | 'host_not_allowed'
  | 'too_long';

export type LinkVerdict =
  | { readonly ok: true; readonly href: string }
  | { readonly ok: false; readonly reason: LinkRefusal };

const MAX_URL_LENGTH = 2048;
/** `1.2.3.4`, `[::1]`, and the decimal/octal spellings of the same. */
const IP_LITERAL = /^(?:\[|\d+(?:\.\d+)*$|0[xX][0-9a-fA-F]+)/;

/**
 * `host` is inside `allowed` — exactly, or as a subdomain of it.
 *
 * Both sides are lowercased and any trailing root dot is dropped first, because
 * `EXAMPLE.COM.` and `example.com` are the same host to a resolver and two
 * different strings to `===`.
 */
export function hostMatches(host: string, allowed: string): boolean {
  const left = host.toLowerCase().replace(/\.$/, '');
  const right = allowed.toLowerCase().replace(/\.$/, '');
  if (right.length === 0) return false;
  if (left === right) return true;
  return left.endsWith(`.${right}`);
}

/**
 * Check one outbound link against one advisor's allow-list.
 *
 * `allowlist` is `AdvisorManifest.egress_allowlist`. An empty list refuses
 * everything, which is what makes a `builtin` advisor structurally incapable of
 * linking off-site rather than merely not doing so today.
 */
export function checkLink(url: string, allowlist: readonly string[]): LinkVerdict {
  if (url.length === 0 || url.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'unparsable' };
  }

  if (parsed.protocol !== 'https:') return { ok: false, reason: 'scheme_not_https' };
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'has_credentials' };
  }
  if (parsed.port !== '') return { ok: false, reason: 'explicit_port' };
  if (IP_LITERAL.test(parsed.hostname)) return { ok: false, reason: 'host_is_ip_literal' };
  if (!allowlist.some((allowed) => hostMatches(parsed.hostname, allowed))) {
    return { ok: false, reason: 'host_not_allowed' };
  }
  // The normalised form, not the input: it is what the UI will render and what
  // the row will store, so a link that passed as one string and is shown as
  // another cannot happen.
  return { ok: true, href: parsed.toString() };
}

/** `external:https://…` → the URL. `null` for a ref this module does not own. */
export function externalUrlOf(ref: string): string | null {
  return ref.startsWith('external:') ? ref.slice('external:'.length) : null;
}
