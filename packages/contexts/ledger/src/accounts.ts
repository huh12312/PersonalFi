// SPDX-License-Identifier: MIT
/**
 * Accounts, balances, and the net-worth inputs built from them.
 *
 * Two rules run through this file.
 *
 * **A balance is an observation, not a column.** `account_balances` is
 * append-only and every figure carries `as_of` and `source`, because every
 * balance in the UI has to be able to answer "as of when?" (04 §4.5). A mutable
 * `accounts.current_balance` cannot: it loses the series a net-worth chart is
 * built from, and it lets a provider reporting a stale figure silently overwrite
 * a fresher manual one.
 *
 * **Provider metadata is the provider's; the rest is ours.** An upsert refreshes
 * what the institution owns (name, subtype, mask, currency) and deliberately
 * leaves `closed_at` and `include_in_net_worth` alone — those are user/ledger
 * state, and a nightly sync that silently reopened an account the user closed, or
 * put a hidden account back in net worth, is the kind of bug that gets noticed as
 * "the numbers are wrong" three weeks later.
 */
import { Money, newId, type Clock, type Money as MoneyType } from '@core/kernel';
import { appendEvent, toInstant } from '@core/platform';
import { and, eq, sql } from 'drizzle-orm';
import {
  accountBalances,
  accounts,
  type AccountClassification,
  type AccountType,
  type BalanceSource,
} from '../schema/index.ts';
import { moneyOf, outboxOf, type LedgerExecutor } from './db.ts';
import { LedgerError } from './errors.ts';
import { AccountUpserted, BalanceRecorded } from './events.ts';

export interface LedgerWriteContext {
  readonly clock: Clock;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface UpsertAccountInput {
  readonly userId: string;
  readonly provider: string;
  readonly providerAccountId: string;
  /** Opaque here; `@ctx/connections` owns it. NULL for a manual account. */
  readonly connectionId?: string | null;
  readonly name: string;
  readonly officialName?: string | null;
  readonly type: AccountType;
  readonly subtype?: string | null;
  /** Defaults to the natural classification of `type`. */
  readonly classification?: AccountClassification;
  readonly currency: string;
  readonly mask?: string | null;
  /** Honoured on creation only; afterwards it is the user's to change. */
  readonly includeInNetWorth?: boolean;
}

export interface UpsertAccountResult {
  readonly accountId: string;
  readonly created: boolean;
  readonly changedFields: readonly string[];
}

/**
 * A credit card and a mortgage are money you owe; everything else is money you
 * have. A manual account can be either, which is why the caller may override.
 */
export function classificationOf(type: AccountType): AccountClassification {
  return type === 'credit' || type === 'loan' ? 'liability' : 'asset';
}

export async function upsertAccount(
  executor: LedgerExecutor,
  input: UpsertAccountInput,
  context: LedgerWriteContext,
): Promise<UpsertAccountResult> {
  const now = context.clock.now();
  const classification = input.classification ?? classificationOf(input.type);

  const existing = (
    await executor
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, input.userId),
          eq(accounts.provider, input.provider),
          eq(accounts.providerAccountId, input.providerAccountId),
        ),
      )
  )[0];

  const providerFields = {
    connectionId: input.connectionId ?? null,
    name: input.name,
    officialName: input.officialName ?? null,
    type: input.type,
    subtype: input.subtype ?? null,
    classification,
    currency: input.currency,
    mask: input.mask ?? null,
  };

  if (existing === undefined) {
    const accountId = newId();
    await executor.insert(accounts).values({
      id: accountId,
      userId: input.userId,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      ...providerFields,
      closedAt: null,
      includeInNetWorth: input.includeInNetWorth ?? true,
      createdAt: now,
      updatedAt: now,
    });
    await emitAccountUpserted(executor, input.userId, context, {
      accountId,
      connectionId: providerFields.connectionId,
      provider: input.provider,
      created: true,
      changedFields: Object.keys(providerFields),
    });
    return { accountId, created: true, changedFields: Object.keys(providerFields) };
  }

  const changedFields = Object.entries(providerFields)
    .filter(([field, value]) => existing[field as keyof typeof existing] !== value)
    .map(([field]) => field);

  if (changedFields.length === 0) {
    return { accountId: existing.id, created: false, changedFields: [] };
  }

  await executor
    .update(accounts)
    .set({ ...providerFields, updatedAt: now })
    .where(eq(accounts.id, existing.id));
  await emitAccountUpserted(executor, input.userId, context, {
    accountId: existing.id,
    connectionId: providerFields.connectionId,
    provider: input.provider,
    created: false,
    changedFields,
  });
  return { accountId: existing.id, created: false, changedFields };
}

