// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';

import { attachVirtualAuthenticator } from './support/cold-start-authenticator.ts';

/**
 * C-6 (docs/evidence/phase-2/gate-security-review.md §5, G2-4): "the first
 * passkey enrolment attempt failed on CSRF until the token was reissued."
 * This suite reproduces the gate's exact cold-start conditions — a real
 * `docker compose down -v && build && up -d`, `just bootstrap-user`, then the
 * *first* browser visit ever made to the enrolment link — against the real
 * API over real TLS, with a real CDP virtual authenticator, not
 * `support/mock-api.ts`'s mocked network (see that file's own header for why
 * the rest of this suite's siblings use mocks and this one does not).
 *
 * ## Why every test here self-skips by default
 *
 * There is no `webServer` for this project (`playwright.config.ts`'s
 * `cold-start` project, `csp-plaid.spec.ts`'s shape): a mocked network cannot
 * expose a mismatch between the browser's cookie jar and the server's CSRF
 * check, and Playwright cannot script `docker compose` here without turning
 * every `just check`/CI run into one. `COLD_START_BASE_URL` names a live
 * stack; `COLD_START_REGISTER_URL` additionally supplies the one-time,
 * single-use enrolment link `just bootstrap-user` printed (D21) — a real
 * token consumed by test 2 below and unusable a second time, so it cannot be
 * baked into CI. Run manually, once per bootstrapped stack:
 *
 * ```
 * docker compose down -v && docker compose build && docker compose up -d
 * just bootstrap-user name="Gate Walk" timezone="America/Los_Angeles"
 * COLD_START_BASE_URL=https://personalfi.lan \
 *   COLD_START_REGISTER_URL='https://personalfi.lan/register#token=...' \
 *   pnpm --filter @app/web exec playwright test cold-start --project=cold-start
 * docker compose down -v
 * ```
 *
 * `personalfi.lan` needs no `/etc/hosts` entry: `playwright.config.ts`'s
 * `cold-start` project launches Chromium with
 * `--host-resolver-rules=MAP <host> 127.0.0.1` (the same flag Phase 1's gate
 * walk script used, gate-security-review.md §8) derived from whichever host
 * `COLD_START_BASE_URL` names, and `ignoreHTTPSErrors: true` stands in for
 * `just trust-ca` so the suite needs no CA import either.
 *
 * ## Reproduction result (docs/evidence/phase-3/wp3.13-carry-overs.md item 2)
 *
 * Run against `main` at the tree this work package landed on: **did not
 * reproduce**. Every attempt — normal timing, and an impatient fill-and-click
 * with no settle wait — completed `GET unlock-state -> 200`,
 * `POST register/options -> 200`, `POST register/verify -> 200` on the first
 * try, no reissue. `pending-contracts.ts`'s and `client-runtime-config.ts`'s
 * `ensureCsrfCookie()` (Phase 0 P0-4) already prime the cookie with a GET
 * before the first mutation of a cold session, and test 1 below proves that
 * primer is load-bearing: without it, the identical request is `403
 * csrf_failed`. Kept as a permanent regression guard rather than deleted,
 * since G2-4 was found once already on a tree that looked identical to this
 * one from a code-review pass.
 */

/**
 * The live-stack URLs arrive as a test option set in `playwright.config.ts`'s
 * `cold-start` project (the repo-wide `process.env` ban exempts the config,
 * not `e2e/`). Absent means "no live stack" and each test skips itself.
 */
interface ColdStartOptions {
  readonly coldStart: { readonly baseURL?: string; readonly registerURL?: string };
}

const test = base.extend<ColdStartOptions>({
  coldStart: [{}, { option: true }],
});

