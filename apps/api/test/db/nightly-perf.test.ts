// SPDX-License-Identifier: MIT
/**
 * WP 9.9 (CF-13) — the nightly chain, timed: §3.4 "nightly sync completes in
 * under 5 minutes".
 *
 * Nothing measured this before. The chain is what the worker does while the
 * holder sleeps: the 03:15 scheduled sync fans out to every connection; each
 * sync's events reach categorisation, recurring detection, budgeting and the
 * rest through the consumer pump; the 04:00 net-worth snapshot seals the day; the
 * 04:15 advisor pass runs the whole insight catalogue over what has landed.
 *
 * ## What runs, and that it is the shipped composition (C5-11)
 *
 *   * the REAL `appModules()` — the one `worker.ts` builds — resolved through the
 *     REAL `resolveModules()` over a real `buildPlatform()`, so the consumers, jobs
 *     and schedule rows are exactly the worker's;
 *   * the REAL `createJobRunner`, `createConsumerPump` and `createScheduler`,
 *     started the way `worker.ts` starts them, at the poll intervals `loadConfig`
 *     defaults to (so claim latency is in the number);
 *   * the worker's own pool, sized `DATABASE_POOL_MAX + WORKER_PINNED_CONNECTIONS` as
 *     worker.ts sizes it (the orchestrator is the harness's, over the api pool);
 *   * the REAL `PlaidConnector`, `SyncOrchestrator`, ledger write path, sealed
 *     credentials and event outbox. Only the network is a double: `FakePlaidApi`
 *     replays recorded-shape replies (the connector's own fixtures: the same
 *     transaction, account and item shapes the conformance suite replays), pushed
 *     through the real `/connections/plaid/exchange` route.
 *
 * Two things differ from a night on a real install, and both are stated here
 * rather than discovered: the scheduler runs with `random: () => 0`, so the ±20
 * minute jitter 08 §3.7 puts on the 03:15 sync is not waited out (it is a
 * deliberate delay, not work, and the budget is about work); and each stage's
 * schedule row is made due by hand and ticked in cron order, so the four
 * hours of idle between 03:15 and 04:15 are not slept through. Every stage then
 * waits for the queue and the outbox to go quiet before the next begins, which
 * is what the cron gaps guarantee on a real night.
 *
 * ## The chain, stage by stage
 *
 * | Stage | Driven by |
 * |---|---|
 * | 03:15 sync of eight connections, a day's delta each | the `connections.nightly_sync` schedule → `connections.sync_all` → eight `connections.sync` jobs |
 * | categorisation, recurring, budgeting, notifications | the consumer pump, on the events those syncs append |
 * | transfer pairing | `pairTransfers` called directly after the sync (see below) |
 * | 04:00 net worth | the `planning.net_worth_snapshot` schedule |
 * | 04:15 insights | the `insights.nightly` schedule → `insights.run_all` → `insights.run` |
 *
 * **Transfer pairing is not a shipped job.** `pairTransfers` has callers only in
 * the seed loader and (as a confirm/reject) in `routes/transactions.ts`; no
 * consumer or schedule runs it on a sync, so a real night never pairs a transfer
 * the holder has not confirmed. The spec lists it in the chain, so it is timed
 * here as its own step — but it is called directly, it is labelled as such in
 * the output, and it is reported as an open item.
 *
 * ## The budget, and what is only recorded
 *
 * **< 5 minutes** from the first sync's start to the last nightly job's end,
 * `assertWithinBudget`-style (a loaded host skips by name, a quiet one fails).
 * The first 730-day backfill — what happens when a connection is first linked —
 * is run the same way and **recorded, not budgeted**. `PERF_NIGHTLY_BACKFILL_DAYS`
 * scales it down for development.
 *
 * ## Row counts first
 *
 * A chain timed over nothing is a lie: the sanity test asserts the backfill
 * landed (rows per connection), the delta landed (added, modified and removed
 * counted by the sync runs), every job in the chain finished, none is dead, and
 * every consumer reached the head of the outbox.
 */
import { PlaidConnector } from '@connector/plaid';
import {
  ACCOUNTS,
  FakePlaidApi,
  ITEM,
  SYNC_PAGES,
  linkSettings,
  type FakeItemSpec,
} from '@connector/plaid/test';
import { loadConfig } from '@core/config';
import { createDatabase, createPool } from '@core/db';
import { newId, systemClock } from '@core/kernel';
import {
  createConsumerPump,
  createJobRunner,
  createScheduler,
  outboxHealth,
  queueHealth,
  type ConsumerPump,
  type JobRunner,
  type Scheduler,
} from '@core/platform';
import { NIGHTLY_SCHEDULE_NAME } from '@ctx/connections';
import { SCHEDULE_NAME as INSIGHTS_NIGHTLY_SCHEDULE_NAME } from '@ctx/insights';
import { BUILTIN_CATALOGUE, grantScopes } from '@ctx/insights';
import { pairTransfers } from '@ctx/ledger';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvestmentSyncPort, drizzleTransactionalExecutor } from '../../src/domain.ts';
import {
  appModules,
  NET_WORTH_SNAPSHOT_SCHEDULE_NAME,
  registerBuiltinAdvisors,
} from '../../src/modules.ts';
import { buildPlatform, resolveModules, type Platform } from '../../src/platform.ts';
import { WORKER_PINNED_CONNECTIONS } from '../../src/worker.ts';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';
import { createTempSecrets, type TempSecrets } from '../helpers/secrets.ts';
import { assertWithinBudget, describeLoad, recordFigure, settleLoad } from './perf-support.ts';

