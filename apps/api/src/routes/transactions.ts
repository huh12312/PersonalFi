// SPDX-License-Identifier: MIT
/**
 * `/transactions`, `/transfers` and the CSV export.
 *
 * ## Pagination is keyset, and the contract is "pass `nextCursor` back verbatim"
 *
 * `cursor` is opaque: base64url of `<effective_date>|<id>`, produced by
 * `@ctx/ledger` and validated on the way back in. A client that parses it will
 * break the first time the ordering gains a tiebreaker, and one that uses an
 * offset will see transactions twice or never — a sync inserts rows *into the
 * middle* of a date-ordered feed, which makes offset pagination not slow but
 * **wrong** (04 §6.3).
 *
 * ## The summary is computed on the first page only
 *
 * 05 §4.3 puts "1,284 transactions · −$4,120.55" above the list, and both halves
 * are aggregates over the whole filter, not over the page. They are also the slow
 * half of the query. So they are returned when `cursor` is absent — the first
 * request for a given filter — and `null` on every subsequent page, which is
 * exactly when an infinite-scroll client would throw them away anyway.
 *
 * ## What "effective" means on the wire
 *
 * Every user-facing field below is the **resolved** value: the user's override if
 * they set one, the provider's fact otherwise. The provider's own numbers are not
 * hidden — they are in `GET /transactions/:id` under `provenance`, which is what
 * the detail drawer renders (04 §2.2). The list does not carry them because the
 * list is 200 rows and the answer to "where did this come from?" is one click
 * away.
 */
import { DateOnly, money as makeMoney, type Money as MoneyType } from '@core/kernel';
import {
  confirmTransferPair,
  getTransaction,
  countTransactions,
  listTransactions,
  rejectTransferPair,
  setTransactionOverlay,
  sumTransactions,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type LedgerTransaction,
  type OverlayPatch,
  type TransactionDetail,
  type TransactionFilters,
} from '@ctx/ledger';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, problems } from '../problem.ts';
import { clearTransactionSplits, setTransactionSplits } from '../ledger-splits.ts';
import {
  booleanQuery,
  dateOnly,
  dateOnlyQuery,
  idList,
  instantOrNull,
  isoInstant,
  minorQuery,
  money,
  moneySchema,
} from '../wire.ts';
import { mapDomainErrors } from './domain-errors.ts';
import type { RouteDeps } from './deps.ts';

/** Rows per page of the export loop. Not the API page size; this one never ships. */
const EXPORT_CHUNK = 1_000;

// ------------------------------------------------------------------ schemas

const splitSchema = z
  .object({
    id: z.uuid(),
    position: z.int().nonnegative(),
    amount: moneySchema,
    userCategoryId: z.uuid().nullable(),
    note: z.string().nullable(),
  })
  .meta({ id: 'TransactionSplit' });

const transactionSchema = z
  .object({
    id: z.uuid(),
    accountId: z.uuid(),
    factId: z.uuid().describe('The provider fact the current numbers were resolved from.'),
    date: dateOnly,
    amount: moneySchema.describe('Negative is an outflow. Always.'),
    name: z.string().describe('The resolved payee: the user’s name, else the provider’s.'),
    merchantId: z.uuid().nullable(),
    merchantName: z.string().nullable(),
    pending: z.boolean(),
    excluded: z.boolean().describe('The user took this out of budgets and totals.'),
    categoryId: z.uuid().nullable().describe('Opaque here; @ctx/categorization owns categories.'),
    note: z.string().nullable(),
    isTransfer: z.boolean(),
    transferLinkId: z.uuid().nullable(),
    refundOfId: z.uuid().nullable(),
    refundConfidence: z.number().nullable(),
    supersededById: z
      .uuid()
      .nullable()
      .describe('Set when another row supersedes this one. Marked, never hidden.'),
    supersededReason: z.enum(['duplicate', 'merged']).nullable(),
    createdAt: isoInstant,
    updatedAt: isoInstant,
  })
  .meta({
    id: 'Transaction',
    description:
      'A transaction as the reader resolves it: provider fact plus user overlay. The provider’s ' +
      'own numbers are under `provenance` in the detail endpoint.',
  });

const provenanceSchema = z
  .object({
    factId: z.uuid(),
    provider: z.string(),
    providerTransactionId: z.string(),
    pendingTransactionId: z.string().nullable(),
    postedDate: dateOnly,
    authorizedDate: dateOnly.nullable(),
    providerName: z.string(),
    providerMerchantName: z.string().nullable(),
    providerAmount: moneySchema,
    paymentChannel: z.string().nullable(),
    pending: z.boolean(),
    revision: z.int().positive().describe('How many times the provider has restated this row.'),
    firstSeenAt: isoInstant,
    lastSeenAt: isoInstant,
    removedAt: isoInstant.nullable(),
  })
  .meta({ id: 'TransactionProvenance' });

