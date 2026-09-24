// SPDX-License-Identifier: MIT
/**
 * `/securities/{id}` — the securities master, and the user's overlay on it.
 *
 * WP 3.9. Two routes, and the interesting one is the `PATCH`: 04 §2.2's
 * **immutable facts plus a mutable overlay**, which is what makes a user's
 * asset-class correction survive a provider re-sync. The provider owns
 * `securities`; the user owns `security_overlay`; `effectiveClassificationOf`
 * decides which wins, field by field, and it is the context's function rather
 * than a `??` chain here.
 *
 * ## `locked_fields` is the whole mechanism, so the API makes it impossible to
 * forget
 *
 * The migration's rule is that **only a locked field wins**. A row that stored
 * `asset_class = 'US_BOND'` without `'asset_class'` in `locked_fields` is a
 * setting that silently does nothing — the worst shape a preference can take,
 * because the screen shows it and the chart ignores it. So this route does not
 * accept `lockedFields` from the client at all. Writing a value locks it;
 * writing `null` clears **and** unlocks it. There is no way through this API to
 * produce the inert row.
 *
 * ## Why a session is enough
 *
 * An overlay is the user disagreeing with a classifier about their own holding.
 * It writes no credential, reaches no provider, and is reversible in one call —
 * the same posture `rules.ts` argues for its own overlay writes. The step-up
 * assertions in this work package are on the things that are *not* that: the
 * rung-1 price override (`prices.ts`), the market-data source ladder and test
 * fetch (`market-data.ts`), and the sticky basis-method election
 * (`investments.ts`). §2 of `docs/evidence/phase-3/wp3.9-routes.md` states the
 * rule per row.
 */
import type { Database } from '@core/db';
import { newId } from '@core/kernel';
import {
  effectiveClassificationOf,
  type DerivedClassification,
  type StoredOverlay,
} from '@ctx/investments';
import {
  ASSET_CLASSES,
  OVERLAY_FIELDS,
  REGIONS,
  SECURITY_TYPES,
  securityOverlay,
  type AssetClass,
  type ClassificationSource,
  type OverlayField,
  type Region,
  type SecurityType,
} from '@ctx/investments/schema';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, problems } from '../problem.ts';
import type { RouteDeps } from './deps.ts';

interface SecurityRow extends Record<string, unknown> {
  id: string;
  identity_kind: string;
  identity_key: string;
  ticker: string | null;
  mic: string | null;
  cusip: string | null;
  isin: string | null;
  figi: string | null;
  chain: string | null;
  contract: string | null;
  name: string | null;
  type: SecurityType;
  currency: string | null;
  expense_ratio: string | null;
  is_cash_equivalent: boolean;
  asset_class: AssetClass;
  region: Region;
  sector: string;
  classification_source: ClassificationSource;
  classification_depth: number;
  classification_residual: string | null;
  classification_flagged: boolean;
  merged_into_id: string | null;
  o_asset_class: AssetClass | null;
  o_region: Region | null;
  o_sector: string | null;
  o_name: string | null;
  o_expense_ratio: string | null;
  o_is_cash_equivalent: boolean | null;
  o_note: string | null;
  o_locked_fields: OverlayField[] | null;
}

/**
 * One security and this user's overlay on it.
 *
 * `user_id` is on **both** sides of the join and in the `WHERE`. Another
 * holder's security id is indistinguishable from one that does not exist, which
 * is the answer a 404 gives and a 403 does not.
 */
async function readSecurity(
  database: Database,
  userId: string,
  securityId: string,
): Promise<SecurityRow | null> {
  const result = await database.execute<SecurityRow>(sql`
    SELECT s.id, s.identity_kind, s.identity_key, s.ticker, s.mic, s.cusip, s.isin, s.figi,
           s.chain, s.contract, s.name, s.type, s.currency, s.expense_ratio,
           s.is_cash_equivalent, s.asset_class, s.region, s.sector,
           s.classification_source, s.classification_depth, s.classification_residual,
           s.classification_flagged, s.merged_into_id,
           o.asset_class       AS o_asset_class,
           o.region            AS o_region,
           o.sector            AS o_sector,
           o.name              AS o_name,
           o.expense_ratio     AS o_expense_ratio,
           o.is_cash_equivalent AS o_is_cash_equivalent,
           o.note              AS o_note,
           o.locked_fields     AS o_locked_fields
      FROM securities s
      LEFT JOIN security_overlay o
        ON o.security_id = s.id AND o.user_id = ${userId}::uuid
     WHERE s.id = ${securityId}::uuid
       AND s.user_id = ${userId}::uuid
     LIMIT 1
  `);
  return result.rows[0] ?? null;
}

const overlayWire = z.object({
  assetClass: z.enum(ASSET_CLASSES).nullable(),
  region: z.enum(REGIONS).nullable(),
  sector: z.string().nullable(),
  name: z.string().nullable(),
  expenseRatio: z.string().nullable(),
  isCashEquivalent: z.boolean().nullable(),
  note: z.string().nullable(),
  lockedFields: z.array(z.enum(OVERLAY_FIELDS)),
});