// perf-skip: NO_DATABASE — DATABASE_URL is unset, so there is no Postgres to run the worker's chain against (CI's migration-test job has one)
// perf-skip: ON_SHARED_RUNNER — a GitHub shared runner is not the target hardware (09 §6 Q1); the chain still runs there (at 30 days of backfill and a 250 ms poll, to fit the job's 25 minutes) and the row-count test still runs, the < 5 min assertion does not
// perf-skip: HOST_LOADED — an over-budget reading at a 1-minute load of 3 or more is not believed (09 §3 rule 4); in-budget readings pass at any load
const describeWithDb = describe.skipIf(NO_DATABASE);
const ON_SHARED_RUNNER = process.env['CI'] !== undefined;

const CONNECTIONS = 8;
const BACKFILL_DAYS = Number(
  process.env['PERF_NIGHTLY_BACKFILL_DAYS'] ?? (process.env['CI'] === undefined ? 730 : 30),
);
/** Posted transactions per connection per day, over its checking and card accounts. */
const PER_DAY = 3;
const BUDGET_MS = 5 * 60_000;
/**
 * `JOB_POLL_INTERVAL_MS` as the worker runs it (compose.yml: 5,000). The override
 * exists to take a what-if reading (see the evidence: the insights stage is poll
 * latency, not work); a gated run never sets it.
 */
const POLL_OVERRIDE =
  process.env['PERF_NIGHTLY_JOB_POLL_MS'] ?? (process.env['CI'] === undefined ? undefined : '250');
const QUIET_TIMEOUT_MS = 20 * 60_000;
const DAY_MS = 86_400_000;

type SyncPage = (typeof SYNC_PAGES)[number];
type PlaidTransaction = SyncPage['added'][number];

const TEMPLATE: PlaidTransaction = (() => {
  const first = SYNC_PAGES[0]?.added[0];
  if (first === undefined) throw new Error('the Plaid fixture has no transaction to template from');
  return first;
})();

// ---------------------------------------------------------------------------
// The recorded-reply provider: a deterministic household's history
// ---------------------------------------------------------------------------

