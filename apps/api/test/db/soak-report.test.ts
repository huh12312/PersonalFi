// SPDX-License-Identifier: MIT
/**
 * WP 9.1 exit tests for the weekly soak report (`scripts/soak/report.ts`;
 * docs/plan/09-phase-9-dispatch.md §3 "WP 9.1", parts 3-5).
 *
 * The report's output is committed and pushed (`docs/evidence/phase-9/soak/`),
 * which is exactly why the canary test exists: names, memos, institutions,
 * goals and an amount are planted in a real, migrated database, rows reach it
 * through the real ledger (a manual connection synced by the real
 * orchestrator), and the report -- the real script's real queries and real
 * renderer, never a parallel construction (C5-11) -- must not contain one.
 *
 * Three independent controls guard the same property (see the script header):
 * the select-list parser, the output-column whitelist, and this canary. The
 * canary calls `executeSoakQueries`, which skips the first two, so it is a
 * control of its own.
 */
import { writeFileSync } from 'node:fs';

import { manualTransaction } from '@connector/manual';
import { DateOnly, money, newId, systemClock } from '@core/kernel';
import { categoryIdsByKey, seedSystemTaxonomy } from '@ctx/categorization';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertQueriesAreSafe,
  CRITERIA,
  computeClockState,
  evaluateCriteria,
  evaluateCriterionTwo,
  executeSoakQueries,
  isAllowedOutputColumn,
  isoWeekOf,
  parseClockRows,
  renderSoakReport,
  runSoakQueries,
  SOAK_QUERIES,
  selectListsOf,
  type SoakPool,
  type SoakQuery,
} from '../../../../scripts/soak/report.ts';
import { SEEDED } from './soak-canary-columns.ts';
import {
  createApiHarness,
  linkManual,
  NO_DATABASE,
  syncConnection,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const AS_OF = new Date('2026-11-09T12:00:00.000Z'); // a Monday, ISO week 2026-W46
const CHECKING = 'soak-acct-checking';
const SAVINGS = 'soak-acct-savings';
const BROKERAGE = 'soak-acct-brokerage';
const CONN_A = 'soak-conn-a';
const CONN_B = 'soak-conn-b';

/** Everything planted in the database that must never appear in a report. */
const CANARIES = [
  'CANARY-INSTITUTION-ALPHA',
  'CANARY-INSTITUTION-BETA',
  'CANARY-ACCOUNT-CHECKING',
  'CANARY-ACCOUNT-SAVINGS',
  'CANARY-ACCOUNT-BROKERAGE',
  'CANARY-MERCHANT-ZEBRA',
  'CANARY-MERCHANT-OVERRIDE',
  'CANARY-MEMO-ORCHID',
  'CANARY-GOAL-HOUSE',
  'CANARY-BRIEF-TITLE',
  'CANARY-INSIGHT-TITLE',
  'CANARY-CHANNEL',
  'CANARY-ADVISOR',
  'CANARY-EMPLOYER',
  'CANARY-TRANSFER',
];
/** The canary amount: -76,543.21 USD as minor units, and every way it might be printed. */
const CANARY_AMOUNT_MINOR = 7_654_321n;
const CANARY_AMOUNT_FORMS = ['7654321', '76543.21', '76,543.21', '76 543,21'];

const asPool = (h: ApiHarness): SoakPool => h.database.pool as unknown as SoakPool;

async function exec(h: ApiHarness, statement: ReturnType<typeof sql>): Promise<void> {
  await h.database.db.execute(statement);
}

/** One scheduled, successful sync on each of the seven complete UTC days before AS_OF, per connection. */
async function seedSyncRuns(h: ApiHarness, connectionIds: readonly string[]): Promise<void> {
  for (const connectionId of connectionIds) {
    for (let daysBack = 1; daysBack <= 7; daysBack += 1) {
      const startedAt = new Date(AS_OF.getTime() - daysBack * 86_400_000 - 3_600_000);
      await exec(
        h,
        // fixture: sync_runs row written by SQL because soak-report: the report reads counts, ages and column presence, never row content or shape (no route is asserted here), and this test plants canary text in free-text columns; its writer is the sync orchestrator, which the linked manual connections above already drive for real; this helper adds scheduled successful runs over past days (trigger 'scheduled'), which the orchestrator writes for the nightly sync.
        sql`INSERT INTO sync_runs (id, user_id, connection_id, trigger, operation, status, started_at, finished_at, duration_ms, correlation_id)
            VALUES (${newId()}::uuid, ${h.userId}::uuid, ${connectionId}::uuid, 'scheduled', 'transactions', 'success',
                    ${startedAt.toISOString()}::timestamptz, ${new Date(startedAt.getTime() + 2_000).toISOString()}::timestamptz,
                    ${1_500 + daysBack * 100}, ${newId()}::uuid)`,
      );
    }
  }
}

async function seedBriefs(h: ApiHarness): Promise<void> {
  const weeks = ['2026-W41', '2026-W42', '2026-W43', '2026-W44'];
  for (const [index, isoWeek] of weeks.entries()) {
    const insightId = newId();
    const briefId = newId();
    // Three of the four insights are accepted by the holder.
    const accepted = index < 3;
    await exec(
      h,
      // fixture: insights row written by SQL because soak-report: the report reads counts, ages and column presence, never row content or shape (no route is asserted here), and this test plants canary text in free-text columns; its writer is `upsertInsight` (the nightly advisor run); the run could write it as a pending_review finding with a canary title/summary, as here.
      sql`INSERT INTO insights (id, user_id, advisor_id, advisor_version, key, period, type, severity, title, summary_md,
                                confidence, confidence_basis, horizon, input_digest, status, reviewed_at)
          VALUES (${insightId}::uuid, ${h.userId}::uuid, 'canary.advisor', '1.0.0', ${`k-${index}`}, '2026-10', 'canary_type', 'info',
                  'CANARY-INSIGHT-TITLE', 'CANARY-MEMO-ORCHID', 0.9, 'deterministic', 'this_period',
                  ${`sha256:${'a'.repeat(64)}`}, ${accepted ? 'accepted' : 'pending_review'},
                  ${accepted ? '2026-10-20T10:00:00Z' : null}::timestamptz)`,
    );
    await exec(
      h,
      // fixture: advisory_briefs row written by SQL because soak-report: the report reads counts, ages and column presence, never row content or shape (no route is asserted here), and this test plants canary text in free-text columns; its writer is `publishWeeklyBrief`; the job could write it as a published week.
      sql`INSERT INTO advisory_briefs (id, user_id, iso_week, currency, input_digest, published_at)
          VALUES (${briefId}::uuid, ${h.userId}::uuid, ${isoWeek}, 'USD', ${`sha256:${'b'.repeat(64)}`},
                  ${new Date(Date.UTC(2026, 9, 10 + index * 7, 9)).toISOString()}::timestamptz)`,
    );
    await exec(
      h,
      // fixture: advisory_brief_items row written by SQL because soak-report: the report reads counts, ages and column presence, never row content or shape (no route is asserted here), and this test plants canary text in free-text columns; its writer is `publishWeeklyBrief`; the job could write it as a ranked item linked to its insight.
      sql`INSERT INTO advisory_brief_items (id, user_id, brief_id, section, position, insight_id, advisor_id, insight_key, insight_type,
                                            severity, title, summary_md, confidence, horizon, retirement_effect)
          VALUES (${newId()}::uuid, ${h.userId}::uuid, ${briefId}::uuid, ${index % 2 === 0 ? 'ranked' : 'attention'}, 0,
                  ${insightId}::uuid, 'canary.advisor', ${`k-${index}`}, 'canary_type', 'info',
                  'CANARY-BRIEF-TITLE', 'CANARY-MEMO-ORCHID', 0.9, 'this_period', '{}'::jsonb)`,
    );
    await exec(
      h,
      // fixture: insight_feedback row written by SQL because soak-report: the report reads counts, ages and column presence, never row content or shape (no route is asserted here), and this test plants canary text in free-text columns; its writer is @ctx/insights' review path (store.ts, reached by POST /insights/:id/review); it could write an action with a reason code, as here.
      sql`INSERT INTO insight_feedback (id, user_id, insight_id, advisor_id, insight_key, action, reason_code, correlation_id, created_at)
          VALUES (${newId()}::uuid, ${h.userId}::uuid, ${insightId}::uuid, 'canary.advisor', ${`k-${index}`},
                  ${accepted ? 'accept' : 'dismiss'}, ${accepted ? null : 'NOT_TRUE'}, ${newId()}::uuid,
                  ${new Date(Date.UTC(2026, 9, 11 + index * 7, 9)).toISOString()}::timestamptz)`,
    );
  }
}

/**
 * G-29 (WP 9.14): put a canary in every free-text column of every table the report reads that the seed
 * above does not already reach. The classification is `soak-canary-columns.ts` (SEEDED / NOT_FREE_TEXT),
 * enforced structurally by `soak-canary-coverage.test.ts`, and each SEEDED column is proved to hold a
 * canary by the test at the end of this file.
 *
 * These columns belong to modules whose own write paths need machinery this test does not run (the
 * advisor runner, the notifier, the job queue's failure path, a provider error), so they are written by
 * UPDATE on rows the seed already made, or by one INSERT where no row exists. The values are text the
 * holder could have typed or a provider could have echoed; the report must never print them.
 */
async function seedCanaryColumns(h: ApiHarness): Promise<void> {
  const marker = 'CANARY-MEMO-ORCHID';
  const note = sql`jsonb_build_object('note', ${marker}::text)`;
  await exec(
    h,
    sql`UPDATE connections SET config = ${note}, last_error = ${note} WHERE user_id = ${h.userId}::uuid`,
  );
  await exec(
    h,
    sql`UPDATE sync_runs SET error_detail = ${note}, cursor_before = ${marker}, cursor_after = ${marker}
        WHERE user_id = ${h.userId}::uuid`,
  );
  await exec(
    h,
    sql`UPDATE category_assignments SET evidence = ${note} WHERE user_id = ${h.userId}::uuid`,
  );
  await exec(
    h,
    sql`UPDATE advisors SET manifest = ${note}
        WHERE user_id = ${h.userId}::uuid AND advisor_id = 'canary.advisor'`,
  );
  await exec(
    h,
    sql`UPDATE insights SET caveats = jsonb_build_array(${marker}::text), derivations = jsonb_build_array(${note})
        WHERE user_id = ${h.userId}::uuid`,
  );
  await exec(
    h,
    sql`UPDATE advisory_briefs SET cold_start = TRUE, cold_start_note = ${marker}
        WHERE user_id = ${h.userId}::uuid AND iso_week = '2026-W44'`,
  );
  await exec(
    h,
    sql`UPDATE advisory_brief_items SET evidence = jsonb_build_array(${note}), retirement_effect = ${note}
        WHERE user_id = ${h.userId}::uuid`,
  );
  await exec(
    h,
    sql`UPDATE insight_feedback SET reason = ${marker} WHERE user_id = ${h.userId}::uuid`,
  );
  await exec(
    h,
    sql`UPDATE jobs SET payload = ${note}, last_error = ${note} WHERE user_id = ${h.userId}::uuid`,
  );
  await exec(
    h,
    sql`UPDATE notification_outbox SET actions = jsonb_build_array(${note}), deep_link = ${`/${marker}`}
        WHERE user_id = ${h.userId}::uuid`,
  );
}

describe.skipIf(NO_DATABASE)('the weekly soak report (WP 9.1 part 3)', () => {
  let h: ApiHarness;
  let connectionA: string;
  let connectionB: string;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp91-soak' });

    // The ledger rows arrive through the real sync, never an INSERT into the ledger.
    const linkedA = await linkManual(h, {
      providerConnectionId: CONN_A,
      displayName: 'CANARY-INSTITUTION-ALPHA',
      accounts: [
        {
          providerAccountId: CHECKING,
          name: 'CANARY-ACCOUNT-CHECKING',
          type: 'depository',
          currency: 'USD',
        },
        {
          providerAccountId: SAVINGS,
          name: 'CANARY-ACCOUNT-SAVINGS',
          type: 'depository',
          currency: 'USD',
        },
      ],
      batch: {
        added: [
          manualTransaction({
            providerAccountId: CHECKING,
            providerTransactionId: 'soak-1',
            amount: money(-4_500n, 'USD'),
            postedDate: DateOnly.parse('2026-10-05'),
            name: 'CANARY-MERCHANT-ZEBRA',
            merchantName: 'CANARY-MERCHANT-ZEBRA',
          }),
          manualTransaction({
            providerAccountId: CHECKING,
            providerTransactionId: 'soak-2',
            amount: money(-CANARY_AMOUNT_MINOR, 'USD'),
            postedDate: DateOnly.parse('2026-10-06'),
            name: 'CANARY-MERCHANT-ZEBRA large purchase',
          }),
          manualTransaction({
            providerAccountId: CHECKING,
            providerTransactionId: 'soak-3',
            amount: money(300_000n, 'USD'),
            postedDate: DateOnly.parse('2026-10-15'),
            name: 'CANARY-EMPLOYER payroll',
          }),
          // Pending for more than 10 days at AS_OF: the `ledger_pending` query reads this row.
          manualTransaction({
            providerAccountId: CHECKING,
            providerTransactionId: 'soak-pending',
            amount: money(-3_333n, 'USD'),
            postedDate: DateOnly.parse('2026-10-01'),
            name: 'CANARY-MERCHANT-ZEBRA pending hold',
            pending: true,
          }),
          manualTransaction({
            providerAccountId: SAVINGS,
            providerTransactionId: 'soak-4',
            amount: money(-1_299n, 'USD'),
            postedDate: DateOnly.parse('2026-10-10'),
            name: 'CANARY-MERCHANT-ZEBRA subscription',
          }),
        ],
      },
    });
    const linkedB = await linkManual(h, {
      providerConnectionId: CONN_B,
      displayName: 'CANARY-INSTITUTION-BETA',
      accounts: [
        {
          providerAccountId: BROKERAGE,
          name: 'CANARY-ACCOUNT-BROKERAGE',
          type: 'depository',
          currency: 'USD',
        },
      ],
      batch: {
        added: [
          manualTransaction({
            providerAccountId: BROKERAGE,
            providerTransactionId: 'soak-5',
            amount: money(-2_222n, 'USD'),
            postedDate: DateOnly.parse('2026-10-12'),
            name: 'CANARY-MERCHANT-ZEBRA fee',
          }),
        ],
      },
    });
    connectionA = linkedA.connectionId;
    connectionB = linkedB.connectionId;

    // A memo and a holder-set merchant name on a real ledger row.
    await exec(
      h,
      sql`UPDATE transactions SET user_note = 'CANARY-MEMO-ORCHID', user_merchant_name = 'CANARY-MERCHANT-OVERRIDE'
          WHERE effective_name LIKE 'CANARY-MERCHANT-ZEBRA%'`,
    );
    // A goal, with its own canary name and amount -- through the route (G9-15, C9-9).
    expect(
      (
        await h.request({
          method: 'POST',
          url: '/goals',
          session: h.stale,
          body: {
            kind: 'purchase',
            name: 'CANARY-GOAL-HOUSE',
            target: { minor: '8765432', currency: 'USD' },
            targetDate: '2030-01-01',
          },
        })
      ).statusCode,
    ).toBe(201);
    // Category assignments: three automatic (provider, classifier, merchant default) and one the holder
    // set, decided inside the trailing 30 days -- 75 % automatic, one overlay write in 2026-W45.
    await seedSystemTaxonomy(h.database.db, { userId: h.userId, clock: systemClock });
    const categoryId = [...(await categoryIdsByKey(h.database.db, h.userId)).values()][0];
    const spendRows = await h.database.db.execute<{ id: string }>(
      sql`SELECT id FROM transactions WHERE NOT pending ORDER BY effective_date, id LIMIT 4`,
    );
    for (const [index, source] of (
      ['provider', 'classifier', 'merchant_default', 'user'] as const
    ).entries()) {
      await exec(
        h,
        // fixture: category_assignments rows written by SQL because soak-report: the report reads counts, ages and column presence, never row content or shape (no route is asserted here), and this test plants canary text in free-text columns; their writers are @ctx/categorization (the consumer) and the holder's own edit; each source value used is one that writer stores.
        sql`INSERT INTO category_assignments (id, user_id, transaction_id, category_id, source, confidence, decided_at)
            VALUES (${newId()}::uuid, ${h.userId}::uuid, ${spendRows.rows[index]?.id}::uuid, ${categoryId}::uuid, ${source}, 0.9,
                    '2026-11-03T10:00:00Z'::timestamptz)`,
      );
    }

    await seedSyncRuns(h, [connectionA, connectionB]);
    await seedBriefs(h);

    // Jobs, advisors, notifications, security events, backups and drills.
    await exec(
      h,
      // fixture: jobs row written by SQL because soak-report: the report reads counts, ages and column presence, never row content or shape (no route is asserted here), and this test plants canary text in free-text columns; its writer is `enqueueJob` and the runner; the runner could leave it as a failed attempt with attempts/max_attempts, as here.
      sql`INSERT INTO jobs (id, user_id, kind, correlation_id, status, attempts, max_attempts, updated_at)
          VALUES (${newId()}::uuid, ${h.userId}::uuid, 'sync.scheduled', ${newId()}::uuid, 'dead', 5, 5, '2026-11-03T10:00:00Z')`,
    );
    await exec(
      h,
      // fixture: advisors row written by SQL because soak-report: the report reads counts, ages and column presence, never row content or shape (no route is asserted here), and this test plants canary text in free-text columns; its writer is `registerAdvisor` (@ctx/insights, at boot); registration could write this manifest-bearing row.
      sql`INSERT INTO advisors (id, user_id, advisor_id, version, kind, contract_version, display_name, purpose, manifest,
                                quarantined_at, quarantine_reason)
          VALUES (${newId()}::uuid, ${h.userId}::uuid, 'canary.advisor', '1.0.0', 'builtin', 1, 'CANARY-ADVISOR', 'CANARY-ADVISOR purpose',
                  '{}'::jsonb, '2026-11-02T10:00:00Z', 'manual')`,
    );
    const channelId = newId();
    await exec(
      h,
      // fixture: notification_channels row written by SQL because soak-report: the report reads counts, ages and column presence, never row content or shape (no route is asserted here), and this test plants canary text in free-text columns; its writer is @ctx/notifications' service (routes/notifications.ts); it could write a scheme/host/port row with a sealed config, as here.
      sql`INSERT INTO notification_channels (id, user_id, kind, display_name, destination_host, destination_port, scheme, sealed_config)
          VALUES (${channelId}::uuid, ${h.userId}::uuid, 'ntfy', 'CANARY-CHANNEL', 'ntfy.example', 443, 'https', decode(repeat('00', 64), 'hex'))`,
    );
    await exec(
      h,
      // fixture: notification_outbox row written by SQL because soak-report: the report reads counts, ages and column presence, never row content or shape (no route is asserted here), and this test plants canary text in free-text columns; its writer is @ctx/notifications' outbox (outbox.ts); it could write a queued row with a dedupe key and delivery class, as here.
      sql`INSERT INTO notification_outbox (id, user_id, channel_id, dedupe_key, delivery_class, title, body_md, correlation_id, queued_at)
          VALUES (${newId()}::uuid, ${h.userId}::uuid, ${channelId}::uuid, 'canary-1', 'PROMPT', 'CANARY-BRIEF-TITLE', 'CANARY-MEMO-ORCHID',
                  ${newId()}::uuid, '2026-11-04T10:00:00Z')`,
    );
    for (const [kind, outcome] of [
      ['auth.webauthn.success', 'success'],
      ['auth.webauthn.failure', 'failure'],
      ['auth.step_up', 'success'],
    ] as const) {
      await exec(
        h,
        // fixture: security_events row written by SQL because soak-report: the report reads counts, ages and column presence, never row content or shape (no route is asserted here), and this test plants canary text in free-text columns; its writer is @ctx/identity's security-events appender (security-events.ts); it could write a kind/outcome/detail row, as here.
        sql`INSERT INTO security_events (id, user_id, occurred_at, kind, outcome, detail)
            VALUES (${newId()}::uuid, ${h.userId}::uuid, '2026-11-05T08:00:00Z', ${kind}, ${outcome}, '{"note":"CANARY-MEMO-ORCHID"}'::jsonb)`,
      );
    }
    await exec(
      h,
      // fixture: ops_backup_runs row written by SQL because soak-report: the report reads counts, ages and column presence, never row content or shape (no route is asserted here), and this test plants canary text in free-text columns; its writer is docker/backup/backup.sh (columns checked against the script in ops-backup-status.test.ts).
      sql`INSERT INTO ops_backup_runs (id, status, finished_at, plaintext_bytes, toc_entries, reason)
          VALUES (${newId()}::uuid, 'ok', '2026-11-09T08:00:00Z', 66346, 160, 'CANARY-MEMO-ORCHID wrote a backup'),
                 (${newId()}::uuid, 'fail', '2026-11-09T10:00:00Z', NULL, NULL, 'pg_dump failed')`,
    );
    await exec(
      h,
      // fixture: ops_restore_drills row written by SQL because soak-report: the report reads counts, ages and column presence, never row content or shape (no route is asserted here), and this test plants canary text in free-text columns; its writer is the justfile restore-drill recipe (columns checked against the recipe in ops-backup-status.test.ts).
      sql`INSERT INTO ops_restore_drills (id, verdict, ran_at, restored_table_count, live_table_count, max_migration, rto_seconds)
          VALUES (${newId()}::uuid, 'pass', '2026-10-30T10:00:00Z', 99, 99, '0036', 74)`,
    );
    await seedCanaryColumns(h);
  }, 180_000);

  afterAll(async () => {
    await h.close();
  });

  const render = async (asOf = AS_OF, clockMarkdown = '') => {
    const results = await executeSoakQueries(asPool(h), asOf);
    return {
      results,
      markdown: renderSoakReport({
        results,
        clockRows: parseClockRows(clockMarkdown),
        asOfDate: asOf,
        assumptionsAsOfDates: ['2026-08-01'],
      }),
    };
  };

  it('the soak report contains no amount, name, memo or institution from the database', async () => {
    const { results, markdown } = await render();

    // Not vacuous: the report really read this database.
    const rows = (name: string) => results.find((r) => r.query.name === name)?.rows ?? [];
    expect(rows('sync_health').length).toBeGreaterThan(0);
    expect(rows('spend_rows_by_month').map((r) => r['calendar_month'])).toContain('2026-10');
    expect(rows('brief_first_four')[0]?.['brief_count']).toBe(4n);
    expect(rows('ledger_pending')[0]?.['pending_over_10_days_count']).toBe(1n);
    expect(rows('categorisation_30d')[0]).toMatchObject({
      auto_count: 3n,
      holder_corrected_count: 1n,
    });
    expect(rows('categorisation_30d')[0]?.['auto_rate_pct']).toBe('75.0');
    expect(rows('review_burden')).toEqual([{ iso_week: '2026-W45', overlay_write_count: 1n }]);
    expect(markdown).toContain('## Sync health');
    expect(markdown).toContain('## Criteria ledger');

    // The planted names, memos, institutions, goal and amount are in the database ...
    const planted = await h.database.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM transactions WHERE effective_name LIKE 'CANARY-%' AND user_note IS NOT NULL`,
    );
    expect(Number(planted.rows[0]?.n)).toBeGreaterThan(0);
    const amount = await h.database.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM transactions WHERE effective_amount_minor = ${-CANARY_AMOUNT_MINOR}`,
    );
    expect(amount.rows[0]?.n).toBe('1');

    // ... and none of them is in the report.
    for (const canary of [...CANARIES, ...CANARY_AMOUNT_FORMS]) {
      expect(markdown, `the report leaked ${canary}`).not.toContain(canary);
    }
    expect(markdown.toLowerCase()).not.toContain('canary');
  }, 60_000);

  it('every column classified SEEDED really holds a canary after the seed (G-29)', async () => {
    const empty: string[] = [];
    for (const column of Object.keys(SEEDED)) {
      const [table, name] = column.split('.');
      const found = await h.database.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${name}::text ILIKE '%canary%'`,
      );
      if ((found.rows[0]?.n ?? 0) === 0) empty.push(column);
    }
    expect(empty, 'SEEDED columns the seed never reached (a canary there proves nothing)').toEqual(
      [],
    );
  });

  it('every query in the soak report selects only aggregates and whitelisted dimensions', async () => {
    // The shipped queries pass, and the parser really reads select-lists.
    expect(assertQueriesAreSafe(SOAK_QUERIES)).toEqual([]);
    for (const query of SOAK_QUERIES) {
      expect(
        selectListsOf(query.sql).length,
        `${query.name} has a parsed select-list`,
      ).toBeGreaterThan(0);
      expect(query.sql, `${query.name} must not call now()`).not.toMatch(/\bnow\s*\(/iu);
      expect([...query.sql.matchAll(/\$(\d+)/gu)].every((m) => m[1] === '1')).toBe(true);
    }

    // Negative controls: each of these is a leak the check must refuse.
    const unsafe = (item: string, from = 'transactions t'): SoakQuery => ({
      name: `unsafe: ${item}`,
      section: 'x',
      description: 'x',
      sql: `SELECT ${item} FROM ${from}`,
    });
    for (const item of [
      't.effective_name',
      'max(t.effective_name)',
      'max(t.user_note)',
      'sum(t.effective_amount_minor)',
      'a.name',
      'display_name',
      'user_merchant_name',
      "string_agg(t.id::text, ',')",
      '*',
      'count(*), t.account_id',
      'max(g.name)',
      'max(c.display_name) AS provider_count',
    ]) {
      expect(
        assertQueriesAreSafe([unsafe(item)]).length,
        `'${item}' must be refused`,
      ).toBeGreaterThan(0);
    }
    // A subquery or CTE select-list is parsed too.
    expect(
      assertQueriesAreSafe([
        {
          name: 'cte',
          section: 'x',
          description: 'x',
          sql: 'WITH c AS (SELECT t.effective_name FROM transactions t) SELECT count(*) AS n_count FROM c',
        },
      ]).length,
    ).toBeGreaterThan(0);
    // Positive controls: aggregates and whitelisted dimensions pass.
    for (const item of [
      'count(*) AS run_count',
      'status',
      'sr.status',
      'co.connection_ordinal',
      "to_char(t.effective_date, 'YYYY-MM') AS calendar_month",
      'max(sr.duration_ms)',
    ]) {
      expect(assertQueriesAreSafe([unsafe(item)]), `'${item}' must pass`).toEqual([]);
    }

    // The output-column control: the real run returns only whitelisted columns,
    // and a result column outside the whitelist is refused before it renders.
    const results = await runSoakQueries(asPool(h), AS_OF);
    expect(results.length).toBe(SOAK_QUERIES.length);
    const sneaky = [
      {
        name: 'sneaky',
        section: 'x',
        description: 'x',
        sql: `SELECT count(*) AS merchant_label FROM transactions`,
      },
    ];
    const executed = await executeSoakQueries(asPool(h), AS_OF, sneaky);
    expect(executed[0]?.columns).toEqual(['merchant_label']);
    for (const result of results) {
      expect(result.columns.filter((column) => !isAllowedOutputColumn(column))).toEqual([]);
    }
    expect(isAllowedOutputColumn('merchant_label')).toBe(false);
    expect(isAllowedOutputColumn('display_name')).toBe(false);
    expect(isAllowedOutputColumn('effective_amount_minor')).toBe(false);
    expect(isAllowedOutputColumn('run_count')).toBe(true);
    expect(isAllowedOutputColumn('iso_week')).toBe(true);
  }, 60_000);

  it('criterion 2 reads met only after a complete month with zero internal transfers in spending, and one planted transfer turns it back', async () => {
    const state = async (asOf: Date) =>
      evaluateCriterionTwo(await executeSoakQueries(asPool(h), asOf), asOf);

    // Inside October there is no complete month yet: not met.
    expect((await state(new Date('2026-10-20T12:00:00Z'))).kind).toBe('observing_since');
    // After October is complete, with no transfer legs in it: met.
    const clean = await state(AS_OF);
    expect(clean.kind).toBe('met');
    if (clean.kind === 'met') {
      expect(clean.date).toBe('2026-11-01');
      expect(clean.evidence).toContain('2026-10');
      expect(clean.evidence).toContain('0 internal-transfer pairs');
    }
    // Before any ledger row exists the criterion is not started.
    expect((await state(new Date('2026-09-01T12:00:00Z'))).kind).toBe('not_started');

    // Plant ONE internal transfer: equal and opposite legs in two accounts, two days apart,
    // arriving through the real sync and not flagged `is_transfer`.
    h.manualStore.append(CONN_A, {
      added: [
        manualTransaction({
          providerAccountId: CHECKING,
          providerTransactionId: 'soak-transfer-out',
          amount: money(-50_000n, 'USD'),
          postedDate: DateOnly.parse('2026-10-20'),
          name: 'CANARY-TRANSFER to savings',
        }),
        manualTransaction({
          providerAccountId: SAVINGS,
          providerTransactionId: 'soak-transfer-in',
          amount: money(50_000n, 'USD'),
          postedDate: DateOnly.parse('2026-10-22'),
          name: 'CANARY-TRANSFER from checking',
        }),
      ],
    });
    await syncConnection(h, connectionA);

    const dirty = await state(AS_OF);
    expect(dirty.kind).toBe('observing_since');
    if (dirty.kind === 'observing_since') {
      expect(dirty.note).toContain('2026-10 had 1 internal-transfer pair');
    }
    const dirtyResults = await executeSoakQueries(asPool(h), AS_OF);
    const residual = dirtyResults.find((r) => r.query.name === 'residual_transfer_pairs_by_month');
    expect(residual?.rows).toEqual([
      { calendar_month: '2026-10', residual_transfer_pair_count: 1n },
    ]);

    // The ledger does its job and flags the pair as an internal transfer: spend is clean again.
    await exec(
      h,
      sql`UPDATE transactions SET is_transfer = TRUE WHERE effective_name LIKE 'CANARY-TRANSFER%'`,
    );
    expect((await state(AS_OF)).kind).toBe('met');

    // Un-flag it, and an excluded-by-the-holder leg does not count either way: the criterion reads
    // the ledger's own spend predicate, not the raw rows.
    await exec(
      h,
      sql`UPDATE transactions SET is_transfer = FALSE WHERE effective_name LIKE 'CANARY-TRANSFER%'`,
    );
    expect((await state(AS_OF)).kind).toBe('observing_since');
    await exec(
      h,
      sql`UPDATE transactions SET user_excluded = TRUE WHERE effective_name LIKE 'CANARY-TRANSFER from%'`,
    );
    expect((await state(AS_OF)).kind).toBe('met');
    await exec(
      h,
      sql`UPDATE transactions SET user_excluded = FALSE WHERE effective_name LIKE 'CANARY-TRANSFER from%'`,
    );

    // The other computed criteria read the same seed.
    const all = evaluateCriteria({
      results: await executeSoakQueries(asPool(h), AS_OF),
      clockRows: [],
      asOfDate: AS_OF,
    });
    expect(all[1]?.kind).toBe('met'); // two connections, seven complete days each
    expect(all[9]?.kind).toBe('met'); // 3 accepted of 4 items across the first four Briefs
    expect(all[2]?.kind).toBe('observing_since'); // the planted pair is back
    expect(Object.keys(all)).toHaveLength(CRITERIA.length);

    // The canary holds with the planted pair in the ledger too.
    const { markdown } = await render();
    for (const canary of CANARIES) expect(markdown).not.toContain(canary);
  }, 120_000);

  it('the clock counts from the attested day one, a fallback resets it, and a week without an attestation prints as a gap', () => {
    // ISO weeks, including the year edges.
    expect(isoWeekOf('2026-10-12')).toBe('2026-W42');
    expect(isoWeekOf('2025-12-29')).toBe('2026-W01');
    expect(isoWeekOf('2027-01-01')).toBe('2026-W53');
    expect(isoWeekOf('2021-01-03')).toBe('2020-W53');
    expect(isoWeekOf('2026-11-09')).toBe('2026-W46');

    const clockFile = (rows: string[]) =>
      ['| Date | Event | Note |', '| --- | --- | --- |', ...rows].join('\n');
    const at = (day: string) => new Date(`${day}T12:00:00Z`);

    // No attestation at all: the clock has not started, and the week is a gap.
    const none = computeClockState(parseClockRows(clockFile([])), at('2026-10-20'));
    expect(none.dayNumber).toBeNull();
    expect(none.isGapWeek).toBe(true);

    // Counted from the attested day one: 2026-10-12 is day 1.
    const rows = parseClockRows(
      clockFile([
        '| 2026-10-12 | day_one | other tools retired |',
        '| 2026-10-14 | attest | all good |',
      ]),
    );
    expect(computeClockState(rows, at('2026-10-12')).dayNumber).toBe(1);
    expect(computeClockState(rows, at('2026-10-14')).dayNumber).toBe(3);
    expect(computeClockState(rows, at('2026-10-14')).isGapWeek).toBe(false);

    // A week with no attestation is a gap, never clean: 2026-W43 has none.
    const gap = computeClockState(rows, at('2026-10-20'));
    expect(gap.dayNumber).toBe(9);
    expect(gap.isGapWeek).toBe(true);
    const gapReport = renderSoakReport({
      results: [],
      clockRows: rows,
      asOfDate: at('2026-10-20'),
      assumptionsAsOfDates: null,
    });
    expect(gapReport).toContain('**Day 9 of 90**');
    expect(gapReport).toContain('| 2026-W42 | day_one 2026-10-12, attest 2026-10-14 |');
    expect(gapReport).toContain('| 2026-W43 | **GAP** -- no attestation |');
    expect(gapReport).toContain('GAP: no attestation is recorded for 2026-W43');
    // The assumptions file's age is "unknown", not "fresh", when it cannot be read.
    expect(gapReport).toContain('**Unknown**');

    // An upgrade row (bookkeeping) never attests a week and never resets or pauses.
    const withUpgrade = parseClockRows(
      clockFile([
        '| 2026-10-12 | day_one | x |',
        '| 2026-10-20 | upgrade | just upgrade at 0123456 |',
      ]),
    );
    const upgraded = computeClockState(withUpgrade, at('2026-10-21'));
    expect(upgraded.dayNumber).toBe(10);
    expect(upgraded.isGapWeek).toBe(true);

    // A fallback resets the clock to the fallback date.
    const fallback = parseClockRows(
      clockFile([
        '| 2026-10-12 | day_one | x |',
        '| 2026-10-21 | attest | x |',
        '| 2026-10-25 | fallback | used a spreadsheet for one purchase |',
      ]),
    );
    const reset = computeClockState(fallback, at('2026-10-27'));
    expect(reset.dayNumber).toBe(3);
    expect(reset.anchorDate).toBe('2026-10-25');
    expect(reset.anchorEvent).toBe('fallback');
    expect(reset.resetCount).toBe(1);
    expect(reset.isGapWeek).toBe(true); // 2026-10-27 is in W44; the fallback row attested W43, not W44
    expect(computeClockState(fallback, at('2026-10-25')).isGapWeek).toBe(false);

    // Data loss resets too; an outage over 24 h pauses; an outage of 24 h or less does not.
    const outages = parseClockRows(
      clockFile([
        '| 2026-10-12 | day_one | x |',
        '| 2026-10-20 | outage_start | host down |',
        '| 2026-10-23 | outage_end | host back |',
        '| 2026-10-25 | outage_start | brief |',
        '| 2026-10-26 | outage_end | back |',
      ]),
    );
    const paused = computeClockState(outages, at('2026-11-02'));
    expect(paused.pausedDays).toBe(3);
    expect(paused.dayNumber).toBe(22 - 3); // Oct 12 .. Nov 2 inclusive = 22 days, minus the 3-day pause
    const lost = computeClockState(
      parseClockRows(
        clockFile([
          '| 2026-10-12 | day_one | x |',
          '| 2026-10-30 | data_loss | restored from 3-day-old backup |',
        ]),
      ),
      at('2026-11-01'),
    );
    expect(lost.dayNumber).toBe(3);
    expect(lost.anchorEvent).toBe('data_loss');

    // Judged criteria come from `criterion` rows, the latest winning; computed ones cannot be overridden.
    const judged = evaluateCriteria({
      results: [],
      clockRows: parseClockRows(
        clockFile([
          '| 2026-10-12 | day_one | x |',
          '| 2026-11-02 | criterion | 3: observing - gold set half checked |',
          '| 2026-11-09 | criterion | 3: met - gold set matched my list |',
          '| 2026-11-09 | criterion | 2: met - I say so |',
        ]),
      ),
      asOfDate: at('2026-11-09'),
    });
    expect(judged[3]).toEqual({
      kind: 'met',
      date: '2026-11-09',
      evidence: 'gold set matched my list',
    });
    expect(judged[2]?.kind).toBe('not_started');
    expect(judged[11]).toEqual({ kind: 'observing_since', date: '2026-10-12' });

    // A hand-edited typo degrades to "fewer rows read" -- which then prints as a gap.
    expect(
      parseClockRows(clockFile(['| 2026-10-12 | dayone | x |', '| not a date | day_one | x |'])),
    ).toEqual([]);
  }, 30_000);
  /**
   * Not an assertion: the week-00 dry run (WP 9.1 evidence). With `SOAK_DRYRUN_OUT=<path>` set, renders the
   * report over this test's seeded database -- the real queries and the real renderer -- and writes it,
   * labelled as a dry run from seed. Skipped otherwise.
   */
  it.skipIf(process.env['SOAK_DRYRUN_OUT'] === undefined)(
    'emits the week-00 dry-run report from the seed',
    async () => {
      // The ledger has paired the planted transfer, as its transfer consumer would in production.
      await exec(
        h,
        sql`UPDATE transactions SET is_transfer = TRUE WHERE effective_name LIKE 'CANARY-TRANSFER%'`,
      );
      const results = await runSoakQueries(asPool(h), AS_OF);
      const clock = [
        '| 2026-10-12 | day_one | other tools retired (DRY RUN sample row) |',
        '| 2026-10-14 | attest | sample |',
        '| 2026-10-27 | attest | sample (2026-W43 and W44 left empty on purpose: they print as gaps) |',
        '| 2026-11-04 | attest | sample |',
        '| 2026-11-05 | criterion | 3: observing - sample judged line |',
      ].join('\n');
      const markdown = renderSoakReport({
        results,
        clockRows: parseClockRows(clock),
        asOfDate: AS_OF,
        assumptionsAsOfDates: ['2026-08-01'],
        label:
          "DRY RUN from seed -- NOT REAL DATA. Produced by apps/api/test/db/soak-report.test.ts over its planted seed (a manual connection synced through the real orchestrator plus rows inserted by SQL) to show the report's shape; every clock row above is a sample. Week 00 of the real soak is written by the orchestrator from production.",
      });
      for (const canary of CANARIES) expect(markdown).not.toContain(canary);
      writeFileSync(process.env['SOAK_DRYRUN_OUT'] ?? '', markdown, 'utf8');
    },
    60_000,
  );
});
