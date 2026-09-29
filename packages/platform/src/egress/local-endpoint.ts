// SPDX-License-Identifier: MIT
/**
 * The local-endpoint egress policy — the *inverse* of `policy.ts`, written as
 * a second policy type rather than as a switch on the first
 * (05-phase-5-dispatch.md §3 WP 5.2 part 1).
 *
 * `policy.ts` refuses every non-public address and says in its header that
 * there is no switch for that, "not even for tests". Ollama lives on a private
 * compose address, so the local-model adapter needs the opposite rule — and
 * the opposite rule must never be reachable from the public policy by a flag.
 * It is therefore a different type (`kind: 'local_endpoint'`), built by a
 * different constructor, and the notification and market-data surfaces cannot
 * be handed one by accident: nothing that takes an `EgressPolicy` accepts it.
 *
 * ## The rules, and why each one exists
 *
 * | Rule | Code | Why |
 * |---|---|---|
 * | exactly one host and one port, fixed at construction | — | the adapter names paths, never destinations; there is nothing to allow-list because there is only one |
 * | `http` or `https` while local; **`https` only** when `allowRemote` | `scheme_not_allowed` | cleartext is tolerable only because the bytes never leave the host's bridge; a LAN box is 03 T6's reader (05 §6 Q2) |
 * | a single-label name (`ollama`, `localhost`) unless `allowRemote` | `host_not_allowed` | a compose service name is what "on this host" looks like from inside a container; a dotted name is somewhere else |
 * | never an IP literal | `literal_ip` | the same reasoning as `policy.ts`: numeric forms are how allow-lists get walked past, and a name is what TLS verifies |
 * | no userinfo, no path, no query in the endpoint | `userinfo_in_url` / `url_malformed` | the endpoint is an origin; a credential there ends up in logs |
 * | **every** resolved address is `loopback` or `private` | `address_not_local` | link-local — and with it 169.254.169.254, the metadata range — CGNAT, multicast, unspecified and reserved are all "not public" and still not a local model |
 * | **any** public address refuses the whole destination | `public_address` | a name answering both private and public is an attack, not a deployment — the same "refuse, never filter" rule as `policy.ts` |
 * | no redirects | `redirect_not_followed` | Ollama never redirects; a 3xx means something else is answering |
 * | the body is bounded while it arrives | `response_too_large` | a model that never stops costs `maxResponseBytes`, not memory (08 §4.4 step 1) |
 * | one whole-request deadline | `timeout` | a model that dribbles a token a minute resets any idle timer forever |
 * | the caller's `AbortSignal` destroys the socket | `aborted` | a kill must stop the generation, not abandon it (05 §5 risk "a kill level that does not actually stop an in-flight run") |
 * | connect to the address that was checked | — | resolve, classify, then dial *that address* with a lookup that ignores DNS: the rebinding defence of `transport.ts`, same construction |
 *
 * Classification is `policy.ts`'s `classifyAddress`, imported, never
 * re-implemented: 03 §5.2's lesson — the second implementation of an
 * allow-list is where the hole is — applies to its inverse as well. Inside
 * compose "loopback" in the literal sense is unreachable across containers,
 * so the enforced property is **"never a public address, and on an internal
 * network"**: the address half is this file, the network half is
 * `compose.yml`'s `llm` network (`internal: true`) and
 * `scripts/compose-hardening-check.sh`'s `ollama-*` rules.
 *
 * ## Why this file carries its own request function
 *
 * `createNodeTransport` has no `AbortSignal`, and its pinned lookup is a
 * closure rather than an export. The request function below uses the same
 * pinned-lookup construction and adds the signal; folding the two back into
 * one transport is recorded for the orchestrator in
 * `docs/evidence/phase-5/wp5.2-local-model.md` §10. Until then there are two
 * copies of *the dial*, and still exactly one of *the classification*.
 */
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import {
  classifyAddress,
  looksLikeIpLiteral,
  normaliseHost,
  systemResolver,
  type AddressClass,
  type Resolver,
} from './policy.ts';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const LOCAL_ENDPOINT_REFUSAL_CODES = [
  'url_malformed',
  'userinfo_in_url',
  'scheme_not_allowed',
  'host_not_allowed',
  'port_not_allowed',
  'literal_ip',
  'path_not_allowed',
  'public_address',
  'address_not_local',
  'dns_resolution_failed',
  'redirect_not_followed',
  'response_too_large',
  'timeout',
  'aborted',
  'header_not_allowed',
  'connection_failed',
] as const;
export type LocalEndpointRefusalCode = (typeof LOCAL_ENDPOINT_REFUSAL_CODES)[number];

