// SPDX-License-Identifier: MIT
/**
 * `ledger.TransactionsUpserted` in, `category_assignments` out — through the real
 * consumer pump, against a real Postgres.
 *
 * Three things are being tested here and only the first is obvious:
 *
 *   1. **The wiring.** The consumer names its trigger as a *string*
 *     (`'ledger.TransactionsUpserted'`) because importing `@ctx/ledger`'s
 *     `events.ts` would be importing another context and the boundary lint
 *     correctly refuses. A duplicated string is the honest cost of that
 *     decoupling, and a duplicated string can be wrong. The event published below
 *     is declared with the same `type`, `aggregateType` and payload shape as
 *     `@ctx/ledger`'s, so a rename on either side makes this suite go quiet —
 *     which is why the first assertion is "something was written at all".
 *
 *   2. **The invariant.** At most one current assignment per transaction, with
 *     history kept. That is a partial unique index in migration 0006, not a
 *     convention, and the last test in this file tries to violate it directly.
 *
 *   3. **Idempotence.** 04 §5.2: "re-running categorisation must be safe and
 *     idempotent". A redelivered event, or a second sync page covering the same
 *     rows, must write nothing and must not bump a version — otherwise every
 *     sync grows the history and wakes every downstream consumer for nothing.
 */
import { newId } from '@core/kernel';
import { appendEvent, createConsumerPump, defineEvent, platformExecutor } from '@core/platform';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCategorizationConsumer, transactionIdsOf } from '../src/consumer.ts';
import { outboxOf } from '../src/db.ts';
import { seedSystemTaxonomy, categoryIdsByKey } from '../src/seed-taxonomy.ts';
import type { CategorizableTransaction } from '../src/index.ts';
import {
  CORRELATION_ID,
  NO_DATABASE,
  assignmentsOf,
  categorizationDatabase,
  currentAssignmentOf,
  eventPayloads,
  inMemoryPort,
  recordingLogger,
  testClock,
  transactionFixture,
  type TestDatabase,
} from './harness.ts';

/**
 * `@ctx/ledger`'s event, redeclared.
 *
 * Not imported: that is the whole point (see the file header). Kept
 * field-for-field identical to `packages/contexts/ledger/src/events.ts` so the
 * payload this consumer reads is the payload it will actually be handed.
 */
const TransactionsUpserted = defineEvent({
  type: 'ledger.TransactionsUpserted',
  aggregateType: 'account',
  description: 'A sync page landed. Ids and counts only.',
  schema: z.object({
    accountId: z.uuid(),
    addedIds: z.array(z.uuid()),
    updatedIds: z.array(z.uuid()),
    removedIds: z.array(z.uuid()),
    dateFrom: z.string().nullable(),
    dateTo: z.string().nullable(),
    count: z.int().nonnegative(),
  }),
});

const TransactionSupersededByPosted = defineEvent({
  type: 'ledger.TransactionSupersededByPosted',
  aggregateType: 'transaction',
  description: 'A pending fact was replaced by the posted one; the id did not change.',
  schema: z.object({
    transactionId: z.uuid(),
    accountId: z.uuid(),
    pendingFactId: z.uuid(),
    postedFactId: z.uuid(),
    amountChanged: z.boolean(),
    dateChanged: z.boolean(),
  }),
});

const COFFEE_PFC = {
  primary: 'FOOD_AND_DRINK',
  detailed: 'FOOD_AND_DRINK_COFFEE',
  confidence_level: 'HIGH',
};

const ACCOUNT_ID = '00000000-0000-7000-8000-b00000000001';
const CONSUMER_OFFSET_NAME = 'categorization.assignments@v1';