/**
 * Close an account, or reopen it.
 *
 * A closed account keeps every transaction it ever had — the history is the point
 * — and drops out of net worth and of the default account list. It is a soft
 * state for the same reason a removed transaction is: "delete the account" and
 * "stop showing me this account" are different requests, and only one of them is
 * reversible.
 */
export async function setAccountClosed(
  executor: LedgerExecutor,
  input: { userId: string; accountId: string; closed: boolean; closedAt?: Date },
  context: LedgerWriteContext,
): Promise<{ changed: boolean }> {
  const now = context.clock.now();
  const rows = await executor
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, input.userId)));
  const existing = rows[0];
  if (existing === undefined) {
    throw new LedgerError('ledger.account_not_found', `no account ${input.accountId}`);
  }
  const closedAt = input.closed ? (input.closedAt ?? now) : null;
  if ((existing.closedAt === null) === (closedAt === null)) return { changed: false };

  await executor
    .update(accounts)
    .set({ closedAt, updatedAt: now })
    .where(eq(accounts.id, input.accountId));
  await emitAccountUpserted(executor, input.userId, context, {
    accountId: input.accountId,
    connectionId: existing.connectionId,
    provider: existing.provider,
    created: false,
    changedFields: ['closedAt'],
  });
  return { changed: true };
}

/** Include or exclude an account from net worth. The user's call, never sync's. */
export async function setIncludeInNetWorth(
  executor: LedgerExecutor,
  input: { userId: string; accountId: string; include: boolean },
  context: LedgerWriteContext,
): Promise<{ changed: boolean }> {
  const updated = await executor
    .update(accounts)
    .set({ includeInNetWorth: input.include, updatedAt: context.clock.now() })
    .where(
      and(
        eq(accounts.id, input.accountId),
        eq(accounts.userId, input.userId),
        eq(accounts.includeInNetWorth, !input.include),
      ),
    )
    .returning({ id: accounts.id });
  return { changed: updated.length > 0 };
}

export interface RecordBalanceInput {
  readonly userId: string;
  readonly accountId: string;
  /** Contribution to net worth: a card you owe $420 on records `-42000n`. */
  readonly current: MoneyType;
  readonly available?: MoneyType | null;
  /** A magnitude, not a contribution, so it stays positive. */
  readonly limit?: MoneyType | null;
  readonly asOf: Date;
  readonly source: BalanceSource;
}

/**
 * Append a balance observation.
 *
 * Idempotent on `(account_id, as_of, source)`: replaying a sync page records
 * nothing and emits nothing, which is idempotency layer 1 (04 §4.4) applied to
 * the other half of what a sync returns.
 */
export async function recordBalance(
  executor: LedgerExecutor,
  input: RecordBalanceInput,
  context: LedgerWriteContext,
): Promise<{ balanceId: string | null; recorded: boolean }> {
  const rows = await executor
    .select({ id: accounts.id, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, input.userId)));
  const account = rows[0];
  if (account === undefined) {
    throw new LedgerError('ledger.account_not_found', `no account ${input.accountId}`);
  }
  if (account.currency.trim() !== input.current.currency) {
    throw new LedgerError(
      'ledger.currency_mismatch',
      `account ${input.accountId} is in ${account.currency.trim()}, balance is in ${input.current.currency}`,
    );
  }
  if (input.limit != null && Money.isNegative(input.limit)) {
    throw new LedgerError('ledger.currency_mismatch', 'a credit limit is a magnitude, not a debt');
  }

  const balanceId = newId();
  const inserted = await executor
    .insert(accountBalances)
    .values({
      id: balanceId,
      userId: input.userId,
      accountId: input.accountId,
      currentMinor: input.current.minor,
      availableMinor: input.available?.minor ?? null,
      limitMinor: input.limit?.minor ?? null,
      currency: input.current.currency,
      asOf: input.asOf,
      source: input.source,
      createdAt: context.clock.now(),
    })
    .onConflictDoNothing()
    .returning({ id: accountBalances.id });

  if (inserted.length === 0) return { balanceId: null, recorded: false };

  await appendEvent(
    outboxOf(executor),
    BalanceRecorded.create(
      {
        accountId: input.accountId,
        balanceId,
        asOf: input.asOf.toISOString(),
        source: input.source,
      },
      {
        userId: input.userId,
        aggregateId: input.accountId,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
      },
      context.clock,
    ),
  );
  return { balanceId, recorded: true };
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface AccountBalanceSummary {
  readonly current: MoneyType;
  readonly available: MoneyType | null;
  readonly limit: MoneyType | null;
  readonly asOf: Date;
  readonly source: BalanceSource;
}

