// SPDX-License-Identifier: MIT
/**
 * The only writer of `account_overrides`.
 *
 * Every statement here is scoped by `user_id` *and* the account id, and the
 * table's composite foreign key `(user_id, account_id) → accounts (user_id, id)`
 * is the backstop under them: if a predicate here were ever dropped, the
 * database would still refuse a row naming another holder's account. The
 * predicates are tested one at a time anyway (`test/db/account-overrides.test.ts`),
 * because "the constraint would have caught it" is a reason to have two layers,
 * not a reason to test one.
 */
import { newId } from '@core/kernel';
import { appendEvent } from '@core/platform';
import { and, eq } from 'drizzle-orm';
import { accountOverrides, accounts, type AccountOverrideRow } from '../../schema/index.ts';
import type { LedgerWriteContext } from '../accounts.ts';
import { outboxOf, type LedgerExecutor } from '../db.ts';
import { LedgerError } from '../errors.ts';
import { AccountOverrideChanged } from './events.ts';
import type { AccountOverride } from './resolve.ts';
import {
  OVERRIDE_FIELDS,
  type AccountRole,
  type ManagementStyle,
  type OverrideField,
  type TaxTreatment,
  type ValuationBasis,
} from './vocab.ts';

/** A holder-set override cannot apply to this account; the message says why. */
export class OverrideNotApplicable extends Error {
  readonly code = 'ledger.override_not_applicable' as const;
  readonly field: OverrideField;
  constructor(field: OverrideField, message: string) {
    super(message);
    this.name = 'OverrideNotApplicable';
    this.field = field;
  }
}

export function isOverrideNotApplicable(value: unknown): value is OverrideNotApplicable {
  return value instanceof OverrideNotApplicable;
}

export interface SetAccountOverridesInput {
  readonly userId: string;
  readonly accountId: string;
  /** `null` (or omitted) clears the field: the provider-derived default decides again. */
  readonly taxTreatment?: TaxTreatment | null;
  readonly role?: AccountRole | null;
  readonly valuation?: ValuationBasis | null;
  /** WP 10.3: who manages the account. Any account may carry it; it moves no projection. */
  readonly management?: ManagementStyle | null;
}

export interface OverrideWriteResult {
  readonly changed: boolean;
  readonly changedFields: readonly OverrideField[];
  /** The override row no longer exists: every field is back to its default. */
  readonly cleared: boolean;
}

function toOverride(row: AccountOverrideRow): AccountOverride {
  return {
    accountId: row.accountId,
    taxTreatment: row.taxTreatment,
    role: row.role,
    valuation: row.valuation,
    management: row.management,
    updatedAt: row.updatedAt,
  };
}

/** Every override the holder has set. One predicate: the holder. */
export async function listAccountOverrides(
  executor: LedgerExecutor,
  input: { readonly userId: string },
): Promise<AccountOverride[]> {
  const rows = await executor
    .select()
    .from(accountOverrides)
    .where(eq(accountOverrides.userId, input.userId))
    .orderBy(accountOverrides.accountId);
  return rows.map(toOverride);
}

/** One account's override, or `null`. Two predicates: the holder and the account. */
export async function getAccountOverride(
  executor: LedgerExecutor,
  input: { readonly userId: string; readonly accountId: string },
): Promise<AccountOverride | null> {
  const rows = await executor
    .select()
    .from(accountOverrides)
    .where(
      and(
        eq(accountOverrides.userId, input.userId),
        eq(accountOverrides.accountId, input.accountId),
      ),
    );
  const row = rows[0];
  return row === undefined ? null : toOverride(row);
}

/**
 * Why an override cannot apply to an account, or `null` when it can. Pure, so the
 * route and a test can ask the same question.
 *
 * - A tax treatment is a claim about an asset's wrapper; a liability has none.
 * - `balance` valuation only means something where the default is a different
 *   basis: an investment or crypto account is valued by its holdings, everything
 *   else is already valued from its balance.
 */
