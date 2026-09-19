// SPDX-License-Identifier: MIT
/**
 * The egress guard. **This is the security surface of WP 2.4.**
 *
 * 02-phase-2-dispatch.md §5: "Notification channels are egress — the first
 * outbound path in the app that a *user-supplied string* controls. An SSRF
 * here reaches `db:5432` and the container metadata endpoint."
 *
 * Every outbound byte this context sends passes through `guardDestination` and
 * then through a transport that was handed an already-validated IP address. No
 * other file in the package opens a socket, and the adapters
 * (`adapters/ntfy.ts`, `adapters/smtp.ts`) cannot reach the network except
 * through what this file returns.
 *
 * ## The nine refusals, and why each one exists
 *
 * | Code | Stops |
 * |---|---|
 * | `url_malformed` | anything that is not a parseable absolute URL |
 * | `userinfo_in_url` | `https://user:pass@ntfy.example/` — a credential in a field that ends up in logs, and the oldest parser-confusion trick there is |
 * | `scheme_not_allowed` | `http:`, bare `smtp:`, `file:`, `gopher:`, `dict:` — the classic SSRF pivots |
 * | `host_not_allowed` | anything the operator did not name. This is the control that does the most work: `db`, `metadata.google.internal` and `localhost` all fail here before anything is resolved |
 * | `port_not_allowed` | `5432`, `6379`, `25` — a second, independent reason `db:5432` is refused, so allow-listing `db` by mistake is still not enough |
 * | `literal_ip` | `https://169.254.169.254/`, `https://[::1]/`, `https://2130706433/`, `https://0x7f000001/` — a destination given as an address rather than a name never has a legitimate reason here, and the numeric forms are how an allow-list that only pattern-matched dotted quads gets walked past |
 * | `private_address` | a *name* that resolves into loopback, RFC1918, CGNAT, link-local (169.254.0.0/16, which is the metadata range), IPv6 ULA/link-local, IPv4-mapped IPv6, multicast, or the unspecified address |
 * | `dns_resolution_failed` | a name that does not resolve — fail closed, never "try it and see" |
 * | `redirect_not_followed` | a 3xx. We do not follow redirects at all, so an allow-listed host cannot launder a request to an internal one |
 * | `response_too_large` | a response that keeps coming. Bounded before it is buffered, not after |
 * | `timeout` | a socket that hangs, which is how a worker thread pool is exhausted |
 * | `header_not_allowed` | a CR or LF in a value that becomes a header — request splitting |
 *
 * ## DNS rebinding: resolve, check, then connect to *that address*
 *
 * Checking the name and then handing the name to the socket layer is a
 * time-of-check/time-of-use bug with a name: the attacker's resolver answers
 * `93.184.216.34` for the check and `127.0.0.1` for the connect, and the guard
 * has validated nothing. So `guardDestination` returns the **resolved
 * addresses it validated**, and `createNodeTransport` connects with a `lookup`
 * that ignores DNS entirely and returns one of them. The TLS `servername` is
 * still the hostname, so certificate validation is unweakened.
 *
 * A host that resolves to *both* a public and a private address is refused
 * outright rather than filtered down to the public one. There is no benign
 * reason for that answer and filtering it would be an invitation to race it.
 *
 * ## What is deliberately not configurable
 *
 * There is no "allow private addresses" switch, not even for tests.
 * `createEgressPolicy` refuses an allow-list entry that is an IP literal, so
 * an operator cannot spell `127.0.0.1` into the allow-list and reach the same
 * place by another door. `test/egress-allowlist.test.ts` proves the redirect
 * refusal against a real local HTTP server by pointing the **transport** at it
 * — the transport has no policy in it by design — and proves the refusal
 * itself against the real production policy. Neither half needs a hatch.
 */
import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';
import type { ChannelScheme } from '../schema/index.ts';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const REFUSAL_CODES = [
  'url_malformed',
  'userinfo_in_url',
  'scheme_not_allowed',
  'host_not_allowed',
  'port_not_allowed',
  'literal_ip',
  'private_address',
  'dns_resolution_failed',
  'redirect_not_followed',
  'response_too_large',
  'timeout',
  'header_not_allowed',
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** What an address turned out to be. Only `public` is ever dialled. */
export type AddressClass =
  | 'public'
  | 'unspecified'
  | 'loopback'
  | 'private'
  | 'cgnat'
  | 'link_local'
  | 'multicast'
  | 'reserved'
  | 'documentation';

export interface Destination {
  readonly scheme: ChannelScheme;
  /** Lowercased, trailing dot stripped, never an IP literal. */
  readonly host: string;
  readonly port: number;
  /** Path + query for an HTTP destination; `''` for SMTP. */
  readonly path: string;
  /** Every address the name resolved to. All of them classified `public`. */
  readonly addresses: readonly string[];
}

export type EgressDecision =
  | { readonly ok: true; readonly destination: Destination }
  | { readonly ok: false; readonly code: RefusalCode; readonly detail: string };

/**
 * A refusal raised as an error, for the call sites where a `Promise<T>` has no
 * room for a decision type. Carries the code so `delivery_attempts.refusal_code`
 * can be written from it without parsing a message.
 */
export class EgressRefusedError extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, detail: string) {
    super(`egress refused (${code}): ${detail}`);
    this.name = 'EgressRefusedError';
    this.code = code;
  }
}

