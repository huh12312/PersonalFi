// SPDX-License-Identifier: MIT
/**
 * `/accounts` and `/net-worth` — what money sits in, and what it adds up to.
 *
 * Two things here are load-bearing and neither is obvious from the shapes:
 *
 * **Every balance answers "as of when?".** 04 §4.5 asks for data freshness to be
 * tracked per account and surfaced, and 05 §4.4 turns that into a UI rule: an
 * account whose institution needs re-authentication shows its *last known*
 * balance with an "as of" caption, and is neither hidden nor zeroed — "net worth
 * doesn't lie by omission". So `balance` carries `asOf` and `source`, and a
 * `null` balance is a distinct state from a zero one.
 *
 * **Net worth reports per currency and never sums across them.** `netWorthNow`
 * builds its totals from the same `listAccounts` this route serves, deliberately,
 * so "what does net worth include?" and "what does the accounts page show?"
 * cannot disagree. FX conversion is a Phase 2 table; adding dollars to euros
 * here would be a wrong number rendered confidently.
 *
 * ## Manual entry (WP 2.5) closes wp1.6 §7's "`ManualAccountForm` reads 'No
 * balance yet'"
 *
 * `POST /connections { provider: "manual", ... }` (`connections.ts`) creates the
 * account; nothing before this WP could ever put a balance or a transaction on
 * it afterwards. `POST /accounts/{id}/balance` is a direct call into
 * `recordBalance` — the same append-only observation `applyProviderTransactions`
 * would write from a sync, just with `source: 'manual'` and a human typing the
 * numbers instead of a page from Plaid. `POST /accounts/{id}/transactions` is
 * the same idea over `applyProviderTransactions` itself, with `@connector/manual`'s
 * `manualTransaction()` computing the mandatory fingerprint (08 §2.5) so a
 * hand-typed row reconciles against a future provider backfill exactly like any
 * other adapter's does. Both bypass `ManualConnector`/`ManualStore` on purpose:
 * that pair exists to give an *initial* batch of accounts a `connect()` and a
 * sync history, but `applyProviderTransactions` and `recordBalance` are the
 * actual ledger writers underneath every adapter's sync, already scoped to
 * `(userId, accountId)` and already the one place `TransactionsUpserted` /
 * `BalanceRecorded` get emitted — a second path through the connector would be
 * a second way to reach the same table.
 *
 * Both routes are scoped to `account.provider === MANUAL_PROVIDER`: a Plaid or
 * CSV account's balance and transactions arrive from that adapter, not by hand,
 * and letting this route write into one would put a fabricated row next to real
 * provider facts under the same natural key.
 *
 * **Step-up (decision D21), matching `connections.ts`'s policy.** A manual
 * balance or transaction changes net worth exactly the way linking or removing
 * a connection does — a stolen session cookie must not be enough to inflate a
 * balance or invent a transaction that budgeting and reports then treat as
 * ground truth. Every other route in this file (`GET`, the net-worth read, the
 * `includeInNetWorth`/`closed` toggle) needs only a session, unchanged.
 */
import { DateOnly, Money } from '@core/kernel';
import {
  applyProviderTransactions,
  listAccounts,
  netWorthNow,
  recordBalance,
  setAccountClosed,
  setIncludeInNetWorth,
  type AccountSummary,
  type NetWorthNow,
} from '@ctx/ledger';
import { MANUAL_PROVIDER, manualTransaction } from '@connector/manual';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, problems } from '../problem.ts';
import {
  booleanQuery,
  dateOnlyQuery,
  instantOrNull,
  isoInstant,
  money,
  moneyOrNull,
  moneySchema,
} from '../wire.ts';
import { mapDomainErrors } from './domain-errors.ts';
import type { RouteDeps } from './deps.ts';

const accountBalanceSchema = z
  .object({
    current: moneySchema.describe('Contribution to net worth. A card you owe on is negative.'),
    available: moneySchema.nullable(),
    limit: moneySchema.nullable().describe('A magnitude, not a contribution: always positive.'),
    asOf: isoInstant,
    source: z.enum(['provider', 'manual', 'derived']),
  })
  .meta({ id: 'AccountBalance' });

