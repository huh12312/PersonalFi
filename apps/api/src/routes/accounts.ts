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
  ACCOUNT_ROLES,
  TAX_TREATMENTS,
  VALUATION_BASES,
  applyProviderTransactions,
  clearAccountOverrides,
  isOverrideNotApplicable,
  listAccountOverrides,
  listAccounts,
  netWorthNow,
  recordBalance,
  setAccountClosed,
  setAccountOverrides,
  setIncludeInNetWorth,
  type AccountOverride,
  type AccountSummary,
  type NetWorthNow,
  type ResolvedAccountOverlay,
} from '@ctx/ledger';
import { openDateIn, summariseValuation } from '@ctx/planning';
import { MANUAL_PROVIDER, manualTransaction } from '@connector/manual';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, problems } from '../problem.ts';
import {
  booleanQuery,
  dateOnly,
  dateOnlyQuery,
  instantOrNull,
  isoInstant,
  money,
  moneyOrNull,
  moneySchema,
} from '../wire.ts';
import { planningPortsFor, resolveAccountOverlayFor } from '../domain.ts';
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

const taxTreatmentSchema = z.enum(TAX_TREATMENTS);
const accountRoleSchema = z.enum(ACCOUNT_ROLES);
const valuationSchema = z.enum(VALUATION_BASES);

/**
 * What an account is, as the holder sees it — the effective value *and where it
 * came from* (WP 9.2). The provider's metadata is never mutated; the holder's
 * override outranks it, and `source` says which one is speaking, so the screen
 * can say "from Plaid: 401k" or "set by you" and never present a guess as a fact.
 */
const accountOverlaySchema = z
  .object({
    taxTreatment: z.object({
      effective: taxTreatmentSchema.nullable().describe('null: the account has no tax bucket.'),
      source: z
        .enum(['holder', 'provider_subtype', 'provider_fallback', 'none'])
        .describe(
          '`provider_subtype`: the provider’s own subtype named it. `provider_fallback`: ' +
            'nothing recognised the subtype and TAXABLE is assumed — a guess, not a fact.',
        ),
      override: taxTreatmentSchema.nullable().describe('What the holder set, if anything.'),
      providerDefault: taxTreatmentSchema.nullable(),
    }),
    role: z.object({
      effective: accountRoleSchema.nullable(),
      source: z.enum(['holder', 'none']),
    }),
    valuation: z.object({
      effective: valuationSchema,
      source: z.enum(['holder', 'default']),
    }),
  })
  .meta({ id: 'AccountOverlay' });

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
    overlay: accountOverlaySchema,
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

function serialiseOverlay(overlay: ResolvedAccountOverlay): z.infer<typeof accountOverlaySchema> {
  return {
    taxTreatment: {
      effective: overlay.taxTreatment.value,
      source: overlay.taxTreatment.source,
      override: overlay.taxTreatment.override,
      providerDefault: overlay.taxTreatment.providerDefault,
    },
    role: { effective: overlay.role.value, source: overlay.role.source },
    valuation: { effective: overlay.valuation.value, source: overlay.valuation.source },
  };
}

