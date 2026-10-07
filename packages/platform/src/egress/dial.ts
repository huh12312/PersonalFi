// SPDX-License-Identifier: MIT
/**
 * **The** outbound dial — the one place in the tree that opens an HTTP(S)
 * connection to somewhere a guard has approved (WP 9.11, gaps G-24 and G-27).
 *
 * Until WP 9.11 there were two copies of this: `transport.ts` (the public
 * egress policy: ntfy, market data, Esplora/Etherscan) and
 * `local-endpoint.ts` (the local model). Their header rules had already
 * drifted apart, which is 03 §5.2's warning come true: the second
 * implementation of an allow-list is where the hole is. Both are now thin
 * wrappers that build a `DialRequest` and map `DialError` onto their own
 * refusal vocabulary; everything that touches the socket is here, once:
 *
 * 1. **It connects to the address the guard validated, not to a name.**
 *    `lookup` is replaced by a function that never consults DNS. That closes
 *    the rebinding window between check and connect. `servername` stays the
 *    hostname, so certificate verification is against the name the operator
 *    allow-listed.
 * 2. **TLS is verified, at 1.2 or above, and no caller can say otherwise.**
 *    `TLS_CLIENT_OPTIONS` is frozen and spread last; `DialRequest` has no field
 *    that reaches it. `apps/api/test/tls-verification.test.ts` points both
 *    wrappers at a loopback server with a self-signed certificate and watches
 *    each refuse it with nothing written.
 * 3. **Header names and values are checked before a byte is written**: a CR,
 *    LF or NUL in a value is request splitting; a name outside `[A-Za-z0-9-]`
 *    is not something an adapter builds.
 * 4. **One socket per request** (`agent: false`): no pooled connection can
 *    outlive the check that justified it.
 * 5. **Redirects are never followed.** The caller chooses whether a 3xx is
 *    returned to it (with `location`, so it can record the refusal) or refused
 *    here without reading the body.
 * 6. **The body is bounded while it arrives**: the socket is destroyed the
 *    moment the cap is passed.
 * 7. **Timers that a dribbling server cannot defeat**: an optional idle timeout
 *    and a whole-request deadline; and the caller's `AbortSignal` destroys the
 *    socket.
 *
 * Connection errors (refused, reset, a certificate the client cannot verify)
 * are passed through as the original `Error`, so a caller can see Node's
 * `code`; everything this function decides itself is a `DialError`.
 */
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

/**
 * The TLS client options every outbound connection uses. Frozen, and spread
 * *after* everything else in `pinnedRequest`, so nothing upstream can win.
 */
export const TLS_CLIENT_OPTIONS = Object.freeze({
  rejectUnauthorized: true,
  minVersion: 'TLSv1.2',
} as const);

export const DIAL_ERROR_CODES = [
  'header_not_allowed',
  'redirect_not_followed',
  'response_too_large',
  'timeout',
  'idle_timeout',
  'aborted',
  'incomplete_response',
] as const;
export type DialErrorCode = (typeof DIAL_ERROR_CODES)[number];

export class DialError extends Error {
  readonly code: DialErrorCode;
  constructor(code: DialErrorCode, detail: string) {
    super(detail);
    this.name = 'DialError';
    this.code = code;
  }
}

export function isDialError(error: unknown): error is DialError {
  return error instanceof DialError;
}

export interface DialRequest {
  /** The name: SNI and certificate verification are against it. */
  readonly host: string;
  /** The address a guard validated. DNS is never consulted again. */
  readonly address: string;
  readonly port: number;
  readonly path: string;
  readonly method: string;
  /** The `Host` header value (`host` or `host:port`, as the protocol wants). */
  readonly hostHeader: string;
  /** From a fixed set of names an adapter builds. Checked here regardless. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | Buffer;
  /** TLS or cleartext. Cleartext only for a compose-internal model or a test fixture. */
  readonly tls: boolean;
  readonly maxResponseBytes: number;
  /** The whole-request deadline. */
  readonly deadlineMs: number;
  /** No bytes for this long ends the request. Omitted: the deadline alone. */
  readonly idleTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** `return`: hand a 3xx back with its `location`. `refuse`: reject it unread. */
  readonly redirects: 'return' | 'refuse';
}