const accountSchema = z
  .object({
    id: z.uuid(),
    connectionId: z.uuid().nullable(),
    provider: z.string(),
    name: z.string(),
    officialName: z.string().nullable(),
    type: z.enum(['depository', 'credit', 'loan', 'investment', 'crypto', 'manual']),
    subtype: z.string().nullable(),
    classification: z.enum(['asset', 'liability']),
    currency: z.string().length(3),
    mask: z.string().nullable().describe('Last 2-4 digits. Never the full number.'),
    closedAt: isoInstant.nullable(),
    includeInNetWorth: z.boolean(),
    balance: accountBalanceSchema.nullable().describe('null until a balance has been observed.'),
  })
  .meta({ id: 'Account' });

const netWorthSchema = z
  .object({
    asOf: isoInstant.nullable().describe('The oldest balance the totals rest on.'),
    totals: z.array(
      z.object({
        currency: z.string().length(3),
        assets: moneySchema,
        liabilities: moneySchema,
        net: moneySchema,
      }),
    ),
    inputs: z.array(
      z.object({
        accountId: z.uuid(),
        name: z.string(),
        classification: z.enum(['asset', 'liability']),
        balance: moneySchema.nullable(),
        asOf: isoInstant.nullable(),
        included: z.boolean(),
        excludedReason: z.enum(['closed', 'opted_out', 'no_balance']).nullable(),
      }),
    ),
  })
  .meta({
    id: 'NetWorth',
    description:
      'Net worth from the latest balance of every included account, per currency. ' +
      '`inputs` is the audit trail: every account, whether it counted, and why not.',
  });

function serialiseAccount(account: AccountSummary): z.infer<typeof accountSchema> {
  return {
    id: account.id,
    connectionId: account.connectionId,
    provider: account.provider,
    name: account.name,
    officialName: account.officialName,
    type: account.type,
    subtype: account.subtype,
    classification: account.classification,
    currency: account.currency.trim(),
    mask: account.mask,
    closedAt: instantOrNull(account.closedAt),
    includeInNetWorth: account.includeInNetWorth,
    balance:
      account.balance === null
        ? null
        : {
            current: money(account.balance.current),
            available: moneyOrNull(account.balance.available),
            limit: moneyOrNull(account.balance.limit),
            asOf: account.balance.asOf.toISOString(),
            source: account.balance.source,
          },
  };
}

function serialiseNetWorth(result: NetWorthNow): z.infer<typeof netWorthSchema> {
  return {
    asOf: instantOrNull(result.asOf),
    totals: result.totals.map((total) => ({
      currency: total.currency.trim(),
      assets: money(total.assets),
      liabilities: money(total.liabilities),
      net: money(total.net),
    })),
    inputs: result.inputs.map((input) => ({
      accountId: input.accountId,
      name: input.name,
      classification: input.classification,
      balance: moneyOrNull(input.balance),
      asOf: instantOrNull(input.asOf),
      included: input.included,
      excludedReason: input.excludedReason,
    })),
  };
}

