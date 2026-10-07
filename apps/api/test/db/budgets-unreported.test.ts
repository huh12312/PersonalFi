// SPDX-License-Identifier: MIT
/**
 * WP 9.11, G-23 / F-94-5 (Medium): a budget against an account with no
 * balance observation must neither persist from a failing GET nor stop the
 * actuals consumer for good.
 *
 * WP 9.4's chain found it at W2: `GET /budgets/current` created the budget,
 * opened the period, then answered 409 `budgeting.balance_unreported`; the next
 * ledger event made `budgeting.actuals@v1` throw the same refusal five times
 * and dead-letter, with no operator path back, and `/ready` read `degraded`
 * from then on.
 *
 * Driven through the shipped pieces (C5-11): the real routes over `buildApp`,
 * and the consumer `modules.ts` registers (`createBudgetingConsumer` over
 * `domain.ts`'s `createBudgetingLedgerPort`) in `@core/platform`'s real pump.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConsumerPump, platformExecutor, silentLogger } from '@core/platform';
import { systemClock } from '@core/kernel';
import { CONSUMER_NAME, createBudgetingConsumer } from '@ctx/budgeting';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBudgetingLedgerPort } from '../../src/domain.ts';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';
import { createTempSecrets } from '../helpers/secrets.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

describe.skipIf(NO_DATABASE)('G-23: an unreported balance never wedges budgeting', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp911_budget' });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  async function budgetCount(): Promise<number> {
    const result = await h.database.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM budgets WHERE user_id = $1',
      [h.userId],
    );
    return result.rows[0]?.n ?? -1;
  }

  async function offset(): Promise<{ status: string; failed_count: number } | undefined> {
    const result = await h.database.pool.query<{ status: string; failed_count: number }>(
      'SELECT status, failed_count, failed_error FROM event_consumer_offsets WHERE consumer_name = $1',
      [CONSUMER_NAME],
    );
    return result.rows[0];
  }

  async function lagEvents(): Promise<number> {
    const result = await h.database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM domain_events
       WHERE seq > COALESCE((SELECT last_seq FROM event_consumer_offsets WHERE consumer_name = $1), 0)
         AND event_type = ANY($2)`,
      [
        CONSUMER_NAME,
        [
          'ledger.TransactionsUpserted',
          'ledger.TransactionSupersededByPosted',
          'ledger.TransferPaired',
          'ledger.BalanceRecorded',
          'categorization.AssignmentsChanged',
        ],
      ],
    );
    return result.rows[0]?.n ?? -1;
  }

  function pump() {
    const database = h.database.db;
    return createConsumerPump({
      pool: h.database.pool,
      db: platformExecutor(database),
      clock: systemClock,
      logger: silentLogger,
      consumers: [createBudgetingConsumer({ database, port: createBudgetingLedgerPort(database) })],
    });
  }

  async function setBalance(accountId: string, minor: string): Promise<void> {
    expectStatus(
      await h.request({
        method: 'POST',
        url: `/accounts/${accountId}/balance`,
        session: h.fresh,
        body: { current: { minor, currency: 'USD' } },
      }),
      200,
    );
  }

  let checking = '';
  let savings = '';

  it('GET /budgets/current answers 409 and persists nothing while an account is unreported', async () => {
    const link = await linkManual(h, {
      providerConnectionId: 'wp911-checking',
      displayName: 'Checking',
      accounts: [
        { providerAccountId: 'checking', name: 'Checking', type: 'depository', currency: 'USD' },
      ],
    });
    checking = link.accountIds[0] ?? '';

    const refused = await h.request({ method: 'GET', url: '/budgets/current', session: h.stale });
    expectStatus(refused, 409);
    expect(problemOf(refused)['code']).toBe('budgeting.balance_unreported');
    // A GET that failed must not have left a budget (and an open period) behind.
    expect(await budgetCount()).toBe(0);

    await setBalance(checking, '100000');
    expectStatus(
      await h.request({ method: 'GET', url: '/budgets/current', session: h.stale }),
      200,
    );
    expect(await budgetCount()).toBe(1);
  }, 60_000);

  it('a later unreported account makes the consumer wait, not dead-letter', async () => {
    // A budget now exists; a second account arrives with no balance yet —
    // the normal shape of linking an institution.
    const link = await linkManual(h, {
      providerConnectionId: 'wp911-savings',
      displayName: 'Savings',
      // Depository, not a card: a card already owing when the budget's first
      // period opens trips identity II (9.4's O-94-1, reproduced here at HEAD
      // and recorded for 9.14) — a different defect from this one.
      accounts: [
        { providerAccountId: 'savings', name: 'Savings', type: 'depository', currency: 'USD' },
      ],
    });
    savings = link.accountIds[0] ?? '';
    const today = new Date().toISOString().slice(0, 10);
    expectStatus(
      await h.request({
        method: 'POST',
        url: `/accounts/${checking}/transactions`,
        session: h.fresh,
        body: {
          transactions: [
            { amount: { minor: '-2500', currency: 'USD' }, postedDate: today, name: 'Coffee' },
          ],
        },
      }),
      201,
    );

    const consumerPump = pump();
    // Several passes: at HEAD each one is a failed attempt towards the
    // five that dead-letter the consumer.
    for (let i = 0; i < 6; i += 1) {
      await h.database.pool.query(
        'UPDATE event_consumer_offsets SET retry_after = NULL WHERE consumer_name = $1',
        [CONSUMER_NAME],
      );
      await consumerPump.drain();
    }
    expect(await offset()).toMatchObject({ status: 'running', failed_count: 0 });
    expect(await lagEvents()).toBe(0);
    // The period waits, dirty, for the balance.
    const dirty = await h.database.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM budget_periods WHERE user_id = $1 AND dirty',
      [h.userId],
    );
    expect(dirty.rows[0]?.n).toBeGreaterThan(0);

    // The budget is still there, and reads again once the balance arrives.
    expect(await budgetCount()).toBe(1);
    await setBalance(savings, '35000');
    for (let i = 0; i < 2; i += 1) await consumerPump.drain();
    expect(await offset()).toMatchObject({ status: 'running', failed_count: 0 });
    expectStatus(
      await h.request({ method: 'GET', url: '/budgets/current', session: h.stale }),
      200,
    );
  }, 90_000);

  it('a dead-lettered consumer has an operator path back: just consumer-resume <name>', async () => {
    // The state F-94-5 left an install in: stopped on an event, with SQL the
    // only way out.
    await h.database.pool.query(
      `UPDATE event_consumer_offsets
         SET status = 'failed', failed_count = 5, failed_seq = last_seq + 1,
             failed_error = 'budgeting.actuals@v1 failed on event seq 99: wp911 fixture'
         WHERE consumer_name = $1`,
      [CONSUMER_NAME],
    );
    const secrets = createTempSecrets();
    try {
      const run = (name: string) =>
        spawnSync(process.execPath, ['apps/api/src/bin/consumer-resume.ts', name], {
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
        });
      const unknown = run('no.such.consumer@v1');
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain('no consumer named');

      const resumed = run(CONSUMER_NAME);
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain(`${CONSUMER_NAME} resumed (was failed`);
      expect(resumed.stdout).toContain('wp911 fixture');
      expect(await offset()).toMatchObject({ status: 'running', failed_count: 0 });

      const again = run(CONSUMER_NAME);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('already running');
    } finally {
      secrets.dispose();
    }
  }, 90_000);
});
