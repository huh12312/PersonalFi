// SPDX-License-Identifier: MIT
/**
 * WP 9.14, O-94-1: a credit card that already owes when its budget is first
 * computed must neither answer `GET /budgets/current` with 409
 * `budgeting.card_identity_violation` nor dead-letter `budgeting.actuals@v1`
 * (`identity II failed for card …: owed 350.00 ≠ available 0.00 + unfunded 0.00`).
 *
 * `budgeting`'s own tests prove the arithmetic against a fake ledger port. This
 * one is the shipped composition (C5-11): the real routes over `buildApp`, a
 * real card linked through the manual connector with a real balance observation
 * and real posted rows, and the consumer `modules.ts` registers, in
 * `@core/platform`'s real pump, over `domain.ts`'s ledger port.
 */
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
  type ApiHarness,
} from '../helpers/api-harness.ts';

describe.skipIf(NO_DATABASE)('O-94-1: a card already owing never wedges budgeting', () => {
  let h: ApiHarness;
  let checking = '';
  let card = '';

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp914_card_owing' });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

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

  async function offset(): Promise<
    { status: string; failed_count: number; failed_error: string | null } | undefined
  > {
    const result = await h.database.pool.query<{
      status: string;
      failed_count: number;
      failed_error: string | null;
    }>(
      'SELECT status, failed_count, failed_error FROM event_consumer_offsets WHERE consumer_name = $1',
      [CONSUMER_NAME],
    );
    return result.rows[0];
  }

  async function cardLine(): Promise<{ unfunded: string; available: string } | undefined> {
    const result = await h.database.pool.query<{ unfunded: string; available: string }>(
      `SELECT l.unfunded_debt_minor::text AS unfunded, l.available_minor::text AS available
         FROM budget_lines l JOIN budget_periods p ON p.id = l.budget_period_id
        WHERE l.user_id = $1 AND l.kind = 'credit_card_payment' AND l.credit_account_id = $2
        ORDER BY p.sequence DESC LIMIT 1`,
      [h.userId, card],
    );
    return result.rows[0];
  }

  it('GET /budgets/current answers 200 for a card owing $350 before the budget existed', async () => {
    const link = await linkManual(h, {
      providerConnectionId: 'wp914-household',
      displayName: 'Household',
      accounts: [
        { providerAccountId: 'checking', name: 'Checking', type: 'depository', currency: 'USD' },
        { providerAccountId: 'card', name: 'Card', type: 'credit', currency: 'USD' },
      ],
    });
    checking = link.accountIds[0] ?? '';
    card = link.accountIds[1] ?? '';
    await setBalance(checking, '500000');
    // House sign convention: owing $350.00 is a negative balance.
    await setBalance(card, '-35000');

    const response = await h.request({ method: 'GET', url: '/budgets/current', session: h.stale });
    expectStatus(response, 200);
    expect(await cardLine()).toEqual({ unfunded: '35000', available: '0' });
  }, 60_000);

  it('the consumer survives a charge and a recompute on the same card, and the line follows', async () => {
    const today = new Date().toISOString().slice(0, 10);
    expectStatus(
      await h.request({
        method: 'POST',
        url: `/accounts/${card}/transactions`,
        session: h.fresh,
        body: {
          transactions: [
            { amount: { minor: '-5000', currency: 'USD' }, postedDate: today, name: 'Groceries' },
          ],
        },
      }),
      201,
    );
    await setBalance(card, '-40000');

    const database = h.database.db;
    const consumerPump = createConsumerPump({
      pool: h.database.pool,
      db: platformExecutor(database),
      clock: systemClock,
      logger: silentLogger,
      consumers: [createBudgetingConsumer({ database, port: createBudgetingLedgerPort(database) })],
    });
    // Several passes: at HEAD~ the first one is a failed attempt towards the
    // five that dead-letter the consumer.
    for (let i = 0; i < 6; i += 1) {
      await h.database.pool.query(
        'UPDATE event_consumer_offsets SET retry_after = NULL WHERE consumer_name = $1',
        [CONSUMER_NAME],
      );
      await consumerPump.drain();
    }
    const after = await offset();
    expect(after?.failed_error ?? '').toBe('');
    expect(after).toMatchObject({ status: 'running', failed_count: 0 });
    expectStatus(
      await h.request({ method: 'GET', url: '/budgets/current', session: h.stale }),
      200,
    );
    // $350 carried in plus the $50 charge (uncategorised, so borrowed).
    const line = await cardLine();
    expect(Number(line?.unfunded)).toBe(40_000 - Number(line?.available));
  }, 90_000);
});