export const accountRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;

  /**
   * Fetch one account, scoped to this user, and confirm it takes manual entry.
   *
   * `listAccounts` rather than a single-row query — the same "re-read through
   * the read model" choice `PATCH /accounts/{id}` below makes, so `assignable`,
   * `balance` and every other derived field come from the one place that
   * computes them. A 404 here is indistinguishable from "belongs to another
   * user": both are `listAccounts` returning no row for this `userId`.
   */
  async function requireManualAccount(userId: string, accountId: string): Promise<AccountSummary> {
    const accounts = await listAccounts(database, { userId, includeClosed: true });
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (account === undefined) {
      throw new AppError({
        status: 404,
        code: 'ledger.account_not_found',
        title: 'Not Found',
        detail: `No account ${accountId}.`,
        family: 'user',
      });
    }
    if (account.provider !== MANUAL_PROVIDER) {
      throw new AppError({
        status: 422,
        code: 'ledger.account_not_manual',
        title: 'Unprocessable Content',
        detail:
          `Account ${accountId} is backed by ${account.provider}; its balance and transactions ` +
          'arrive from that connection, not by hand.',
        family: 'user',
      });
    }
    return account;
  }

  return async (app) => {
    app.get(
      '/accounts',
      {
        schema: {
          operationId: 'listAccounts',
          summary: 'Every account, with its latest balance',
          description:
            'Closed accounts are hidden by default. They keep every transaction they ever had — ' +
            '"delete the account" and "stop showing me this account" are different requests.',
          tags: ['accounts'],
          querystring: z.object({ includeClosed: booleanQuery }),
          response: {
            200: z.object({ accounts: z.array(accountSchema) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const accounts = await listAccounts(database, {
          userId: session.userId,
          ...(request.query.includeClosed === undefined
            ? {}
            : { includeClosed: request.query.includeClosed }),
        });
        return { accounts: accounts.map(serialiseAccount) };
      },
    );

    app.patch(
      '/accounts/:accountId',
      {
        schema: {
          operationId: 'updateAccount',
          summary: 'Include an account in net worth, or close it',
          description:
            'The two fields a user owns. An account name comes from the provider and is not ' +
            'editable in Phase 1 — there is no nickname column yet (see the WP 1.5 evidence note).',
          tags: ['accounts'],
          params: z.object({ accountId: z.uuid() }),
          body: z
            .object({
              includeInNetWorth: z.boolean().optional(),
              closed: z.boolean().optional(),
            })
            .refine(
              (body) => body.includeInNetWorth !== undefined || body.closed !== undefined,
              'a PATCH with no fields changes nothing; say what to change',
            ),
          response: {
            200: z.object({ account: accountSchema, changed: z.boolean() }),
            ...problems(400, 401, 403, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const { accountId } = request.params;
        const context = { clock, correlationId: String(request.id) };
        let changed = false;

        await mapDomainErrors(async () => {
          if (request.body.includeInNetWorth !== undefined) {
            const result = await setIncludeInNetWorth(
              database,
              { userId: session.userId, accountId, include: request.body.includeInNetWorth },
              context,
            );
            changed ||= result.changed;
          }
          if (request.body.closed !== undefined) {
            const result = await setAccountClosed(
              database,
              { userId: session.userId, accountId, closed: request.body.closed },
              context,
            );
            changed ||= result.changed;
          }
        });

        // Re-read rather than patch a local copy: `setAccountClosed` also drops
        // the account out of net worth, and a response assembled by hand would
        // be the third place that rule is written down.
        const accounts = await listAccounts(database, {
          userId: session.userId,
          includeClosed: true,
        });
        const account = accounts.find((candidate) => candidate.id === accountId);
        if (account === undefined) {
          throw new AppError({
            status: 404,
            code: 'ledger.account_not_found',
            title: 'Not Found',
            detail: `No account ${accountId}.`,
            family: 'user',
          });
        }
        return { account: serialiseAccount(account), changed };
      },
    );

    app.get(
      '/net-worth',
      {
        schema: {
          operationId: 'getNetWorth',
          summary: 'Net worth now, per currency',
          description:
            'Totals are reported per currency and never summed across them: there is no FX table ' +
            'in Phase 1, and adding dollars to euros would be a wrong number rendered confidently.',
          tags: ['accounts'],
          response: { 200: netWorthSchema, ...problems(401, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return serialiseNetWorth(await netWorthNow(database, { userId: session.userId }));
      },
    );

    app.post(
      '/accounts/:accountId/balance',
      {
        schema: {
          operationId: 'recordManualBalance',
          summary: 'Record a balance for a manual account',
          description:
            'Only for `provider: "manual"` accounts (see this file\'s module comment) — a 422 ' +
            'otherwise. Appends through `recordBalance`, the same writer a sync uses, with ' +
            '`source: "manual"`; it never replaces a prior observation, so a correction is a new ' +
            'row with a later `asOf`, not an edit of an old one. Needs a step-up assertion, the ' +
            'same policy `connections.ts` uses for every write that moves net worth.',
          tags: ['accounts'],
          params: z.object({ accountId: z.uuid() }),
          body: z.object({
            current: moneySchema.describe(
              'Contribution to net worth. A card you owe on is negative.',
            ),
            available: moneySchema.nullable().optional(),
            limit: moneySchema
              .nullable()
              .optional()
              .describe('A magnitude, not a contribution: always positive.'),
            asOf: isoInstant
              .optional()
              .describe('Defaults to now — when the observation is entered, not backdated.'),
          }),
          response: {
            200: z.object({ account: accountSchema, recorded: z.boolean() }),
            ...problems(400, 401, 403, 404, 409, 422, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const { accountId } = request.params;
        await requireManualAccount(session.userId, accountId);

        const result = await mapDomainErrors(() =>
          recordBalance(
            database,
            {
              userId: session.userId,
              accountId,
              current: Money.fromJSON(request.body.current),
              ...(request.body.available === undefined
                ? {}
                : {
                    available:
                      request.body.available === null
                        ? null
                        : Money.fromJSON(request.body.available),
                  }),
              ...(request.body.limit === undefined
                ? {}
                : {
                    limit: request.body.limit === null ? null : Money.fromJSON(request.body.limit),
                  }),
              asOf: request.body.asOf === undefined ? clock.now() : new Date(request.body.asOf),
              source: 'manual',
            },
            { clock, correlationId: String(request.id) },
          ),
        );

        // Re-read: `recordBalance` only returns the new row's id, and `balance`
        // on the wire is always "the latest", which is a `listAccounts` rule.
        const accounts = await listAccounts(database, {
          userId: session.userId,
          includeClosed: true,
        });
        const account = accounts.find((candidate) => candidate.id === accountId);
        if (account === undefined) {
          throw new AppError({
            status: 404,
            code: 'ledger.account_not_found',
            title: 'Not Found',
            detail: `No account ${accountId}.`,
            family: 'user',
          });
        }
        return { account: serialiseAccount(account), recorded: result.recorded };
      },
    );

    app.post(
      '/accounts/:accountId/transactions',
      {
        schema: {
          operationId: 'createManualTransactions',
          summary: 'Add one or more hand-entered transactions to a manual account',
          description:
            'Only for `provider: "manual"` accounts — a 422 otherwise. Builds each row through ' +
            "`@connector/manual`'s `manualTransaction()`, which computes the mandatory " +
            'fingerprint (08 §2.5) and a content-hash id, so entering the same row twice is one ' +
            'row and a later real import of the same charge reconciles against it rather than ' +
            'duplicating it. Writes through `applyProviderTransactions`, the same function every ' +
            "adapter's sync uses, so `categorization.AssignmentsChanged` and budgeting's consumer " +
            'see a typed transaction exactly like a synced one. Needs a step-up assertion, the ' +
            'same policy `connections.ts` uses for every write that moves net worth.',
          tags: ['accounts'],
          params: z.object({ accountId: z.uuid() }),
          body: z.object({
            transactions: z
              .array(
                z.object({
                  amount: moneySchema.describe(
                    'Negative is money leaving the account, on every account type — the same ' +
                      'sign convention every provider adapter uses.',
                  ),
                  postedDate: dateOnlyQuery,
                  name: z.string().min(1).max(200).describe('What the user typed. Never sniffed.'),
                  merchantName: z.string().min(1).max(200).nullable().optional(),
                  pending: z.boolean().optional(),
                }),
              )
              .min(1)
              .max(50),
          }),
          response: {
            201: z.object({
              addedTransactionIds: z.array(z.uuid()),
              updatedTransactionIds: z.array(z.uuid()),
            }),
            ...problems(400, 401, 403, 404, 409, 422, 503),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireFreshSession(request);
        const { accountId } = request.params;
        const account = await requireManualAccount(session.userId, accountId);
        const currency = account.currency.trim();

        const facts = request.body.transactions.map((item) => {
          const amount = Money.fromJSON(item.amount);
          if (amount.currency !== currency) {
            throw new AppError({
              status: 409,
              code: 'ledger.currency_mismatch',
              title: 'Conflict',
              detail: `account ${accountId} is in ${currency}, this entry is in ${amount.currency}`,
              family: 'domain',
            });
          }
          return manualTransaction({
            providerAccountId: account.providerAccountId,
            amount,
            postedDate: DateOnly.parse(item.postedDate),
            name: item.name,
            merchantName: item.merchantName ?? null,
            pending: item.pending ?? false,
          });
        });

        const result = await mapDomainErrors(() =>
          applyProviderTransactions(database, {
            userId: session.userId,
            accountId,
            provider: MANUAL_PROVIDER,
            added: facts,
            clock,
            correlationId: String(request.id),
          }),
        );

        return reply.code(201).send({
          addedTransactionIds: [...result.addedTransactionIds],
          updatedTransactionIds: [...result.updatedTransactionIds],
        });
      },
    );
  };
};