export interface DialResponse {
  readonly status: number;
  readonly body: string;
  readonly bytesRead: number;
  /** Present on a 3xx when `redirects` is `return`. Recorded, never followed. */
  readonly location: string | null;
}

const HEADER_NAME = /^[A-Za-z0-9-]+$/u;
const HEADER_VALUE_FORBIDDEN = /[\r\n\0]/u;
export const MAX_HEADER_VALUE_LENGTH = 4096;

/**
 * Why a header may not be written, or `null`. The single rule both egress
 * policies apply (`policy.ts`'s `assertHeaderValueSafe` delegates here).
 */
export function headerProblem(name: string, value: string): string | null {
  if (!HEADER_NAME.test(name)) return `${JSON.stringify(name)} is not a plain header name`;
  if (HEADER_VALUE_FORBIDDEN.test(value)) return `${name} contains a control character`;
  if (value.length > MAX_HEADER_VALUE_LENGTH) return `${name} is implausibly long`;
  return null;
}

/** A lookup that answers with the validated address and never asks DNS. */
function pinnedLookupFor(address: string): LookupFunction {
  const family = address.includes(':') ? 6 : 4;
  // Both callback shapes are answered, and that is not defensive padding:
  // `net` calls `lookup` with `{ all: true }` whenever `autoSelectFamily` is on
  // (the default since Node 20) and reads `addresses[0].address`; a lookup that
  // only answered the string form hands `undefined` to `isIP`.
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options !== null && options.all === true) {
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
}

export async function pinnedRequest(request: DialRequest): Promise<DialResponse> {
  if (request.signal?.aborted === true) {
    throw new DialError('aborted', 'the signal was aborted before the request');
  }
  for (const [name, value] of Object.entries(request.headers)) {
    const problem = headerProblem(name, value);
    if (problem !== null) throw new DialError('header_not_allowed', problem);
  }

  const client = request.tls ? https : http;
  const requestOptions: https.RequestOptions = {
    host: request.host,
    port: request.port,
    path: request.path === '' ? '/' : request.path,
    method: request.method,
    headers: { ...request.headers, host: request.hostHeader },
    lookup: pinnedLookupFor(request.address),
    agent: false,
    ...(request.tls ? { servername: request.host, ...TLS_CLIENT_OPTIONS } : {}),
  };

  return await new Promise<DialResponse>((resolve, reject) => {
    let settled = false;
    const signal = request.signal;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      outcome();
    };
    const fail = (error: Error): void => {
      outbound.destroy();
      finish(() => reject(error));
    };

    const outbound = client.request(requestOptions, (response) => {
      const status = response.statusCode ?? 0;
      if (request.redirects === 'refuse' && status >= 300 && status < 400) {
        response.destroy();
        fail(
          new DialError(
            'redirect_not_followed',
            `HTTP ${String(status)}: redirects are never followed`,
          ),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let bytesRead = 0;
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytesRead += chunk.length;
        if (bytesRead > request.maxResponseBytes) {
          response.destroy();
          fail(
            new DialError(
              'response_too_large',
              `response exceeded ${String(request.maxResponseBytes)} bytes`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const location = response.headers.location;
        finish(() =>
          resolve({
            status,
            body: Buffer.concat(chunks).toString('utf8'),
            bytesRead,
            location: typeof location === 'string' ? location : null,
          }),
        );
      });
      response.on('error', (error) => fail(error));
      response.on('close', () => {
        if (!response.complete) {
          fail(new DialError('incomplete_response', 'the server closed mid-response'));
        }
      });
    });

    if (request.idleTimeoutMs !== undefined) {
      const idle = request.idleTimeoutMs;
      outbound.setTimeout(idle, () => {
        fail(new DialError('idle_timeout', `no response within ${String(idle)} ms`));
      });
    }

    const deadline = setTimeout(() => {
      fail(
        new DialError(
          'timeout',
          `request did not complete within ${String(request.deadlineMs)} ms`,
        ),
      );
    }, request.deadlineMs);
    deadline.unref?.();

    function onAbort(): void {
      fail(new DialError('aborted', 'the caller aborted the request'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    outbound.on('error', (error) => {
      if (!settled) fail(error);
    });
    if (request.body !== undefined) outbound.write(request.body);
    outbound.end();
  });
}
