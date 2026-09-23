// SPDX-License-Identifier: MIT
/**
 * The one place a market-data adapter can open a socket.
 *
 * Every adapter in `src/adapters/` receives a `ProviderClient` and has no other
 * way out of the process. The client composes four things that must all hold
 * for the egress claim to mean anything:
 *
 *   1. **`guardUrl` from `@core/platform`** — the WP 2.4 allow-list, reused.
 *      Scheme, host, port, literal IP, private/link-local/loopback range, and a
 *      DNS answer classified *before* the connect.
 *   2. **The transport connects to the address the guard validated**, not to
 *      the name, which is what closes the rebinding window.
 *   3. **`classifyStatus`** turns a 3xx into `redirect_not_followed`. We never
 *      issue the second request, so an allow-listed host cannot launder one to
 *      an internal one.
 *   4. **A closed header vocabulary.** `HEADER_NAMES` below is the complete set
 *      of names this context will put on the wire. A caller cannot add one.
 *
 * ## Why the URL never appears in an error
 *
 * FRED takes its key as a query parameter and has no header form (see
 * `secrets.ts`). So a URL built for FRED contains a credential, and `throw new
 * Error(\`GET ${url} failed\`)` would put it in a stack trace, a log line and
 * `market_data_runs.error_message` in one stroke. This client therefore never
 * interpolates a URL into a message — it names the *provider and path*, which
 * is what an operator actually needs — and it runs every provider-authored
 * string through `redactSecrets` before returning it.
 *
 * `test/log-hygiene.test.ts` → `'an API key never appears in a log line'`
 * sabotages this by making the fake transport answer with a body that echoes
 * the key, and asserts on everything that comes back out.
 */
import {
  classifyStatus,
  guardUrl,
  isEgressRefusedError,
  systemResolver,
  type EgressPolicy,
  type HttpTransport,
  type RefusalCode,
  type Resolver,
} from '@core/platform';
import type { MarketDataProvider } from '../schema/index.ts';
import { baseUrlFor } from './egress.ts';
import { redactSecrets, type ApiKey } from './secrets.ts';

/**
 * Every header name this context may send. Closed set, checked at runtime.
 *
 * 08 §4.4's egress rule is "no user-supplied headers". The strongest form of
 * that is a caller who cannot express one: `ProviderRequest.headers` is keyed
 * by this union, so a header name that is not here is a type error, and
 * `buildHeaders` re-checks at runtime for the untyped edges.
 */
export const HEADER_NAMES = [
  'accept',
  'authorization',
  'content-type',
  'user-agent',
  'x-cg-demo-api-key',
  'x-openfigi-apikey',
] as const;
export type HeaderName = (typeof HEADER_NAMES)[number];

/**
 * The User-Agent every request carries.
 *
 * SEC EDGAR *requires* a contactable User-Agent and several providers ask for
 * one; sending a real, honest identifier is also simply how a self-hosted
 * client should behave. It contains no user data and no deployment hostname.
 */
export const USER_AGENT = 'PersonalFi/0.1 (self-hosted personal finance; +https://github.com/)';

export interface ProviderRequest {
  readonly method: 'GET' | 'POST';
  /** Path only, beginning with `/`. The host comes from the allow-list, never from a caller. */
  readonly path: string;
  /** Query parameters, encoded here. A value is never trusted to be pre-encoded. */
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Partial<Readonly<Record<HeaderName, string>>>;
  readonly body?: string;
  /** Provider billing units this request costs. Defaults to 1 request. */
  readonly cost?: number;
}

export type ProviderResponse =
  | { readonly kind: 'ok'; readonly status: number; readonly body: string }
  /** 4xx/5xx. `body` is redacted; it is the provider's words, not ours. */
  | { readonly kind: 'http_error'; readonly status: number; readonly detail: string }
  | { readonly kind: 'refused'; readonly code: RefusalCode | string; readonly detail: string }
  | { readonly kind: 'transport_error'; readonly detail: string };