const securityWire = z
  .object({
    id: z.uuid(),
    identityKind: z.string(),
    identityKey: z.string(),
    ticker: z.string().nullable(),
    mic: z.string().nullable(),
    cusip: z.string().nullable(),
    isin: z.string().nullable(),
    figi: z.string().nullable(),
    chain: z.string().nullable(),
    contract: z.string().nullable(),
    type: z.enum(SECURITY_TYPES),
    currency: z.string().nullable(),
    mergedIntoId: z.uuid().nullable(),
    /** What the provider and the classification waterfall say. Never user-written. */
    derived: z.object({
      name: z.string().nullable(),
      assetClass: z.enum(ASSET_CLASSES),
      region: z.enum(REGIONS),
      sector: z.string(),
      expenseRatio: z.string().nullable(),
      isCashEquivalent: z.boolean(),
      classificationSource: z.string(),
      classificationDepth: z.int().nonnegative(),
      classificationResidual: z.string().nullable(),
      classificationFlagged: z.boolean(),
    }),
    /** What the user said. `null` when they have said nothing. */
    overlay: overlayWire.nullable(),
    /** 04 §2.2's resolution. What every chart in the app actually reads. */
    effective: z.object({
      name: z.string().nullable(),
      assetClass: z.enum(ASSET_CLASSES),
      region: z.enum(REGIONS),
      sector: z.string(),
      expenseRatio: z.string().nullable(),
      isCashEquivalent: z.boolean(),
      /** `USER_OVERRIDE` whenever *any* field came from the user. */
      classificationSource: z.string(),
      overridden: z.array(z.enum(OVERLAY_FIELDS)),
    }),
  })
  .meta({ id: 'Security' });

function securityWireOf(row: SecurityRow): z.infer<typeof securityWire> {
  const derived: DerivedClassification = {
    assetClass: row.asset_class,
    region: row.region,
    sector: row.sector,
    expenseRatio: row.expense_ratio,
    classificationSource: row.classification_source,
  };
  const locked = row.o_locked_fields ?? [];
  const overlay: StoredOverlay | null =
    row.o_locked_fields === null
      ? null
      : {
          assetClass: row.o_asset_class,
          region: row.o_region,
          sector: row.o_sector,
          expenseRatio: row.o_expense_ratio,
          lockedFields: locked,
        };
  const effective = effectiveClassificationOf(derived, overlay);
  const nameOverridden = locked.includes('name') && row.o_name !== null;
  const cashOverridden = locked.includes('is_cash_equivalent') && row.o_is_cash_equivalent !== null;
  return {
    id: row.id,
    identityKind: row.identity_kind,
    identityKey: row.identity_key,
    ticker: row.ticker,
    mic: row.mic,
    cusip: row.cusip,
    isin: row.isin,
    figi: row.figi,
    chain: row.chain,
    contract: row.contract,
    type: row.type,
    currency: row.currency,
    mergedIntoId: row.merged_into_id,
    derived: {
      name: row.name,
      assetClass: row.asset_class,
      region: row.region,
      sector: row.sector,
      expenseRatio: row.expense_ratio,
      isCashEquivalent: row.is_cash_equivalent,
      classificationSource: row.classification_source,
      classificationDepth: row.classification_depth,
      classificationResidual: row.classification_residual,
      classificationFlagged: row.classification_flagged,
    },
    overlay:
      row.o_locked_fields === null
        ? null
        : {
            assetClass: row.o_asset_class,
            region: row.o_region,
            sector: row.o_sector,
            name: row.o_name,
            expenseRatio: row.o_expense_ratio,
            isCashEquivalent: row.o_is_cash_equivalent,
            note: row.o_note,
            lockedFields: locked,
          },
    effective: {
      name: nameOverridden ? row.o_name : row.name,
      assetClass: effective.assetClass,
      region: effective.region,
      sector: effective.sector,
      expenseRatio: effective.expenseRatio,
      isCashEquivalent: cashOverridden ? row.o_is_cash_equivalent === true : row.is_cash_equivalent,
      classificationSource:
        effective.overridden.length > 0 || nameOverridden || cashOverridden
          ? 'USER_OVERRIDE'
          : effective.source,
      // `name` and `is_cash_equivalent` are overlay fields the context's
      // resolver does not cover (it resolves the four classification fields),
      // so they are added here by the same "only a locked field wins" rule.
      overridden: [
        ...effective.overridden,
        ...(nameOverridden ? (['name'] as const) : []),
        ...(cashOverridden ? (['is_cash_equivalent'] as const) : []),
      ],
    },
  };
}

/**
 * The patch body.
 *
 * Every field is *optional and nullable*, and the two mean different things:
 * absent leaves the current value alone, `null` clears it and unlocks it.
 * `lockedFields` is deliberately **not** accepted — see the file header.
 */
