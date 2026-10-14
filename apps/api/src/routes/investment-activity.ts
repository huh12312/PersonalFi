// SPDX-License-Identifier: MIT
/**
 * `GET /investments/transactions` — the Investments screen's Activity tab
 * (WP 10.3).
 *
 * Plaid's `/transactions/sync` never covers an investment account; the
 * connector pulls `/investments/transactions/get` on every sync (orchestrator
 * leg `investment_txns`) and the rows land in `investment_transactions` through
 * the lot store. Until this route nothing listed them, so a 401(k) linked
 * through Plaid showed a balance and no activity at all.
 *
 * ## What a row says
 *
 * `kind` is `@ctx/investments`' `classifyActivity` — the same function the
 * performance route uses to decide what is an external flow — so the list and
 * the return can never disagree about whether a row was a contribution. `type`
 * (the house vocabulary) and `subtype` (the provider's own word, verbatim) are
 * carried beside it as evidence.
 *
 * ## Pagination: a keyset cursor over a bounded window
 *
 * Newest first, ordered `(trade_date DESC, id DESC)`. `nextCursor` is an
 * opaque token naming the last row returned; the next page is every row after
 * it in that order. The window (`from`..`to`, both inclusive; default the last
 * twelve months) is read in full for the account filter and classified in this
 * process, because `kind` is a function of `(type, subtype, amount)` and
 * re-stating that function in SQL would be a second classifier that agreed with
 * the first one right up until it did not. One holder's year of investment
 * activity is hundreds of rows, not millions; `MAX_WINDOW_ROWS` refuses a
 * window that is not (400, naming the limit) rather than reading it.
 *
 * ## "No activity" versus "not synced yet"
 *
 * `accounts[].activitySync` says, per account, whether the `investment_txns`
 * leg has ever completed (`sync_runs`, operation `investment_txns`). An empty
 * list for an account whose leg never ran is **pending**, not "no
 * transactions" — the UI must not say the second when it means the first.
 *
 * Scoped by `user_id` in the predicate of every table it reads.
 */
import { DateOnly, Money, Quantity, currency as toCurrency } from '@core/kernel';
import { ACTIVITY_KINDS, classifyActivity, type ActivityInput } from '@ctx/investments';
import { TRANSACTION_SOURCES } from '@ctx/investments/schema';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, problems } from '../problem.ts';
import { dateOnly, isoInstant, money } from '../wire.ts';
import type { RouteDeps } from './deps.ts';
import { investmentAccountsOf, todayFor } from './investments.ts';

/** The page size when none is asked for, and the most one request may ask for. */
export const DEFAULT_ACTIVITY_LIMIT = 50;
export const MAX_ACTIVITY_LIMIT = 200;
/** A window holding more rows than this is refused: narrow the dates or pick an account. */
export const MAX_WINDOW_ROWS = 20_000;

/**
 * The connectors whose manifest declares `investment_txns` (Plaid: WP 3.7;
 * Coinbase: WP 3.5). An account from any other provider gets its investment
 * activity by import or by hand, so "no sync has run" is not a state it can be
 * in — it is `not_applicable`.
 */
export const INVESTMENT_ACTIVITY_PROVIDERS = ['plaid', 'coinbase'] as const;

const ACTIVITY_SYNC_STATES = ['synced', 'pending', 'failed', 'not_applicable'] as const;
type ActivitySyncState = (typeof ACTIVITY_SYNC_STATES)[number];

const moneyWire = z.object({ minor: z.string(), currency: z.string().length(3) });

