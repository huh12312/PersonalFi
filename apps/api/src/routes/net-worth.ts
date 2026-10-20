// SPDX-License-Identifier: MIT
/**
 * `/net-worth/series` and `/net-worth/corrections` — the chart, and the only
 * honest way to change a day that has closed.
 *
 * WP 3.9 over WP 3.8. `GET /net-worth` (in `accounts.ts`) is *now*, per
 * currency, from `@ctx/ledger`. This file is *over time*, from
 * `@ctx/planning`'s `net_worth_daily` read model, and the two differences are
 * the whole reason it exists:
 *
 *   * **The series is gapless and a day with no data is `null`, not zero.**
 *     `readSeries` joins against the migration's own
 *     `net_worth_calendar_spine(...)` function, so "the series has no gaps" is a
 *     property of the database rather than of a range this route built. A `null`
 *     total says the day existed and had no data, which is not the same claim as
 *     "net worth was nothing".
 *   * **Sealed days are visually distinct, so the response labels them.** 08
 *     §3.5: a day is sealed after it closes and is never updated. `sealed`,
 *     `revision`, `source` and `stalePrice` all travel on the row, because WP
 *     3.12's chart has to draw sealed history differently from today's live row
 *     and cannot infer any of them.
 *
 * ## A correction is a decision, and it needs a step-up assertion
 *
 * `POST /net-worth/corrections` calls `@ctx/planning`'s `correctDay`, which
 * **inserts a new revision carrying `supersedes_id` and a mandatory
 * `correction_reason`** and never writes to the row it supersedes. That is what
 * makes `'a past date is byte-identical after a second snapshot run'` a
 * byte-comparison rather than a number compared to itself.
 *
 * It is a `requireFreshSession` route. Not because it writes a credential — it
 * does not — but because it is the one HTTP path in the application that can
 * change what a *closed* day says, and `snapshot.ts`'s own comment is explicit
 * that nothing calls it on a schedule because "a correction is a decision".
 *
 * ## Why `planningPortsFor` and not a local reader
 *
 * `net_worth_daily` lives in `@ctx/planning` and **every one of its inputs
 * belongs to somebody else**; `pnpm lint:schema-ownership` refuses any SQL in
 * that package naming `accounts`, `holdings`, `prices` or `fx_rates`. The four
 * ports are satisfied in `domain.ts` and nowhere else, so this route asks for
 * them there rather than growing a fifth copy.
 */
import { newId } from '@core/kernel';
import { listAccounts } from '@ctx/ledger';
import {
  InterpolationRefused,
  NET_WORTH_BUCKETINGS,
  NET_WORTH_SEGMENT_KINDS,
  SealedRowImmutable,
  SNAPSHOT_JOB_KIND,
  correctDay,
  dismissMilestones,
  isFxRateUnavailable,
  listUndismissedMilestones,
  readNetWorthBuckets,
  readSeries,
  type NetWorthBucketing,
  type PlanningExecutor,
  type SegmentAccountLookup,
} from '@ctx/planning';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { planningPortsFor } from '../domain.ts';
import { AppError, problems } from '../problem.ts';
import { dateOnly } from '../wire.ts';
import type { RouteDeps } from './deps.ts';
import { todayFor } from './investments.ts';

/** A year, which is what a chart opens on when the caller names no window. */
const DEFAULT_SERIES_DAYS = 365;

/** The widest window the spine will be materialised over. Ten years of days. */
const MAX_SERIES_DAYS = 3653;

interface DetailRow extends Record<string, unknown> {
  as_of_date: string;
  revision: number;
  base_currency: string;
  assets_minor: string | bigint;
  liabilities_minor: string | bigint;
  net_worth_minor: string | bigint;
  liquid_minor: string | bigint;
  investable_minor: string | bigint;
  on_budget_minor: string | bigint;
  source: string;
  stale_price: boolean;
  dirty: boolean;
  sealed_at: Date | string | null;
  accounts_counted: number;
  accounts_unvalued: number;
  correction_reason: string | null;
}

/**
 * The current revision of every day that *has* one, in the window.
 *
 * Read beside `readSeries` rather than instead of it: `readSeries` owns the
 * gapless spine (and the guarantee that a missing day is `null`), and this adds
 * the four 07 §4.1 totals, the seal, the revision and the staleness flag, which
 * a chart needs and the series read model deliberately does not carry. Joining
 * the two here keeps `@ctx/planning`'s reader unchanged.
 */
