// SPDX-License-Identifier: MIT
/**
 * WP 12.6 — the holder half of Yahoo Finance, over a real database (D33).
 *
 * Settings → Market data's Yahoo card: a consent to the versioned text
 * `yahoo-consent/1`, recorded with its sha256 and time; "Use this provider"
 * (placing `yfinance` in a ladder through `PUT /market-data/priority`) refused
 * until it is ticked; unticking withdraws Yahoo from every ladder at once; the
 * api never reaches the sidecar (test-fetch refuses), and nothing here makes a
 * request to anyone. The two-half gate on the request itself is
 * `packages/contexts/integrations/test/yfinance.test.ts`, and the worker's
 * registration is `test/market-data-runtime.test.ts`.
 */
import { sha256 } from '@core/secretbox';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { YAHOO_CONSENT_TEXT, YAHOO_CONSENT_VERSION } from '../../src/yahoo-consent.ts';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface YahooBody {
  readonly operatorEnabled: boolean;
  readonly consent: { given: boolean; consentedAt: string | null; version: string | null };
  readonly consentVersion: string;
  readonly consentText: string;
  readonly consentSha256: string;
  readonly ready: boolean;
  readonly notReady: string | null;
  readonly placements: readonly { securityKind: string; position: number; of: number }[];
  readonly lastOutcome: { outcome: string; detail: string | null } | null;
  readonly budget: readonly { label: string; used: number; limit: number }[];
  readonly attribution: { required: boolean; text: string };
}

const AFTER_TIINGO = ['user_override', 'exchange_fill', 'tiingo', 'yfinance', 'last_known'];