const transferLinkSchema = z
  .object({
    id: z.uuid(),
    otherTransactionId: z.uuid(),
    direction: z.enum(['outflow', 'inflow']),
    amount: moneySchema,
    dayGap: z.int().nonnegative(),
    confidence: z.number(),
    howMatched: z.string(),
  })
  .meta({ id: 'TransferLink' });

const transactionDetailSchema = transactionSchema
  .extend({
    provenance: provenanceSchema,
    splits: z.array(splitSchema),
    transfer: transferLinkSchema.nullable(),
    removedAt: isoInstant.nullable().describe('The provider retracted this row.'),
  })
  .meta({ id: 'TransactionDetail' });

const summarySchema = z
  .object({
    count: z.int().nonnegative(),
    totals: z
      .array(moneySchema)
      .describe('Summed per currency, transfers excluded. Never summed across currencies.'),
  })
  .meta({ id: 'TransactionSummary' });

const overlayPatchSchema = z
  .object({
    note: z.string().max(2_000).nullable().optional(),
    excluded: z.boolean().optional(),
    categoryId: z.uuid().nullable().optional(),
    payeeName: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .describe('The user’s name for the payee. `null` restores the provider’s.'),
  })
  .meta({ id: 'TransactionOverlayPatch' });

const listQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  accountIds: idList,
  merchantIds: idList,
  categoryIds: idList,
  from: dateOnlyQuery.optional(),
  to: dateOnlyQuery.optional(),
  amountMin: minorQuery,
  amountMax: minorQuery,
  q: z.string().max(200).optional(),
  pending: booleanQuery,
  excluded: booleanQuery,
  transfers: z.enum(['include', 'exclude', 'only']).optional(),
  uncategorized: booleanQuery,
  includeRemoved: booleanQuery,
  includeDuplicates: booleanQuery,
});

type ListQuery = z.infer<typeof listQuery>;
type FilterQuery = Omit<ListQuery, 'cursor' | 'limit'>;

// ------------------------------------------------------------- serialisation