const activityWire = z
  .object({
    id: z.uuid(),
    accountId: z.uuid(),
    tradeDate: dateOnly,
    settleDate: dateOnly.nullable(),
    kind: z.enum(ACTIVITY_KINDS),
    type: z.string().describe('The house vocabulary the lot engine reads (`BUY`, `CASH`, …).'),
    subtype: z.string().nullable().describe('The provider’s own word, verbatim.'),
    name: z.string().nullable().describe('The provider’s description of the movement.'),
    security: z
      .object({ id: z.uuid(), symbol: z.string().nullable(), name: z.string().nullable() })
      .nullable()
      .describe(
        'null: the movement is about no security (cash, a fee, a deposit), or about one nobody ' +
          'could identify — then `unresolvedSecurity` is set.',
      ),
    unresolvedSecurity: z
      .object({ name: z.string().nullable(), symbol: z.string().nullable() })
      .nullable()
      .describe(
        'WP 10.4: the provider named a security the resolver could not identify. Its own name ' +
          'and ticker, verbatim. The movement is listed here and left out of lots and ' +
          'performance; its `kind` and `flow` are classified as for any other row.',
      ),
    quantity: z.string().describe('Signed as the provider reported it: negative on a disposal.'),
    price: z.string().nullable().describe('Unit price; null when nobody stated one.'),
    amount: moneyWire.describe('House sign: negative = cash left the account.'),
    flow: moneyWire
      .nullable()
      .describe(
        'For a contribution or withdrawal: the external flow the performance route measures ' +
          'against, positive = into the portfolio. A 401(k) payroll contribution arrives as a ' +
          'buy whose `amount` is the cash the buy spent; `flow` is the money that arrived. ' +
          'null for everything else, and for an in-kind transfer (valued only by the ' +
          'performance route, at the transfer date).',
      ),
    fees: moneyWire.describe('A magnitude.'),
    source: z.enum(TRANSACTION_SOURCES),
  })
  .meta({ id: 'InvestmentActivity' });

const accountSyncWire = z
  .object({
    accountId: z.uuid(),
    name: z.string(),
    provider: z.string(),
    activitySync: z
      .enum(ACTIVITY_SYNC_STATES)
      .describe(
        '`synced`: the investment-activity leg has completed at least once. `pending`: it has ' +
          'not run yet (an empty list is not "no activity"). `failed`: it ran and never ' +
          'completed. `not_applicable`: activity for this account arrives by import or by hand.',
      ),
    lastSyncedAt: isoInstant.nullable(),
  })
  .meta({ id: 'InvestmentActivityAccount' });

/** `?kind=dividend` or `?kind=dividend&kind=interest`. */
const kindQuery = z
  .union([z.enum(ACTIVITY_KINDS), z.array(z.enum(ACTIVITY_KINDS))])
  .optional()
  .transform((value): readonly (typeof ACTIVITY_KINDS)[number][] =>
    value === undefined ? [] : Array.isArray(value) ? value : [value],
  );

interface ActivityRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  security_id: string | null;
  trade_date: string;
  settle_date: string | null;
  type: string;
  subtype: string | null;
  name: string | null;
  quantity: string;
  price: string | null;
  amount_minor: string | bigint;
  fees_minor: string | bigint;
  currency: string;
  source: (typeof TRANSACTION_SOURCES)[number];
  ticker: string | null;
  security_name: string | null;
  security_unresolved: boolean;
  provider_security_name: string | null;
  provider_ticker: string | null;
}

