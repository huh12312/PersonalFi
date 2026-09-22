// SPDX-License-Identifier: MIT
/**
 * Persistence for the securities master, behind one narrow interface.
 *
 * `SecurityResolver` is the interesting code and it is almost entirely about
 * *deciding*: which name is strongest, which existing row a set of names points
 * at, whether to abstain. None of that is about Postgres. So the resolver talks
 * to `SecurityStore`, and this file supplies two implementations of it:
 *
 *   * `drizzleSecurityStore(db)` — the real one, over `0013_securities.sql`.
 *   * `inMemorySecurityStore()` — for the merge-rule proofs in `src/*.test.ts`.
 *
 * The fake **enforces the same two invariants the schema does**, and that is
 * the only reason it is allowed to exist: one identifier points at one security
 * (`security_identifiers`' UNIQUE (user_id, identifier_key)), and a security's
 * identity is never `proprietary` (`securities.identity_kind`'s CHECK, which
 * has no such member). A fake that relaxed either would make every unit test in
 * this package a statement about the fake. It lives in `src/` rather than in
 * `test/` for the same reason `@ctx/recurring`'s `inMemoryLedgerPort` does:
 * a reviewer re-running these proofs cannot accidentally substitute a
 * friendlier one.
 *
 * What the fake cannot prove, and `test/db/` therefore does: that Postgres
 * agrees. `'two identifiers for one security never create two rows'` runs as a
 * `fast-check` property here *and* against the real unique index there.
 */

import type { Database } from '@core/db';
import { newId, systemClock, type Clock } from '@core/kernel';
import type { Executor } from '@core/platform';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  IDENTITY_KINDS,
  securities,
  securityIdentifiers,
  securityOverlay,
  type AssetClass,
  type ClassificationSource,
  type IdentifierKind,
  type IdentityKind,
  type OverlayField,
  type Region,
  type SecurityType,
} from '../schema/index.ts';

export type InvestmentsExecutor = Pick<
  Database,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'with'
>;

export type InvestmentsDatabase = Database;

/**
 * Adapt a Drizzle handle to the platform's narrow `Executor`, for `appendEvent`.
 *
 * One cast, in one place, for one reason: Drizzle's `execute()` returns `PgRaw`,
 * a lazily-executed thenable, where the platform's `Executor` declares a
 * `Promise`. They are interchangeable at runtime and not assignable at compile
 * time, which is why `@core/platform` makes the identical cast in
 * `platformExecutor()` and `@ctx/recurring` in its own `store.ts`.
 */
export function outboxOf(executor: InvestmentsExecutor): Executor {
  return {
    execute: <TRow extends Record<string, unknown>>(query: SQL) =>
      executor.execute(query) as unknown as Promise<{ rows: TRow[] }>,
  };
}

/** One `securities` row, in the shape the resolver reasons about. */
export interface SecurityRecord {
  readonly id: string;
  readonly userId: string;
  readonly identityKind: IdentityKind;
  readonly identityKey: string;
  readonly ticker: string | null;
  readonly mic: string | null;
  readonly cusip: string | null;
  readonly isin: string | null;
  readonly figi: string | null;
  readonly chain: string | null;
  readonly contract: string | null;
  readonly name: string | null;
  readonly type: SecurityType;
  readonly currency: string | null;
  readonly expenseRatio: string | null;
  readonly isCashEquivalent: boolean;
  readonly assetClass: AssetClass;
  readonly region: Region;
  readonly sector: string;
  readonly classificationSource: ClassificationSource;
  readonly classificationDepth: number;
  readonly classificationResidual: string | null;
  readonly classificationFlagged: boolean;
  readonly mergedIntoId: string | null;
  readonly createdAt: Date;
}

export type NewSecurity = Omit<SecurityRecord, 'id' | 'createdAt' | 'mergedIntoId'>;

/** The subset of a `securities` row a re-sync is allowed to rewrite. */
export interface SecurityPatch {
  readonly identityKind?: IdentityKind;
  readonly identityKey?: string;
  readonly ticker?: string | null;
  readonly mic?: string | null;
  readonly cusip?: string | null;
  readonly isin?: string | null;
  readonly figi?: string | null;
  readonly chain?: string | null;
  readonly contract?: string | null;
  readonly name?: string | null;
  readonly type?: SecurityType;
  readonly currency?: string | null;
  readonly expenseRatio?: string | null;
  readonly isCashEquivalent?: boolean;
  readonly assetClass?: AssetClass;
  readonly region?: Region;
  readonly sector?: string;
  readonly classificationSource?: ClassificationSource;
  readonly classificationDepth?: number;
  readonly classificationResidual?: string | null;
  readonly classificationFlagged?: boolean;
}