describe.skipIf(NO_DATABASE)('the categorization consumer', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;

  beforeAll(async () => {
    database = await categorizationDatabase('consumer');
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.truncate();
    clock = testClock();
    await seedSystemTaxonomy(database.db, { userId: database.userId, clock });
  });

  /** The pump, wired to this context's consumer and an in-memory ledger. */
  function pumpOver(transactions: readonly CategorizableTransaction[]) {
    const logger = recordingLogger();
    const port = inMemoryPort(transactions);
    const pump = createConsumerPump({
      pool: database.pool,
      // `@core/db`'s `Database` and the platform's `TransactionalExecutor` are
      // interchangeable at runtime and not assignable at compile time (Drizzle's
      // `execute()` returns a lazily-executed `PgRaw`). `platformExecutor` is the
      // one place that cast lives.
      db: platformExecutor(database.db),
      clock,
      logger,
      consumers: [
        createCategorizationConsumer({
          database: database.db,
          port,
        }),
      ],
    });
    return { pump, logger, port };
  }

  async function publishUpserted(
    ids: { added?: readonly string[]; updated?: readonly string[]; removed?: readonly string[] },
    correlationId = CORRELATION_ID,
  ): Promise<void> {
    const added = ids.added ?? [];
    const updated = ids.updated ?? [];
    const removed = ids.removed ?? [];
    await appendEvent(
      outboxOf(database.db),
      TransactionsUpserted.create(
        {
          accountId: ACCOUNT_ID,
          addedIds: [...added],
          updatedIds: [...updated],
          removedIds: [...removed],
          dateFrom: '2026-05-01',
          dateTo: '2026-05-31',
          count: added.length + updated.length + removed.length,
        },
        { userId: database.userId, correlationId },
        clock,
      ),
    );
  }

  async function insertRule(rule: {
    id?: string;
    name: string;
    priority?: number;
    conditions: unknown;
    actions: unknown;
    enabled?: boolean;
  }): Promise<string> {
    const id = rule.id ?? newId();
    await database.db.execute(sql`
      INSERT INTO rules (id, user_id, name, priority, enabled, conditions, actions, run_on_sync, stop_processing)
      VALUES (
        ${id}, ${database.userId}, ${rule.name}, ${rule.priority ?? 100}, ${rule.enabled ?? true},
        ${JSON.stringify(rule.conditions)}::jsonb, ${JSON.stringify(rule.actions)}::jsonb, TRUE, FALSE
      )
    `);
    return id;
  }

  it('categorises the transactions a sync page named', async () => {
    const coffee = transactionFixture({ providerCategory: COFFEE_PFC });
    const { pump, logger, port } = pumpOver([coffee]);

    await publishUpserted({ added: [coffee.id] });
    expect(await pump.drain()).toBe(1);

    const current = await currentAssignmentOf(database, coffee.id);
    expect(current).toMatchObject({
      category_key: 'dining.coffee',
      source: 'provider',
      version: 1,
      is_current: true,
    });
    // 0.85 is Plaid's `HIGH`, carried through rather than invented here.
    expect(Number(current?.confidence)).toBeCloseTo(0.85, 4);
    const logged = logger.lines.find((line) => line.msg === 'categorised transactions');
    expect(logged?.obj).toMatchObject({
      consumer: 'categorization.assignments@v1',
      considered: 1,
      written: 1,
      bySource: { provider: 1 },
    });
    // The provider tier lives entirely in this context's own
    // `category_assignments` — @ctx/ledger has no column for it, so the port's
    // write side must stay silent.
    expect(port.ruleCategoryWrites).toEqual([]);
  });

  it('stores the whole decision chain, losers included', async () => {
    const coffee = transactionFixture({ providerCategory: COFFEE_PFC });
    const { pump } = pumpOver([coffee]);
    await publishUpserted({ added: [coffee.id] });
    await pump.drain();

    const stored = await database.db.execute<{
      evidence: { chain: { source: string; won: boolean }[] };
    }>(sql`
      SELECT evidence FROM category_assignments WHERE transaction_id = ${coffee.id} AND is_current
    `);
    const chain = stored.rows[0]?.evidence.chain ?? [];
    // Every tier above the winner recorded an abstention *with a reason*, which
    // is what "why not the rule I wrote?" is answered from.
    expect(chain.map((entry) => entry.source)).toEqual([
      'user',
      'rule',
      'merchant_default',
      'provider',
    ]);
    expect(chain.filter((entry) => entry.won)).toHaveLength(1);
  });

  it('carries the sync run’s correlation id into its own event', async () => {
    const coffee = transactionFixture({ providerCategory: COFFEE_PFC });
    const { pump } = pumpOver([coffee]);
    const correlationId = '01920000-0000-7000-8000-0000000000dd';

    await publishUpserted({ added: [coffee.id] }, correlationId);
    await pump.drain();

    const emitted = await database.db.execute<{
      correlation_id: string;
      payload: { trigger: string; count: number };
    }>(sql`
      SELECT correlation_id, payload FROM domain_events
       WHERE event_type = 'categorization.AssignmentsChanged'
    `);
    // One id spans the browser request, the sync, and every category it caused.
    expect(emitted.rows[0]?.correlation_id).toBe(correlationId);
    expect(emitted.rows[0]?.payload).toMatchObject({ trigger: 'sync', count: 1 });
  });

  it('lets a rule beat the provider, and records which rule', async () => {
    const coffee = transactionFixture({ providerCategory: COFFEE_PFC });
    const ruleId = await insertRule({
      name: 'Blue Bottle is a treat',
      conditions: { all: [{ type: 'payee', match: 'contains', value: 'BLUE BOTTLE' }], any: [] },
      actions: [{ type: 'set_category', categoryKey: 'dining.restaurants' }],
    });

    const { pump, port } = pumpOver([coffee]);
    await publishUpserted({ added: [coffee.id] });
    await pump.drain();

    expect(await currentAssignmentOf(database, coffee.id)).toMatchObject({
      category_key: 'dining.restaurants',
      source: 'rule',
      rule_id: ruleId,
    });

    // wp1.4 evidence §6: a winning rule decision is the one tier that also
    // reaches @ctx/ledger's resolveEffective seam, through the LedgerPort —
    // never a direct import (decision D8).
    const idByKey = await categoryIdsByKey(database.db, database.userId);
    expect(port.ruleCategoryWrites).toEqual([
      {
        userId: database.userId,
        transactionId: coffee.id,
        ruleCategoryId: idByKey.get('dining.restaurants'),
        correlationId: CORRELATION_ID,
        causationId: expect.any(String),
      },
    ]);
  });

  it('does not compete with a category the user already set', async () => {
    // Tier 1 lives in `@ctx/ledger`'s overlay and this context does not own it.
    // Writing an assignment here would create a second answer to "what category
    // is this?", which is the exact failure the overlay design prevents.
    const mine = transactionFixture({
      providerCategory: COFFEE_PFC,
      userCategoryId: '00000000-0000-7000-8000-d00000000001',
    });
    const { pump } = pumpOver([mine]);

    await publishUpserted({ added: [mine.id] });
    await pump.drain();

    expect(await assignmentsOf(database, mine.id)).toEqual([]);
    expect(await eventPayloads(database, 'categorization.AssignmentsChanged')).toEqual([]);
  });

  it('does not record "uncategorised" as the first thing it ever says', async () => {
    // The absence of an assignment already means uncategorised, and the review
    // queue reads both. A row here would buy nothing and cost an event.
    const unknown = transactionFixture({ payee: 'ZZQX', rawDescriptor: 'ZZQX' });
    const { pump } = pumpOver([unknown]);

    await publishUpserted({ added: [unknown.id] });
    await pump.drain();

    expect(await assignmentsOf(database, unknown.id)).toEqual([]);
  });

  it('writes nothing the second time the same page is delivered', async () => {
    const coffee = transactionFixture({ providerCategory: COFFEE_PFC });
    const { pump } = pumpOver([coffee]);

    await publishUpserted({ added: [coffee.id] });
    await pump.drain();

    // Rewind the offset without clearing the receipts is the pump's own
    // idempotence; what is tested here is *ours*, so the page is published
    // again as a genuinely new event — a second sync covering the same rows,
    // which is what actually happens every night.
    await publishUpserted({ updated: [coffee.id] });
    await pump.drain();

    const rows = await assignmentsOf(database, coffee.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
    // The second pass emitted no event at all: nothing changed, so nothing
    // downstream needs waking.
    expect(await eventPayloads(database, 'categorization.AssignmentsChanged')).toHaveLength(1);
  });

  it('keeps history, and exactly one row stays current', async () => {
    const coffee = transactionFixture({ providerCategory: COFFEE_PFC });
    const { pump } = pumpOver([coffee]);

    await publishUpserted({ added: [coffee.id] });
    await pump.drain();

    // The user writes a rule, and the next sync page re-decides.
    await insertRule({
      name: 'Blue Bottle is a treat',
      conditions: { all: [{ type: 'payee', match: 'contains', value: 'BLUE BOTTLE' }], any: [] },
      actions: [{ type: 'set_category', categoryKey: 'dining.restaurants' }],
    });
    await publishUpserted({ updated: [coffee.id] });
    await pump.drain();

    const rows = await assignmentsOf(database, coffee.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ version: 2, source: 'rule', is_current: true });
    expect(rows[1]).toMatchObject({ version: 1, source: 'provider', is_current: false });
  });

  it('never demotes a decision to a weaker tier', async () => {
    // A transaction categorised by a rule must not fall back to the provider
    // because the rule was disabled: the previous answer stands until something
    // explicitly retracts it.
    const coffee = transactionFixture({ providerCategory: COFFEE_PFC });
    const ruleId = await insertRule({
      name: 'Blue Bottle is a treat',
      conditions: { all: [{ type: 'payee', match: 'contains', value: 'BLUE BOTTLE' }], any: [] },
      actions: [{ type: 'set_category', categoryKey: 'dining.restaurants' }],
    });

    const { pump } = pumpOver([coffee]);
    await publishUpserted({ added: [coffee.id] });
    await pump.drain();

    await database.db.execute(sql`UPDATE rules SET enabled = FALSE WHERE id = ${ruleId}`);
    await publishUpserted({ updated: [coffee.id] });
    await pump.drain();

    const rows = await assignmentsOf(database, coffee.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'rule', category_key: 'dining.restaurants' });
  });

  it('re-decides when a pending transaction posts', async () => {
    // The id survives (decision D10) but the amount commonly moves — tips, FX,
    // fuel holds — and the amount is an engine input.
    const held = transactionFixture({ providerCategory: COFFEE_PFC });
    const { pump } = pumpOver([held]);
    await publishUpserted({ added: [held.id] });
    await pump.drain();

    await database.db.execute(
      sql`DELETE FROM category_assignments WHERE transaction_id = ${held.id}`,
    );
    await appendEvent(
      outboxOf(database.db),
      TransactionSupersededByPosted.create(
        {
          transactionId: held.id,
          accountId: ACCOUNT_ID,
          pendingFactId: newId(),
          postedFactId: newId(),
          amountChanged: true,
          dateChanged: false,
        },
        { userId: database.userId, correlationId: CORRELATION_ID },
        clock,
      ),
    );
    await pump.drain();

    expect(await currentAssignmentOf(database, held.id)).toMatchObject({
      category_key: 'dining.coffee',
    });
  });

  it('leaves a removed transaction’s category alone', async () => {
    const coffee = transactionFixture({ providerCategory: COFFEE_PFC });
    const { pump } = pumpOver([coffee]);

    await publishUpserted({ removed: [coffee.id] });
    await pump.drain();

    expect(await assignmentsOf(database, coffee.id)).toEqual([]);
    // The unit half of the same claim: `removedIds` never reaches the engine,
    // because a tombstone and the row that supersedes it are not ordered
    // relative to each other and discarding the decision would lose work a later
    // page is about to reclaim.
    expect(
      transactionIdsOf({
        eventType: 'ledger.TransactionsUpserted',
        payload: { addedIds: ['a'], updatedIds: ['b'], removedIds: ['c'] },
      } as never),
    ).toEqual(['a', 'b']);
  });

  it('skips one unparseable rule rather than failing the whole batch', async () => {
    // A rule stored by an older schema must not be able to stop a sync. The
    // user's punishment for a bad rule is that it does nothing, visibly — not
    // that their transactions stop arriving.
    const coffee = transactionFixture({ providerCategory: COFFEE_PFC });
    await insertRule({
      name: 'Written by a schema that no longer exists',
      priority: 1,
      conditions: { all: [{ type: 'phase_of_moon', value: 'waxing' }], any: [] },
      actions: [{ type: 'set_category', categoryKey: 'dining.bars' }],
    });

    const { pump } = pumpOver([coffee]);
    await publishUpserted({ added: [coffee.id] });
    await pump.drain();

    expect(await currentAssignmentOf(database, coffee.id)).toMatchObject({
      category_key: 'dining.coffee',
      source: 'provider',
    });
  });

  it('advances its offset, so a restart does not re-categorise the world', async () => {
    const coffee = transactionFixture({ providerCategory: COFFEE_PFC });
    const { pump } = pumpOver([coffee]);
    await publishUpserted({ added: [coffee.id] });
    await pump.drain();

    const offset = await database.db.execute<{ last_seq: string }>(sql`
      SELECT last_seq FROM event_consumer_offsets WHERE consumer_name = ${CONSUMER_OFFSET_NAME}
    `);
    expect(Number(offset.rows[0]?.last_seq)).toBeGreaterThan(0);
    expect(await pump.drain()).toBe(0);
  });

  it('the database refuses a second current assignment for one transaction', async () => {
    // The invariant, asserted by trying to break it. Application-enforced
    // uniqueness under a consumer that may run on two workers is uniqueness that
    // holds until the day it matters.
    const coffee = transactionFixture({ providerCategory: COFFEE_PFC });
    const { pump } = pumpOver([coffee]);
    await publishUpserted({ added: [coffee.id] });
    await pump.drain();

    const idByKey = await categoryIdsByKey(database.db, database.userId);
    const failure = await database.db
      .execute(
        sql`
          INSERT INTO category_assignments
            (id, user_id, transaction_id, category_id, source, confidence, evidence, decided_at, version, is_current)
          VALUES (
            ${newId()}, ${database.userId}, ${coffee.id}, ${idByKey.get('dining.bars') as string},
            'provider', 0.5, '{}'::jsonb, now(), 99, TRUE
          )
        `,
      )
      .then(
        () => null,
        (error: unknown) => error as { cause?: { constraint?: string } },
      );
    expect(failure?.cause?.constraint).toBe('category_assignments_current_idx');
  });
});