async function readDetail(
  executor: PlanningExecutor,
  userId: string,
  from: string,
  to: string,
): Promise<ReadonlyMap<string, DetailRow>> {
  const result = await executor.execute<DetailRow>(sql`
    SELECT DISTINCT ON (as_of_date)
           to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date,
           revision, base_currency, assets_minor, liabilities_minor, net_worth_minor,
           liquid_minor, investable_minor, on_budget_minor, source, stale_price, dirty,
           sealed_at, accounts_counted, accounts_unvalued, correction_reason
      FROM net_worth_daily
     WHERE user_id = ${userId}::uuid
       AND as_of_date >= ${from}::date
       AND as_of_date <= ${to}::date
     ORDER BY as_of_date, revision DESC
  `);
  return new Map(result.rows.map((row) => [String(row.as_of_date).slice(0, 10), row]));
}

// ---------------------------------------------------------------------------
// C-9 (gate-security-review.md G3-12): a missing FX rate is refused
// correctly at write time, but until now nothing on screen said so — the
// nightly snapshot job retried silently and the chart just kept the last
// written day.
// ---------------------------------------------------------------------------

export interface SnapshotFxFailure {
  /** `FxRateUnavailable`'s own message — names the pair and the date (`@ctx/investments`' `fx.ts`). */
  readonly message: string;
  readonly occurredAt: string;
}

interface JobLastErrorRow {
  last_error: { name?: string; message?: string } | null;
  updated_at: Date;
}

/**
 * Whether the most recent attempt at `planning.net_worth_snapshot` failed on
 * a missing FX rate — read from `jobs` (a `@core/platform` table) directly
 * rather than adding a reader to `@ctx/planning`: `last_error` is already
 * the durable "did the last attempt fail, and why" for *any* job kind
 * (`packages/platform/src/jobs/runner.ts`'s `finish` clears it to `NULL` on
 * success and sets it on every failed or still-retrying attempt), so a
 * planning-owned copy of the same fact would be a second, driftable one.
 *
 * The schedule enqueues a fresh `jobs` row each firing (WP 3.8's
 * `registerNetWorthSnapshotSchedule`), so "most recent by `created_at`" is
 * last night's attempt, not a stale failure from weeks ago that has since
 * succeeded — a `NULL` `last_error` on the latest row means the most recent
 * attempt was clean, regardless of how many nights before it failed.
 */
