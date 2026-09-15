// SPDX-License-Identifier: MIT
import { vi } from 'vitest';

import { client } from '../api/generated/client.gen.ts';
import { Sdk } from '../api/generated/index.ts';
import { registerCsrfInterceptor } from '../api/client-runtime-config.ts';

let initialized = false;

/**
 * Every generated React Query hook resolves through `Sdk.__registry.get()`
 * (`generated/@tanstack/react-query.gen.ts`), which throws "No SDK client
 * found" until `new Sdk()` has run once — `src/main.tsx` does this for the
 * real app, but a component test that renders a screen directly (not through
 * `main.tsx`) needs the same setup. Idempotent: safe to call from every test
 * file's module scope.
 */
export function ensureApiClient(): void {
  if (initialized) return;
  registerCsrfInterceptor(client);
  new Sdk();
  initialized = true;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function textResponse(body: string, status = 200, contentType = 'text/csv'): Response {
  return new Response(body, { status, headers: { 'Content-Type': contentType } });
}

export interface FetchRoute {
  method?: string;
  /** Matched against the request's pathname. */
  match: string | RegExp;
  handle: (context: { url: URL; request: Request }) => Response | Promise<Response>;
}

/**
 * Routes a stubbed global `fetch` by method + pathname, first match wins —
 * the same idea as `src/app/router.test.tsx`'s `stubFetch`, generalised with
 * a method and a `RegExp` match (several screens PATCH/POST/DELETE the same
 * resource family, which a pathname-only map can't disambiguate).
 */
export function stubFetchRoutes(routes: FetchRoute[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, 'http://localhost/');
      // The generated client calls `fetch(new Request(url, init))` for a
      // mutating request — a single `Request` argument, not `fetch(url,
      // init)` — so both the method and the body live on `input`, not the
      // (then-`undefined`) second argument. Normalising to one real
      // `Request` here means a handler can always call `.json()`/`.text()`
      // regardless of which shape the caller used.
      const request = input instanceof Request ? input : new Request(url, init);
      const method = request.method.toUpperCase();

      const route = routes.find((candidate) => {
        if (candidate.method !== undefined && candidate.method.toUpperCase() !== method)
          return false;
        return typeof candidate.match === 'string'
          ? candidate.match === url.pathname
          : candidate.match.test(url.pathname);
      });

      if (route === undefined) {
        throw new Error(`api-test-utils: no fetch route stubbed for ${method} ${url.pathname}`);
      }
      return route.handle({ url, request });
    }),
  );
}
