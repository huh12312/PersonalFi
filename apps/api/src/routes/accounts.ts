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
 */
import {
  listAccounts,
  netWorthNow,
  setAccountClosed,
  setIncludeInNetWorth,
  type AccountSummary,
  type NetWorthNow,
} from '@ctx/ledger';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, problems } from '../problem.ts';
import {
  booleanQuery,
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
  };
};