export function overrideRefusal(
  account: { readonly type: string; readonly classification: string },
  input: {
    readonly taxTreatment?: TaxTreatment | null | undefined;
    readonly valuation?: ValuationBasis | null | undefined;
  },
): { readonly field: OverrideField; readonly message: string } | null {
  if (input.taxTreatment != null && account.classification !== 'asset') {
    return {
      field: 'taxTreatment',
      message: 'A tax treatment describes an asset account; this one is a liability.',
    };
  }
  if (input.valuation === 'balance' && account.type !== 'investment' && account.type !== 'crypto') {
    return {
      field: 'valuation',
      message:
        'Valuing by balance applies to investment and crypto accounts, which are otherwise ' +
        'valued by their holdings; this account is already valued by its balance.',
    };
  }
  return null;
}

/**
 * Replace the holder's override on one account. All four fields are set as
 * given — absent or `null` clears a field — and when none is left the row is
 * deleted, so "no override" has one representation.
 *
 * @throws {LedgerError} `ledger.account_not_found` — no such account *for this holder*;
 *   another holder's account is indistinguishable from a missing one.
 * @throws {OverrideNotApplicable} the account's kind cannot take the field.
 */
export async function setAccountOverrides(
  executor: LedgerExecutor,
  input: SetAccountOverridesInput,
  context: LedgerWriteContext,
): Promise<OverrideWriteResult> {
  const account = (
    await executor
      .select({ id: accounts.id, type: accounts.type, classification: accounts.classification })
      .from(accounts)
      .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, input.userId)))
  )[0];
  if (account === undefined) {
    throw new LedgerError('ledger.account_not_found', `no account ${input.accountId}`);
  }
  const refusal = overrideRefusal(account, input);
  if (refusal !== null) throw new OverrideNotApplicable(refusal.field, refusal.message);

  const next = {
    taxTreatment: input.taxTreatment ?? null,
    role: input.role ?? null,
    valuation: input.valuation ?? null,
    management: input.management ?? null,
  };
  const existing = await getAccountOverride(executor, input);
  const changedFields = OVERRIDE_FIELDS.filter(
    (field) => (existing?.[field] ?? null) !== next[field],
  );
  if (changedFields.length === 0) return { changed: false, changedFields: [], cleared: false };

  const now = context.clock.now();
  const empty =
    next.taxTreatment === null &&
    next.role === null &&
    next.valuation === null &&
    next.management === null;
  if (empty) {
    await executor
      .delete(accountOverrides)
      .where(
        and(
          eq(accountOverrides.userId, input.userId),
          eq(accountOverrides.accountId, input.accountId),
        ),
      );
  } else {
    await executor
      .insert(accountOverrides)
      .values({
        id: newId(),
        userId: input.userId,
        accountId: input.accountId,
        ...next,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [accountOverrides.userId, accountOverrides.accountId],
        set: { ...next, updatedAt: now },
      });
  }
  await emitChanged(executor, input.userId, input.accountId, changedFields, empty, context);
  return { changed: true, changedFields, cleared: empty };
}

/**
 * Remove the holder's override on one account: every field returns to its
 * provider-derived default. Idempotent — clearing an account with no override
 * changes nothing and emits nothing.
 *
 * @throws {LedgerError} `ledger.account_not_found` for an account that is not this holder's.
 */
export async function clearAccountOverrides(
  executor: LedgerExecutor,
  input: { readonly userId: string; readonly accountId: string },
  context: LedgerWriteContext,
): Promise<OverrideWriteResult> {
  const account = (
    await executor
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, input.userId)))
  )[0];
  if (account === undefined) {
    throw new LedgerError('ledger.account_not_found', `no account ${input.accountId}`);
  }
  const deleted = await executor
    .delete(accountOverrides)
    .where(
      and(
        eq(accountOverrides.userId, input.userId),
        eq(accountOverrides.accountId, input.accountId),
      ),
    )
    .returning();
  const row = deleted[0];
  if (row === undefined) return { changed: false, changedFields: [], cleared: false };
  const changedFields = OVERRIDE_FIELDS.filter((field) => row[field] !== null);
  await emitChanged(executor, input.userId, input.accountId, changedFields, true, context);
  return { changed: true, changedFields, cleared: true };
}

async function emitChanged(
  executor: LedgerExecutor,
  userId: string,
  accountId: string,
  changedFields: readonly OverrideField[],
  cleared: boolean,
  context: LedgerWriteContext,
): Promise<void> {
  await appendEvent(
    outboxOf(executor),
    AccountOverrideChanged.create(
      { accountId, changedFields: [...changedFields], cleared },
      {
        userId,
        aggregateId: accountId,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
      },
      context.clock,
    ),
  );
}