test.describe('cold-start CSRF (C-6)', () => {
  test('a cold cookie jar is refused CSRF, and the same jar succeeds immediately after one priming GET', async ({
    browser,
    coldStart,
  }) => {
    const { baseURL } = coldStart;
    test.skip(baseURL === undefined, 'set COLD_START_BASE_URL to a live stack to run this test');
    const base = baseURL as string;

    // A fresh context (its own cookie jar), and `fetch` run *inside* the page
    // via `page.evaluate` rather than Playwright's Node-side `request`
    // fixture: the latter has its own DNS resolver and never sees this
    // project's `--host-resolver-rules`, so it cannot reach `personalfi.lan`
    // without a real `/etc/hosts` entry. Running the fetches from the page
    // itself is also closer to the actual defect surface — this is the same
    // network stack, and the same cookie jar, a real browser tab uses.
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    // `/register` is a static SPA route — loading it consumes no token and
    // sets no cookie (Caddy serves it directly; only `/api/*` reaches the
    // API's CSRF hook, confirmed against the live stack while writing this
    // test), so it is a safe, repeatable way to get a same-origin `fetch`.
    await page.goto(`${base}/register`, { waitUntil: 'domcontentloaded' });
    expect(await page.evaluate(() => document.cookie)).toBe('');

    // Unprimed: the double-submit cookie has never been minted for this jar.
    // Exactly `pending-contracts.ts`'s comment describes — a browser whose
    // first request is the mutation itself.
    const cold = await page.evaluate(async () => {
      const response = await fetch('/api/auth/register/options', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return { status: response.status, body: (await response.json()) as { code?: string } };
    });
    expect(cold.status).toBe(403);
    expect(cold.body.code).toBe('csrf_failed');

    // Prime it with exactly the GET `ensureCsrfCookie()` uses, then read the
    // cookie back out of the same jar and echo it, exactly as the client does.
    const primerStatus = await page.evaluate(async () => {
      const response = await fetch('/api/auth/unlock-state', { credentials: 'include' });
      return response.status;
    });
    expect(primerStatus).toBe(200);
    const csrf = (await page.evaluate(() => document.cookie))
      .split('; ')
      .find((row) => row.startsWith('__Host-pfi_csrf='))
      ?.slice('__Host-pfi_csrf='.length);
    expect(csrf).toBeDefined();

    const primed = await page.evaluate(async (token) => {
      const response = await fetch('/api/auth/register/options', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: '{}',
      });
      return response.status;
    }, csrf ?? '');
    // No longer 403: the CSRF gate passed. (401/400 for "no such registration
    // token" is the next, unrelated check — this test's job stops at CSRF.)
    expect(primed).not.toBe(403);

    await context.close();
  });

  test('the first real browser visit to a freshly printed enrolment link enrols a passkey with no retry', async ({
    browser,
    coldStart,
  }) => {
    const { registerURL } = coldStart;
    test.skip(
      registerURL === undefined,
      'set COLD_START_REGISTER_URL to a fresh, unused just bootstrap-user link to run this test',
    );
    const url = registerURL as string;

    // A context of its own — this is the "first browser visit ever" the gate
    // finding is about, so it must start with an empty cookie jar, same as
    // every other test in this describe block and unrelated to Playwright's
    // shared browser process.
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await attachVirtualAuthenticator(context, page);

    const authResponses: { path: string; status: number }[] = [];
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith('/api/auth/')) authResponses.push({ path, status: response.status() });
    });

    await page.goto(url, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Set up a passkey' })).toBeVisible();

    await page.getByLabel('Name this passkey').fill('Cold-start gate walk');
    await page.getByRole('button', { name: 'Create passkey' }).click();

    // Either "enrol a second one" or "you're all set" is a completed first
    // enrolment; both mean the ceremony's own POSTs (options, then verify)
    // came back 200 on the very first attempt.
    await expect(
      page.getByRole('heading', { name: /Add a backup passkey|You.?re all set/ }),
    ).toBeVisible({ timeout: 15_000 });

    const csrfFailures = authResponses.filter((r) => r.status === 403);
    expect(csrfFailures, JSON.stringify(authResponses)).toEqual([]);

    await context.close();
  });
});