export interface AccountSummary {
  readonly id: string;
  readonly connectionId: string | null;
  readonly provider: string;
  readonly providerAccountId: string;
  readonly name: string;
  readonly officialName: string | null;
  readonly type: AccountType;
  readonly subtype: string | null;
  readonly classification: AccountClassification;
  readonly currency: string;
  readonly mask: string | null;
  readonly closedAt: Date | null;
  readonly includeInNetWorth: boolean;
  /** The latest observation, or `null` for an account that has never reported. */
  readonly balance: AccountBalanceSummary | null;
}

interface AccountJoinRow extends Record<string, unknown> {
  id: string;
  connection_id: string | null;
  provider: string;
  provider_account_id: string;
  name: string;
  official_name: string | null;
  type: AccountType;
  subtype: string | null;
  classification: AccountClassification;
  currency: string;
  mask: string | null;
  closed_at: string | Date | null;
  include_in_net_worth: boolean;
  balance_current_minor: bigint | null;
  balance_available_minor: bigint | null;
  balance_limit_minor: bigint | null;
  balance_currency: string | null;
  balance_as_of: string | Date | null;
  balance_source: BalanceSource | null;
}

/**
 * Every account with its latest balance.
 *
 * `LEFT JOIN LATERAL … ORDER BY as_of DESC LIMIT 1` rather than a window function
 * or a `DISTINCT ON` over the whole table: the lateral runs one index-only probe
 * of `account_balances_latest_idx` per account, so the cost is a function of the
 * number of accounts (tens) and not of the number of observations (hundreds of
 * thousands after a year of nightly syncs).
 */
export async function listAccounts(
  executor: LedgerExecutor,
  input: { userId: string; includeClosed?: boolean },
): Promise<AccountSummary[]> {
  const result = await executor.execute<AccountJoinRow>(sql`
    SELECT a.id,
           a.connection_id,
           a.provider,
           a.provider_account_id,
           a.name,
           a.official_name,
           a.type,
           a.subtype,
           a.classification,
           a.currency,
           a.mask,
           a.closed_at,
           a.include_in_net_worth,
           b.current_minor   AS balance_current_minor,
           b.available_minor AS balance_available_minor,
           b.limit_minor     AS balance_limit_minor,
           b.currency        AS balance_currency,
           b.as_of           AS balance_as_of,
           b.source          AS balance_source
      FROM accounts a
      LEFT JOIN LATERAL (
        SELECT current_minor, available_minor, limit_minor, currency, as_of, source
          FROM account_balances
         WHERE account_id = a.id
         ORDER BY as_of DESC
         LIMIT 1
      ) b ON true
     WHERE a.user_id = ${input.userId}::uuid
       ${input.includeClosed === true ? sql`` : sql`AND a.closed_at IS NULL`}
     ORDER BY a.name, a.id
  `);

  return result.rows.map((row) => ({
    id: row.id,
    connectionId: row.connection_id,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    name: row.name,
    officialName: row.official_name,
    type: row.type,
    subtype: row.subtype,
    classification: row.classification,
    currency: row.currency.trim(),
    mask: row.mask,
    closedAt: row.closed_at === null ? null : toInstant(row.closed_at),
    includeInNetWorth: row.include_in_net_worth,
    balance: balanceOf(row),
  }));
}

/**
 * The lateral join's balance columns, or `null` when the account has never
 * reported one. All four are checked rather than just the amount: they come from
 * the same row, so any of them being NULL means the `LEFT JOIN LATERAL` found
 * nothing, and a partial balance is a bug worth surfacing as "no balance" rather
 * than as a zero that looks like a real observation.
 */
