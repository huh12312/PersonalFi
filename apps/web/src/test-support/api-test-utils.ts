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
 * The two-level slice of the real taxonomy the picker tests need.
 *
 * Small and shaped exactly like `GET /categories`: one heading that is *not*
 * assignable with two children that are, one childless top-level row
 * (`uncategorised`, which is how the real taxonomy ships it), and a non-expense
 * `kind` so the grouping's kind annotation is exercised rather than assumed.
 * Real ids, because `app-walkthrough.spec.ts` asserts the id that reaches the
 * PATCH body and a placeholder there would prove nothing.
 */
export const TEST_CATEGORIES = [
  {
    id: 'cat_dining',
    key: 'dining',
    parentId: null,
    label: 'Dining',
    description: 'Eating out.',
    kind: 'expense',
    icon: 'utensils',
    sort: 100,
    isSystem: true,
    archivedAt: null,
    assignable: false,
  },
  {
    id: 'cat_dining_restaurants',
    key: 'dining.restaurants',
    parentId: 'cat_dining',
    label: 'Restaurants',
    description: 'Sit-down meals.',
    kind: 'expense',
    icon: 'utensils',
    sort: 101,
    isSystem: true,
    archivedAt: null,
    assignable: true,
  },
  {
    id: 'cat_dining_coffee',
    key: 'dining.coffee',
    parentId: 'cat_dining',
    label: 'Coffee Shops',
    description: 'Coffee and tea.',
    kind: 'expense',
    icon: 'coffee',
    sort: 102,
    isSystem: true,
    archivedAt: null,
    assignable: true,
  },
  {
    id: 'cat_transfers',
    key: 'transfers',
    parentId: null,
    label: 'Transfers',
    description: 'Movement between your own accounts.',
    kind: 'transfer',
    icon: 'arrow-left-right',
    sort: 200,
    isSystem: true,
    archivedAt: null,
    assignable: false,
  },
  {
    id: 'cat_transfers_internal',
    key: 'transfers.internal',
    parentId: 'cat_transfers',
    label: 'Internal Transfer',
    description: 'Between two of your accounts.',
    kind: 'transfer',
    icon: 'arrow-left-right',
    sort: 201,
    isSystem: true,
    archivedAt: null,
    assignable: true,
  },
  {
    id: 'cat_uncategorised',
    key: 'uncategorised',
    parentId: null,
    label: 'Uncategorised',
    description: 'We do not know yet.',
    kind: 'other',
    icon: 'circle-help',
    sort: 900,
    isSystem: true,
    archivedAt: null,
    assignable: true,
  },
] as const;

/**
 * `GET /categories`, for every `stubFetchRoutes` list that mounts a screen
 * containing a `CategoryPicker`.
 *
 * Exported as a route rather than left to each test to spell out, because
 * `stubFetchRoutes` throws on an unstubbed path by design — so a screen that
 * starts rendering a picker breaks every suite that mounts it until this is
 * added, which is the behaviour we want, and a shared constant is how that stays
 * a one-line fix instead of six copies of a fixture drifting apart.
 */
export function categoriesRoute(): FetchRoute {
  return {
    match: '/api/categories',
    handle: () => jsonResponse({ categories: TEST_CATEGORIES }),
  };
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
