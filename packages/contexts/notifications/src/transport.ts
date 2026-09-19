// SPDX-License-Identifier: MIT
/**
 * The HTTP transport. A dumb pipe with four safety properties and no policy.
 *
 * Separating it from `egress.ts` is deliberate and is what lets both halves be
 * proven honestly. The guard decides *whether* to connect and to which address;
 * this decides *how*, and it has no allow-list in it, so
 * `test/egress-allowlist.test.ts` can point it at a real local server answering
 * 302 and observe that the redirect target is never contacted — without the
 * test needing a switch that turns a security control off.
 *
 * The four properties:
 *
 * 1. **It connects to an address, not to a name.** `lookup` is overridden with
 *    a function that ignores DNS and hands back the address `guardDestination`
 *    already validated. That closes the DNS-rebinding window between check and
 *    connect. `servername` is still the hostname, so TLS verification is
 *    unweakened, and the `Host` header is the hostname, so virtual hosting
 *    still works.
 * 2. **It never follows a redirect.** Node's `http`/`https` clients do not,
 *    and this adds nothing that would. A 3xx is returned to the caller, which
 *    turns it into `redirect_not_followed`.
 * 3. **The body is bounded while it arrives.** The counter runs in the `data`
 *    handler and destroys the socket the moment the cap is passed, so a
 *    server that streams forever costs us `maxResponseBytes`, not memory.
 * 4. **Two timers, not one.** A connect/idle timeout via `request.setTimeout`
 *    and a whole-request deadline, because a server that dribbles one byte per
 *    second resets the idle timer forever.
 *
 * `rejectUnauthorized` is never set to false and there is no option that would
 * let a caller set it. A notification is not worth a downgraded TLS session.
 */
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { EgressRefusedError, assertHeaderValueSafe, type Destination } from './egress.ts';

export interface TransportRequest {
  readonly destination: Destination;
  readonly method: 'GET' | 'POST' | 'PUT';
  /** Built by an adapter from a fixed set of names. Never user-supplied keys. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  /**
   * TLS, or not. Every adapter passes `true` and the channel scheme allow-list
   * has no cleartext member, so the only caller that ever passes `false` is the
   * local 302 fixture in `test/egress-allowlist.test.ts`. It lives on the
   * *request* rather than being derived from the destination precisely so that
   * `Destination.scheme` stays the closed, TLS-only set the schema enforces.
   */
  readonly secure: boolean;
}

export interface TransportResponse {
  readonly status: number;
  /** Bounded by `maxResponseBytes`; truncated rather than grown. */
  readonly body: string;
  readonly bytesRead: number;
  /** Present on a 3xx. Recorded, never followed. */
  readonly location: string | null;
}

export type HttpTransport = (request: TransportRequest) => Promise<TransportResponse>;

/**
 * The real transport, over `node:https` (or `node:http` when the destination
 * says so, which only a test fixture ever does — the channel scheme allow-list
 * has no cleartext member).
 */
export function createNodeTransport(): HttpTransport {
  return async (request: TransportRequest): Promise<TransportResponse> => {
    const { destination } = request;
    const address = destination.addresses[0];
    if (address === undefined) {
      throw new EgressRefusedError(
        'private_address',
        'the transport was handed a destination with no validated address',
      );
    }

    for (const [name, value] of Object.entries(request.headers)) {
      assertHeaderValueSafe(name, value);
    }

    const secure = request.secure;
    const client = secure ? https : http;

    // The whole point: DNS is not consulted again. Whatever the guard resolved
    // and validated is what the socket connects to.
    const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
      const family = address.includes(':') ? 6 : 4;
      // Node's overloads differ by `options.all`; this callback shape satisfies
      // both because we only ever return a single address.
      (callback as (error: null, addr: string, family: number) => void)(null, address, family);
    };

    return await new Promise<TransportResponse>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        outcome();
      };

      const requestOptions: https.RequestOptions = {
        host: destination.host,
        port: destination.port,
        path: destination.path === '' ? '/' : destination.path,
        method: request.method,
        headers: { ...request.headers, host: destination.host },
        lookup: pinnedLookup,
        ...(secure
          ? { servername: destination.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' as const }
          : {}),
      };

      const outbound = client.request(requestOptions, (response) => {
        const chunks: Buffer[] = [];
        let bytesRead = 0;
        let overflowed = false;

        response.on('data', (chunk: Buffer) => {
          bytesRead += chunk.length;
          if (bytesRead > request.maxResponseBytes) {
            overflowed = true;
            response.destroy();
            outbound.destroy();
            finish(() =>
              reject(
                new EgressRefusedError(
                  'response_too_large',
                  `response exceeded ${String(request.maxResponseBytes)} bytes`,
                ),
              ),
            );
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          if (overflowed) return;
          const location = response.headers.location;
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              bytesRead,
              location: typeof location === 'string' ? location : null,
            }),
          );
        });

        response.on('error', (error) => finish(() => reject(error)));
      });

      // Idle timeout: no bytes for `timeoutMs`.
      outbound.setTimeout(request.timeoutMs, () => {
        outbound.destroy();
        finish(() =>
          reject(new EgressRefusedError('timeout', `no response within ${String(request.timeoutMs)} ms`)),
        );
      });

      // Whole-request deadline, because the idle timer above can be reset
      // forever by a server that sends one byte per second.
      const deadline = setTimeout(() => {
        outbound.destroy();
        finish(() =>
          reject(
            new EgressRefusedError(
              'timeout',
              `request did not complete within ${String(request.timeoutMs * 3)} ms`,
            ),
          ),
        );
      }, request.timeoutMs * 3);
      deadline.unref?.();

      outbound.on('error', (error) => finish(() => reject(error)));
      if (request.body !== undefined) outbound.write(request.body);
      outbound.end();
    });
  };
}