export class LocalEndpointRefusedError extends Error {
  readonly code: LocalEndpointRefusalCode;
  constructor(code: LocalEndpointRefusalCode, detail: string) {
    super(`local endpoint refused (${code}): ${detail}`);
    this.name = 'LocalEndpointRefusedError';
    this.code = code;
  }
}

export function isLocalEndpointRefusedError(error: unknown): error is LocalEndpointRefusedError {
  return error instanceof LocalEndpointRefusedError;
}

/** The only two classes a local endpoint may resolve to. */
const LOCAL_CLASSES: readonly AddressClass[] = Object.freeze(['loopback', 'private']);

export const DEFAULT_LOCAL_MAX_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_LOCAL_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface LocalEndpointPolicyInput {
  /**
   * `ollama:11434` (a bare host:port is `http`), `http://ollama:11434`, or —
   * only with `allowRemote` — `https://llm.lan:443`.
   */
  readonly endpoint: string;
  readonly allowRemote?: boolean;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}

export interface LocalEndpointPolicy {
  /** The discriminant that keeps this type from ever being mistaken for an `EgressPolicy`. */
  readonly kind: 'local_endpoint';
  readonly scheme: 'http' | 'https';
  /** Lowercased, trailing dot stripped. Never an IP literal. */
  readonly host: string;
  readonly port: number;
  readonly allowRemote: boolean;
  readonly maxResponseBytes: number;
  readonly timeoutMs: number;
}

export type LocalEndpointDecision =
  | { readonly ok: true; readonly policy: LocalEndpointPolicy }
  | { readonly ok: false; readonly code: LocalEndpointRefusalCode; readonly detail: string };

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * The synchronous half: everything that can be refused without resolving.
 * Returned as a decision so a caller can report it; `createLocalEndpointPolicy`
 * is the throwing form for a composition root.
 */
export function checkLocalEndpoint(input: LocalEndpointPolicyInput): LocalEndpointDecision {
  const raw = input.endpoint.trim();
  if (raw.length === 0) return refuseDecision('url_malformed', 'the endpoint is empty');
  if (/[\s\0]/u.test(raw)) {
    return refuseDecision(
      'url_malformed',
      'the endpoint contains whitespace or a control character',
    );
  }
  const allowRemote = input.allowRemote === true;

  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  } catch {
    return refuseDecision('url_malformed', 'the endpoint is not host:port or an absolute URL');
  }
  if (url.username !== '' || url.password !== '') {
    return refuseDecision('userinfo_in_url', 'a credential in the endpoint ends up in logs');
  }
  const scheme = url.protocol.replace(/:$/u, '');
  if (scheme !== 'http' && scheme !== 'https') {
    return refuseDecision('scheme_not_allowed', `${scheme}: only http or https`);
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    return refuseDecision(
      'url_malformed',
      'the endpoint is an origin — the adapter names its own paths',
    );
  }
  if (allowRemote && scheme !== 'https') {
    return refuseDecision(
      'scheme_not_allowed',
      'a remote local-model endpoint must be https: a prompt carrying your finances would ' +
        'otherwise cross the LAN in plaintext (05 §6 Q2)',
    );
  }

  // `URL` already lowercases and IDNA-encodes the hostname; normalise the
  // trailing dot the same way `policy.ts` does.
  const host = normaliseHost(url.hostname);
  if (host.length === 0) return refuseDecision('url_malformed', 'the endpoint has no host');
  if (looksLikeIpLiteral(host)) {
    return refuseDecision('literal_ip', `${host} is an IP address, not a name`);
  }
  const labels = host.split('.');
  if (!labels.every((label) => LABEL.test(label))) {
    return refuseDecision('host_not_allowed', `${host} is not a syntactically valid hostname`);
  }
  if (labels.length > 1 && !allowRemote) {
    return refuseDecision(
      'host_not_allowed',
      `${host} is a dotted name; a local endpoint is a single-label compose service name ` +
        'unless LOCAL_MODEL_ALLOW_REMOTE is set',
    );
  }

  const port = url.port === '' ? (scheme === 'https' ? 443 : 80) : Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return refuseDecision('port_not_allowed', `${url.port} is not a TCP port`);
  }

  const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_LOCAL_MAX_RESPONSE_BYTES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) {
    return refuseDecision('url_malformed', 'maxResponseBytes must be a positive integer');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return refuseDecision('url_malformed', 'timeoutMs must be a positive integer');
  }

  return {
    ok: true,
    policy: Object.freeze({
      kind: 'local_endpoint',
      scheme,
      host,
      port,
      allowRemote,
      maxResponseBytes,
      timeoutMs,
    }),
  };
}