const patchBody = z
  .object({
    assetClass: z.enum(ASSET_CLASSES).nullable().optional(),
    region: z.enum(REGIONS).nullable().optional(),
    sector: z.string().min(1).nullable().optional(),
    name: z.string().min(1).nullable().optional(),
    expenseRatio: z
      .string()
      .regex(/^\d*\.?\d+$/u, 'an expense ratio is a plain decimal string, e.g. "0.0003"')
      .nullable()
      .optional(),
    isCashEquivalent: z.boolean().nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'an empty patch changes nothing');

export const securityRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database } = deps;

  const requireSecurity = async (userId: string, securityId: string): Promise<SecurityRow> => {
    const row = await readSecurity(database, userId, securityId);
    if (row === null) {
      throw new AppError({
        status: 404,
        code: 'investments.security_not_found',
        title: 'Not Found',
        detail: `no security ${securityId}`,
        family: 'user',
      });
    }
    return row;
  };

  return async (app) => {
    app.get(
      '/securities/:securityId',
      {
        schema: {
          operationId: 'getSecurity',
          summary: 'One security: the derived facts, the user’s overlay, and the resolution',
          description:
            'Three blocks rather than one merged object, because "what the provider said" and ' +
            '"what I corrected" are different questions and a screen that offered to edit the ' +
            'merged value could not tell the user which half they were changing.',
          tags: ['investments'],
          params: z.object({ securityId: z.uuid() }),
          response: { 200: z.object({ security: securityWire }), ...problems(401, 404, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const row = await requireSecurity(session.userId, request.params.securityId);
        return { security: securityWireOf(row) };
      },
    );

    app.patch(
      '/securities/:securityId',
      {
        schema: {
          operationId: 'patchSecurity',
          summary: 'Set or clear the user’s overlay on one security (04 §3.2)',
          description:
            'A value sets **and locks** the field; `null` clears **and unlocks** it; an absent ' +
            'field is untouched. `lockedFields` is not accepted from the client — a stored ' +
            'value that is not locked is a setting that silently does nothing. A session is ' +
            'enough: this writes no credential and is reversible in one call.',
          tags: ['investments'],
          params: z.object({ securityId: z.uuid() }),
          body: patchBody,
          response: {
            200: z.object({ security: securityWire }),
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const existing = await requireSecurity(session.userId, request.params.securityId);
        const body = request.body;

        /**
         * Absent keeps, `null` clears, a value sets. One helper rather than
         * seven `if`s, so the three-way rule is written down once.
         */
        const merge = <T>(incoming: T | null | undefined, current: T | null): T | null =>
          incoming === undefined ? current : incoming;

        const next = {
          assetClass: merge(body.assetClass, existing.o_asset_class),
          region: merge(body.region, existing.o_region),
          sector: merge(body.sector, existing.o_sector),
          name: merge(body.name, existing.o_name),
          expenseRatio: merge(body.expenseRatio, existing.o_expense_ratio),
          isCashEquivalent: merge(body.isCashEquivalent, existing.o_is_cash_equivalent),
          note: merge(body.note, existing.o_note),
        };

        // The locked set is *derived* from which values are present, never
        // taken from the request. This is the invariant the file header is
        // about: a non-null value is locked, a null one is not, and there is no
        // third state an API caller can construct.
        const locked: OverlayField[] = [];
        if (next.assetClass !== null) locked.push('asset_class');
        if (next.region !== null) locked.push('region');
        if (next.sector !== null) locked.push('sector');
        if (next.name !== null) locked.push('name');
        if (next.expenseRatio !== null) locked.push('expense_ratio');
        if (next.isCashEquivalent !== null) locked.push('is_cash_equivalent');

        // Through Drizzle's builder rather than raw SQL for exactly one reason:
        // `locked_fields` is `text[]`, and hand-rolling a Postgres array
        // literal is the kind of string assembly that works until a value
        // contains a comma. The table definition already knows the type.
        await database
          .insert(securityOverlay)
          .values({
            id: newId(),
            userId: session.userId,
            securityId: request.params.securityId,
            assetClass: next.assetClass,
            region: next.region,
            sector: next.sector,
            name: next.name,
            expenseRatio: next.expenseRatio,
            isCashEquivalent: next.isCashEquivalent,
            note: next.note,
            lockedFields: locked,
          })
          .onConflictDoUpdate({
            target: [securityOverlay.userId, securityOverlay.securityId],
            set: {
              assetClass: next.assetClass,
              region: next.region,
              sector: next.sector,
              name: next.name,
              expenseRatio: next.expenseRatio,
              isCashEquivalent: next.isCashEquivalent,
              note: next.note,
              lockedFields: locked,
              updatedAt: deps.clock.now(),
            },
          });

        // Read back rather than echo the request: the response is what the next
        // `GET` will say, including the resolution the user actually cares
        // about (`effective`), which the request body does not contain.
        return {
          security: securityWireOf(
            await requireSecurity(session.userId, request.params.securityId),
          ),
        };
      },
    );
  };
};