export interface IdentifierRow {
  readonly userId: string;
  readonly securityId: string;
  readonly kind: IdentifierKind;
  readonly value: string;
  readonly chain: string | null;
  readonly mic: string | null;
  readonly identifierKey: string;
  readonly provider: string | null;
  readonly confidence: string;
  readonly seenAt: Date;
}

/** What a lookup found: a key, and the security it already belongs to. */
export interface IdentifierMatch {
  readonly identifierKey: string;
  readonly kind: IdentifierKind;
  readonly securityId: string;
}

/** The user's overlay, as the effective-value rules need it. */
export interface OverlayRecord {
  readonly securityId: string;
  readonly assetClass: AssetClass | null;
  readonly region: Region | null;
  readonly sector: string | null;
  readonly expenseRatio: string | null;
  readonly lockedFields: readonly OverlayField[];
}

export interface SecurityStore {
  findByIdentifierKeys(
    userId: string,
    keys: readonly string[],
  ): Promise<readonly IdentifierMatch[]>;
  getSecurity(userId: string, securityId: string): Promise<SecurityRecord | null>;
  insertSecurity(row: NewSecurity): Promise<SecurityRecord>;
  updateSecurity(securityId: string, patch: SecurityPatch): Promise<void>;
  /** Idempotent: an identifier already pointing at this security refreshes `last_seen_at`. */
  attachIdentifiers(rows: readonly IdentifierRow[]): Promise<void>;
  /** Move every identifier of the loser onto the winner, then mark the loser merged. */
  mergeSecurities(loserId: string, winnerId: string): Promise<void>;
  getOverlay(userId: string, securityId: string): Promise<OverlayRecord | null>;
}

/**
 * The two schema invariants, restated as errors the fake can raise.
 *
 * Named after the constraints they stand in for, so that a failure in a unit
 * test and a failure in a `*-db` test read the same and a reader can tell they
 * are the same claim.
 */
export type SecurityConstraint =
  | 'securities_identity_kind_check'
  | 'security_identifiers_user_key_uniq'
  | 'security_identifiers_proprietary_names_its_issuer';

export class SecurityConstraintError extends Error {
  // A field and an assignment rather than a TypeScript parameter property: the
  // repo compiles with `erasableSyntaxOnly`, so every construct has to survive
  // type stripping with no emit.
  readonly constraint: SecurityConstraint;

  constructor(constraint: SecurityConstraint, message: string) {
    super(message);
    this.name = 'SecurityConstraintError';
    this.constraint = constraint;
  }
}

const IDENTITY_KINDS_SET = new Set<string>(IDENTITY_KINDS);

function assertInsertable(row: NewSecurity): void {
  if (!IDENTITY_KINDS_SET.has(row.identityKind)) {
    throw new SecurityConstraintError(
      'securities_identity_kind_check',
      `a security cannot be identified by a '${row.identityKind}' name. A provider's own id is ` +
        'evidence, never identity (D25); the resolver must abstain and emit ' +
        'investments.SecurityResolutionFailed rather than mint a row.',
    );
  }
}

// ---------------------------------------------------------------------------
// The in-memory store
// ---------------------------------------------------------------------------

export interface InMemorySecurityStore extends SecurityStore {
  /** Every row, for a test that wants to count them. */
  readonly rows: readonly SecurityRecord[];
  readonly identifiers: readonly IdentifierRow[];
  setOverlay(overlay: OverlayRecord & { readonly userId: string }): void;
}

/**
 * A `Clock`, never a constructed date: the repo's lint rule forbids building one
 * anywhere a clock could be injected, and it is right to — a store whose
 * `created_at` came from the wall clock would make the merge rule's
 * earliest-row tie-break untestable, which is the one place a timestamp here
 * is load-bearing.
 */