/**
 * Build the policy or throw. A composition root should let the throw fail
 * boot: an endpoint that does not mean what the operator wrote is a
 * configuration error, the same stance `createEgressPolicy` takes.
 */
export function createLocalEndpointPolicy(input: LocalEndpointPolicyInput): LocalEndpointPolicy {
  const decision = checkLocalEndpoint(input);
  if (!decision.ok) throw new LocalEndpointRefusedError(decision.code, decision.detail);
  return decision.policy;
}

// ---------------------------------------------------------------------------
// The guard: resolve, then classify every answer
// ---------------------------------------------------------------------------

export type LocalAddressDecision =
  | { readonly ok: true; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly code: LocalEndpointRefusalCode; readonly detail: string };

/**
 * Resolve the policy's host and classify **every** address it answers with.
 *
 * A public answer anywhere refuses the whole destination (checked first, so
 * the recorded code is the more serious one); any answer that is neither
 * loopback nor private refuses too. There is no filtering: the addresses
 * returned are all of them, all local, and the dial uses the first.
 */
export async function guardLocalEndpoint(
  policy: LocalEndpointPolicy,
  resolve: Resolver = systemResolver,
): Promise<LocalAddressDecision> {
  let addresses: readonly string[];
  try {
    addresses = await resolve(policy.host);
  } catch (error) {
    return {
      ok: false,
      code: 'dns_resolution_failed',
      detail: `${policy.host} did not resolve: ${describe(error)}`,
    };
  }
  if (addresses.length === 0) {
    return {
      ok: false,
      code: 'dns_resolution_failed',
      detail: `${policy.host} resolved to no addresses`,
    };
  }

  const classified = addresses.map((address) => ({ address, klass: classifyAddress(address) }));
  const publicAnswer = classified.find((entry) => entry.klass === 'public');
  if (publicAnswer !== undefined) {
    return {
      ok: false,
      code: 'public_address',
      detail:
        `${policy.host} resolves to ${publicAnswer.address}, a public address; a local ` +
        'endpoint never leaves the host, so the whole destination is refused',
    };
  }
  const foreign = classified.find((entry) => !LOCAL_CLASSES.includes(entry.klass));
  if (foreign !== undefined) {
    return {
      ok: false,
      code: 'address_not_local',
      detail: `${policy.host} resolves to ${foreign.address} (${foreign.klass}), which is neither loopback nor private`,
    };
  }
  return { ok: true, addresses };
}

// ---------------------------------------------------------------------------
// The dial
// ---------------------------------------------------------------------------

export interface LocalEndpointRequest {
  readonly method: 'GET' | 'POST';
  /** An absolute path the adapter chose, e.g. `/api/chat`. Never user-supplied. */
  readonly path: string;
  /** From a fixed set of names the adapter builds. Never user-supplied keys. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Aborting destroys the socket: the server sees the connection close. */
  readonly signal?: AbortSignal;
  /** May only lower the policy's cap. */
  readonly maxResponseBytes?: number;
  /** May only shorten the policy's deadline. */
  readonly timeoutMs?: number;
}

export interface LocalEndpointResponse {
  readonly status: number;
  readonly body: string;
  readonly bytesRead: number;
  /** The address that was checked and dialled. Recorded for evidence, never re-resolved. */
  readonly address: string;
}

export interface LocalEndpointTransport {
  readonly policy: LocalEndpointPolicy;
  request(request: LocalEndpointRequest): Promise<LocalEndpointResponse>;
}

export interface LocalEndpointTransportOptions {
  /** Injected by tests. Production uses `systemResolver` — Docker's embedded DNS inside compose. */
  readonly resolve?: Resolver;
}

const PATH = /^\/[A-Za-z0-9._~/-]*$/u;

/**
 * The only network path `@advisor/local-model` has. Every request re-runs the
 * guard (a name that re-points between two runs is re-checked), dials the
 * checked address with a lookup that never consults DNS, refuses a 3xx
 * without reading it, bounds the body while it arrives, and honours both the
 * deadline and the caller's signal by destroying the socket.
 */