function serialiseAccount(
  account: AccountSummary,
  override: AccountOverride | null,
): z.infer<typeof accountSchema> {
  return {
    overlay: serialiseOverlay(resolveAccountOverlayFor(account, override)),
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

/** D6: one holder, and their zone is what a local calendar day means. */
async function timezoneOf(deps: RouteDeps): Promise<string> {
  const rows = await deps.pool.query<{ display_timezone: string }>(
    `SELECT display_timezone FROM users ORDER BY created_at, id LIMIT 1`,
  );
  return rows.rows[0]?.display_timezone ?? 'UTC';
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

  /** The holder's overrides by account id — one predicate, the holder. */
  async function overridesOf(userId: string): Promise<ReadonlyMap<string, AccountOverride>> {
    const overrides = await listAccountOverrides(database, { userId });
    return new Map(overrides.map((override) => [override.accountId, override] as const));
  }

  /** One account, re-read through the read model, or the same 404 a stranger's gets. */
  async function accountWire(
    userId: string,
    accountId: string,
  ): Promise<z.infer<typeof accountSchema>> {
    const [accounts, overrides] = await Promise.all([
      listAccounts(database, { userId, includeClosed: true }),
      overridesOf(userId),
    ]);
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
    return serialiseAccount(account, overrides.get(account.id) ?? null);
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
        const overrides = await overridesOf(session.userId);
        return {
          accounts: accounts.map((account) =>
            serialiseAccount(account, overrides.get(account.id) ?? null),
          ),
        };
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
        return { account: await accountWire(session.userId, accountId), changed };
      },
    );

    // -------------------------------------------------------------------
    // The holder's overlay on an account (WP 9.2)
    // -------------------------------------------------------------------
    //
    // Session only, no step-up: no money moves. An override changes what a
    // *projection* is computed from, and the stored projection says so rather
    // than recomputing (`account_overrides_changed`); it cannot move a balance
    // or reach a provider.

    app.put(
      '/accounts/:accountId/overrides',
      {
        schema: {
          operationId: 'setAccountOverrides',
          summary: 'Set what an account is: its tax treatment, role and valuation basis',
          description:
            'The holder’s overlay on the provider’s facts, which are never mutated. A **full ' +
            'replacement**: an omitted or `null` field is cleared, and when none is left the ' +
            'override is removed. `taxTreatment` outranks the provider-subtype default the ' +
            'projection starts from (CF-16). `valuation: "balance"` counts an investment or ' +
            'crypto account that has no priced holdings at its latest balance instead of leaving ' +
            'it out — labelled as such wherever it appears (O-2). Changing any field makes a ' +
            'stored projection read `stale`, naming the change; nothing is recomputed. Another ' +
            'holder’s account is a 404, exactly as a missing one. Emits ' +
            '`ledger.AccountOverrideChanged`. Session only: no money moves.',
          tags: ['accounts'],
          params: z.object({ accountId: z.uuid() }),
          body: z.object({
            taxTreatment: taxTreatmentSchema.nullable().optional(),
            role: accountRoleSchema.nullable().optional(),
            valuation: valuationSchema.nullable().optional(),
          }),
          response: {
            200: z.object({ account: accountSchema, changed: z.boolean() }),
            ...problems(400, 401, 404, 422, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const { accountId } = request.params;
        const result = await mapDomainErrors(async () => {
          try {
            return await database.transaction((tx) =>
              setAccountOverrides(
                tx,
                {
                  userId: session.userId,
                  accountId,
                  taxTreatment: request.body.taxTreatment ?? null,
                  role: request.body.role ?? null,
                  valuation: request.body.valuation ?? null,
                },
                { clock, correlationId: String(request.id) },
              ),
            );
          } catch (error) {
            if (isOverrideNotApplicable(error)) {
              throw new AppError({
                status: 422,
                code: error.code,
                title: 'Unprocessable Content',
                detail: error.message,
                family: 'user',
              });
            }
            throw error;
          }
        });
        return { account: await accountWire(session.userId, accountId), changed: result.changed };
      },
    );

    app.delete(
      '/accounts/:accountId/overrides',
      {
        schema: {
          operationId: 'clearAccountOverrides',
          summary: 'Clear every override on an account, back to the provider’s defaults',
          description:
            'Idempotent: clearing an account with no override changes nothing. A stored ' +
            'projection computed with the override reads `stale` afterwards, as for any change. ' +
            'Another holder’s account is a 404. Session only: no money moves.',
          tags: ['accounts'],
          params: z.object({ accountId: z.uuid() }),
          response: {
            200: z.object({ account: accountSchema, changed: z.boolean() }),
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const { accountId } = request.params;
        const result = await mapDomainErrors(() =>
          database.transaction((tx) =>
            clearAccountOverrides(
              tx,
              { userId: session.userId, accountId },
              { clock, correlationId: String(request.id) },
            ),
          ),
        );
        return { account: await accountWire(session.userId, accountId), changed: result.changed };
      },
    );

    app.get(
      '/accounts/valuation',
      {
        schema: {
          operationId: 'getAccountValuation',
          summary:
            'Which accounts net worth leaves out, and which it counts by the holder’s say-so',
          description:
            'Computed live by the same valuation the net-worth snapshot uses, without FX and ' +
            'without writing. `unvalued` is every account in net worth that cannot be valued — ' +
            'an investment account with no priced holdings, an account with no balance — and is ' +
            'never counted as zero. `byBalance` is every account counted at its latest balance ' +
            'because the holder set `valuation: "balance"`. The plan and net-worth screens name ' +
            'both, so a figure is never quietly missing an account (O-2).',
          tags: ['accounts'],
          response: {
            200: z.object({
              asOfDate: dateOnly,
              unvalued: z.array(
                z.object({
                  accountId: z.uuid(),
                  name: z.string(),
                  reason: z.enum(['no_balance', 'no_priced_holding', 'no_earlier_observation']),
                }),
              ),
              byBalance: z.array(z.object({ accountId: z.uuid(), name: z.string() })),
            }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const timeZone = await timezoneOf(deps);
        const asOfDate = openDateIn(clock, timeZone);
        const summary = await summariseValuation(
          planningPortsFor(database, { userId: session.userId, timeZone, clock }),
          { userId: session.userId, asOfDate },
        );
        return {
          asOfDate,
          unvalued: summary.unvalued.map((entry) => ({
            accountId: entry.accountId,
            name: entry.name,
            reason: entry.reason,
          })),
          byBalance: summary.byBalance.map((entry) => ({
            accountId: entry.accountId,
            name: entry.name,
          })),
        };
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
        return { account: await accountWire(session.userId, accountId), recorded: result.recorded };
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
