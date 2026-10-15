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
 * Since WP 9.11 all four properties, and the TLS options, live in `dial.ts`
 * (the one dialer); `apps/api/test/tls-verification.test.ts` proves the
 * certificate check against a self-signed loopback server.
 */
import { isDialError, pinnedRequest } from './dial.ts';
import { EgressRefusedError, type Destination } from './policy.ts';

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
  /**
   * WP 10.6: the caller's cancellation. Aborting destroys the socket, the way
   * the local-endpoint transport's signal does — a hosted narrator call that a
   * kill switch or the run's deadline stops must not keep a request open.
   */
  readonly signal?: AbortSignal;
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
 * The real transport, over `node:https` (or `node:http` when the request says
 * so, which only a test fixture ever does — the channel scheme allow-list has
 * no cleartext member).
 *
 * Since WP 9.11 (G-24) it owns no socket code: the pinned lookup, the TLS
 * options, the body cap and both timers are `dial.ts`'s `pinnedRequest`, the
 * one dialer this tree has, shared with `local-endpoint.ts`. This wrapper
 * keeps its own contract: a 3xx is *returned* (with `location`) so the caller
 * can record `redirect_not_followed`, and the refusals it raises are
 * `EgressRefusedError`s with `policy.ts`'s codes.
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
    try {
      return await pinnedRequest({
        host: destination.host,
        address,
        port: destination.port,
        path: destination.path,
        method: request.method,
        hostHeader: destination.host,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        tls: request.secure,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        maxResponseBytes: request.maxResponseBytes,
        // Idle: no bytes for `timeoutMs`. Deadline: three of those, because the
        // idle timer can be reset forever by a server sending a byte a second.
        idleTimeoutMs: request.timeoutMs,
        deadlineMs: request.timeoutMs * 3,
        redirects: 'return',
      });
    } catch (error) {
      throw toEgressError(error);
    }
  };
}

function toEgressError(error: unknown): unknown {
  if (!isDialError(error)) return error;
  switch (error.code) {
    case 'header_not_allowed':
      return new EgressRefusedError('header_not_allowed', error.message);
    case 'response_too_large':
      return new EgressRefusedError('response_too_large', error.message);
    case 'timeout':
    case 'idle_timeout':
      return new EgressRefusedError('timeout', error.message);
    case 'redirect_not_followed':
      return new EgressRefusedError('redirect_not_followed', error.message);
    case 'aborted':
    case 'incomplete_response':
      return error;
  }
}
