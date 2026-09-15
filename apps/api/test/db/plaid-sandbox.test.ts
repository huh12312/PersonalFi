// SPDX-License-Identifier: MIT
/**
 * The live Plaid **Sandbox** smoke test — through the actual `apps/api` HTTP
 * path, not the connector in isolation.
 *
 * `packages/connectors/plaid/test/sandbox.test.ts` already proved
 * `PlaidConnector` agrees with real Plaid Sandbox (WP 1.3 §7/§7a). What this
 * file proves is the layer WP 1.3b added on top: that `POST
 * /connections/plaid/exchange`, driven by a real Plaid public token, really
 * creates a connection whose backfill completes — the hermetic
 * `plaid-routes.test.ts` suite (over `FakePlaidApi`) cannot check that Plaid
 * itself agrees with the wiring.
 *
 * ## Why it is skipped by default
 *
 * No Plaid credentials belong on a CI runner or a machine that has not opted
 * in. Skipped unless `PLAID_CLIENT_ID` / `PLAID_SECRET` are present in the
 * environment, exactly like the connector-level smoke test.
 *
 * ## How to run it
 *
 * Credentials come from the secret files this repo already keeps under
 * `secrets/` (mode 0400, gitignored) — read into this one process and never
 * echoed to a terminal, a log, or a commit:
 *
 * ```
 * env PLAID_CLIENT_ID="$(cat secrets/plaid_client_id)" \
 *     PLAID_SECRET="$(cat secrets/plaid_secret)" \
 *     PLAID_ENV="$(cat secrets/plaid_env)" \
 *   DATABASE_URL="postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev" \
 *   TEST_ADMIN_DATABASE_URL="postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev" \
 *   pnpm exec vitest run --project api-db test/db/plaid-sandbox.test.ts
 * ```
 *
 * Refuses to run against anything but Sandbox (D16: Production's ten-Item
 * cap and `/item/remove` not freeing a slot — the same guard
 * `sandbox.test.ts` carries). Cleans the Item up through the application's
 * own `DELETE /connections/{id}` in `afterAll`, which runs even when the body
 * throws.
 */
import {
  PLAID_MAX_HISTORY_DAYS,
  PLAID_PRODUCTS,
  PlaidConnector,
  createPlaidApi,
} from '@connector/plaid';
import { linkSettings, testClock } from '@connector/plaid/test';
import { newId } from '@core/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const CLIENT_ID = process.env['PLAID_CLIENT_ID'];
const SECRET = process.env['PLAID_SECRET'];
const ENV = process.env['PLAID_ENV'] ?? 'sandbox';

/** Plaid's own test institution; `/sandbox/public_token/create` skips Link. */
const SANDBOX_INSTITUTION = 'ins_109508';

const configured =
  CLIENT_ID !== undefined && CLIENT_ID !== '' && SECRET !== undefined && SECRET !== '';

if (!configured) {
  // Printed once, deliberately, so a green run cannot be mistaken for a run
  // that actually talked to Plaid.
  console.info(
    '\n  [api-db] live Sandbox smoke (apps/api) SKIPPED: PLAID_CLIENT_ID / PLAID_SECRET are unset.\n' +
      '  This is expected — no Plaid credentials exist on this machine and none belong in CI.\n' +
      '  plaid-routes.test.ts (over FakePlaidApi) covers everything it can without a network;\n' +
      '  this test is the only one that checks the real HTTP path agrees with Plaid.\n' +
      '  To run it, see docs/evidence/phase-1/wp1.3b-plaid-api.md §5 (Sandbox runbook).\n',
  );
}

// D16: a Production Item is a permanent ratchet spend. A smoke test must
// never create one.
if (configured && ENV !== 'sandbox') {
  throw new Error(
    `refusing to run the API-level smoke test against PLAID_ENV=${ENV}. Production has a hard ` +
      'ten-Item cap and /item/remove does not free a slot (D16), so a test run would permanently ' +
      'spend part of the allowance. Set PLAID_ENV=sandbox.',
  );
}

// Construction performs no I/O (`client.ts`), so this is safe to build
// unconditionally — the empty-string fallback is never dialled, because the
// describe block below is skipped whenever `configured` is false.
const api = createPlaidApi({
  clientId: CLIENT_ID ?? '',
  secret: SECRET ?? '',
  environment: 'sandbox',
});

