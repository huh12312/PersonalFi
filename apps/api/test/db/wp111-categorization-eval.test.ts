// SPDX-License-Identifier: MIT
/**
 * WP 11.1 through the real composition: `GET /transactions/explanations` reads
 * the stored working, and `categorization-eval` (the bin `just
 * categorization-eval` runs) replays the holder's hand-filed transactions and
 * writes nothing.
 *
 * Transactions arrive through the real sync (`linkManual`), the holder files
 * them through the real overlay route (`PATCH /transactions/:id`), and the
 * categorisation pass runs through `createCategorizationLedgerPort` — the port
 * the consumer and the bin both use.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { manualTransaction } from '@connector/manual';
import { DateOnly, money, systemClock } from '@core/kernel';
import {
  categorizeTransactions,
  categoryIdsByKey,
  seedSystemTaxonomy,
  type CategorizationExecutor,
} from '@ctx/categorization';
import type { LedgerDatabase } from '@ctx/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCategorizationLedgerPort } from '../../src/domain.ts';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';
import { createTempSecrets } from '../helpers/secrets.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CHECKING = 'checking';

/** Every table the replay could conceivably touch, counted. */
const WATCHED = [
  'transactions',
  'transactions_provider',
  'category_assignments',
  'category_abstentions',
  'classifier_examples',
  'classifier_versions',
  'merchant_profiles',
  'rules',
  'rule_runs',
  'domain_events',
] as const;