function balanceOf(row: AccountJoinRow): AccountBalanceSummary | null {
  const current = row.balance_current_minor;
  const currency = row.balance_currency;
  const asOf = row.balance_as_of;
  const source = row.balance_source;
  if (current === null || currency === null || asOf === null || source === null) return null;
  return {
    current: moneyOf(current, currency),
    available:
      row.balance_available_minor === null ? null : moneyOf(row.balance_available_minor, currency),
    limit: row.balance_limit_minor === null ? null : moneyOf(row.balance_limit_minor, currency),
    asOf: toInstant(asOf),
    source,
  };
}

/** One account's contribution to net worth, with the reason it does or does not. */
export interface NetWorthInput {
  readonly accountId: string;
  readonly name: string;
  readonly classification: AccountClassification;
  readonly balance: MoneyType | null;
  readonly asOf: Date | null;
  readonly included: boolean;
  /** Why it is excluded: `closed`, `opted_out`, or `no_balance`. */
  readonly excludedReason: 'closed' | 'opted_out' | 'no_balance' | null;
}

export interface NetWorthTotal {
  readonly currency: string;
  /** Sum of asset contributions. */
  readonly assets: MoneyType;
  /** Sum of liability contributions — normally negative, being money owed. */
  readonly liabilities: MoneyType;
  /** `assets + liabilities`. */
  readonly net: MoneyType;
}

export interface NetWorthNow {
  /** The freshest observation any included account contributed. */
  readonly asOf: Date | null;
  /**
   * One total per currency. Not one number: converting a CAD account into USD
   * needs an FX rate with an as-of date, which is a Phase 3 concern (`fx_rates`
   * is not this context's table). Reporting the currencies separately is the
   * honest answer until then, and never silently adds dollars to euros.
   */
  readonly totals: readonly NetWorthTotal[];
  readonly inputs: readonly NetWorthInput[];
}

/**
 * Net worth from the latest balance of every included account.
 *
 * Built from `listAccounts`, deliberately: "what does net worth include?" and
 * "what does the accounts page show?" must have the same answer, and the fastest
 * way to make them disagree is to write the aggregate as its own query.
 */
export async function netWorthNow(
  executor: LedgerExecutor,
  input: { userId: string },
): Promise<NetWorthNow> {
  const all = await listAccounts(executor, { userId: input.userId, includeClosed: true });
  const inputs: NetWorthInput[] = all.map((account) => {
    const excludedReason =
      account.closedAt !== null
        ? ('closed' as const)
        : !account.includeInNetWorth
          ? ('opted_out' as const)
          : account.balance === null
            ? ('no_balance' as const)
            : null;
    return {
      accountId: account.id,
      name: account.name,
      classification: account.classification,
      balance: account.balance?.current ?? null,
      asOf: account.balance?.asOf ?? null,
      included: excludedReason === null,
      excludedReason,
    };
  });

  const byCurrency = new Map<string, { assets: MoneyType; liabilities: MoneyType }>();
  let asOf: Date | null = null;
  for (const entry of inputs) {
    if (!entry.included || entry.balance === null) continue;
    const currency = entry.balance.currency;
    const bucket = byCurrency.get(currency) ?? {
      assets: Money.zero(currency),
      liabilities: Money.zero(currency),
    };
    if (entry.classification === 'asset') {
      bucket.assets = Money.add(bucket.assets, entry.balance);
    } else {
      bucket.liabilities = Money.add(bucket.liabilities, entry.balance);
    }
    byCurrency.set(currency, bucket);
    if (entry.asOf !== null && (asOf === null || entry.asOf > asOf)) asOf = entry.asOf;
  }

  const totals = [...byCurrency.entries()]
    .map(([currency, bucket]) => ({
      currency,
      assets: bucket.assets,
      liabilities: bucket.liabilities,
      net: Money.add(bucket.assets, bucket.liabilities),
    }))
    .sort((a, b) => (a.currency < b.currency ? -1 : 1));

  return { asOf, totals, inputs };
}

// ---------------------------------------------------------------------------

async function emitAccountUpserted(
  executor: LedgerExecutor,
  userId: string,
  context: LedgerWriteContext,
  payload: {
    accountId: string;
    connectionId: string | null;
    provider: string;
    created: boolean;
    changedFields: readonly string[];
  },
): Promise<void> {
  await appendEvent(
    outboxOf(executor),
    AccountUpserted.create(
      { ...payload, changedFields: [...payload.changedFields] },
      {
        userId,
        aggregateId: payload.accountId,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
      },
      context.clock,
    ),
  );
}