export function inMemorySecurityStore(clock: Clock = systemClock): InMemorySecurityStore {
  const rows = new Map<string, SecurityRecord>();
  const identifiers = new Map<string, IdentifierRow>();
  const overlays = new Map<string, OverlayRecord>();
  const keyOf = (userId: string, identifierKey: string): string =>
    `${userId}\u001f${identifierKey}`;

  return {
    get rows() {
      return [...rows.values()];
    },
    get identifiers() {
      return [...identifiers.values()];
    },

    findByIdentifierKeys(userId, keys) {
      const matches: IdentifierMatch[] = [];
      for (const key of keys) {
        const row = identifiers.get(keyOf(userId, key));
        if (row === undefined) continue;
        matches.push({ identifierKey: key, kind: row.kind, securityId: row.securityId });
      }
      return Promise.resolve(matches);
    },

    getSecurity(userId, securityId) {
      const row = rows.get(securityId);
      return Promise.resolve(row !== undefined && row.userId === userId ? row : null);
    },

    insertSecurity(row) {
      assertInsertable(row);
      for (const existing of rows.values()) {
        if (existing.userId === row.userId && existing.identityKey === row.identityKey) {
          throw new SecurityConstraintError(
            'security_identifiers_user_key_uniq',
            `securities_user_identity_idx: ${row.identityKey} already identifies a security`,
          );
        }
      }
      const record: SecurityRecord = {
        ...row,
        id: newId(),
        mergedIntoId: null,
        createdAt: clock.now(),
      };
      rows.set(record.id, record);
      return Promise.resolve(record);
    },

    updateSecurity(securityId, patch) {
      const row = rows.get(securityId);
      if (row === undefined) return Promise.resolve();
      const next = { ...row, ...patch } as SecurityRecord;
      assertInsertable(next);
      rows.set(securityId, next);
      return Promise.resolve();
    },

    attachIdentifiers(newRows) {
      for (const row of newRows) {
        if (row.kind === 'proprietary' && row.provider === null) {
          throw new SecurityConstraintError(
            'security_identifiers_proprietary_names_its_issuer',
            'a proprietary identifier must name the provider that issued it',
          );
        }
        const key = keyOf(row.userId, row.identifierKey);
        const existing = identifiers.get(key);
        if (existing === undefined) {
          identifiers.set(key, row);
          continue;
        }
        if (existing.securityId !== row.securityId) {
          throw new SecurityConstraintError(
            'security_identifiers_user_key_uniq',
            `${row.identifierKey} already points at security ${existing.securityId}`,
          );
        }
        identifiers.set(key, { ...existing, seenAt: row.seenAt });
      }
      return Promise.resolve();
    },

    mergeSecurities(loserId, winnerId) {
      for (const [key, row] of identifiers) {
        if (row.securityId !== loserId) continue;
        identifiers.set(key, { ...row, securityId: winnerId });
      }
      const loser = rows.get(loserId);
      if (loser !== undefined) rows.set(loserId, { ...loser, mergedIntoId: winnerId });
      return Promise.resolve();
    },

    getOverlay(userId, securityId) {
      return Promise.resolve(overlays.get(keyOf(userId, securityId)) ?? null);
    },

    setOverlay(overlay) {
      overlays.set(keyOf(overlay.userId, overlay.securityId), overlay);
    },
  };
}

// ---------------------------------------------------------------------------
// The Drizzle store
// ---------------------------------------------------------------------------

function recordOf(row: typeof securities.$inferSelect): SecurityRecord {
  return {
    id: row.id,
    userId: row.userId,
    identityKind: row.identityKind,
    identityKey: row.identityKey,
    ticker: row.ticker,
    mic: row.mic,
    cusip: row.cusip,
    isin: row.isin,
    figi: row.figi,
    chain: row.chain,
    contract: row.contract,
    name: row.name,
    type: row.type,
    currency: row.currency,
    expenseRatio: row.expenseRatio,
    isCashEquivalent: row.isCashEquivalent,
    assetClass: row.assetClass,
    region: row.region,
    sector: row.sector,
    classificationSource: row.classificationSource,
    classificationDepth: row.classificationDepth,
    classificationResidual: row.classificationResidual,
    classificationFlagged: row.classificationFlagged,
    mergedIntoId: row.mergedIntoId,
    createdAt: row.createdAt,
  };
}