interface Cursor {
  readonly date: string;
  readonly id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.date}|${cursor.id}`, 'utf8').toString('base64url');
}

function decodeCursor(token: string): Cursor {
  const text = Buffer.from(token, 'base64url').toString('utf8');
  const [date = '', id = ''] = text.split('|');
  if (!DateOnly.is(date) || !/^[0-9a-f-]{36}$/u.test(id)) {
    throw new AppError({
      status: 400,
      code: 'investments.invalid_cursor',
      title: 'Bad Request',
      detail: 'the cursor is not one this route issued',
      family: 'user',
    });
  }
  return { date, id };
}

/** `(date DESC, id DESC)`: does `row` come strictly after `cursor`? */
function isAfter(row: { tradeDate: string; id: string }, cursor: Cursor): boolean {
  return row.tradeDate < cursor.date || (row.tradeDate === cursor.date && row.id < cursor.id);
}

export const investmentActivityRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database } = deps;

  return async (app) => {
    app.get(
      '/investments/transactions',
      {
        schema: {
          operationId: 'listInvestmentTransactions',
          summary: 'Investment activity: buys, sells, dividends, contributions, fees',
          description:
            'Every investment movement in the window, newest first, with the kind the ' +
            'performance route classifies it as (`classifyActivity`): a contribution here is ' +
            'exactly an external flow there. `from`/`to` are inclusive and default to the last ' +
            'twelve months. Keyset pagination: pass `nextCursor` back as `cursor`. ' +
            '`accounts[].activitySync` distinguishes an account whose activity has not been ' +
            'synced yet from one that has none (WP 10.3).',
          tags: ['investments'],
          querystring: z.object({
            from: dateOnly.optional(),
            to: dateOnly.optional(),
            account: z.uuid().optional(),
            kind: kindQuery,
            cursor: z.string().max(200).optional(),
            limit: z.coerce.number().int().min(1).max(MAX_ACTIVITY_LIMIT).optional(),
          }),
          response: {
            200: z.object({
              from: dateOnly,
              to: dateOnly,
              items: z.array(activityWire),
              nextCursor: z.string().nullable(),
              total: z
                .int()
                .nonnegative()
                .describe('Rows matching the filters in the window, across every page.'),
              accounts: z.array(accountSyncWire),
            }),
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const userId = session.userId;
        const query = request.query;

        const to = query.to ?? (await todayFor(deps));
        if (!DateOnly.is(to) || (query.from !== undefined && !DateOnly.is(query.from))) {
          throw new AppError({
            status: 400,
            code: 'investments.invalid_period',
            title: 'Bad Request',
            detail: 'from and to must be calendar dates that exist',
            family: 'user',
          });
        }
        const toDate = DateOnly.parse(to);
        const fromDate =
          query.from === undefined
            ? DateOnly.addDays(DateOnly.addMonths(toDate, -12), 1)
            : DateOnly.parse(query.from);
        if (DateOnly.compare(fromDate, toDate) > 0) {
          throw new AppError({
            status: 400,
            code: 'investments.invalid_period',
            title: 'Bad Request',
            detail: '`from` must not be later than `to`',
            family: 'user',
          });
        }
        const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
        const limit = query.limit ?? DEFAULT_ACTIVITY_LIMIT;

        const universe = await investmentAccountsOf(database, userId);
        const scoped =
          query.account === undefined
            ? universe
            : universe.filter((account) => account.id === query.account);
        if (query.account !== undefined && scoped.length === 0) {
          throw new AppError({
            status: 404,
            code: 'investments.account_not_found',
            title: 'Not Found',
            detail: 'no investment account with that id',
            family: 'user',
          });
        }
        const accountFilter =
          query.account === undefined ? sql`TRUE` : sql`t.account_id = ${query.account}::uuid`;

        const result = await database.execute<ActivityRow>(sql`
          SELECT t.id,
                 t.account_id,
                 t.security_id,
                 to_char(t.trade_date, 'YYYY-MM-DD')  AS trade_date,
                 to_char(t.settle_date, 'YYYY-MM-DD') AS settle_date,
                 t.type,
                 t.subtype,
                 t.name,
                 t.quantity,
                 t.price,
                 t.amount_minor,
                 t.fees_minor,
                 t.currency,
                 t.source,
                 s.ticker,
                 COALESCE(o.name, s.name) AS security_name,
                 t.security_unresolved,
                 t.provider_security_name,
                 t.provider_ticker
            FROM investment_transactions t
            LEFT JOIN securities s
              ON s.id = t.security_id AND s.user_id = ${userId}::uuid
            LEFT JOIN security_overlay o
              ON o.security_id = t.security_id AND o.user_id = ${userId}::uuid
           WHERE t.user_id = ${userId}::uuid
             AND ${accountFilter}
             AND t.trade_date >= ${fromDate}::date
             AND t.trade_date <= ${toDate}::date
           ORDER BY t.trade_date DESC, t.id DESC
           LIMIT ${MAX_WINDOW_ROWS + 1}
        `);
        if (result.rows.length > MAX_WINDOW_ROWS) {
          throw new AppError({
            status: 400,
            code: 'investments.window_too_large',
            title: 'Bad Request',
            detail: `more than ${String(MAX_WINDOW_ROWS)} movements in that window; narrow the dates or pick an account`,
            family: 'user',
          });
        }

        const kinds = new Set(query.kind);
        const matching = result.rows
          .map((row) => {
            const code = toCurrency(row.currency.trim());
            const quantity = Quantity.fromDatabaseString(String(row.quantity));
            const amount = Money.of(BigInt(row.amount_minor), code);
            const fees = Money.of(BigInt(row.fees_minor), code);
            const input: ActivityInput = {
              type: row.type,
              subtype: row.subtype,
              amount,
              fees,
              quantity,
              securityId: row.security_id,
            };
            const classified = classifyActivity(input);
            return {
              id: row.id,
              accountId: row.account_id,
              tradeDate: String(row.trade_date).slice(0, 10),
              settleDate: row.settle_date === null ? null : String(row.settle_date).slice(0, 10),
              kind: classified.kind,
              type: row.type,
              subtype: row.subtype,
              name: row.name,
              security:
                row.security_id === null
                  ? null
                  : { id: row.security_id, symbol: row.ticker, name: row.security_name },
              unresolvedSecurity: row.security_unresolved
                ? { name: row.provider_security_name, symbol: row.provider_ticker }
                : null,
              quantity: Quantity.toDatabaseString(quantity),
              price:
                row.price === null
                  ? null
                  : Quantity.toDatabaseString(Quantity.fromDatabaseString(String(row.price))),
              amount: money(amount),
              flow: classified.flow === null ? null : money(classified.flow),
              fees: money(fees),
              source: row.source,
            };
          })
          .filter((item) => kinds.size === 0 || kinds.has(item.kind));

        const remaining =
          cursor === null ? matching : matching.filter((item) => isAfter(item, cursor));
        const page = remaining.slice(0, limit);
        const last = page[page.length - 1];
        const nextCursor =
          remaining.length > limit && last !== undefined
            ? encodeCursor({ date: last.tradeDate, id: last.id })
            : null;

        return {
          from: fromDate,
          to: toDate,
          items: page,
          nextCursor,
          total: matching.length,
          accounts: await activitySyncOf(deps, userId, scoped),
        };
      },
    );
  };
};

interface SyncRow extends Record<string, unknown> {
  connection_id: string;
  succeeded_at: Date | string | null;
  any_failed: boolean;
}

/** Per account: has its connection's `investment_txns` leg ever completed? */
async function activitySyncOf(
  deps: RouteDeps,
  userId: string,
  accounts: readonly {
    readonly id: string;
    readonly name: string;
    readonly provider: string;
    readonly connectionId: string | null;
  }[],
): Promise<
  {
    accountId: string;
    name: string;
    provider: string;
    activitySync: ActivitySyncState;
    lastSyncedAt: string | null;
  }[]
> {
  const result = await deps.database.execute<SyncRow>(sql`
    SELECT r.connection_id,
           max(r.finished_at) FILTER (WHERE r.status IN ('success', 'partial')) AS succeeded_at,
           bool_or(r.status = 'failed') AS any_failed
      FROM sync_runs r
     WHERE r.user_id = ${userId}::uuid
       AND r.operation = 'investment_txns'
     GROUP BY r.connection_id
  `);
  const byConnection = new Map(result.rows.map((row) => [row.connection_id, row]));
  const supported = new Set<string>(INVESTMENT_ACTIVITY_PROVIDERS);

  return accounts.map((account) => {
    const run = account.connectionId === null ? undefined : byConnection.get(account.connectionId);
    const succeededAt =
      run?.succeeded_at === null || run?.succeeded_at === undefined
        ? null
        : new Date(run.succeeded_at).toISOString();
    const state: ActivitySyncState =
      succeededAt !== null
        ? 'synced'
        : !supported.has(account.provider)
          ? 'not_applicable'
          : run?.any_failed === true
            ? 'failed'
            : // Never run, or the first run still in flight.
              'pending';
    return {
      accountId: account.id,
      name: account.name,
      provider: account.provider,
      activitySync: state,
      lastSyncedAt: succeededAt,
    };
  });
}