describe.skipIf(NO_DATABASE)('/market-data Yahoo Finance (WP 12.6)', () => {
  let h: ApiHarness;
  let off: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp126_yahoo', env: { YAHOO_FINANCE_ENABLED: 'true' } });
    off = await createApiHarness({ suite: 'wp126_yahoo_off' });
  }, 120_000);

  afterAll(async () => {
    await h.close();
    await off.close();
  });

  async function yahoo(harness: ApiHarness): Promise<YahooBody> {
    const settings = await harness.request({
      method: 'GET',
      url: '/market-data/settings',
      session: harness.stale,
    });
    expectStatus(settings, 200);
    return (settings.json() as { yahoo: YahooBody }).yahoo;
  }

  it('the card states both halves, the exact text and its sha256, and the label', async () => {
    const card = await yahoo(h);
    expect(card).toMatchObject({
      operatorEnabled: true,
      consent: { given: false, consentedAt: null, version: null },
      consentVersion: 'yahoo-consent/1',
      consentText: YAHOO_CONSENT_TEXT,
      ready: false,
      notReady: 'consent_required',
      placements: [],
      lastOutcome: null,
      attribution: { required: true, text: 'Yahoo Finance via yfinance — unofficial, best effort' },
    });
    const digest = Array.from(sha256(new TextEncoder().encode(YAHOO_CONSENT_TEXT)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    expect(card.consentSha256).toBe(`sha256:${digest}`);
    expect(card.budget).toEqual([
      { label: '60/hour (self-imposed; Yahoo publishes none)', used: 0, limit: 60 },
    ]);
    for (const words of [
      'unofficial',
      'prohibit automated collection',
      'personal use only',
      'best effort',
      'may stop working',
      'not licensed for redistribution',
      'What leaves this machine',
    ]) {
      expect(card.consentText, words).toContain(words);
    }

    const offCard = await yahoo(off);
    expect(offCard).toMatchObject({ operatorEnabled: false, notReady: 'operator_disabled' });
    const providers = (
      (
        await off.request({ method: 'GET', url: '/market-data/settings', session: off.stale })
      ).json() as { providers: { provider: string; registered: boolean }[] }
    ).providers;
    expect(providers.find((p) => p.provider === 'yfinance')?.registered).toBe(false);
  });

  it('placing yfinance in a ladder is refused until the consent is ticked', async () => {
    const refused = await h.request({
      method: 'PUT',
      url: '/market-data/priority',
      session: h.fresh,
      body: { securityKind: 'equity', sources: AFTER_TIINGO },
    });
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused)['code']).toBe('market_data.consent_required');
    const rows = await h.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM price_source_priority WHERE source = 'yfinance'`,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it('the consent needs a step-up and the version shown; it is stored with its hash and time', async () => {
    const stale = await h.request({
      method: 'PUT',
      url: '/market-data/providers/yfinance/consent',
      session: h.stale,
      body: { consentVersion: YAHOO_CONSENT_VERSION },
    });
    expect(stale.statusCode).toBe(403);

    const wrong = await h.request({
      method: 'PUT',
      url: '/market-data/providers/yfinance/consent',
      session: h.fresh,
      body: { consentVersion: 'yahoo-consent/0' },
    });
    expect(wrong.statusCode).toBe(409);
    expect(problemOf(wrong)['code']).toBe('market_data.consent_version_unknown');

    const given = await h.request({
      method: 'PUT',
      url: '/market-data/providers/yfinance/consent',
      session: h.fresh,
      body: { consentVersion: YAHOO_CONSENT_VERSION },
    });
    expectStatus(given, 200);
    const card = given.json() as YahooBody;
    expect(card).toMatchObject({ consent: { given: true }, ready: true, notReady: null });
    // Consenting places nothing.
    expect(card.placements).toEqual([]);

    const stored = await h.database.db.execute<{
      consent_text_version: string;
      consent_text_sha256: string;
      consented_at: string;
      withdrawn_at: string | null;
    }>(sql`SELECT consent_text_version, consent_text_sha256, consented_at, withdrawn_at
             FROM market_data_consents WHERE provider = 'yfinance'`);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      consent_text_version: 'yahoo-consent/1',
      consent_text_sha256: card.consentSha256,
      withdrawn_at: null,
    });
    expect(Number.isNaN(Date.parse(String(stored.rows[0]?.consented_at)))).toBe(false);
  });

  it('with the consent, the holder places Yahoo, and the card shows where it sits', async () => {
    const placed = await h.request({
      method: 'PUT',
      url: '/market-data/priority',
      session: h.fresh,
      body: { securityKind: 'equity', sources: AFTER_TIINGO },
    });
    expectStatus(placed, 200);
    const card = await yahoo(h);
    expect(card.placements).toEqual([
      expect.objectContaining({ securityKind: 'equity', position: 4, of: 5 }),
    ]);
  });

  it('unticking withdraws Yahoo from every ladder at once, and the row is kept', async () => {
    await h.request({
      method: 'PUT',
      url: '/market-data/priority',
      session: h.fresh,
      body: { securityKind: 'etf', sources: ['user_override', 'yfinance', 'tiingo', 'last_known'] },
    });
    expect((await yahoo(h)).placements).toHaveLength(2);

    const withdrawn = await h.request({
      method: 'DELETE',
      url: '/market-data/providers/yfinance/consent',
      session: h.fresh,
    });
    expectStatus(withdrawn, 200);
    expect(withdrawn.json()).toMatchObject({
      consent: { given: false },
      ready: false,
      placements: [],
    });
    const left = await h.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM price_source_priority WHERE source = 'yfinance'`,
    );
    expect(left.rows[0]?.n).toBe(0);
    // Tiingo is still in both ladders: only Yahoo was taken out.
    const tiingo = await h.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM price_source_priority
           WHERE source = 'tiingo' AND security_kind IN ('equity', 'etf')`,
    );
    expect(tiingo.rows[0]?.n).toBe(2);
    const history = await h.database.db.execute<{ withdrawn: boolean }>(
      sql`SELECT withdrawn_at IS NOT NULL AS withdrawn FROM market_data_consents`,
    );
    expect(history.rows).toEqual([{ withdrawn: true }]);

    // And the refusal is back.
    const again = await h.request({
      method: 'PUT',
      url: '/market-data/priority',
      session: h.fresh,
      body: { securityKind: 'equity', sources: AFTER_TIINGO },
    });
    expect(again.statusCode).toBe(409);
  });

  it('the api never reaches the sidecar: test-fetch for yfinance is refused, nothing recorded', async () => {
    const response = await h.request({
      method: 'POST',
      url: '/market-data/test-fetch',
      session: h.fresh,
      body: { provider: 'yfinance', symbol: 'PFTEST' },
    });
    expect(response.statusCode).toBe(400);
    expect(problemOf(response)['code']).toBe('market_data.not_testable_here');
    const runs = await h.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM market_data_runs WHERE provider = 'yfinance'`,
    );
    expect(runs.rows[0]?.n).toBe(0);
  });

  it("the card shows the worker's last outcome and the budget left", async () => {
    const userId = h.userId;
    await h.database.db.execute(sql`
      INSERT INTO market_data_runs (id, user_id, provider, operation, started_at, finished_at,
                                    outcome, requests_made, units_spent, symbols_asked,
                                    rows_written, error_message, retry_after_ms)
      VALUES ('01920000-0000-7000-8000-00000000c126', ${userId}::uuid, 'yfinance',
              'price_refresh', now() - interval '5 minutes', now() - interval '5 minutes',
              'rate_limited', 3, 3, 3, 0,
              'Yahoo answered 429 Too Many Requests (via the sidecar); backing off', 60000)`);
    const card = await yahoo(h);
    expect(card.lastOutcome).toMatchObject({ outcome: 'rate_limited' });
    expect(card.lastOutcome?.detail).toMatch(/429/);
    expect(card.budget[0]).toMatchObject({ used: 3, limit: 60 });
  });
});