export function drizzleSecurityStore(
  executor: InvestmentsExecutor,
  clock: Clock = systemClock,
): SecurityStore {
  return {
    async findByIdentifierKeys(userId, keys) {
      if (keys.length === 0) return [];
      const found = await executor
        .select({
          identifierKey: securityIdentifiers.identifierKey,
          kind: securityIdentifiers.kind,
          securityId: securityIdentifiers.securityId,
        })
        .from(securityIdentifiers)
        .where(
          and(
            eq(securityIdentifiers.userId, userId),
            inArray(securityIdentifiers.identifierKey, [...keys]),
          ),
        );
      return found;
    },

    async getSecurity(userId, securityId) {
      const found = await executor
        .select()
        .from(securities)
        .where(and(eq(securities.userId, userId), eq(securities.id, securityId)))
        .limit(1);
      const row = found[0];
      return row === undefined ? null : recordOf(row);
    },

    async insertSecurity(row) {
      assertInsertable(row);
      const inserted = await executor
        .insert(securities)
        .values({
          id: newId(),
          userId: row.userId,
          identityKind: row.identityKind,
          identityKey: row.identityKey,
          ticker: row.ticker,
          mic: row.mic,
          cusip: row.cusip,
          isin: row.isin,
          figi: row.figi,
          chain: row.chain,
          contract: row.contract,
          name: row.name,
          type: row.type,
          currency: row.currency,
          expenseRatio: row.expenseRatio,
          isCashEquivalent: row.isCashEquivalent,
          assetClass: row.assetClass,
          region: row.region,
          sector: row.sector,
          classificationSource: row.classificationSource,
          classificationDepth: row.classificationDepth,
          classificationResidual: row.classificationResidual,
          classificationFlagged: row.classificationFlagged,
        })
        .returning();
      const created = inserted[0];
      if (created === undefined) {
        throw new Error('insertSecurity: the insert returned no row');
      }
      return recordOf(created);
    },

    async updateSecurity(securityId, patch) {
      await executor
        .update(securities)
        .set({ ...patch, updatedAt: clock.now() })
        .where(eq(securities.id, securityId));
    },

    async attachIdentifiers(rows) {
      for (const row of rows) {
        await executor
          .insert(securityIdentifiers)
          .values({
            id: newId(),
            userId: row.userId,
            securityId: row.securityId,
            kind: row.kind,
            value: row.value,
            chain: row.chain,
            mic: row.mic,
            identifierKey: row.identifierKey,
            provider: row.provider,
            confidence: row.confidence,
            firstSeenAt: row.seenAt,
            lastSeenAt: row.seenAt,
          })
          // A name we have already seen is not news; the only thing that
          // changes is when we last saw it. The `WHERE` clause is what makes a
          // collision *across* securities an error rather than a silent
          // re-point: if the key belongs to another security, nothing updates
          // and `mergeSecurities` is the only path that may move it.
          .onConflictDoUpdate({
            target: [securityIdentifiers.userId, securityIdentifiers.identifierKey],
            set: { lastSeenAt: row.seenAt },
            where: eq(securityIdentifiers.securityId, row.securityId),
          });
      }
    },

    async mergeSecurities(loserId, winnerId) {
      await executor
        .update(securityIdentifiers)
        .set({ securityId: winnerId })
        .where(eq(securityIdentifiers.securityId, loserId));
      await executor
        .update(securities)
        .set({ mergedIntoId: winnerId, updatedAt: clock.now() })
        .where(eq(securities.id, loserId));
    },

    async getOverlay(userId, securityId) {
      const found = await executor
        .select()
        .from(securityOverlay)
        .where(and(eq(securityOverlay.userId, userId), eq(securityOverlay.securityId, securityId)))
        .limit(1);
      const row = found[0];
      if (row === undefined) return null;
      return {
        securityId: row.securityId,
        assetClass: row.assetClass,
        region: row.region,
        sector: row.sector,
        expenseRatio: row.expenseRatio,
        lockedFields: row.lockedFields,
      };
    },
  };
}

/** `SELECT count(*)` over one of this context's tables. For proofs, not for app code. */
export async function countSecurities(
  executor: InvestmentsExecutor,
  userId: string,
): Promise<number> {
  const result = await executor.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM securities WHERE user_id = ${userId}::uuid`,
  );
  return Number(result.rows[0]?.count ?? '0');
}
