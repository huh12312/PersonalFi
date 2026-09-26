// SPDX-License-Identifier: MIT
/**
 * Security tags — migration `0026_allocation_targets.sql`.
 *
 * 07 I5, verbatim: *"an employer is never inferred."* `employer_stock` is the
 * holder's own claim, attached through exactly one function —
 * {@link setSecurityTag} — and there is no second writer anywhere in this
 * package. `test/tags.test.ts`'s structural test greps the whole `src/` tree
 * (comments stripped, the `packages/connectors/coinbase/test/no-trade-surface.test.ts`
 * pattern WP 3.5 established) and fails if a second file so much as mentions
 * "employer", let alone writes the tag.
 *
 * `watchlist` rides the same table because both are "the holder's own claim
 * about a security" and nothing distinguishes them structurally; only
 * `employer_stock` carries the never-infer rule, because only I5 depends on it.
 */
import { newId, systemClock, type Clock } from '@core/kernel';
import { and, eq } from 'drizzle-orm';
import {
  securityTags,
  type NewSecurityTagRow,
  type SecurityTagKind,
  type SecurityTagRow,
} from '../schema/index.ts';
import type { InvestmentsDatabase } from './store.ts';

export interface SecurityTag {
  readonly securityId: string;
  readonly tag: SecurityTagKind;
  readonly setAt: Date;
}

function tagFromRow(row: SecurityTagRow): SecurityTag {
  return { securityId: row.securityId, tag: row.tag, setAt: row.setAt };
}

export interface SecurityTagsStore {
  /** Every tag on one security. Empty when the holder has set none. */
  readonly listFor: (userId: string, securityId: string) => Promise<readonly SecurityTag[]>;
  /**
   * Every tag across a set of securities, in one read — the shape
   * `createInsightsInvestmentsPort`'s composition wants, so filling in
   * `employerStock` for a whole portfolio is one query rather than one per
   * position.
   */
  readonly listForMany: (
    userId: string,
    securityIds: readonly string[],
  ) => Promise<ReadonlyMap<string, ReadonlySet<SecurityTagKind>>>;
  /**
   * Attach a tag. Idempotent: setting a tag that is already set changes
   * nothing but `setAt`. This is the **only** writer — see the file header.
   */
  readonly set: (userId: string, securityId: string, tag: SecurityTagKind) => Promise<void>;
  /** Detach a tag. Idempotent: clearing an absent tag is not an error. */
  readonly clear: (userId: string, securityId: string, tag: SecurityTagKind) => Promise<void>;
}

/** The real store, over `0026_allocation_targets.sql`. */
export function drizzleSecurityTagsStore(db: InvestmentsDatabase, clock: Clock): SecurityTagsStore {
  return {
    async listFor(userId, securityId) {
      const rows = await db
        .select()
        .from(securityTags)
        .where(and(eq(securityTags.userId, userId), eq(securityTags.securityId, securityId)));
      return rows.map(tagFromRow);
    },

    async listForMany(userId, securityIds) {
      const byId = new Map<string, Set<SecurityTagKind>>();
      if (securityIds.length === 0) return byId;
      const rows = await db.select().from(securityTags).where(eq(securityTags.userId, userId));
      for (const row of rows) {
        if (!securityIds.includes(row.securityId)) continue;
        const set = byId.get(row.securityId) ?? new Set<SecurityTagKind>();
        set.add(row.tag);
        byId.set(row.securityId, set);
      }
      return byId;
    },

    async set(userId, securityId, tag) {
      const row: NewSecurityTagRow = { id: newId(), userId, securityId, tag, setAt: clock.now() };
      await db
        .insert(securityTags)
        .values(row)
        .onConflictDoUpdate({
          target: [securityTags.userId, securityTags.securityId, securityTags.tag],
          set: { setAt: row.setAt },
        });
    },

    async clear(userId, securityId, tag) {
      await db
        .delete(securityTags)
        .where(
          and(
            eq(securityTags.userId, userId),
            eq(securityTags.securityId, securityId),
            eq(securityTags.tag, tag),
          ),
        );
    },
  };
}

/**
 * For `test/tags.test.ts` and for the seam a fake `InsightsInvestmentsPort`
 * composition can drive without a database. Enforces nothing beyond the type
 * — there is no invariant here the schema states that this fake could violate,
 * unlike `inMemoryAllocationTargetsStore`'s sum-to-one rule.
 */
export function inMemorySecurityTagsStore(clock: Clock = systemClock): SecurityTagsStore {
  const byUser = new Map<string, Map<string, Set<SecurityTagKind>>>();
  const forUser = (userId: string): Map<string, Set<SecurityTagKind>> => {
    const existing = byUser.get(userId);
    if (existing !== undefined) return existing;
    const created = new Map<string, Set<SecurityTagKind>>();
    byUser.set(userId, created);
    return created;
  };

  return {
    async listFor(userId, securityId) {
      const setAt = clock.now();
      const tags = forUser(userId).get(securityId);
      if (tags === undefined) return [];
      return [...tags].map((tag) => ({ securityId, tag, setAt }));
    },

    async listForMany(userId, securityIds) {
      const byId = new Map<string, ReadonlySet<SecurityTagKind>>();
      const securities = forUser(userId);
      for (const securityId of securityIds) {
        const tags = securities.get(securityId);
        if (tags !== undefined) byId.set(securityId, new Set(tags));
      }
      return byId;
    },

    async set(userId, securityId, tag) {
      const securities = forUser(userId);
      const tags = securities.get(securityId) ?? new Set<SecurityTagKind>();
      tags.add(tag);
      securities.set(securityId, tags);
    },

    async clear(userId, securityId, tag) {
      forUser(userId).get(securityId)?.delete(tag);
    },
  };
}