export function isEgressRefusedError(error: unknown): error is EgressRefusedError {
  return error instanceof EgressRefusedError;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface EgressPolicy {
  /** Exact hostnames, lowercased. No wildcards, no IPs, no suffix matching. */
  readonly allowedHosts: readonly string[];
  readonly allowedSchemes: readonly ChannelScheme[];
  readonly allowedPorts: readonly number[];
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
}

export interface EgressPolicyInput {
  readonly allowedHosts?: readonly string[];
  readonly allowedSchemes?: readonly ChannelScheme[];
  readonly allowedPorts?: readonly number[];
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}

/**
 * The ports a notification channel may use. 443 for ntfy, 465 for implicit-TLS
 * SMTP, 587 for submission-with-STARTTLS.
 *
 * Note what is missing: 25. Port 25 is server-to-server relay, it is blocked
 * outbound by every residential ISP and most VPS providers, and a "submission"
 * configuration pointed at it is a misconfiguration that would send cleartext
 * if anything ever let it.
 */
export const DEFAULT_ALLOWED_PORTS: readonly number[] = Object.freeze([443, 465, 587]);

export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Build a policy from operator configuration.
 *
 * Throws rather than silently narrowing, because a deployment whose allow-list
 * did not mean what the operator wrote should fail to boot, not quietly refuse
 * every notification at 03:00.
 */
export function createEgressPolicy(input: EgressPolicyInput = {}): EgressPolicy {
  const allowedHosts = (input.allowedHosts ?? []).map((raw) => {
    const host = normaliseHost(raw);
    if (host.length === 0) {
      throw new TypeError('an egress allow-list entry may not be empty');
    }
    if (host.includes('*')) {
      throw new TypeError(
        `${raw}: wildcards are not supported. A wildcard allow-list is one typo away from *.` +
          'attacker.example matching, and this list has at most a handful of entries.',
      );
    }
    if (looksLikeIpLiteral(host)) {
      throw new TypeError(
        `${raw}: an allow-list entry must be a hostname, not an IP address. Allowing a literal ` +
          'would be a second door to the private-range refusal this policy exists to enforce.',
      );
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
      throw new TypeError(`${raw}: is not a syntactically valid hostname`);
    }
    return host;
  });

  const allowedPorts = input.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  for (const port of allowedPorts) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new TypeError(`${String(port)}: is not a TCP port`);
    }
  }

  return Object.freeze({
    allowedHosts: Object.freeze([...new Set(allowedHosts)]),
    allowedSchemes: Object.freeze([...(input.allowedSchemes ?? ['https', 'smtps', 'smtp+starttls'])]),
    allowedPorts: Object.freeze([...new Set(allowedPorts)]),
    maxResponseBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

/** A policy that allows nothing. The default before an operator configures one. */
export const DENY_ALL_POLICY: EgressPolicy = createEgressPolicy({ allowedHosts: [] });

// ---------------------------------------------------------------------------
// Host and address classification
// ---------------------------------------------------------------------------

export function normaliseHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  // A trailing dot is the DNS root and `ntfy.example.` === `ntfy.example`. An
  // allow-list that compared the two as strings would let the dotted form
  // through, which is a documented WAF bypass.
  while (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * Is this host an IP address rather than a name?
 *
 * Wider than `net.isIP` on purpose. `http://2130706433/` and
 * `http://0x7f000001/` are both 127.0.0.1 to a C resolver and neither is an
 * `isIP` match; historically they are the single most common way an allow-list
 * that only looked for dotted quads has been walked past.
 *
 * The rule: a bracketed host is a literal, anything `net.isIP` accepts is a
 * literal, and **a host whose last label is entirely numeric or hexadecimal is
 * a literal**. RFC 3696 §2 makes an all-numeric TLD illegal, so the third
 * clause cannot refuse a real hostname.
 */
export function looksLikeIpLiteral(host: string): boolean {
  if (host.length === 0) return false;
  if (host.startsWith('[') || host.endsWith(']')) return true;
  if (host.includes(':')) return true;
  if (isIP(host) !== 0) return true;
  const lastLabel = host.slice(host.lastIndexOf('.') + 1);
  return /^\d+$/.test(lastLabel) || /^0[xX][0-9a-fA-F]+$/.test(lastLabel);
}

function ipv4Octets(address: string): readonly number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function classifyIpv4(address: string): AddressClass {
  const octets = ipv4Octets(address);
  if (octets === null) return 'reserved';
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  // 169.254.0.0/16. 169.254.169.254 — the cloud metadata endpoint — is in here,
  // and so is every other link-local address an attacker might reach for.
  if (a === 169 && b === 254) return 'link_local';
  if (a === 192 && b === 0 && c === 0) return 'reserved';
  if (a === 192 && b === 0 && c === 2) return 'documentation';
  if (a === 198 && b === 51 && c === 100) return 'documentation';
  if (a === 203 && b === 0 && c === 113) return 'documentation';
  if (a === 192 && b === 88 && c === 99) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  if (a === 255 && b === 255 && c === 255 && d === 255) return 'reserved';
  return 'public';
}

function classifyIpv6(address: string): AddressClass {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  if (lower === '::' || lower === '') return 'unspecified';
  if (lower === '::1') return 'loopback';
  // ::ffff:127.0.0.1 and ::ffff:7f00:1 are both loopback wearing a v6 hat.
  const mapped = /^::ffff:(?:0:)?(.+)$/.exec(lower);
  if (mapped !== null) {
    const inner = mapped[1] ?? '';
    if (isIP(inner) === 4) return classifyIpv4(inner);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
    if (hex !== null) {
      const high = Number.parseInt(hex[1] ?? '0', 16);
      const low = Number.parseInt(hex[2] ?? '0', 16);
      const dotted = `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`;
      return classifyIpv4(dotted);
    }
    return 'reserved';
  }
  const firstHextet = Number.parseInt((lower.split(':')[0] ?? '0') || '0', 16);
  // fc00::/7 unique-local, fe80::/10 link-local, fec0::/10 site-local
  // (deprecated but still routed by some stacks), ff00::/8 multicast.
  if ((firstHextet & 0xfe00) === 0xfc00) return 'private';
  if ((firstHextet & 0xffc0) === 0xfe80) return 'link_local';
  if ((firstHextet & 0xffc0) === 0xfec0) return 'private';
  if ((firstHextet & 0xff00) === 0xff00) return 'multicast';
  if ((firstHextet & 0xffff) === 0x0064) return 'reserved'; // 64:ff9b::/96 NAT64, 100::/64 discard
  if (lower.startsWith('2001:db8')) return 'documentation';
  if (lower.startsWith('2001:0db8')) return 'documentation';
  return 'public';
}

/** What range does this address sit in? Anything but `public` is refused. */
export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 4) return classifyIpv4(address);
  if (family === 6) return classifyIpv6(address);
  // Not an address at all. Refuse rather than guess.
  return 'reserved';
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === 'public';
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export type Resolver = (host: string) => Promise<readonly string[]>;

/** `dns.lookup(host, { all: true })`, which honours `/etc/hosts` as the OS does. */
export const systemResolver: Resolver = async (host) => {
  const results = await dns.lookup(host, { all: true, verbatim: true });
  return results.map((result) => result.address);
};

export interface DestinationInput {
  readonly scheme: ChannelScheme;
  readonly host: string;
  readonly port: number;
  readonly path?: string;
}

/**
 * The synchronous half: scheme, host, port, literal-IP.
 *
 * Split out from the DNS half so every refusal that does not need the network
 * is provable without one, and so a `verify()` on a mistyped host answers
 * immediately instead of after a resolver timeout.
 */
export function checkDestination(input: DestinationInput, policy: EgressPolicy): EgressDecision {
  const host = normaliseHost(input.host);

  if (!policy.allowedSchemes.includes(input.scheme)) {
    return refuse('scheme_not_allowed', `${input.scheme} is not an allowed scheme`);
  }
  if (host.length === 0) {
    return refuse('url_malformed', 'the destination has no host');
  }
  if (looksLikeIpLiteral(host)) {
    // Checked *before* the allow-list so the message is the true reason: a
    // literal is refused even if somebody managed to get one into the list.
    return refuse('literal_ip', `${host} is an IP address, not a hostname`);
  }
  if (!policy.allowedHosts.includes(host)) {
    return refuse('host_not_allowed', `${host} is not in the destination allow-list`);
  }
  if (!Number.isInteger(input.port) || !policy.allowedPorts.includes(input.port)) {
    return refuse('port_not_allowed', `port ${String(input.port)} is not allowed`);
  }

  return {
    ok: true,
    destination: { scheme: input.scheme, host, port: input.port, path: input.path ?? '', addresses: [] },
  };
}

/**
 * Parse a user-supplied URL into a destination, refusing everything a URL can
 * carry that a destination may not.
 */
export function checkUrl(rawUrl: string, policy: EgressPolicy): EgressDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return refuse('url_malformed', 'the channel URL is not an absolute URL');
  }
  if (url.username !== '' || url.password !== '') {
    return refuse('userinfo_in_url', 'a credential in a URL ends up in logs; put it in the config');
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (scheme !== 'https') {
    // Only ntfy takes a URL, and ntfy is HTTPS-only. `checkDestination`'s
    // scheme list is the general rule; this is the specific one.
    return refuse('scheme_not_allowed', `${scheme}: only https may appear in a channel URL`);
  }
  const port = url.port === '' ? 443 : Number.parseInt(url.port, 10);
  return checkDestination(
    { scheme: 'https', host: url.hostname, port, path: `${url.pathname}${url.search}` },
    policy,
  );
}

/**
 * The full guard: everything `checkDestination` does, then resolve the name and
 * classify **every** address it answers with.
 *
 * The returned `addresses` are what the transport must connect to. Passing the
 * hostname on to the socket layer instead would reopen the rebinding window
 * this function exists to close.
 */
export async function guardDestination(
  input: DestinationInput,
  policy: EgressPolicy,
  resolve: Resolver = systemResolver,
): Promise<EgressDecision> {
  const syntactic = checkDestination(input, policy);
  if (!syntactic.ok) return syntactic;

  let addresses: readonly string[];
  try {
    addresses = await resolve(syntactic.destination.host);
  } catch (error) {
    return refuse(
      'dns_resolution_failed',
      `${syntactic.destination.host} did not resolve: ${describe(error)}`,
    );
  }
  if (addresses.length === 0) {
    return refuse('dns_resolution_failed', `${syntactic.destination.host} resolved to no addresses`);
  }

  for (const address of addresses) {
    const klass = classifyAddress(address);
    if (klass !== 'public') {
      // Refuse on *any* non-public answer rather than filtering to the public
      // ones. A name that answers with both is an attack, not a deployment.
      return refuse(
        'private_address',
        `${syntactic.destination.host} resolves to ${address} (${klass})`,
      );
    }
  }

  return { ok: true, destination: { ...syntactic.destination, addresses } };
}

export async function guardUrl(
  rawUrl: string,
  policy: EgressPolicy,
  resolve: Resolver = systemResolver,
): Promise<EgressDecision> {
  const syntactic = checkUrl(rawUrl, policy);
  if (!syntactic.ok) return syntactic;
  return guardDestination(
    {
      scheme: syntactic.destination.scheme,
      host: syntactic.destination.host,
      port: syntactic.destination.port,
      path: syntactic.destination.path,
    },
    policy,
    resolve,
  );
}

/**
 * Header values this context will put on the wire.
 *
 * There is no path by which a user supplies a header *name*: the adapters build
 * a fixed set. What a user does supply is an ntfy access token, which becomes
 * an `Authorization` value, and a CR or LF in it would split the request. This
 * refuses that, and refuses a value long enough to be a smuggled body.
 */
export function assertHeaderValueSafe(name: string, value: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new EgressRefusedError('header_not_allowed', `${name} contains a control character`);
  }
  if (value.length > 4096) {
    throw new EgressRefusedError('header_not_allowed', `${name} is implausibly long`);
  }
}

export type StatusVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'retryable' }
  | { readonly kind: 'permanent' }
  | { readonly kind: 'refused'; readonly code: RefusalCode; readonly detail: string };

/**
 * A response status, classified.
 *
 * `3xx` is a **refusal**, not a failure: we did not follow it, and an operator
 * needs to see that we *chose* not to. 08 §4.5's notification channels are the
 * one place a redirect could launder an allow-listed host into an internal one,
 * and `test/egress-allowlist.test.ts` → `'a 302 to an internal host is not
 * followed'` is the proof that both halves hold — this classification, and a
 * transport that never issues the second request.
 */
export function classifyStatus(status: number): StatusVerdict {
  if (status >= 300 && status < 400) {
    return {
      kind: 'refused',
      code: 'redirect_not_followed',
      detail: `HTTP ${String(status)}: redirects are never followed`,
    };
  }
  if (status >= 200 && status < 300) return { kind: 'ok' };
  if (status === 408 || status === 429 || status >= 500) return { kind: 'retryable' };
  return { kind: 'permanent' };
}

function refuse(code: RefusalCode, detail: string): EgressDecision {
  return { ok: false, code, detail };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