describe.skipIf(NO_DATABASE)('WP 11.1 — explanations route and the gold-set replay CLI', () => {
  let h: ApiHarness;
  let ids: { chewy: string[]; oddity: string };

  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of WATCHED) {
      const result = await h.database.pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM ${table}`,
      );
      out[table] = Number(result.rows[0]?.count ?? 0);
    }
    return out;
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp111_eval' });
    await seedSystemTaxonomy(h.database.db, { userId: h.userId, clock: systemClock });
    const row = (n: number, name: string, day: string) =>
      manualTransaction({
        providerAccountId: CHECKING,
        providerTransactionId: `wp111-${String(n)}`,
        amount: money(-4_200n, 'USD'),
        postedDate: DateOnly.parse(`2026-05-${day}`),
        name,
        merchantName: name === 'CHEWY.COM' ? 'Chewy' : null,
      });
    await linkManual(h, {
      providerConnectionId: 'wp111-conn',
      displayName: 'Everyday Bank',
      accounts: [
        { providerAccountId: CHECKING, name: 'Checking', type: 'depository', currency: 'USD' },
      ],
      batch: {
        added: [
          row(1, 'CHEWY.COM', '02'),
          row(2, 'CHEWY.COM', '09'),
          row(3, 'CHEWY.COM', '16'),
          row(4, 'ODDITY 1234', '20'),
        ],
      },
    });
    const list = await h.request({ method: 'GET', url: '/transactions', session: h.stale });
    expectStatus(list, 200);
    const items = (list.json() as { items: { id: string; name: string }[] }).items;
    ids = {
      chewy: items.filter((t) => t.name.toUpperCase().includes('CHEWY')).map((t) => t.id),
      oddity: items.find((t) => t.name.toUpperCase().includes('ODDITY'))?.id ?? '',
    };
    expect(ids.chewy).toHaveLength(3);

    const pets = (
      await categoryIdsByKey(h.database.db as unknown as CategorizationExecutor, h.userId)
    ).get('family.pets');
    for (const id of ids.chewy) {
      const patched = await h.request({
        method: 'PATCH',
        url: `/transactions/${id}`,
        session: h.stale,
        body: { categoryId: pets },
      });
      expectStatus(patched, 200);
    }
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('explains an abstention from its stored working, and says so where nothing ran', async () => {
    const port = createCategorizationLedgerPort(
      h.database.db as unknown as LedgerDatabase,
      systemClock,
    );
    await categorizeTransactions(
      h.database.db,
      port,
      { transactionIds: [ids.oddity] },
      {
        userId: h.userId,
        clock: systemClock,
        correlationId: '01920000-0000-7000-8000-0000000111c4',
      },
    );

    const response = await h.request({
      method: 'GET',
      url: `/transactions/explanations?ids=${ids.oddity},not-a-uuid,${ids.chewy[0] ?? ''}`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as {
      items: { transactionId: string; status: string; line: string; tiers: unknown[] }[];
    };
    expect(body.items.map((item) => item.transactionId)).toEqual([ids.oddity, ids.chewy[0]]);
    const oddity = body.items[0];
    expect(oddity?.status).toBe('abstained');
    expect(oddity?.line).toMatch(/^Every tier abstained: no rules yet, /u);
    expect(oddity?.line).toContain('no bank category');
    expect(oddity?.tiers).toHaveLength(6);
    expect(body.items[1]?.status).toBe('not_recorded');
  });

  it('refuses more than 200 ids, and needs a session', async () => {
    const many = Array.from(
      { length: 201 },
      (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    const tooMany = await h.request({
      method: 'GET',
      url: `/transactions/explanations?ids=${many.join(',')}`,
      session: h.stale,
    });
    expectStatus(tooMany, 400);
    const anonymous = await h.request({
      method: 'GET',
      url: `/transactions/explanations?ids=${ids.oddity}`,
    });
    expectStatus(anonymous, 401);
  });

  it('the CLI replays the hand-filed transactions as stable JSON and writes nothing', () => {
    return (async () => {
      const before = await counts();
      const secrets = createTempSecrets();
      try {
        const run = spawnSync(
          process.execPath,
          ['scripts/categorization-eval.ts', `--holder=${h.userId}`, '--json'],
          {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 60_000,
            env: {
              ...process.env,
              NODE_ENV: 'test',
              LOG_LEVEL: 'silent',
              SECRETS_DIR: secrets.dir,
              DATABASE_URL: h.database.url,
              BASE_URL: 'http://127.0.0.1:8080',
              AUTH_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
              AUTH_RP_ID: '127.0.0.1',
            },
          },
        );
        expect(run.status, run.stderr).toBe(0);
        const output = JSON.parse(run.stdout) as Record<string, unknown> & {
          transaction: { schema: string; total: number; holdout: string };
          merchant: { holdout: string };
        };
        expect(Object.keys(output)).toEqual([
          'schema',
          'examples',
          'rules',
          'lockedMerchants',
          'fromOverlay',
          'fromConfirmed',
          'missingTransactions',
          'transaction',
          'merchant',
        ]);
        expect(output).toMatchObject({
          schema: 'categorization-eval/1',
          examples: 3,
          fromOverlay: 3,
          fromConfirmed: 0,
        });
        expect(output.transaction).toMatchObject({
          schema: 'categorization-eval/1',
          total: 3,
          holdout: 'transaction',
        });
        expect(output.merchant.holdout).toBe('merchant');
        // Counts, ratios and category keys only: no payee, no id.
        expect(run.stdout).not.toContain('CHEWY');
        expect(run.stdout).not.toContain(ids.chewy[0] ?? '');

        const text = spawnSync(
          process.execPath,
          ['scripts/categorization-eval.ts', `--holder=${h.userId}`],
          {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 60_000,
            env: {
              ...process.env,
              NODE_ENV: 'test',
              LOG_LEVEL: 'silent',
              SECRETS_DIR: secrets.dir,
              DATABASE_URL: h.database.url,
              BASE_URL: 'http://127.0.0.1:8080',
              AUTH_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
              AUTH_RP_ID: '127.0.0.1',
            },
          },
        );
        expect(text.status, text.stderr).toBe(0);
        expect(text.stdout).toContain('waterfall (the engine as it runs)');
        expect(text.stdout).toContain('holdout: merchant');
      } finally {
        secrets.dispose();
      }
      expect(await counts()).toEqual(before);
    })();
  }, 120_000);
});