async function readLastSnapshotFxFailure(
  pool: RouteDeps['pool'],
  userId: string,
): Promise<SnapshotFxFailure | null> {
  const result = await pool.query<JobLastErrorRow>(
    `SELECT last_error, updated_at
       FROM jobs
      WHERE kind = $1 AND user_id = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [SNAPSHOT_JOB_KIND, userId],
  );
  const row = result.rows[0];
  if (row === undefined || row.last_error === null || row.last_error.name !== 'FxRateUnavailable') {
    return null;
  }
  return {
    message:
      typeof row.last_error.message === 'string'
        ? row.last_error.message
        : 'a scheduled net worth snapshot failed on a missing FX rate',
    occurredAt: new Date(row.updated_at).toISOString(),
  };
}

const snapshotFxFailureWire = z
  .object({ message: z.string(), occurredAt: z.string() })
  .meta({ id: 'SnapshotFxFailure' });

/** A positive decimal string — `\d*\.?\d+` alone also accepts "0" and "0.00", neither a rate. */
function isPositiveDecimalString(value: string): boolean {
  return /^\d*\.?\d+$/u.test(value) && /[1-9]/u.test(value);
}

const moneyWire = z.object({ minor: z.string(), currency: z.string().length(3) });

const seriesPointWire = z
  .object({
    asOfDate: dateOnly,
    /**
     * `null` on a day with no row. **Not zero** — the chart must draw a gap and
     * not a crash to the axis.
     */
    netWorth: moneyWire.nullable(),
    assets: moneyWire.nullable(),
    liabilities: moneyWire.nullable(),
    liquid: moneyWire.nullable(),
    investable: moneyWire.nullable(),
    onBudget: moneyWire.nullable(),
    /** 08 §3.5: sealed history is drawn differently from today's live row. */
    sealed: z.boolean(),
    sealedAt: z.string().nullable(),
    revision: z.int().nonnegative(),
    /** `observed`, `interpolated` or `corrected`. Interpolated days are labelled. */
    source: z.string().nullable(),
    /** 08 §3.7: the day was sealed with a price older than 24 hours. */
    stalePrice: z.boolean(),
    dirty: z.boolean(),
    accountsCounted: z.int().nonnegative().nullable(),
    accountsUnvalued: z.int().nonnegative().nullable(),
    correctionReason: z.string().nullable(),
  })
  .meta({ id: 'NetWorthSeriesPoint' });

/**
 * WP 10.13 (V6): one bucket of the stacked chart — the closing snapshot day's figure and its segments by
 * account type (`@ctx/planning`'s `buckets.ts` states the rule). Σ `segments[].amount` = `netWorth`, and
 * `netWorth` equals `points[]`' value on `asOfDate`, for every bucket (asserted in the api-db test).
 */
const bucketWire = z
  .object({
    /** First and last calendar day of the bucket, cut at the window's edges. */
    start: dateOnly,
    end: dateOnly,
    /** The closing snapshot day; `null` when the bucket has no snapshot (a gap, never a zero). */
    asOfDate: dateOnly.nullable(),
    netWorth: moneyWire.nullable(),
    segments: z.array(
      z.object({
        kind: z.enum(NET_WORTH_SEGMENT_KINDS),
        /** Signed: liabilities are negative and drawn below the zero line. */
        amount: moneyWire,
        accounts: z.int().nonnegative(),
      }),
    ),
    /** The closing day's seal: `false` is today's live row, which may still change. */
    sealed: z.boolean(),
    source: z.string().nullable(),
  })
  .meta({ id: 'NetWorthBucket' });

const milestoneWire = z
  .object({
    id: z.uuid(),
    /** The round figure crossed; zero is the zero line. */
    milestone: moneyWire,
    direction: z.enum(['up', 'down']),
    crossedOn: dateOnly,
    previous: moneyWire,
    latest: moneyWire,
  })
  .meta({ id: 'NetWorthMilestone' });

export const netWorthRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;

  /** D6: one holder, and their zone is what a local calendar day means. */
  const timezoneOf = async (): Promise<string> => {
    const rows = await deps.pool.query<{ display_timezone: string }>(
      `SELECT display_timezone FROM users ORDER BY created_at, id LIMIT 1`,
    );
    return rows.rows[0]?.display_timezone ?? 'UTC';
  };

  /**
   * The bucketed segments (WP 10.13): one read of `net_worth_daily` in `@ctx/planning`, with the ledger's
   * account type and subtype handed in so crypto and property can be told apart from the breakdown's
   * valuation class. The ledger read is the accounts list, not the snapshots.
   */
  const readBucketsFor = async (
    userId: string,
    from: string,
    to: string,
    bucketing: NetWorthBucketing,
  ) => {
    const accounts = await listAccounts(database, { userId, includeClosed: true });
    const accountLookup: SegmentAccountLookup = new Map(
      accounts.map((account) => [account.id, { type: account.type, subtype: account.subtype }]),
    );
    return readNetWorthBuckets(database, { userId, from, to, bucketing, accounts: accountLookup });
  };

  return async (app) => {
    app.get(
      '/net-worth/series',
      {
        schema: {
          operationId: 'getNetWorthSeries',
          summary: 'Net worth per day over a window, gapless, with the seal on every row',
          description:
            'One row per calendar day between `from` and `to`, from the migration’s own spine ' +
            'function — a day with no data comes back with `null` totals rather than being ' +
            'absent, because "we did not know" and "it was zero" are different facts. `sealed`, ' +
            '`revision`, `source` and `stalePrice` are fields: a chart cannot infer any of them. ' +
            '`lastSnapshotFailure` (C-9, G3-12) is non-null exactly when the most recent nightly ' +
            'snapshot attempt failed on a missing FX rate — 08 §6.6’s manual-entry affordance is ' +
            '`POST /net-worth/fx-rates`.',
          tags: ['planning'],
          querystring: z.object({
            from: dateOnly.optional(),
            to: dateOnly.optional(),
            /**
             * WP 10.13: also return `buckets` — the window cut into days, ISO weeks (Monday–Sunday) or
             * calendar months, each with its closing day's figure and segments by account type.
             */
            bucket: z.enum(NET_WORTH_BUCKETINGS).optional(),
          }),
          response: {
            200: z.object({
              from: dateOnly,
              to: dateOnly,
              baseCurrency: z.string().length(3),
              points: z.array(seriesPointWire),
              lastSnapshotFailure: snapshotFxFailureWire.nullable(),
              /** The bucketing asked for, or `null` when `bucket` was not given. */
              bucketing: z.enum(NET_WORTH_BUCKETINGS).nullable(),
              /** `null` when `bucket` was not given; otherwise every bucket in the window, oldest first. */
              buckets: z.array(bucketWire).nullable(),
            }),
            ...problems(400, 401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const to = request.query.to ?? (await todayFor(deps));
        const from =
          request.query.from ??
          new Date(Date.parse(`${to}T00:00:00Z`) - (DEFAULT_SERIES_DAYS - 1) * 86_400_000)
            .toISOString()
            .slice(0, 10);

        const span = Math.round(
          (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
        );
        if (span < 0) {
          throw new AppError({
            status: 400,
            code: 'planning.invalid_window',
            title: 'Bad Request',
            detail: '`to` must not be earlier than `from`',
            family: 'user',
          });
        }
        if (span > MAX_SERIES_DAYS) {
          throw new AppError({
            status: 400,
            code: 'planning.window_too_wide',
            title: 'Bad Request',
            detail: `a series spans at most ${String(MAX_SERIES_DAYS)} days; asked for ${String(span)}`,
            family: 'user',
          });
        }

        const bucketing: NetWorthBucketing | null = request.query.bucket ?? null;
        const [spine, detail, lastSnapshotFailure, buckets] = await Promise.all([
          readSeries(database, { userId: session.userId, from, to }),
          readDetail(database, session.userId, from, to),
          readLastSnapshotFxFailure(deps.pool, session.userId),
          bucketing === null
            ? Promise.resolve(null)
            : readBucketsFor(session.userId, from, to, bucketing),
        ]);

        // `base_currency` is per row. The window's currency is whatever the
        // rows agree on; with no rows at all there is nothing to report but the
        // deployment default, and saying so beats inventing a row.
        const currencies = new Set([...detail.values()].map((row) => row.base_currency.trim()));
        const baseCurrency = currencies.size === 1 ? [...currencies][0] : 'USD';

        const asMoney = (
          minor: string | bigint | undefined,
          code: string,
        ): { minor: string; currency: string } | null =>
          minor === undefined ? null : { minor: String(minor), currency: code };

        return {
          from,
          to,
          baseCurrency: baseCurrency ?? 'USD',
          points: spine.map((point) => {
            const row = detail.get(point.asOfDate);
            const code = row?.base_currency.trim() ?? baseCurrency ?? 'USD';
            return {
              asOfDate: point.asOfDate,
              // From `readSeries`, not from `detail`: the spine read model is
              // the one `@ctx/planning` publishes for a chart, and taking the
              // headline number from anywhere else would let the two drift.
              netWorth:
                point.netWorthMinor === null
                  ? null
                  : { minor: point.netWorthMinor.toString(), currency: code },
              assets: asMoney(row?.assets_minor, code),
              liabilities: asMoney(row?.liabilities_minor, code),
              liquid: asMoney(row?.liquid_minor, code),
              investable: asMoney(row?.investable_minor, code),
              onBudget: asMoney(row?.on_budget_minor, code),
              sealed: row?.sealed_at != null,
              sealedAt: row?.sealed_at == null ? null : new Date(row.sealed_at).toISOString(),
              revision: row?.revision ?? 0,
              source: row?.source ?? null,
              stalePrice: row?.stale_price ?? false,
              dirty: row?.dirty ?? false,
              accountsCounted: row?.accounts_counted ?? null,
              accountsUnvalued: row?.accounts_unvalued ?? null,
              correctionReason: row?.correction_reason ?? null,
            };
          }),
          lastSnapshotFailure,
          bucketing,
          buckets:
            buckets === null
              ? null
              : buckets.map((bucket) => {
                  const row = bucket.asOfDate === null ? undefined : detail.get(bucket.asOfDate);
                  const code = bucket.currency ?? baseCurrency ?? 'USD';
                  return {
                    start: bucket.start,
                    end: bucket.end,
                    asOfDate: bucket.asOfDate,
                    netWorth:
                      bucket.netWorthMinor === null
                        ? null
                        : { minor: bucket.netWorthMinor.toString(), currency: code },
                    segments: bucket.segments.map((segment) => ({
                      kind: segment.kind,
                      amount: { minor: segment.amountMinor.toString(), currency: code },
                      accounts: segment.accounts,
                    })),
                    sealed: row?.sealed_at != null,
                    source: row?.source ?? null,
                  };
                }),
        };
      },
    );

    app.get(
      '/net-worth/milestones',
      {
        schema: {
          operationId: 'listNetWorthMilestones',
          summary: 'Round net-worth figures crossed and not yet dismissed, newest first',
          description:
            'WP 10.13: written by the snapshotter when the latest net worth crosses $10k, $25k, $50k, ' +
            '$100k or a further $100k going up, or the zero line either way — once per holder per ' +
            'milestone, ever. The dashboard shows the newest as a one-line notice until dismissed.',
          tags: ['planning'],
          response: {
            200: z.object({ milestones: z.array(milestoneWire) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const milestones = await listUndismissedMilestones(database, session.userId);
        return {
          milestones: milestones.map((milestone) => ({
            id: milestone.id,
            milestone: {
              minor: milestone.milestoneMinor.toString(),
              currency: milestone.currency,
            },
            direction: milestone.direction,
            crossedOn: milestone.crossedOn,
            previous: { minor: milestone.previousMinor.toString(), currency: milestone.currency },
            latest: { minor: milestone.latestMinor.toString(), currency: milestone.currency },
          })),
        };
      },
    );

    app.post(
      '/net-worth/milestones/dismiss',
      {
        schema: {
          operationId: 'dismissNetWorthMilestones',
          summary: 'Dismiss milestone notices; a dismissed milestone is never shown again',
          tags: ['planning'],
          body: z.object({ ids: z.array(z.uuid()).min(1).max(100) }),
          response: {
            200: z.object({ dismissed: z.int().nonnegative() }),
            ...problems(400, 401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const dismissed = await dismissMilestones(database, {
          userId: session.userId,
          ids: request.body.ids,
          clock,
        });
        return { dismissed };
      },
    );

    app.post(
      '/net-worth/fx-rates',
      {
        schema: {
          operationId: 'setManualFxRate',
          summary:
            '08 §6.6’s manual-entry affordance: enter an FX rate the scheduled job could not fetch',
          description:
            'Writes `fx_rates` with `source: "user_override"` — already ranked ahead of any ' +
            'provider on the same date by `drizzleFxStore`’s own read order (a rate the user ' +
            'typed in meant it; a later provider fetch for the same day must not silently ' +
            'overwrite it). Needs a fresh session for the reason `POST /net-worth/corrections` ' +
            'does: the very next snapshot retry can use this rate to recompute a day whose ' +
            'total the user will see change.',
          tags: ['planning'],
          body: z.object({
            base: z.string().length(3),
            quote: z.string().length(3),
            rateDate: dateOnly,
            rate: z
              .string()
              .describe('A positive decimal string, e.g. "1.0842". Never a JSON number (D3).'),
          }),
          response: {
            200: z.object({
              base: z.string().length(3),
              quote: z.string().length(3),
              rateDate: dateOnly,
              rate: z.string(),
            }),
            ...problems(400, 401, 403, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const base = request.body.base.trim().toUpperCase();
        const quote = request.body.quote.trim().toUpperCase();
        if (!/^[A-Z]{3}$/u.test(base) || !/^[A-Z]{3}$/u.test(quote)) {
          throw new AppError({
            status: 400,
            code: 'planning.fx_rate_bad_currency',
            title: 'Bad Request',
            detail: 'base and quote must each be a 3-letter ISO-4217 alphabetic code',
            family: 'user',
          });
        }
        if (base === quote) {
          throw new AppError({
            status: 400,
            code: 'planning.fx_rate_same_currency',
            title: 'Bad Request',
            detail: 'base and quote must differ (fx_rates_is_a_real_pair)',
            family: 'user',
          });
        }
        if (!isPositiveDecimalString(request.body.rate)) {
          throw new AppError({
            status: 400,
            code: 'planning.fx_rate_not_positive',
            title: 'Bad Request',
            detail: `${JSON.stringify(request.body.rate)} is not a positive decimal (fx_rates_rate_is_positive)`,
            family: 'user',
          });
        }

        await database.execute(sql`
          INSERT INTO fx_rates (
            id, user_id, base_currency, quote_currency, rate_date, source, rate, observed_at
          ) VALUES (
            ${newId()}::uuid, ${session.userId}::uuid, ${base}, ${quote},
            ${request.body.rateDate}::date, 'user_override', ${request.body.rate}::numeric, now()
          )
          ON CONFLICT (user_id, base_currency, quote_currency, rate_date, source) DO UPDATE SET
            rate = excluded.rate,
            observed_at = now(),
            updated_at = now()
        `);

        return { base, quote, rateDate: request.body.rateDate, rate: request.body.rate };
      },
    );

    app.post(
      '/net-worth/corrections',
      {
        schema: {
          operationId: 'correctNetWorthDay',
          summary: 'Recompute one closed day and write the result as a new revision',
          description:
            'Needs a step-up assertion. The sealed row is **never written to**: `correctDay` ' +
            'inserts the next revision carrying `supersedes_id` and a mandatory ' +
            '`correction_reason`, so the app can still answer "what did we show on the 14th?" ' +
            'after the 14th has been corrected. A missing FX rate is a 409 naming the pair, ' +
            'never a conversion at par (D4).',
          tags: ['planning'],
          body: z.object({
            asOfDate: dateOnly,
            reason: z
              .string()
              .min(1, 'a correction nobody can explain is indistinguishable from a bug'),
          }),
          response: {
            200: z.object({
              asOfDate: dateOnly,
              revision: z.int().positive(),
              netWorth: moneyWire,
              source: z.string(),
              stalePrice: z.boolean(),
              accountsCounted: z.int().nonnegative(),
              accountsUnvalued: z.int().nonnegative(),
            }),
            ...problems(400, 401, 403, 404, 409, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const timeZone = await timezoneOf();
        const baseCurrency = 'USD';

        try {
          // One transaction: the recomputation, the new revision and
          // `planning.NetWorthSnapshotTaken` are one atomic fact, or a
          // notification rule hears about a correction that rolled back.
          const result = await database.transaction(async (tx) =>
            correctDay(
              tx,
              planningPortsFor(tx, { userId: session.userId, timeZone, clock }),
              {
                userId: session.userId,
                clock,
                timeZone,
                baseCurrency,
                correlationId: String(request.id),
              },
              { asOfDate: request.body.asOfDate, reason: request.body.reason },
            ),
          );
          return {
            asOfDate: result.asOfDate,
            revision: result.revision,
            netWorth: { minor: result.netWorthMinor.toString(), currency: baseCurrency },
            source: result.source,
            stalePrice: result.stalePrice,
            accountsCounted: result.accountsCounted,
            accountsUnvalued: result.accountsUnvalued,
          };
        } catch (error) {
          if (error instanceof SealedRowImmutable) {
            throw new AppError({
              status: 404,
              code: 'planning.day_not_found',
              title: 'Not Found',
              detail: `there is no revision of ${request.body.asOfDate} to supersede`,
              family: 'user',
            });
          }
          // The exported predicate rather than `instanceof`: a class identity
          // check across two copies of a module is the failure that turns a
          // 409 into a 500 at the worst possible moment.
          if (isFxRateUnavailable(error)) {
            // D4 and 08 §6.6, on the wire: the day is not written, and the
            // response names the pair rather than reporting a total converted
            // at a rate nobody observed.
            throw new AppError({
              status: 409,
              code: 'planning.fx_rate_missing',
              title: 'Conflict',
              detail: error.message,
              family: 'domain',
            });
          }
          if (error instanceof InterpolationRefused) {
            throw new AppError({
              status: 409,
              code: 'planning.interpolation_refused',
              title: 'Conflict',
              detail: error.message,
              family: 'domain',
            });
          }
          throw error;
        }
      },
    );
  };
};
