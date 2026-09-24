// SPDX-License-Identifier: MIT
/**
 * `/market-data/*` — WP 3.9's settings surface, over a real database.
 *
 * The load-bearing test here is negative, and it is deliberately not written as
 * *"the response has no `apiKey` field"*. A field-name assertion passes forever
 * while a key leaks through `detail`, through a serialised config object, or
 * through a provider error message nobody thought to redact. So this suite
 * **plants a synthetic key file** in the harness's `SECRETS_DIR` — the same
 * mechanism a real deployment uses (D5: file secrets under `/run/secrets`, never
 * environment variables) — and then asserts that the bytes of that key appear
 * in **no** response body from any route in this router, including the error
 * bodies.
 *
 * The planted value is obviously synthetic and is never a real credential; it is
 * long enough (>= 8 characters) that `redactSecrets` would catch it if the
 * redaction path were the thing under test, which makes a pass meaningful rather
 * than an artefact of a short string.
 *
 * ## Why the live fetch is opt-in
 *
 * `POST /market-data/test-fetch` is the one route in WP 3.9 that leaves the
 * machine. A suite that dialled `api.tiingo.com` on every `just check` would be
 * slow, flaky, and would spend a real free-tier allowance; CI has no egress to
 * it at all. The **skip** branch — no key, or a host narrowed out of
 * `MARKET_DATA_ALLOWED_HOSTS` — is asserted unconditionally here, because that
 * is the branch a deployment with zero keys actually takes (§6 of the dispatch:
 * *"Phase 3 completes with zero keys"*). The live branch is gated on
 * `MARKET_DATA_LIVE=1`, the same shape `plaid-sandbox.test.ts` uses for its own
 * real-provider smoke, and `docs/evidence/phase-3/wp3.9-routes.md` §5 records
 * the run.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

/**
 * The planted key. Synthetic, inert, and distinctive enough that a substring
 * search for it cannot collide with anything else in a payload.
 */
const SYNTHETIC_TIINGO_KEY = 'pfi-synthetic-tiingo-key-do-not-use-9f3c1a77';

const LIVE = process.env['MARKET_DATA_LIVE'] === '1';

interface SettingsBody {
  readonly providers: readonly {
    provider: string;
    keyPresent: boolean;
    registered: boolean;
    capabilities: Record<string, boolean>;
    budget: { label: string; used: number; limit: number }[];
    attribution: { provider: string; required: boolean; text: string; linkUrl: string | null };
  }[];
  readonly ladders: readonly {
    securityKind: string;
    sources: { source: string; rung: number }[];
  }[];
  readonly settingsAttributions: readonly { provider: string; text: string }[];
  readonly allowedHostsNarrowed: boolean;
}