/** mulberry32: a fixed seed gives every run the same history. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Merchant {
  readonly name: string;
  readonly descriptor: string;
  readonly primary: string;
  readonly detailed: string;
  readonly low: number;
  readonly high: number;
}

const MERCHANTS: readonly Merchant[] = [
  {
    name: 'Blue Bottle Coffee',
    descriptor: 'SQ *BLUE BOTTLE 4471',
    primary: 'FOOD_AND_DRINK',
    detailed: 'FOOD_AND_DRINK_COFFEE',
    low: 3.5,
    high: 7.5,
  },
  {
    name: 'Philz Coffee',
    descriptor: 'SQ *PHILZ COFFEE 118',
    primary: 'FOOD_AND_DRINK',
    detailed: 'FOOD_AND_DRINK_COFFEE',
    low: 4,
    high: 9,
  },
  {
    name: 'Whole Foods Market',
    descriptor: 'WHOLEFDS MKT #10234',
    primary: 'FOOD_AND_DRINK',
    detailed: 'FOOD_AND_DRINK_GROCERIES',
    low: 22,
    high: 160,
  },
  {
    name: 'Trader Joes',
    descriptor: 'TRADER JOE S #552',
    primary: 'FOOD_AND_DRINK',
    detailed: 'FOOD_AND_DRINK_GROCERIES',
    low: 18,
    high: 95,
  },
  {
    name: 'Safeway',
    descriptor: 'SAFEWAY #1190',
    primary: 'FOOD_AND_DRINK',
    detailed: 'FOOD_AND_DRINK_GROCERIES',
    low: 15,
    high: 120,
  },
  {
    name: 'Chipotle',
    descriptor: 'CHIPOTLE 2291',
    primary: 'FOOD_AND_DRINK',
    detailed: 'FOOD_AND_DRINK_FAST_FOOD',
    low: 9,
    high: 24,
  },
  {
    name: 'The French Laundry',
    descriptor: 'TST* FRENCH LNDRY',
    primary: 'FOOD_AND_DRINK',
    detailed: 'FOOD_AND_DRINK_RESTAURANT',
    low: 40,
    high: 260,
  },
  {
    name: 'Shell',
    descriptor: 'SHELL OIL 57444',
    primary: 'TRANSPORTATION',
    detailed: 'TRANSPORTATION_GAS',
    low: 28,
    high: 74,
  },
  {
    name: 'Uber',
    descriptor: 'UBER *TRIP',
    primary: 'TRANSPORTATION',
    detailed: 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES',
    low: 8,
    high: 45,
  },
  {
    name: 'Amazon',
    descriptor: 'AMZN MKTP US',
    primary: 'GENERAL_MERCHANDISE',
    detailed: 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES',
    low: 9,
    high: 210,
  },
  {
    name: 'Target',
    descriptor: 'TARGET 00012345',
    primary: 'GENERAL_MERCHANDISE',
    detailed: 'GENERAL_MERCHANDISE_SUPERSTORES',
    low: 14,
    high: 140,
  },
  {
    name: 'CVS Pharmacy',
    descriptor: 'CVS/PHARMACY #3714',
    primary: 'MEDICAL',
    detailed: 'MEDICAL_PHARMACIES_AND_SUPPLEMENTS',
    low: 6,
    high: 60,
  },
  {
    name: 'AMC Theatres',
    descriptor: 'AMC 7830 OAKLAND',
    primary: 'ENTERTAINMENT',
    detailed: 'ENTERTAINMENT_TV_AND_MOVIES',
    low: 12,
    high: 48,
  },
  {
    name: 'REI',
    descriptor: 'REI #6405',
    primary: 'GENERAL_MERCHANDISE',
    detailed: 'GENERAL_MERCHANDISE_SPORTING_GOODS',
    low: 20,
    high: 230,
  },
];

interface Subscription {
  readonly name: string;
  readonly descriptor: string;
  readonly primary: string;
  readonly detailed: string;
  readonly amount: number;
  readonly dayOfMonth: number;
  readonly account: 'checking' | 'card';
}

const SUBSCRIPTIONS: readonly Subscription[] = [
  {
    name: 'Netflix',
    descriptor: 'NETFLIX.COM',
    primary: 'ENTERTAINMENT',
    detailed: 'ENTERTAINMENT_TV_AND_MOVIES',
    amount: 15.49,
    dayOfMonth: 3,
    account: 'card',
  },
  {
    name: 'Spotify',
    descriptor: 'SPOTIFY USA',
    primary: 'ENTERTAINMENT',
    detailed: 'ENTERTAINMENT_MUSIC_AND_AUDIO',
    amount: 10.99,
    dayOfMonth: 9,
    account: 'card',
  },
  {
    name: 'Equinox',
    descriptor: 'EQUINOX CLUB DUES',
    primary: 'PERSONAL_CARE',
    detailed: 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS',
    amount: 189,
    dayOfMonth: 15,
    account: 'card',
  },
  {
    name: 'Comcast',
    descriptor: 'COMCAST XFINITY',
    primary: 'RENT_AND_UTILITIES',
    detailed: 'RENT_AND_UTILITIES_INTERNET_AND_CABLE',
    amount: 79.99,
    dayOfMonth: 21,
    account: 'checking',
  },
  {
    name: 'PG&E',
    descriptor: 'PG&E WEB ONLINE',
    primary: 'RENT_AND_UTILITIES',
    detailed: 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY',
    amount: 112.4,
    dayOfMonth: 12,
    account: 'checking',
  },
  {
    name: 'Landlord',
    descriptor: 'ACH RENT PMT',
    primary: 'RENT_AND_UTILITIES',
    detailed: 'RENT_AND_UTILITIES_RENT',
    amount: 2450,
    dayOfMonth: 1,
    account: 'checking',
  },
];

function dollars(value: number): number {
  return Math.round(value * 100) / 100;
}

function isoDate(daysFromToday: number): string {
  return new Date(Date.now() + daysFromToday * DAY_MS).toISOString().slice(0, 10);
}

interface ItemIds {
  readonly itemId: string;
  readonly accessToken: string;
  readonly publicToken: string;
  readonly checking: string;
  readonly card: string;
}

function itemIds(index: number): ItemIds {
  const itemId = `item-nightly-${String(index)}`;
  return {
    itemId,
    accessToken: `access-nightly-NEVER-REAL-${String(index).padStart(2, '0')}-9f2c4d7a1b6e`,
    publicToken: `public-nightly-NEVER-REAL-${String(index).padStart(2, '0')}-3e8b1a5c9d0f`,
    checking: `${itemId}-acct-checking-001`,
    card: `${itemId}-acct-card-002`,
  };
}

function plaidTransaction(
  ids: ItemIds,
  fields: {
    readonly id: string;
    readonly account: 'checking' | 'card';
    /** Plaid's sign: positive is money out. */
    readonly amount: number;
    readonly date: string;
    readonly name: string;
    readonly descriptor: string;
    readonly primary: string;
    readonly detailed: string;
    readonly pending?: boolean;
    readonly pendingId?: string | null;
  },
): PlaidTransaction {
  return {
    ...TEMPLATE,
    transaction_id: fields.id,
    account_id: fields.account === 'checking' ? ids.checking : ids.card,
    amount: dollars(fields.amount),
    date: fields.date,
    authorized_date: fields.date,
    authorized_datetime: null,
    datetime: null,
    name: fields.descriptor,
    original_description: fields.descriptor,
    merchant_name: fields.name,
    merchant_entity_id: `ent-${fields.name.toLowerCase().replaceAll(/[^a-z0-9]/g, '')}`,
    counterparties: [
      {
        name: fields.name,
        type: 'merchant',
        entity_id: `ent-${fields.name.toLowerCase().replaceAll(/[^a-z0-9]/g, '')}`,
        website: null,
        logo_url: null,
        confidence_level: 'VERY_HIGH',
        phone_number: null,
      },
    ],
    pending: fields.pending === true,
    pending_transaction_id: fields.pendingId ?? null,
    personal_finance_category: {
      primary: fields.primary,
      detailed: fields.detailed,
      confidence_level: 'VERY_HIGH',
      version: 'v2',
    },
  } as unknown as PlaidTransaction;
}

function pageOf(
  cursor: string,
  hasMore: boolean,
  added: readonly PlaidTransaction[],
  modified: readonly PlaidTransaction[],
  removed: readonly { transaction_id: string; account_id: string }[],
): SyncPage {
  return {
    ...SYNC_PAGES[0],
    accounts: [],
    added: [...added],
    modified: [...modified],
    removed: [...removed],
    next_cursor: cursor,
    has_more: hasMore,
    request_id: `req-${cursor}`,
  } as unknown as SyncPage;
}