export interface ProviderClient {
  readonly provider: MarketDataProvider;
  send(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface ProviderClientOptions {
  readonly provider: MarketDataProvider;
  readonly policy: EgressPolicy;
  readonly transport: HttpTransport;
  /** Injected so a test can answer `127.0.0.1` and watch the guard refuse it. */
  readonly resolve?: Resolver;
  /**
   * Every key this process holds, so a response body that echoes *any* of them
   * is redacted. Not just this provider's: a proxy or a mis-copied config could
   * surface another one, and the redactor costs nothing.
   */
  readonly keys?: readonly ApiKey[];
}

export function createProviderClient(options: ProviderClientOptions): ProviderClient {
  const { provider, policy, transport } = options;
  const resolve = options.resolve ?? systemResolver;
  const keys = options.keys ?? [];

  return {
    provider,

    async send(request: ProviderRequest): Promise<ProviderResponse> {
      const url = buildUrl(provider, request);

      // 1. The guard. Note what is passed: the policy, which for an adapter
      //    allows exactly one host. A refusal here never reaches the network.
      const decision = await guardUrl(url, policy, resolve);
      if (!decision.ok) {
        return {
          kind: 'refused',
          code: decision.code,
          // `detail` names the host, which is not a secret. It never names the
          // URL, which for FRED would carry the key.
          detail: redactSecrets(decision.detail, keys),
        };
      }

      let headers: Record<string, string>;
      try {
        headers = buildHeaders(request.headers ?? {});
      } catch (error) {
        return {
          kind: 'refused',
          code: 'header_not_allowed',
          detail: redactSecrets(describe(error), keys),
        };
      }

      try {
        // 2. The transport connects to `decision.destination.addresses[0]`,
        //    which the guard classified `public`. DNS is not consulted again.
        const response = await transport({
          destination: decision.destination,
          method: request.method,
          headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          timeoutMs: policy.timeoutMs,
          maxResponseBytes: policy.maxResponseBytes,
          secure: true,
        });

        // 3. A 3xx is a refusal, not a failure: we chose not to follow it.
        const verdict = classifyStatus(response.status);
        if (verdict.kind === 'refused') {
          return {
            kind: 'refused',
            code: verdict.code,
            detail: `${provider} answered ${String(response.status)}; redirects are never followed`,
          };
        }
        if (verdict.kind !== 'ok') {
          return {
            kind: 'http_error',
            status: response.status,
            detail: redactSecrets(truncate(response.body), keys),
          };
        }
        return { kind: 'ok', status: response.status, body: response.body };
      } catch (error) {
        if (isEgressRefusedError(error)) {
          return {
            kind: 'refused',
            code: error.code,
            detail: redactSecrets(error.message, keys),
          };
        }
        // A socket error's message can carry the host but never the path or the
        // query; redact anyway, because "never" is a claim this module should
        // not have to make about somebody else's error strings.
        return { kind: 'transport_error', detail: redactSecrets(describe(error), keys) };
      }
    },
  };
}

/**
 * Build the absolute URL.
 *
 * The host is `baseUrlFor(provider)` — a constant — and the path is checked to
 * be a path. A caller cannot supply `//evil.example/x` (protocol-relative, the
 * classic way a "path" becomes a host) or a full URL, and if one ever did, the
 * guard's host allow-list would still refuse it: two independent controls, in
 * the order that puts the cheap one first.
 */
function buildUrl(provider: MarketDataProvider, request: ProviderRequest): string {
  const path = request.path;
  if (!path.startsWith('/') || path.startsWith('//')) {
    // Not a refusal code — a programming error in this package, which should
    // fail loudly in a test rather than be handled at runtime.
    throw new TypeError(`${provider}: a request path must begin with a single '/' (got ${path})`);
  }
  const search = new URLSearchParams(request.query ?? {}).toString();
  return `${baseUrlFor(provider)}${path}${search === '' ? '' : `?${search}`}`;
}

function buildHeaders(requested: Partial<Readonly<Record<HeaderName, string>>>): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
  for (const [name, value] of Object.entries(requested)) {
    if (value === undefined) continue;
    if (!(HEADER_NAMES as readonly string[]).includes(name)) {
      // Unreachable through the typed API; reachable through an untyped edge,
      // which is exactly the case a runtime check is for.
      throw new TypeError(`${name} is not an allowed market-data header`);
    }
    headers[name] = value;
  }
  return headers;
}

/** Enough of an error body to diagnose, not enough to fill a log. */
function truncate(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length <= 500 ? flat : `${flat.slice(0, 500)}…`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