export function createLocalEndpointTransport(
  policy: LocalEndpointPolicy,
  options: LocalEndpointTransportOptions = {},
): LocalEndpointTransport {
  if (policy.kind !== 'local_endpoint') {
    throw new TypeError('createLocalEndpointTransport takes a LocalEndpointPolicy');
  }
  const resolve = options.resolve ?? systemResolver;

  async function request(input: LocalEndpointRequest): Promise<LocalEndpointResponse> {
    if (input.signal?.aborted === true) {
      throw new LocalEndpointRefusedError('aborted', 'the signal was aborted before the request');
    }
    if (!PATH.test(input.path) || input.path.startsWith('//')) {
      throw new LocalEndpointRefusedError(
        'path_not_allowed',
        'the path is not a plain absolute path',
      );
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (/[\r\n\0]/u.test(value) || value.length > 4096 || !/^[A-Za-z0-9-]+$/u.test(name)) {
        throw new LocalEndpointRefusedError('header_not_allowed', `${name} is not a safe header`);
      }
      headers[name.toLowerCase()] = value;
    }

    const guarded = await guardLocalEndpoint(policy, resolve);
    if (!guarded.ok) throw new LocalEndpointRefusedError(guarded.code, guarded.detail);
    const address = guarded.addresses[0];
    if (address === undefined) {
      throw new LocalEndpointRefusedError('dns_resolution_failed', 'no validated address');
    }

    const maxResponseBytes = Math.min(
      policy.maxResponseBytes,
      input.maxResponseBytes ?? policy.maxResponseBytes,
    );
    const timeoutMs = Math.max(1, Math.min(policy.timeoutMs, input.timeoutMs ?? policy.timeoutMs));

    // The rebinding defence, the same construction as `transport.ts`: DNS is
    // not consulted again, and both callback shapes are answered because
    // `net` calls `lookup` with `{ all: true }` whenever `autoSelectFamily` is
    // on (the Node ≥ 20 default).
    const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      const family = address.includes(':') ? 6 : 4;
      if (
        typeof lookupOptions === 'object' &&
        lookupOptions !== null &&
        lookupOptions.all === true
      ) {
        (
          callback as unknown as (
            error: null,
            addresses: { address: string; family: number }[],
          ) => void
        )(null, [{ address, family }]);
        return;
      }
      (callback as (error: null, addr: string, family: number) => void)(null, address, family);
    };

    const body = input.body === undefined ? undefined : Buffer.from(input.body, 'utf8');
    if (body !== undefined) {
      headers['content-type'] ??= 'application/json';
      headers['content-length'] = String(body.length);
    }

    return await new Promise<LocalEndpointResponse>((resolvePromise, rejectPromise) => {
      let settled = false;
      const signal = input.signal;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener('abort', onAbort);
        outcome();
      };
      const fail = (code: LocalEndpointRefusalCode, detail: string): void => {
        outbound.destroy();
        finish(() => rejectPromise(new LocalEndpointRefusedError(code, detail)));
      };

      const client = policy.scheme === 'https' ? https : http;
      const requestOptions: https.RequestOptions = {
        host: policy.host,
        port: policy.port,
        path: input.path,
        method: input.method,
        headers: { ...headers, host: `${policy.host}:${String(policy.port)}` },
        lookup: pinnedLookup,
        // One socket per request, closed with it: no pooled connection can
        // outlive the check that justified it, and an abort always has a
        // socket of its own to destroy.
        agent: false,
        ...(policy.scheme === 'https'
          ? { servername: policy.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const }
          : {}),
      };

      const outbound = client.request(requestOptions, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.destroy();
          fail('redirect_not_followed', `HTTP ${String(status)}: redirects are never followed`);
          return;
        }
        const chunks: Buffer[] = [];
        let bytesRead = 0;
        response.on('data', (chunk: Buffer) => {
          bytesRead += chunk.length;
          if (bytesRead > maxResponseBytes) {
            response.destroy();
            fail('response_too_large', `response exceeded ${String(maxResponseBytes)} bytes`);
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          finish(() =>
            resolvePromise({
              status,
              body: Buffer.concat(chunks).toString('utf8'),
              bytesRead,
              address,
            }),
          );
        });
        response.on('error', (error) => fail('connection_failed', describe(error)));
        response.on('close', () => {
          if (!response.complete) fail('connection_failed', 'the server closed mid-response');
        });
      });

      const deadline = setTimeout(() => {
        fail('timeout', `request did not complete within ${String(timeoutMs)} ms`);
      }, timeoutMs);
      deadline.unref?.();

      function onAbort(): void {
        fail('aborted', 'the caller aborted the request');
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      outbound.on('error', (error) => {
        if (!settled) fail('connection_failed', describe(error));
      });
      if (body !== undefined) outbound.write(body);
      outbound.end();
    });
  }

  return Object.freeze({ policy, request });
}

function refuseDecision(code: LocalEndpointRefusalCode, detail: string): LocalEndpointDecision {
  return { ok: false, code, detail };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