/** One institution's recorded history: `days` of backfill, in pages of 500. */
function backfillPages(
  index: number,
  days: number,
): { pages: SyncPage[]; pendingIds: string[]; rows: number } {
  const ids = itemIds(index);
  const random = prng(1_000 + index);
  const all: PlaidTransaction[] = [];
  const pendingIds: string[] = [];
  for (let offset = days; offset >= 1; offset -= 1) {
    const date = isoDate(-offset);
    const dayOfMonth = Number(date.slice(8, 10));
    for (const subscription of SUBSCRIPTIONS) {
      if (subscription.dayOfMonth !== dayOfMonth) continue;
      all.push(
        plaidTransaction(ids, {
          id: `s-${String(index)}-${subscription.name}-${date}`,
          account: subscription.account,
          amount: subscription.amount,
          date,
          name: subscription.name,
          descriptor: subscription.descriptor,
          primary: subscription.primary,
          detailed: subscription.detailed,
        }),
      );
    }
    // Biweekly payroll, a negative amount (money in) on the checking account.
    if (offset % 14 === 0) {
      all.push(
        plaidTransaction(ids, {
          id: `pay-${String(index)}-${date}`,
          account: 'checking',
          amount: -2100,
          date,
          name: 'Northwind Mutual',
          descriptor: 'NORTHWIND MUTUAL PAYROLL',
          primary: 'INCOME',
          detailed: 'INCOME_SALARY',
        }),
      );
    }
    // Weekly: a card payment out of checking and the matching inflow on the card
    // (a transfer pair for the pairing step to find).
    if (offset % 7 === 0) {
      const amount = dollars(300 + Math.floor(random() * 400));
      all.push(
        plaidTransaction(ids, {
          id: `xo-${String(index)}-${date}`,
          account: 'checking',
          amount,
          date,
          name: 'Online Transfer',
          descriptor: 'ONLINE TRANSFER TO CARD PAYMENT',
          primary: 'LOAN_PAYMENTS',
          detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        }),
        plaidTransaction(ids, {
          id: `xi-${String(index)}-${date}`,
          account: 'card',
          amount: -amount,
          date,
          name: 'Payment Thank You',
          descriptor: 'PAYMENT THANK YOU',
          primary: 'LOAN_PAYMENTS',
          detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
        }),
      );
    }
    for (let k = 0; k < PER_DAY; k += 1) {
      const merchant = MERCHANTS[Math.floor(random() * MERCHANTS.length)] ?? MERCHANTS[0];
      if (merchant === undefined) continue;
      const amount = merchant.low + random() * (merchant.high - merchant.low);
      const pending = offset === 1 && k === 0;
      const id = `t-${String(index)}-${date}-${String(k)}`;
      if (pending) pendingIds.push(id);
      all.push(
        plaidTransaction(ids, {
          id,
          account: random() < 0.7 ? 'card' : 'checking',
          amount,
          date,
          name: merchant.name,
          descriptor: merchant.descriptor,
          primary: merchant.primary,
          detailed: merchant.detailed,
          pending,
        }),
      );
    }
  }
  const pages: SyncPage[] = [];
  for (let start = 0; start < all.length; start += 500) {
    const last = start + 500 >= all.length;
    pages.push(
      pageOf(
        `cursor-${String(index)}-backfill-${String(start / 500)}`,
        !last,
        all.slice(start, start + 500),
        [],
        [],
      ),
    );
  }
  return { pages, pendingIds, rows: all.length };
}

/** A day's delta for one institution: new rows, a pending that posted, a restated amount. */
function deltaPage(
  index: number,
  pendingIds: readonly string[],
): { page: SyncPage; added: number; modified: number; removed: number } {
  const ids = itemIds(index);
  const random = prng(9_000 + index);
  const today = isoDate(0);
  const added: PlaidTransaction[] = [];
  for (let k = 0; k < 6; k += 1) {
    const merchant = MERCHANTS[Math.floor(random() * MERCHANTS.length)] ?? MERCHANTS[0];
    if (merchant === undefined) continue;
    added.push(
      plaidTransaction(ids, {
        id: `d-${String(index)}-${today}-${String(k)}`,
        account: random() < 0.7 ? 'card' : 'checking',
        amount: merchant.low + random() * (merchant.high - merchant.low),
        date: today,
        name: merchant.name,
        descriptor: merchant.descriptor,
        primary: merchant.primary,
        detailed: merchant.detailed,
        pending: k < 2,
      }),
    );
  }
  // Pending → posted is an identity migration: the posted row names the pending
  // one, and the pending one is retracted in the same page.
  const posted = pendingIds.slice(0, 1).map((pendingId) =>
    plaidTransaction(ids, {
      id: `posted-${pendingId}`,
      account: 'card',
      amount: 12.34,
      date: isoDate(-1),
      name: 'Blue Bottle Coffee',
      descriptor: 'SQ *BLUE BOTTLE 4471',
      primary: 'FOOD_AND_DRINK',
      detailed: 'FOOD_AND_DRINK_COFFEE',
      pendingId,
    }),
  );
  const removed = pendingIds
    .slice(0, 1)
    .map((pendingId) => ({ transaction_id: pendingId, account_id: ids.card }));
  return {
    page: pageOf(`cursor-${String(index)}-delta`, false, [...added, ...posted], [], removed),
    added: added.length + posted.length,
    modified: 0,
    removed: removed.length,
  };
}

// ---------------------------------------------------------------------------