function serialiseTransaction(row: LedgerTransaction): z.infer<typeof transactionSchema> {
  return {
    id: row.id,
    accountId: row.accountId,
    factId: row.factId,
    date: row.effective.date,
    amount: money(row.effective.amount),
    name: row.effective.name,
    merchantId: row.merchantId,
    merchantName: row.effective.merchantDisplayName,
    pending: row.effective.pending,
    excluded: row.effective.excluded,
    categoryId: row.effective.categoryId,
    note: row.effective.note,
    isTransfer: row.isTransfer,
    transferLinkId: row.transferLinkId,
    refundOfId: row.refundOfId,
    refundConfidence: row.refundConfidence,
    supersededById: row.supersededById,
    supersededReason: row.supersededReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serialiseDetail(detail: TransactionDetail): z.infer<typeof transactionDetailSchema> {
  return {
    ...serialiseTransaction(detail),
    // `merchantDisplayName` on the detail is the merchants-table row; the
    // effective name may be the user's override of it. Prefer the override.
    merchantName: detail.effective.merchantDisplayName ?? detail.merchantDisplayName,
    removedAt: instantOrNull(detail.removedAt),
    provenance: {
      factId: detail.provenance.factId,
      provider: detail.provenance.provider,
      providerTransactionId: detail.provenance.providerTransactionId,
      pendingTransactionId: detail.provenance.pendingTransactionId,
      postedDate: detail.provenance.postedDate,
      authorizedDate: detail.provenance.authorizedDate,
      providerName: detail.provenance.providerName,
      providerMerchantName: detail.provenance.providerMerchantName,
      providerAmount: money(detail.provenance.providerAmount),
      paymentChannel: detail.provenance.paymentChannel,
      pending: detail.provenance.pending,
      revision: detail.provenance.revision,
      firstSeenAt: detail.provenance.firstSeenAt.toISOString(),
      lastSeenAt: detail.provenance.lastSeenAt.toISOString(),
      removedAt: instantOrNull(detail.provenance.removedAt),
    },
    splits: detail.splits.map((split) => ({
      id: split.id,
      position: split.position,
      amount: money(split.amount),
      userCategoryId: split.userCategoryId,
      note: split.note,
    })),
    transfer:
      detail.transfer === null
        ? null
        : {
            id: detail.transfer.id,
            otherTransactionId: detail.transfer.otherTransactionId,
            direction: detail.transfer.direction,
            amount: money(detail.transfer.amount),
            dayGap: detail.transfer.dayGap,
            confidence: detail.transfer.confidence,
            howMatched: detail.transfer.howMatched,
          },
  };
}

/**
 * Query string → `TransactionFilters`.
 *
 * Every property is conditionally spread rather than assigned `undefined`:
 * `exactOptionalPropertyTypes` is on, and `{ pending: undefined }` is a
 * different thing from `{}` to both TypeScript and the filter builder — the
 * latter means "show both", which is the default a user expects.
 */
function filtersOf(query: FilterQuery): TransactionFilters {
  return {
    ...(query.accountIds === undefined ? {} : { accountIds: query.accountIds }),
    ...(query.merchantIds === undefined ? {} : { merchantIds: query.merchantIds }),
    ...(query.categoryIds === undefined ? {} : { categoryIds: query.categoryIds }),
    ...(query.from === undefined ? {} : { dateFrom: DateOnly.parse(query.from) }),
    ...(query.to === undefined ? {} : { dateTo: DateOnly.parse(query.to) }),
    ...(query.amountMin === undefined ? {} : { amountMinMinor: query.amountMin }),
    ...(query.amountMax === undefined ? {} : { amountMaxMinor: query.amountMax }),
    ...(query.pending === undefined ? {} : { pending: query.pending }),
    ...(query.excluded === undefined ? {} : { excluded: query.excluded }),
    ...(query.transfers === undefined ? {} : { transfers: query.transfers }),
    ...(query.uncategorized === undefined ? {} : { uncategorized: query.uncategorized }),
    ...(query.q === undefined ? {} : { search: query.q }),
    ...(query.includeRemoved === undefined ? {} : { includeRemoved: query.includeRemoved }),
    ...(query.includeDuplicates === undefined
      ? {}
      : { includeDuplicates: query.includeDuplicates }),
  };
}

function patchOf(body: z.infer<typeof overlayPatchSchema>): OverlayPatch {
  return {
    ...(body.note === undefined ? {} : { userNote: body.note }),
    ...(body.excluded === undefined ? {} : { userExcluded: body.excluded }),
    ...(body.categoryId === undefined ? {} : { userCategoryId: body.categoryId }),
    ...(body.payeeName === undefined ? {} : { userMerchantName: body.payeeName }),
  };
}

/** RFC 4180: quote everything, double an embedded quote. Never guess. */
function csvCell(value: string | null): string {
  return `"${(value ?? '').replaceAll('"', '""')}"`;
}

export const transactionRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;

  function writeContext(requestId: string): { clock: typeof clock; correlationId: string } {
    return { clock, correlationId: requestId };
  }

  return async (app) => {
    app.get(
      '/transactions',
      {
        schema: {
          operationId: 'listTransactions',
          summary: 'The transaction feed',
          description:
            'Keyset pagination over `(date DESC, id DESC)`. Pass `nextCursor` back verbatim; it is ' +
            'opaque and a client that parses it will break. `summary` is returned on the first ' +
            'page of a filter (no `cursor`) and is `null` on subsequent pages.',
          tags: ['transactions'],
          querystring: listQuery,
          response: {
            200: z.object({
              items: z.array(transactionSchema),
              nextCursor: z.string().nullable(),
              summary: summarySchema.nullable(),
            }),
            ...problems(400, 401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const filters = filtersOf(request.query);
        const input = {
          userId: session.userId,
          filters,
          limit: request.query.limit,
          ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        };

        const page = await mapDomainErrors(() => listTransactions(database, input));

        let summary: z.infer<typeof summarySchema> | null = null;
        if (request.query.cursor === undefined) {
          const [count, totals] = await Promise.all([
            countTransactions(database, { userId: session.userId, filters }),
            sumTransactions(database, { userId: session.userId, filters }),
          ]);
          summary = { count, totals: totals.map((total) => money(total.total)) };
        }

        return {
          items: page.items.map(serialiseTransaction),
          nextCursor: page.nextCursor,
          summary,
        };
      },
    );

    app.get(
      '/transactions/export.csv',
      {
        schema: {
          operationId: 'exportTransactions',
          summary: 'Every matching transaction, as CSV',
          description:
            'Needs a step-up assertion (decision D21). A stolen session cookie must not be enough ' +
            'to walk out with the complete history. Accepts the same filters as the list.',
          tags: ['transactions'],
          querystring: listQuery.omit({ cursor: true, limit: true }),
          produces: ['text/csv'],
          response: {
            200: z.string().describe('RFC 4180 CSV, one header row.'),
            ...problems(400, 401, 403, 503),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireFreshSession(request);
        const filters = filtersOf(request.query);

        const lines = [
          'date,name,amount_minor,currency,account_id,category_id,pending,excluded,transfer,note',
        ];
        let cursor: string | null = null;
        // Keyset, not one 50,000-row statement: the export has to hold no more
        // than a chunk in memory and must stay stable while a sync writes.
        for (;;) {
          const page: Awaited<ReturnType<typeof listTransactions>> = await listTransactions(
            database,
            {
              userId: session.userId,
              filters,
              limit: EXPORT_CHUNK,
              ...(cursor === null ? {} : { cursor }),
            },
          );
          for (const row of page.items) {
            lines.push(
              [
                csvCell(row.effective.date),
                csvCell(row.effective.name),
                csvCell(row.effective.amount.minor.toString()),
                csvCell(row.effective.amount.currency),
                csvCell(row.accountId),
                csvCell(row.effective.categoryId),
                csvCell(String(row.effective.pending)),
                csvCell(String(row.effective.excluded)),
                csvCell(String(row.isTransfer)),
                csvCell(row.effective.note),
              ].join(','),
            );
          }
          if (page.nextCursor === null) break;
          cursor = page.nextCursor;
        }

        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="transactions.csv"')
          .send(`${lines.join('\n')}\n`);
      },
    );

    app.get(
      '/transactions/:transactionId',
      {
        schema: {
          operationId: 'getTransaction',
          summary: 'One transaction, with provenance, splits and its transfer link',
          tags: ['transactions'],
          params: z.object({ transactionId: z.uuid() }),
          response: { 200: transactionDetailSchema, ...problems(401, 404, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const detail = await mapDomainErrors(() =>
          getTransaction(database, {
            userId: session.userId,
            transactionId: request.params.transactionId,
          }),
        );
        return serialiseDetail(detail);
      },
    );

    app.patch(
      '/transactions/:transactionId',
      {
        schema: {
          operationId: 'updateTransaction',
          summary: 'Write the user overlay',
          description:
            'Provider facts are immutable. This writes intent — note, category, exclusion, payee ' +
            'name — which the resolver layers over the fact and which survives every re-sync.',
          tags: ['transactions'],
          params: z.object({ transactionId: z.uuid() }),
          body: overlayPatchSchema,
          response: { 200: transactionSchema, ...problems(400, 401, 404, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const updated = await mapDomainErrors(() =>
          setTransactionOverlay(
            database,
            {
              userId: session.userId,
              transactionId: request.params.transactionId,
              patch: patchOf(request.body),
            },
            writeContext(String(request.id)),
          ),
        );
        return serialiseTransaction(updated);
      },
    );

    app.post(
      '/transactions/bulk',
      {
        schema: {
          operationId: 'bulkUpdateTransactions',
          summary: 'Apply one overlay patch to many transactions',
          description:
            'One transaction, so a bulk categorise is one undo entry and one toast (05 §5.3). ' +
            'An id that does not exist fails the whole batch rather than being skipped silently.',
          tags: ['transactions'],
          body: z.object({
            transactionIds: z.array(z.uuid()).min(1).max(1_000),
            patch: overlayPatchSchema,
          }),
          response: {
            200: z.object({ updated: z.int().nonnegative(), items: z.array(transactionSchema) }),
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const patch = patchOf(request.body.patch);
        const context = writeContext(String(request.id));
        const updated = await mapDomainErrors(() =>
          database.transaction(async (tx) => {
            const rows: LedgerTransaction[] = [];
            for (const transactionId of request.body.transactionIds) {
              rows.push(
                await setTransactionOverlay(
                  tx,
                  { userId: session.userId, transactionId, patch },
                  context,
                ),
              );
            }
            return rows;
          }),
        );
        return { updated: updated.length, items: updated.map(serialiseTransaction) };
      },
    );

    app.post(
      '/transactions/:transactionId/splits',
      {
        schema: {
          operationId: 'setTransactionSplits',
          summary: 'Divide a transaction across categories',
          description:
            'Replaces the existing splits wholesale. The lines must sum to the transaction, to ' +
            'the cent, in its currency: a set that does not is `ledger.splits_do_not_sum` (422).',
          tags: ['transactions'],
          params: z.object({ transactionId: z.uuid() }),
          body: z.object({
            splits: z
              .array(
                z.object({
                  amount: moneySchema,
                  userCategoryId: z.uuid().nullable().default(null),
                  note: z.string().max(2_000).nullable().default(null),
                }),
              )
              .min(2, 'a split has at least two lines; to undo one, DELETE the splits'),
          }),
          response: {
            200: z.object({ splits: z.array(splitSchema) }),
            ...problems(400, 401, 404, 409, 422, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const splits = request.body.splits.map((split) => ({
          amount: parseMoney(split.amount),
          userCategoryId: split.userCategoryId,
          note: split.note,
        }));
        const written = await mapDomainErrors(() =>
          database.transaction((tx) =>
            setTransactionSplits(
              tx,
              { userId: session.userId, transactionId: request.params.transactionId, splits },
              { clock },
            ),
          ),
        );
        return {
          splits: written.map((split) => ({
            id: split.id,
            position: split.position,
            amount: money(split.amount),
            userCategoryId: split.userCategoryId,
            note: split.note,
          })),
        };
      },
    );

    app.delete(
      '/transactions/:transactionId/splits',
      {
        schema: {
          operationId: 'clearTransactionSplits',
          summary: 'Undo a split',
          tags: ['transactions'],
          params: z.object({ transactionId: z.uuid() }),
          response: {
            200: z.object({ removed: z.int().nonnegative() }),
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return mapDomainErrors(() =>
          clearTransactionSplits(database, {
            userId: session.userId,
            transactionId: request.params.transactionId,
          }),
        );
      },
    );

    // ------------------------------------------------------------- transfers

    app.post(
      '/transfers/pair',
      {
        schema: {
          operationId: 'pairTransfer',
          summary: 'Confirm that two rows are one movement of money',
          description:
            'Confidence 1.0 and `user_confirmed`: this is not a heuristic. Any standing rejection ' +
            'of the same pair is withdrawn, so the next pairing run does not silently refuse to ' +
            're-propose what the user just confirmed.',
          tags: ['transactions'],
          body: z.object({ outflowTransactionId: z.uuid(), inflowTransactionId: z.uuid() }),
          response: {
            200: z.object({ transferLinkId: z.uuid() }),
            ...problems(400, 401, 404, 409, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return mapDomainErrors(() =>
          database.transaction((tx) =>
            confirmTransferPair(
              tx,
              {
                userId: session.userId,
                outflowTransactionId: request.body.outflowTransactionId,
                inflowTransactionId: request.body.inflowTransactionId,
              },
              writeContext(String(request.id)),
            ),
          ),
        );
      },
    );

    app.post(
      '/transfers/:transactionId/reject',
      {
        schema: {
          operationId: 'rejectTransfer',
          summary: 'Say no to a transfer pairing, permanently',
          description:
            '`transactionId` is **either leg** of the pair; the other is read from the link. The ' +
            'rejection is recorded as well as undone, so the heuristic does not re-propose it.',
          tags: ['transactions'],
          params: z.object({ transactionId: z.uuid() }),
          body: z.object({
            otherTransactionId: z
              .uuid()
              .optional()
              .describe('Required only when the two rows are not currently linked.'),
            reason: z.string().max(200).optional(),
          }),
          response: {
            200: z.object({ unlinked: z.boolean() }),
            ...problems(400, 401, 404, 409, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const { transactionId } = request.params;

        const other = await mapDomainErrors(async () => {
          if (request.body.otherTransactionId !== undefined) return request.body.otherTransactionId;
          const detail = await getTransaction(database, {
            userId: session.userId,
            transactionId,
          });
          if (detail.transfer === null) {
            throw new AppError({
              status: 409,
              code: 'ledger.transfer_not_linked',
              title: 'Conflict',
              detail:
                'This transaction is not part of a transfer pair. Supply `otherTransactionId` to ' +
                'reject a proposal that was never linked.',
              family: 'domain',
            });
          }
          return detail.transfer.otherTransactionId;
        });

        return mapDomainErrors(() =>
          database.transaction((tx) =>
            rejectTransferPair(
              tx,
              {
                userId: session.userId,
                transactionIdA: transactionId,
                transactionIdB: other,
                ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
              },
              writeContext(String(request.id)),
            ),
          ),
        );
      },
    );
  };
};

/** `{minor, currency}` → `Money`. The schema already proved the shape. */
function parseMoney(value: z.infer<typeof moneySchema>): MoneyType {
  return makeMoney(BigInt(value.minor), value.currency);
}