describe.skipIf(NO_DATABASE || !configured)('plaid sandbox smoke — through apps/api', () => {
  let h: ApiHarness;
  let connectionId: string | null = null;

  beforeAll(async () => {
    const connector = new PlaidConnector({
      api,
      settings: linkSettings({ redirectUri: null }),
      clock: testClock(),
    });
    h = await createApiHarness({ suite: 'plaidsandbox', plaidConnector: connector });
  }, 180_000);

  afterAll(async () => {
    if (h === undefined) return;
    if (connectionId !== null) {
      // The application's own disconnect path: revokes at Plaid via
      // `connector.disconnect()` (`/item/remove`) and destroys the local
      // credential. Best-effort — a failed cleanup here must not fail the run
      // that already asserted what it came to assert.
      await h
        .request({ method: 'DELETE', url: `/connections/${connectionId}`, session: h.fresh })
        .catch(() => undefined);
    }
    await h.close();
  }, 60_000);

  it('links a real Sandbox Item through /connections/plaid/exchange and completes a sync', async () => {
    // ---- /sandbox/public_token/create — skips the Link UI ---------------
    // Not typed against `plaid`'s own `SandboxPublicTokenCreateRequest`
    // directly: `apps/api` deliberately has no direct dependency on the
    // `plaid` package (only `@connector/plaid` does — the one place it may
    // be imported, `scripts/eslint-boundaries.js`'s `connector-plaid`
    // layer). `Parameters<typeof …>[0]` recovers the real parameter type
    // through the already-imported `api` value instead, so the object
    // below is still checked against it — `Products` is a `plaid` enum
    // (nominal, not structural), which is why a plain string literal needs
    // the cast at all.
    const created = await api.sandboxPublicTokenCreate({
      institution_id: SANDBOX_INSTITUTION,
      initial_products: [...PLAID_PRODUCTS],
      options: { transactions: { days_requested: PLAID_MAX_HISTORY_DAYS } },
    } as Parameters<typeof api.sandboxPublicTokenCreate>[0]);
    expect(created.data.public_token).toMatch(/\S/);

    // ---- POST /connections/plaid/exchange — the route under test --------
    const exchanged = await h.request({
      method: 'POST',
      url: '/connections/plaid/exchange',
      session: h.fresh,
      body: { publicToken: created.data.public_token, institutionName: 'Sandbox Test Bank' },
    });
    expectStatus(exchanged, 201);
    const body = exchanged.json() as {
      connectionId: string;
      accountIds: string[];
      syncJobId: string | null;
    };
    connectionId = body.connectionId;
    expect(body.accountIds.length).toBeGreaterThan(0);
    expect(body.syncJobId, 'plaid is not process-local: the backfill is queued').not.toBeNull();

    // The response itself, and the whole exchange, must never carry the
    // access token — the route's own contract (`linkResultSchema`) has no
    // field for one, so this is really asserting the schema was honoured.
    expect(exchanged.body).not.toContain('access-');

    // ---- Run the backfill to completion ----------------------------------
    // The exchange only *scheduled* it (queued, since plaid is not
    // process-local — `domain.ts`'s module comment). Nothing in this test
    // runs the worker that would pick the job up, so the harness's own
    // `orchestrator` (the exact shape `domain.ts#createDomainRuntime`
    // builds) runs it directly — same retry-on-not-ready shape WP 1.3 §7a
    // found real Sandbox needs right after linking.
    let summary = await h.orchestrator.syncConnection({
      connectionId,
      userId: h.userId,
      trigger: 'manual',
      correlationId: newId(),
    });
    for (let attempt = 0; attempt < 20 && summary.status !== 'success'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      summary = await h.orchestrator.syncConnection({
        connectionId,
        userId: h.userId,
        trigger: 'manual',
        correlationId: newId(),
      });
    }
    expect(summary.status, `last sync summary: ${JSON.stringify(summary)}`).toBe('success');

    // ---- Observed through the API, too -----------------------------------
    const runs = await h.request({
      method: 'GET',
      url: `/connections/${connectionId}/sync-runs`,
      session: h.stale,
    });
    expectStatus(runs, 200);
    const runsBody = runs.json() as { runs: { status: string }[] };
    expect(runsBody.runs.some((run) => run.status === 'success')).toBe(true);
  }, 120_000);
});