describeWithDb(
  `[slow] the nightly chain: ${String(CONNECTIONS)} connections, scheduled sync to last job (< 5 min)`,
  () => {
    let h: ApiHarness;
    let secrets: TempSecrets;
    let platform: Platform;
    let consumerDefinitions: readonly { name: string; filter: readonly string[] | undefined }[] =
      [];
    let workerPool: ReturnType<typeof createPool> | undefined;
    let runner: JobRunner;
    let pump: ConsumerPump;
    let scheduler: Scheduler;
    let api: FakePlaidApi;
    const specs = new Map<number, FakeItemSpec>();
    const backfill = new Map<number, ReturnType<typeof backfillPages>>();
    let backfillRows = 0;
    let backfillMs = 0;
    let chainMs = 0;
    const chainStages: { stage: string; ms: number }[] = [];
    let deltaExpected = { added: 0 };
    let pairing = { paired: 0, considered: 0, ms: 0 };
    let jobWork: { kind: string; runs: number; workSeconds: number }[] = [];
    let dbWindow: { first: Date | null; last: Date | null } = { first: null, last: null };

    /**
     * Events a consumer has yet to see, counted only over the event types it
     * subscribes to (`RegisteredConsumer.filter`). `outboxHealth.maxLagEvents`
     * counts every event past a consumer's offset, and a consumer that filters
     * (`planning.goal_pace@v1` hears only `planning.ProjectionCompleted`) never
     * advances past events it ignores, so on a healthy night that number never
     * reaches zero.
     */
    async function unprocessedEvents(): Promise<number> {
      let total = 0;
      for (const consumer of consumerDefinitions) {
        const rows = await h.database.db.execute<{ pending: string }>(sql`
          SELECT count(*)::text AS pending
            FROM domain_events e
           WHERE e.seq > coalesce(
                   (SELECT last_seq FROM event_consumer_offsets WHERE consumer_name = ${consumer.name}), 0)
             AND (${consumer.filter === undefined}::boolean
                  OR e.event_type = ANY(string_to_array(${(consumer.filter ?? []).join(',')}, ',')))
        `);
        total += Number(rows.rows[0]?.pending ?? 0);
      }
      return total;
    }

    /** `PERF_NIGHTLY_TRACE=1`: every five seconds, how many events each consumer still has to see (P-4: where a backfill's time goes). */
    let lastTrace = 0;
    async function traceLag(what: string): Promise<void> {
      if (process.env['PERF_NIGHTLY_TRACE'] === undefined || Date.now() - lastTrace < 5_000) return;
      lastTrace = Date.now();
      const lag: Record<string, number> = {};
      for (const consumer of consumerDefinitions) {
        const rows = await h.database.db.execute<{ pending: string }>(sql`
          SELECT count(*)::text AS pending FROM domain_events e
           WHERE e.seq > coalesce((SELECT last_seq FROM event_consumer_offsets WHERE consumer_name = ${consumer.name}), 0)
             AND (${consumer.filter === undefined}::boolean
                  OR e.event_type = ANY(string_to_array(${(consumer.filter ?? []).join(',')}, ',')))
        `);
        lag[consumer.name] = Number(rows.rows[0]?.pending ?? 0);
      }
      process.stdout.write(
        `perf nightly trace (${what}) ${new Date().toISOString()}: ${JSON.stringify(lag)}\n`,
      );
    }

    async function untilQuiet(what: string): Promise<void> {
      const deadline = Date.now() + QUIET_TIMEOUT_MS;
      let quiet = 0;
      while (Date.now() < deadline) {
        await traceLag(what);
        const queue = await queueHealth(platform.db);
        const busy = queue.pending + queue.running > 0 || (await unprocessedEvents()) > 0;
        quiet = busy ? 0 : quiet + 1;
        if (quiet >= 3) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`the worker never went quiet after ${what} (${String(QUIET_TIMEOUT_MS)} ms)`);
    }

    async function makeDue(name: string): Promise<void> {
      const result = await h.database.db.execute(sql`
        UPDATE schedules SET next_run_at = now() - interval '1 minute'
         WHERE user_id = ${h.userId}::uuid AND name = ${name}
      `);
      expect(result.rowCount, `no schedule named ${name} for the holder`).toBe(1);
    }

    async function stage(name: string, scheduleName: string): Promise<number> {
      const started = performance.now();
      await makeDue(scheduleName);
      const fired = await scheduler.tick();
      expect(fired, `${scheduleName} enqueued nothing`).toBeGreaterThanOrEqual(1);
      await untilQuiet(name);
      const ms = performance.now() - started;
      chainStages.push({ stage: name, ms });
      return ms;
    }

    beforeAll(async () => {
      api = new FakePlaidApi([]);
      const connector = new PlaidConnector({ api, settings: linkSettings(), clock: systemClock });
      h = await createApiHarness({ suite: 'wp99-nightly', plaidConnector: connector });
      secrets = createTempSecrets();

      // ---- the worker, built the way worker.ts builds it ------------------
      const config = loadConfig({
        env: {
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
          DATABASE_URL: h.database.url,
          SECRETS_DIR: secrets.dir,
          BASE_URL: 'http://127.0.0.1:8080',
          AUTH_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
          AUTH_RP_ID: '127.0.0.1',
          KEK_ARGON2_MEMORY_KIB: '8192',
          KEK_ARGON2_TIME_COST: '2',
          KEK_ARGON2_PARALLELISM: '1',
        },
      });
      // The worker's own pool, sized as worker.ts sizes it: `DATABASE_POOL_MAX` plus
      // the connections the pump, runner and scheduler pin for LISTEN and leader
      // leases (WORKER_PINNED_CONNECTIONS). On the harness's ten-connection api pool
      // the eight consumer leases starve the job runner, which hangs without an error.
      const pool = createPool({
        databaseUrl: h.database.url,
        max: config.env.DATABASE_POOL_MAX + WORKER_PINNED_CONNECTIONS,
        statementTimeoutMs: config.env.DATABASE_STATEMENT_TIMEOUT_MS,
        applicationName: 'personalfi-worker',
      });
      workerPool = pool;
      const workerDatabase = createDatabase(pool);
      platform = buildPlatform({ config, pool });
      const denyAll = createEgressPolicy({ allowedHosts: [] });
      await registerBuiltinAdvisors(h.database.db, {
        userId: h.userId,
        clock: systemClock,
        correlationId: newId(),
      });
      for (const entry of BUILTIN_CATALOGUE) {
        await grantScopes(
          h.database.db,
          { userId: h.userId, clock: systemClock, correlationId: newId() },
          entry.advisor.manifest.advisor_id,
          [...entry.advisor.manifest.requires_scopes],
        );
      }
      const modules = await resolveModules(
        platform,
        h.userId,
        appModules({
          database: workerDatabase,
          userId: h.userId,
          orchestrator: h.orchestrator,
          timezone: 'UTC',
          clock: systemClock,
          advisorsEnabled: true,
          localModelConfigured: false,
          notificationChannels: {
            ntfy: createNtfyChannel({ policy: denyAll }),
            smtp: createSmtpChannel({ policy: denyAll }),
          },
          secretBox: h.security.requireSecretBox(),
          investmentSyncPort: createInvestmentSyncPort(h.database.db),
          advisorTokenSecret: 'nightly-perf-test-secret',
        }),
      );
      expect(modules.enabled.length).toBeGreaterThan(5);
      consumerDefinitions = modules.consumers.map((c) => ({ name: c.name, filter: c.filter }));
      pump = createConsumerPump({
        pool,
        db: drizzleTransactionalExecutor(workerDatabase),
        consumers: modules.consumers,
        metrics: platform.metrics,
        pollIntervalMs: config.env.EVENT_POLL_INTERVAL_MS,
      });
      runner = createJobRunner({
        pool,
        db: platform.db,
        handlers: modules.jobs,
        metrics: platform.metrics,
        concurrency: config.env.WORKER_CONCURRENCY,
        pollIntervalMs:
          POLL_OVERRIDE === undefined ? config.env.JOB_POLL_INTERVAL_MS : Number(POLL_OVERRIDE),
        heartbeatIntervalMs: config.env.JOB_HEARTBEAT_INTERVAL_MS,
        shutdownGraceMs: config.env.WORKER_SHUTDOWN_GRACE_MS,
      });
      scheduler = createScheduler({
        pool,
        db: platform.db,
        metrics: platform.metrics,
        tickIntervalMs: config.env.SCHEDULER_INTERVAL_MS,
        random: () => 0,
      });

      // ---- link eight institutions over the real route, each with its backfill ----
      for (let index = 0; index < CONNECTIONS; index += 1) {
        const ids = itemIds(index);
        const built = backfillPages(index, BACKFILL_DAYS);
        backfill.set(index, built);
        backfillRows += built.rows;
        const spec: FakeItemSpec = {
          accessToken: ids.accessToken,
          publicToken: ids.publicToken,
          item: { ...ITEM, item_id: ids.itemId },
          accounts: ACCOUNTS.map((account) => ({
            ...account,
            account_id: `${ids.itemId}-${account.account_id}`,
          })),
          pages: built.pages,
        };
        specs.set(index, spec);
        api.addItem(spec);
      }

      // ---- the first backfill, timed and recorded, never budgeted ---------
      const backfillStarted = performance.now();
      for (let index = 0; index < CONNECTIONS; index += 1) {
        const ids = itemIds(index);
        const response = await h.request({
          method: 'POST',
          url: '/connections/plaid/exchange',
          session: h.fresh,
          body: { publicToken: ids.publicToken, institutionName: `Nightly Bank ${String(index)}` },
        });
        expectStatus(response, 201);
      }
      await pump.start();
      await runner.start();
      await untilQuiet('the first backfill');
      backfillMs = performance.now() - backfillStarted;
      recordFigure('nightly: first backfill (recorded, not budgeted)', {
        connections: CONNECTIONS,
        days: BACKFILL_DAYS,
        rows: backfillRows,
        seconds: Number((backfillMs / 1_000).toFixed(1)),
      });

      // The state the night starts from, asserted rather than assumed (WP 9.14). A CI run once read
      // 49 of 56 delta rows because ONE connection's scheduled sync re-read its whole 106-row history
      // (a null or unknown cursor at the night's start), and the only symptom was a count at the end of
      // the test. Every connection must have finished its first sync with a stored cursor, and nothing
      // may be dead or failed, BEFORE the night is timed; a violation names the connection and prints
      // its runs and its failed jobs, which is what the end-of-test count could not say.
      const firstSyncState = await h.database.db.execute<{
        connection_ordinal: number;
        cursor: string | null;
        initial_ok: number;
        runs: unknown;
      }>(sql`
        SELECT (dense_rank() OVER (ORDER BY c.created_at))::int AS connection_ordinal,
               c.transactions_cursor AS cursor,
               (SELECT count(*)::int FROM sync_runs r
                 WHERE r.connection_id = c.id AND r.trigger = 'initial'
                   AND r.operation = 'transactions' AND r.status = 'success') AS initial_ok,
               (SELECT coalesce(jsonb_agg(jsonb_build_object('trigger', r.trigger, 'operation', r.operation,
                         'status', r.status, 'added', r.added_count, 'error', r.error_code) ORDER BY r.started_at), '[]'::jsonb)
                  FROM sync_runs r WHERE r.connection_id = c.id) AS runs
          FROM connections c WHERE c.user_id = ${h.userId}::uuid ORDER BY c.created_at
      `);
      const brokenJobs = await h.database.db.execute<{
        kind: string;
        status: string;
        last_error: unknown;
      }>(sql`
        SELECT kind, status, last_error FROM jobs WHERE status IN ('dead', 'failed')
      `);
      const unsynced = firstSyncState.rows.filter(
        (row) => row.cursor === null || row.initial_ok !== 1,
      );
      expect(
        { unsynced, brokenJobs: brokenJobs.rows },
        'every connection finished its first sync with a stored cursor, and no job is dead or failed',
      ).toEqual({ unsynced: [], brokenJobs: [] });

      // A night is ~24 h after the previous sync. Plaid's `minSyncIntervalSeconds` is
      // four hours, and a scheduled sync inside it is skipped (`min_interval`), so a
      // chain that ran seconds after the backfill would time eight skips.
      await h.database.db.execute(sql`
        UPDATE connections SET last_synced_at = now() - interval '24 hours'
         WHERE user_id = ${h.userId}::uuid
      `);

      // ---- the day's delta: each fake Item's chain grows by one page ------
      for (let index = 0; index < CONNECTIONS; index += 1) {
        const spec = specs.get(index);
        const built = backfill.get(index);
        if (spec === undefined || built === undefined) continue;
        const delta = deltaPage(index, built.pendingIds);
        deltaExpected = { added: deltaExpected.added + delta.added };
        api.addItem({ ...spec, pages: [...spec.pages, delta.page] });
      }
    }, 3_600_000);

    afterAll(async () => {
      await scheduler?.stop();
      await runner?.stop();
      await pump?.stop();
      await workerPool?.end();
      secrets?.dispose();
      await h?.close();
    }, 180_000);

    it('the chain runs the 04:00 night: sync, consumers, pairing, net worth, insights', async () => {
      // The backfill just lifted the load average on its own; a real night starts
      // from a quiet worker.
      await settleLoad();
      const chainStarted = performance.now();

      // 03:15 — the scheduled fan-out and its consumers.
      await stage('03:15 scheduled sync + consumers', NIGHTLY_SCHEDULE_NAME);

      // Transfer pairing — a direct call; no shipped job runs it (see the header).
      const pairStarted = performance.now();
      const paired = await pairTransfers(
        h.database.db,
        { userId: h.userId },
        { clock: systemClock, correlationId: newId() },
      );
      const pairMs = performance.now() - pairStarted;
      pairing = { paired: paired.paired.length, considered: paired.consideredLegs, ms: pairMs };
      chainStages.push({ stage: 'transfer pairing (direct call, not a shipped job)', ms: pairMs });
      await untilQuiet('transfer pairing');

      // 04:00 — the net-worth snapshot; 04:15 — the advisor pass.
      await stage('04:00 net-worth snapshot', NET_WORTH_SNAPSHOT_SCHEDULE_NAME);
      await stage('04:15 insights (insights.run_all)', INSIGHTS_NIGHTLY_SCHEDULE_NAME);
      chainMs = performance.now() - chainStarted;

      // The same window from the database's own clock (job_runs: `jobs` clears its
      // lock columns on completion), and how much of the insights stage was work:
      // the sum of the handlers' own durations against the stage's wall time.
      const since = new Date(Date.now() - chainMs - 5_000).toISOString();
      const window = await h.database.db.execute<{ first: Date | null; last: Date | null }>(sql`
        SELECT min(r.started_at) FILTER (WHERE j.kind = 'connections.sync') AS first,
               max(r.finished_at) AS last
          FROM job_runs r JOIN jobs j ON j.id = r.job_id
         WHERE r.user_id = ${h.userId}::uuid AND r.started_at >= ${since}::timestamptz
      `);
      dbWindow = { first: window.rows[0]?.first ?? null, last: window.rows[0]?.last ?? null };
      const work = await h.database.db.execute<{ kind: string; runs: string; work_ms: string }>(sql`
        SELECT j.kind, count(*)::text AS runs, coalesce(sum(r.duration_ms), 0)::text AS work_ms
          FROM job_runs r JOIN jobs j ON j.id = r.job_id
         WHERE r.user_id = ${h.userId}::uuid AND r.started_at >= ${since}::timestamptz
         GROUP BY j.kind ORDER BY j.kind
      `);
      jobWork = work.rows.map((row) => ({
        kind: row.kind,
        runs: Number(row.runs),
        workSeconds: Number((Number(row.work_ms) / 1_000).toFixed(2)),
      }));

      for (const entry of chainStages) {
        process.stdout.write(
          `perf nightly stage: ${entry.stage}: ${(entry.ms / 1_000).toFixed(2)} s\n`,
        );
      }
      recordFigure('nightly chain (first sync start to last job end)', {
        connections: CONNECTIONS,
        seconds: Number((chainMs / 1_000).toFixed(2)),
        stages: chainStages.map((entry) => ({
          stage: entry.stage,
          seconds: Number((entry.ms / 1_000).toFixed(2)),
        })),
        transferPairing: pairing,
        jobWork,
        dbWindowSeconds:
          dbWindow.first === null || dbWindow.last === null
            ? null
            : Number(
                (
                  (new Date(String(dbWindow.last)).getTime() -
                    new Date(String(dbWindow.first)).getTime()) /
                  1_000
                ).toFixed(2),
              ),
        backfillRows,
        jobPollMs: POLL_OVERRIDE === undefined ? 'config default' : Number(POLL_OVERRIDE),
      });
    }, 3_600_000);

    // ---- the row-count sanity check: never skips, for any reason ----------
    it('the night did real work (a chain timed over nothing is a lie)', async () => {
      expect(chainMs, 'the chain test did not run').toBeGreaterThan(0);

      // The backfill landed: every connection, its history.
      const ledger = await h.database.db.execute<{ live: string; accounts: string }>(sql`
        SELECT (SELECT count(*) FROM transactions WHERE user_id = ${h.userId}::uuid AND removed_at IS NULL)::text AS live,
               (SELECT count(*) FROM accounts WHERE user_id = ${h.userId}::uuid)::text AS accounts
      `);
      expect(Number(ledger.rows[0]?.accounts)).toBe(CONNECTIONS * ACCOUNTS.length);
      expect(Number(ledger.rows[0]?.live)).toBeGreaterThan(backfillRows * 0.95);

      // The scheduled night synced every connection, and counted its delta.
      const runs = await h.database.db.execute<{
        connections: string;
        added: string;
        failed: string;
      }>(sql`
        SELECT count(DISTINCT connection_id)::text AS connections,
               coalesce(sum(added_count), 0)::text AS added,
               count(*) FILTER (WHERE status = 'failed')::text AS failed
          FROM sync_runs
         WHERE user_id = ${h.userId}::uuid AND trigger = 'scheduled' AND operation = 'transactions'
      `);
      expect(Number(runs.rows[0]?.connections), 'connections synced by the scheduled run').toBe(
        CONNECTIONS,
      );
      expect(Number(runs.rows[0]?.failed)).toBe(0);
      const perConnection = await h.database.db.execute<{
        added: string;
        modified: string;
        removed: string;
      }>(sql`
        SELECT added_count::text AS added, modified_count::text AS modified, removed_count::text AS removed
          FROM sync_runs
         WHERE user_id = ${h.userId}::uuid AND trigger = 'scheduled' AND operation = 'transactions'
         ORDER BY started_at
      `);
      process.stdout.write(
        `perf nightly per-connection scheduled runs (added/modified/removed): ${JSON.stringify(perConnection.rows)}\n`,
      );
      // Every sync run, by connection ordinal and trigger: what a failure of the delta assertion
      // below has to be read against (WP 9.14: the CI run that read 49 of 56 had one connection
      // whose scheduled sync re-read its whole history).
      const allRuns = await h.database.db.execute<Record<string, unknown>>(sql`
        SELECT (dense_rank() OVER (ORDER BY c.created_at))::int AS connection_ordinal,
               r.trigger, r.operation, r.status, r.added_count, r.modified_count, r.removed_count,
               r.started_at
          FROM sync_runs r JOIN connections c ON c.id = r.connection_id
         WHERE r.user_id = ${h.userId}::uuid
         ORDER BY c.created_at, r.started_at
      `);
      process.stdout.write(`perf nightly all sync runs: ${JSON.stringify(allRuns.rows)}\n`);
      // The day's delta landed: every row the fake Items added is in the ledger,
      // by its provider id. (The runs' own added/modified counters are printed
      // above; they split a pending row that posted between "added" and "modified"
      // by rules of their own, so the ledger is the better witness.)
      const landed = await h.database.db.execute<{ landed: string }>(sql`
        SELECT count(*)::text AS landed
          FROM transactions_provider
         WHERE user_id = ${h.userId}::uuid
           AND (provider_transaction_id LIKE 'd-%' OR provider_transaction_id LIKE 'posted-%')
      `);
      expect(Number(landed.rows[0]?.landed), "the day's delta, in the ledger").toBe(
        deltaExpected.added,
      );

      // Nothing in the chain died, and the consumers reached the head.
      const queue = await queueHealth(platform.db);
      expect(queue.dead + queue.failed).toBe(0);
      expect(queue.pending + queue.running).toBe(0);
      const outbox = await outboxHealth(platform.db);
      expect(outbox.failedConsumers).toEqual([]);
      expect(await unprocessedEvents(), 'events a subscribed consumer has not seen').toBe(0);

      // Each stage's own output exists: events from the sync, a sealed day, an advisor run.
      const produced = await h.database.db.execute<{
        days: string;
        runs: string;
        events: string;
      }>(sql`
        SELECT (SELECT count(*) FROM net_worth_daily WHERE user_id = ${h.userId}::uuid)::text AS days,
               (SELECT count(*) FROM jobs WHERE user_id = ${h.userId}::uuid AND kind = 'insights.run' AND status = 'succeeded')::text AS runs,
               (SELECT count(*) FROM domain_events WHERE user_id = ${h.userId}::uuid)::text AS events
      `);
      expect(Number(produced.rows[0]?.days)).toBeGreaterThanOrEqual(1);
      expect(Number(produced.rows[0]?.runs)).toBeGreaterThanOrEqual(1);
      expect(Number(produced.rows[0]?.events)).toBeGreaterThan(CONNECTIONS);
      expect(pairing.considered).toBeGreaterThan(0);
      process.stdout.write(
        `perf nightly: ${String(CONNECTIONS)} connections, ${String(backfillRows)} backfilled rows, ` +
          `delta ${String(deltaExpected.added)} rows, ` +
          `pairing ${String(pairing.paired)} of ${String(pairing.considered)} legs ${describeLoad()}\n`,
      );
    }, 120_000);

    it.skipIf(ON_SHARED_RUNNER)('the nightly chain completes in under 5 minutes', (ctx) => {
      expect(chainMs, 'the chain test did not run').toBeGreaterThan(0);
      // `assertWithinBudget` compares a p95 in ms against a budget in ms; one night
      // is one sample, so its "p95" is the duration itself.
      assertWithinBudget(ctx, { label: 'nightly chain', p95: chainMs, budgetMs: BUDGET_MS });
    });
  },
);