describe.skipIf(NO_DATABASE)('/market-data (WP 3.9)', () => {
  let h: ApiHarness;
  /** Every body this suite sees, so the key scan is over all of them at once. */
  const bodies: string[] = [];

  async function call(
    request: Parameters<ApiHarness['request']>[0],
  ): Promise<ReturnType<ApiHarness['request']>> {
    const response = await h.request(request);
    bodies.push(response.body);
    return response as Awaited<ReturnType<ApiHarness['request']>>;
  }

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp39-md',
      // Planted the way a deployment plants one: a file under SECRETS_DIR.
      extraSecrets: { tiingo_api_key: SYNTHETIC_TIINGO_KEY },
    });
    // The ladders come from `seedPriceSourcePriority`, which `bootstrap-seed.ts`
    // runs at user creation. The harness's user predates that pass in some
    // orderings, so assert against whatever is there rather than requiring it.
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it('the settings response contains no API key value', async () => {
    const settings = await call({ method: 'GET', url: '/market-data/settings', session: h.stale });
    expectStatus(settings, 200);
    const body = settings.json() as SettingsBody;

    // The key is genuinely there — otherwise this test would pass against an
    // install that simply has no keys, which is the failure mode that makes a
    // "no secret in the payload" assertion worthless.
    const tiingo = body.providers.find((provider) => provider.provider === 'tiingo');
    expect(tiingo, 'tiingo must appear in the settings').toBeDefined();
    expect(tiingo?.keyPresent, 'the planted key must be detected as present').toBe(true);
    expect(tiingo?.registered, 'and the source registered from it').toBe(true);

    const coingecko = body.providers.find((provider) => provider.provider === 'coingecko');
    expect(coingecko?.keyPresent, 'a provider with no key file says so').toBe(false);

    // Every other route in this router, so the scan below covers the whole
    // surface and not only the one endpoint the test is named after.
    const priority = await call({
      method: 'PUT',
      url: '/market-data/priority',
      session: h.fresh,
      body: { securityKind: 'equity', sources: ['user_override', 'tiingo', 'last_known'] },
    });
    expectStatus(priority, 200);

    const refused = await call({
      method: 'PUT',
      url: '/market-data/priority',
      session: h.stale,
      body: { securityKind: 'equity', sources: ['tiingo'] },
    });
    expect(refused.statusCode).toBe(403);

    const skipped = await call({
      method: 'POST',
      url: '/market-data/test-fetch',
      session: h.fresh,
      body: { provider: 'coingecko', symbol: 'bitcoin' },
    });
    expectStatus(skipped, 200);

    const badRequest = await call({
      method: 'POST',
      url: '/market-data/test-fetch',
      session: h.fresh,
      body: { provider: 'tiingo' },
    });
    expect(badRequest.statusCode).toBe(400);

    const unauthenticated = await call({ method: 'GET', url: '/market-data/settings' });
    expect(unauthenticated.statusCode).toBe(401);

    // The assertion this suite exists for.
    expect(bodies.length).toBeGreaterThanOrEqual(6);
    for (const payload of bodies) {
      expect(
        payload.includes(SYNTHETIC_TIINGO_KEY),
        'a market-data response carried the API key value',
      ).toBe(false);
      // And not base64 or URL-encoded either — the two shapes a key takes when
      // it travels inside something else.
      expect(payload.includes(Buffer.from(SYNTHETIC_TIINGO_KEY).toString('base64'))).toBe(false);
      expect(payload.includes(encodeURIComponent(SYNTHETIC_TIINGO_KEY))).toBe(false);
    }
  });

  it('carries the licence obligation for every provider that binds on this screen', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/market-data/settings',
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as SettingsBody;

    // 01 §4.3: FRED's exact sentence, ® included. A paraphrase of a licence
    // condition is a new licence condition, so this is an equality check.
    const fred = body.providers.find((provider) => provider.provider === 'fred');
    expect(fred?.attribution.text).toBe(
      'This product uses the FRED® API but is not endorsed or certified by the ' +
        'Federal Reserve Bank of St. Louis.',
    );
    const coingecko = body.providers.find((provider) => provider.provider === 'coingecko');
    expect(coingecko?.attribution.text).toBe('Data provided by CoinGecko');
    expect(coingecko?.attribution.linkUrl).toBe('https://www.coingecko.com');

    // Tiingo requires no badge; what it forbids is redistribution. Folding the
    // two together would lose the one that matters for an export path.
    const tiingo = body.providers.find((provider) => provider.provider === 'tiingo');
    expect(tiingo?.attribution.required).toBe(false);

    expect(body.settingsAttributions.map((entry) => entry.provider).sort()).toEqual([
      'coingecko',
      'fred',
    ]);
  });

  it('reordering the ladder needs a step-up assertion and pins the two reserved rungs', async () => {
    const stale = await h.request({
      method: 'PUT',
      url: '/market-data/priority',
      session: h.stale,
      body: { securityKind: 'crypto', sources: ['user_override', 'coingecko', 'last_known'] },
    });
    expect(stale.statusCode).toBe(403);
    expect(problemOf(stale)['code']).toBe('step_up_required');

    const fresh = await h.request({
      method: 'PUT',
      url: '/market-data/priority',
      session: h.fresh,
      body: { securityKind: 'crypto', sources: ['user_override', 'coingecko', 'last_known'] },
    });
    expectStatus(fresh, 200);
    const body = fresh.json() as { sources: { source: string; rung: number }[] };
    // The migration pins these two with a CHECK; the route computes them rather
    // than accepting them, so a client cannot demote the one rung a human
    // controls.
    expect(body.sources.find((row) => row.source === 'user_override')?.rung).toBe(1);
    expect(body.sources.find((row) => row.source === 'last_known')?.rung).toBe(99);

    const stored = await h.database.db.execute<{ source: string; rung: number }>(sql`
      SELECT source, rung FROM price_source_priority
       WHERE user_id = ${h.userId}::uuid AND security_kind = 'crypto'
       ORDER BY rung
    `);
    expect(stored.rows.map((row) => row.source)).toEqual([
      'user_override',
      'coingecko',
      'last_known',
    ]);

    const duplicate = await h.request({
      method: 'PUT',
      url: '/market-data/priority',
      session: h.fresh,
      body: { securityKind: 'crypto', sources: ['tiingo', 'tiingo'] },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(problemOf(duplicate)['code']).toBe('market_data.duplicate_rung');
  });

  it('a test fetch with no key skips instead of calling out', async () => {
    const response = await h.request({
      method: 'POST',
      url: '/market-data/test-fetch',
      session: h.fresh,
      // No `fred_api_key` file exists in this harness, so no source is
      // registered and there is nothing to call.
      body: { provider: 'fred' },
    });
    expectStatus(response, 200);
    const body = response.json() as { outcome: string; quote: unknown; detail: string | null };
    expect(body.outcome).toBe('skipped_no_key');
    expect(body.quote).toBeNull();

    // And it left no trace in the run ledger, because it made no request. A
    // `skipped_no_key` row from a provider the operator never configured is
    // noise that trains the reader to ignore the table (`domain.ts`'s own
    // reasoning for leaving an unkeyed source out of `sources` entirely).
    const runs = await h.database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM market_data_runs
       WHERE user_id = ${h.userId}::uuid AND provider = 'fred'
    `);
    expect(runs.rows[0]?.count).toBe('0');
  });

  it("refuses another user's ladder", async () => {
    const otherUserId = await h.database.createUser('Second Holder');
    const theirs = await h.issueSession({ userId: otherUserId, fresh: true });

    await h.request({
      method: 'PUT',
      url: '/market-data/priority',
      session: h.fresh,
      body: { securityKind: 'bond', sources: ['user_override', 'last_known'] },
    });

    const settings = await h.request({
      method: 'GET',
      url: '/market-data/settings',
      session: theirs,
    });
    expectStatus(settings, 200);
    const body = settings.json() as SettingsBody;
    // The other holder has no `price_source_priority` rows, so they see no
    // ladders — not ours.
    expect(body.ladders.some((ladder) => ladder.securityKind === 'bond')).toBe(false);

    // Their write lands on their own rows and leaves ours alone.
    const theirWrite = await h.request({
      method: 'PUT',
      url: '/market-data/priority',
      session: theirs,
      body: { securityKind: 'bond', sources: ['last_known'] },
    });
    expectStatus(theirWrite, 200);

    const ours = await h.database.db.execute<{ source: string }>(sql`
      SELECT source FROM price_source_priority
       WHERE user_id = ${h.userId}::uuid AND security_kind = 'bond'
       ORDER BY rung
    `);
    expect(ours.rows.map((row) => row.source)).toEqual(['user_override', 'last_known']);
  });

  it.runIf(LIVE)(
    'a live test fetch reaches the provider through the existing egress guard',
    async () => {
      const response = await h.request({
        method: 'POST',
        url: '/market-data/test-fetch',
        session: h.fresh,
        body: { provider: 'tiingo', symbol: 'AAPL' },
      });
      expectStatus(response, 200);
      const body = response.json() as { outcome: string; budget: unknown[] };
      // Any outcome but `skipped_no_key` proves the call was attempted with the
      // key; which one it is depends on whether the planted key is real.
      expect(body.outcome).not.toBe('skipped_no_key');
      expect(response.body.includes(SYNTHETIC_TIINGO_KEY)).toBe(false);
    },
    60_000,
  );
});
