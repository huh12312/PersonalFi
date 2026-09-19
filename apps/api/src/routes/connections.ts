// SPDX-License-Identifier: MIT
/**
 * `/connectors`, `/connections` and `/imports/csv` — the provider seam, as HTTP.
 *
 * ## `GET /connectors` is the "Add a connection" screen
 *
 * 08 §2.7's test of the abstraction is that adding a provider needs no UI change.
 * That is only true if the screen renders from a list the server sends, so this
 * endpoint returns `registry.manifests()` verbatim and the Plaid adapter appears
 * in the UI by being registered in `domain.ts` rather than by anyone editing a
 * component. `iconKey` is an asset key and never a URL: this payload is
 * server-controlled and the browser must not be tellable to fetch something
 * arbitrary from it.
 *
 * ## Step-up (decision D21)
 *
 * Adding a connection, completing or re-running its link, and removing it all
 * need a WebAuthn assertion from the last five minutes. The class of attack is a
 * stolen session cookie: possession of the cookie must not be enough to attach a
 * new institution to the account or to detach one and destroy its credential.
 * Reading a connection, its history and its stream needs only a session.
 *
 * ## Why `POST /connections/:id/sync` sometimes does not enqueue
 *
 * `ManualConnector`, `CsvImportConnector` and `SeedConnector` stage their rows in
 * **process memory** (WP 1.2). A job the API enqueues for one of them is picked
 * up by the worker, which has a different, empty store, and produces a
 * successful sync of nothing. So `PROCESS_LOCAL_PROVIDERS` runs those inline and
 * everything else through the queue. The response says which happened; it is 202
 * either way, because the authoritative answer is in `sync_runs` and not in this
 * response body. See the WP 1.5 evidence note — a durable staging area is
 * `@ctx/connections`'s to build, not this file's.
 */
import {
  CSV_PRESETS,
  type CsvFileInput,
  CsvImportConnector,
  IMPORT_PROVIDER,
  importFile,
  parseCsvProfile,
  presetById,
  type CsvProfile,
  type ImportFileInput,
} from '@connector/csv';
import { PLAID_PROVIDER } from '@connector/plaid';
import {
  capabilitiesSchema,
  connectionAccountSchema,
  connectionSummarySchema,
  connectorManifestSchema,
  countConnectionsByProvider,
  createConnection,
  disconnectConnection,
  getConnectionDetail,
  listConnectionSummaries,
  listSyncRuns,
  requireConnection,
  syncRunSchema,
  type ConnectionsContext,
} from '@ctx/connections';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ledgerWriter, PROCESS_LOCAL_PROVIDERS } from '../domain.ts';
import { AppError, problems } from '../problem.ts';
import { mapDomainErrors } from './domain-errors.ts';
import type { RouteDeps } from './deps.ts';

/**
 * A file upload as JSON, not `multipart/form-data`.
 *
 * Deliberate: the whole payload is a bank statement that has to be parsed in one
 * go anyway, the app's `bodyLimit` is 1 MiB and a year of CSV is a few hundred
 * kilobytes, and `@fastify/multipart` would be a dependency added to move bytes
 * that JSON already moves. A file that does not fit is a file that should be
 * split, and the 413 says so.
 */
const csvFileSchema = z
  .object({
    name: z.string().min(1).max(255).describe('For error messages and provenance. Never parsed.'),
    content: z.string().min(1).describe('The file, verbatim, as text.'),
    format: z
      .enum(['csv', 'ofx', 'qif'])
      .optional()
      .describe('Sniffed from the content if absent.'),
    presetId: z
      .enum(CSV_PRESETS.map((preset) => preset.id) as [string, ...string[]])
      .optional()
      .describe('One of the built-in column mappings. Mutually exclusive with `profile`.'),
    profile: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('A hand-built CSV mapping profile, when no preset fits.'),
    account: z
      .object({
        providerAccountId: z.string().min(1),
        name: z.string().min(1),
        type: z.enum(['depository', 'credit', 'loan', 'investment', 'crypto', 'manual']),
        currency: z.string().length(3),
        mask: z.string().max(4).nullable().optional(),
      })
      .optional()
      .describe('Required for CSV and QIF, which carry no account identity of their own.'),
  })
  .meta({ id: 'ImportFile' });

/**
 * `CsvFileInput.profile` → a resolved `CsvProfile`, or `null` for a format that
 * carries its own header (OFX). Duplicates `CsvImportConnector`'s own private
 * `resolveProfile` on purpose: both call the same two exported functions in the
 * same order, so the two can never disagree about what a preset id resolves to,
 * and this file has no way to reach the connector's private method to share it
 * (D2-2's fix runs here, not inside the connector — see `stagedCountsOf`).
 */
function resolveImportProfile(file: CsvFileInput): CsvProfile | null {
  if (file.profile === undefined) return null;
  if (typeof file.profile !== 'string') return parseCsvProfile(file.profile);
  const preset = presetById(file.profile);
  if (preset === null) {
    throw new AppError({
      status: 400,
      code: 'connections.unknown_provider',
      title: 'Bad Request',
      detail: `no import preset named ${JSON.stringify(file.profile)}`,
      family: 'user',
    });
  }
  return preset;
}

/**
 * How many rows a first upload actually staged (D2-2, gate-security-review.md
 * §9.4).
 *
 * `CsvImportConnector.connect()` calls its own `addFile` once per file and
 * discards each call's `{staged, skipped}` — the counts a *second* upload onto
 * an existing connection already gets, one line down in this same route. This
 * recomputes the identical count with the identical pure function
 * (`importFile`, content-hash deduped by `providerTransactionId`, cumulative
 * across the batch exactly as `addFile`'s own loop is), so a first cold upload
 * reports the true row count instead of the `0` a client could not trust.
 *
 * Deliberately a second parse rather than a change to the connector: the
 * connector's in-memory state is not this file's to reach into, and a CSV
 * upload is bounded (`csvFileSchema`'s 1 MiB body limit, twenty files), so
 * paying the parse twice costs milliseconds, not correctness.
 */
function stagedCountsOf(files: readonly CsvFileInput[]): { staged: number; skipped: number } {
  const seen = new Set<string>();
  let staged = 0;
  let skipped = 0;
  for (const file of files) {
    const profile = resolveImportProfile(file);
    const request: ImportFileInput = {
      name: file.name,
      content: file.content,
      ...(file.format === undefined ? {} : { format: file.format }),
      ...(file.account === undefined ? {} : { account: file.account }),
      ...(profile === null ? {} : { profile }),
    };
    const result = importFile(request);
    for (const transaction of result.transactions) {
      if (seen.has(transaction.providerTransactionId)) {
        skipped += 1;
        continue;
      }
      seen.add(transaction.providerTransactionId);
      staged += 1;
    }
  }
  return { staged, skipped };
}

const connectorManifest = connectorManifestSchema
  .extend({ capabilities: capabilitiesSchema })
  .meta({ id: 'ConnectorManifest' });
const connectionSummary = connectionSummarySchema.meta({ id: 'ConnectionSummary' });
const connectionAccount = connectionAccountSchema.meta({ id: 'ConnectionAccount' });
const syncRun = syncRunSchema.meta({ id: 'SyncRun' });
const connectionDetail = connectionSummary
  .extend({ accounts: z.array(connectionAccount), recentRuns: z.array(syncRun) })
  .meta({ id: 'ConnectionDetail' });

/**
 * Exported so `routes/plaid.ts` can return exactly this shape from
 * `POST /connections/plaid/exchange` — the same "link a provider" result every
 * other link-shaped route returns, rather than a second, structurally
 * identical schema that `jsonSchemaTransformObject` would have to hoist under
 * a different `.meta({ id })` or collide on this one.
 */
export const linkResultSchema = z
  .object({
    connectionId: z.uuid(),
    relinked: z.boolean().describe('True when this replaced the credential on an existing row.'),
    accountIds: z.array(z.uuid()),
    syncJobId: z.uuid().nullable().describe('The queued backfill, when one was queued.'),
    syncRunId: z.uuid().nullable().describe('The completed backfill, when it ran inline.'),
  })
  .meta({ id: 'LinkResult' });

const syncStartedSchema = z
  .object({
    mode: z
      .enum(['queued', 'inline'])
      .describe('`inline` means the adapter stages in this process and could not be queued.'),
    jobId: z.uuid().nullable(),
    syncRunId: z.uuid().nullable(),
    deduped: z.boolean().describe('A sync of this connection was already queued or running.'),
    status: z.enum(['running', 'success', 'partial', 'failed', 'skipped']).nullable(),
  })
  .meta({ id: 'SyncStarted' });

/** `{ userId, clock, correlationId }` — every context call needs exactly this. */
export function contextOf(deps: RouteDeps, userId: string, requestId: string): ConnectionsContext {
  return { userId, clock: deps.clock, correlationId: requestId };
}

/**
 * D16: Trial's hard cap on Plaid Items, per `client_id` (i.e. per
 * *deployment*, not per user or per connection). `/item/remove` does not free
 * a slot Plaid already counted, so the only lever this application has is
 * refusing to spend an eleventh Item locally, before ever calling Plaid.
 *
 * Lives here, not in `routes/plaid.ts`, because the check it names is enforced
 * inside `linkConnection` (below) — the one path every provider-linking route
 * shares — and `routes/plaid.ts` imports it from here for its own route
 * description rather than declaring a second copy that could drift.
 */
export const PLAID_ITEM_LIMIT = 10;

/**
 * Link or re-link, then start the backfill.
 *
 * Exported (not a closure inside `connectionRoutes`) so `routes/plaid.ts` can
 * drive the exact same path — `createConnection` inside a transaction,
 * `orchestrator.syncNow` in the same transaction, the process-local inline sync
 * after commit — for `POST /connections/plaid/exchange`, rather than a second,
 * drifting copy of "what does linking a provider actually do".
 *
 * `createConnection` and `syncNow` share one transaction on purpose: a link
 * that committed without its backfill enqueued is a connection that looks
 * linked and never syncs. The inline branch is the exception documented at the
 * top of this file, and it runs *after* the commit — an adapter's page loop
 * must not hold the connection that created the row.
 *
 * ## The Plaid Item ratchet is enforced here, not in a route (R-7, gate C-3)
 *
 * The gate found the ten-Item check only inside `POST /connections/plaid/exchange`
 * — so `POST /connections { "provider": "plaid", ... }` reached a real Item
 * exchange with the ratchet never consulted, and the count it did run was
 * `listConnectionSummaries(database, session.userId)`, scoped to one user
 * while Plaid's own cap is per deployment. Every provider-linking route in
 * this file (`POST /connections`, `/complete`, `/reconnect`) and
 * `routes/plaid.ts`'s `/connections/plaid/exchange` all call this one
 * function, so putting the check here — before `connector.connect` is ever
 * called — is the only placement that cannot be bypassed by routing around
 * it, and `countConnectionsByProvider` (`@ctx/connections`) counts every row
 * for the provider, across every user, disconnected included (D16: a
 * disconnected row may still hold a Plaid slot `/item/remove` never freed).
 */
export async function linkConnection(
  deps: RouteDeps,
  userId: string,
  requestId: string,
  body: { provider: string; input: unknown; config?: Record<string, unknown> },
  expectConnectionId: string | null,
): Promise<z.infer<typeof linkResultSchema>> {
  const { database } = deps;
  const { registry, orchestrator, secretBox } = deps.connections();
  const context = contextOf(deps, userId, requestId);
  const queued = !PROCESS_LOCAL_PROVIDERS.has(body.provider);

  const result = await mapDomainErrors(() =>
    database.transaction(async (tx) => {
      const connector = registry.get(body.provider);

      if (body.provider === PLAID_PROVIDER) {
        // Before `connector.connect` — a real Item exchange — is ever called.
        // Refusing here is what makes this a *ratchet* rather than a billing
        // surprise discovered after the fact.
        const existingCount = await countConnectionsByProvider(tx, body.provider);
        if (existingCount >= PLAID_ITEM_LIMIT) {
          throw new AppError({
            status: 409,
            code: 'connections.plaid_item_limit',
            title: 'Conflict',
            detail:
              `This deployment already has ${String(existingCount)} Plaid connections, at the ` +
              `Trial plan's ${String(PLAID_ITEM_LIMIT)}-Item cap. Disconnect one first — and ` +
              'remove it in the Plaid dashboard, since /item/remove there is what actually frees ' +
              'a slot.',
            family: 'domain',
          });
        }
      }

      const created = await createConnection(
        tx,
        {
          input: body.input,
          connector,
          secretBox,
          ledgerWriter,
          ...(body.config === undefined ? {} : { config: body.config }),
        },
        context,
      );
      if (expectConnectionId !== null && created.connectionId !== expectConnectionId) {
        // The artifact linked a *different* provider connection than the row
        // in the path. Refusing is the only safe answer: silently creating a
        // second connection under a URL that names the first is how a user
        // ends up with two of an institution and a doubled net worth.
        throw new AppError({
          status: 409,
          code: 'connections.link_mismatch',
          title: 'Conflict',
          detail: 'That link artifact belongs to a different connection.',
          family: 'domain',
        });
      }
      if (!queued) return { ...created, syncJobId: null };
      const job = await orchestrator.syncNow(tx, {
        connectionId: created.connectionId,
        userId,
        trigger: 'initial',
        correlationId: requestId,
      });
      return { ...created, syncJobId: job.jobId };
    }),
  );

  let syncRunId: string | null = null;
  if (!queued) {
    const summary = await orchestrator.syncConnection({
      connectionId: result.connectionId,
      userId,
      trigger: 'initial',
      correlationId: requestId,
    });
    syncRunId = summary.syncRunId;
  }

  return {
    connectionId: result.connectionId,
    relinked: result.relinked,
    accountIds: [...result.accountIds],
    syncJobId: result.syncJobId,
    syncRunId,
  };
}

export const connectionRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database } = deps;
  const link = (
    userId: string,
    requestId: string,
    body: { provider: string; input: unknown; config?: Record<string, unknown> },
    expectConnectionId: string | null,
  ): Promise<z.infer<typeof linkResultSchema>> =>
    linkConnection(deps, userId, requestId, body, expectConnectionId);

  return async (app) => {
    app.get(
      '/connectors',
      {
        schema: {
          operationId: 'listConnectors',
          summary: 'Every provider this deployment can link',
          description:
            'The "Add a connection" screen, as data. A new adapter appears here by being ' +
            'registered at the composition root; no UI change is required (08 §2.7).',
          tags: ['connections'],
          response: {
            200: z.object({ connectors: z.array(connectorManifest) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        await guards.requireSession(request);
        const { registry } = deps.connections();
        return {
          connectors: registry.manifests().map((manifest) => {
            // Copied, not spread through: the adapter's capability object is
            // frozen and its arrays are `readonly`, which the response schema's
            // (mutable) inferred type will not accept. One `[...]` here is
            // cheaper than a mutable capability declaration everywhere else.
            const capabilities = registry.get(manifest.provider).capabilities();
            return {
              ...manifest,
              capabilities: {
                ...capabilities,
                supports: [...capabilities.supports],
                currencies:
                  capabilities.currencies === 'multi'
                    ? capabilities.currencies
                    : [...capabilities.currencies],
              },
            };
          }),
        };
      },
    );

    app.get(
      '/connections',
      {
        schema: {
          operationId: 'listConnections',
          summary: 'Every connection, with status and freshness',
          description:
            'No credential appears in this payload — not as a field, not as a redacted ' +
            'placeholder, not as a boolean called `hasToken`. `status` plus `errorSince` is what ' +
            'the UI actually needs to say "stale for 26 hours".',
          tags: ['connections'],
          response: {
            200: z.object({ connections: z.array(connectionSummary) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return { connections: await listConnectionSummaries(database, session.userId) };
      },
    );

    app.get(
      '/connections/:connectionId',
      {
        schema: {
          operationId: 'getConnection',
          summary: 'One connection, its accounts and its recent runs',
          tags: ['connections'],
          params: z.object({ connectionId: z.uuid() }),
          response: { 200: connectionDetail, ...problems(401, 404, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return mapDomainErrors(() =>
          getConnectionDetail(database, session.userId, request.params.connectionId),
        );
      },
    );

    app.post(
      '/connections',
      {
        schema: {
          operationId: 'createConnection',
          summary: 'Link a provider',
          description:
            'Needs a step-up assertion (D21). `input` is opaque and validated by the adapter — a ' +
            'Plaid public token, a set of manual accounts, a file upload descriptor. A union here ' +
            'would have to grow with every provider and would be wrong the first time one ' +
            'changed its link flow. Re-linking an institution already connected updates that row ' +
            'and preserves its cursor and accounts; it never creates a second one.',
          tags: ['connections'],
          body: z.object({
            provider: z.string().min(1),
            input: z.unknown(),
            config: z.record(z.string(), z.unknown()).optional(),
          }),
          response: { 201: linkResultSchema, ...problems(400, 401, 403, 409, 502, 503) },
        },
      },
      async (request, reply) => {
        const session = await guards.requireFreshSession(request);
        const result = await link(
          session.userId,
          String(request.id),
          {
            provider: request.body.provider,
            input: request.body.input,
            ...(request.body.config === undefined ? {} : { config: request.body.config }),
          },
          null,
        );
        return reply.code(201).send(result);
      },
    );

    app.post(
      '/connections/:connectionId/complete',
      {
        schema: {
          operationId: 'completeConnection',
          summary: 'Finish a link whose flow ran in the browser',
          description:
            'The second half of a provider-hosted flow (08 §3.6): the user came back from Plaid ' +
            'Link with a public token and this exchanges it. Needs a step-up assertion. The ' +
            'resulting connection must be the one named in the path, or this is a 409 — silently ' +
            'creating a second connection under the first one’s URL is how a net worth doubles.',
          tags: ['connections'],
          params: z.object({ connectionId: z.uuid() }),
          body: z.object({
            input: z.unknown(),
            config: z.record(z.string(), z.unknown()).optional(),
          }),
          response: { 200: linkResultSchema, ...problems(400, 401, 403, 404, 409, 502, 503) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const row = await mapDomainErrors(() =>
          requireConnection(database, session.userId, request.params.connectionId),
        );
        return link(
          session.userId,
          String(request.id),
          {
            provider: row.provider,
            input: request.body.input,
            ...(request.body.config === undefined ? {} : { config: request.body.config }),
          },
          request.params.connectionId,
        );
      },
    );

    app.post(
      '/connections/:connectionId/reconnect',
      {
        schema: {
          operationId: 'reconnectConnection',
          summary: 'Replace the credential on an existing connection',
          description:
            'Needs a step-up assertion: a new credential is an addition, not a read. The cursor ' +
            'and every mapped account survive, which is the whole point — 08 §3.9, "losing ' +
            'account identity on reconnect is the classic way a personal finance app silently ' +
            'doubles a user’s net worth". `reconnectFlow` on the connector says what the UI ' +
            'should have collected: `provider_hosted`, `credential_form`, `reupload` or `none`.',
          tags: ['connections'],
          params: z.object({ connectionId: z.uuid() }),
          body: z.object({
            input: z.unknown(),
            config: z.record(z.string(), z.unknown()).optional(),
          }),
          response: {
            200: linkResultSchema.extend({
              reconnectFlow: z.enum(['provider_hosted', 'credential_form', 'reupload', 'none']),
            }),
            ...problems(400, 401, 403, 404, 409, 502, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const { registry } = deps.connections();
        const row = await mapDomainErrors(() =>
          requireConnection(database, session.userId, request.params.connectionId),
        );
        const reconnectFlow = registry.get(row.provider).capabilities().reconnectFlow;
        const result = await link(
          session.userId,
          String(request.id),
          {
            provider: row.provider,
            input: request.body.input,
            ...(request.body.config === undefined ? {} : { config: request.body.config }),
          },
          request.params.connectionId,
        );
        return { ...result, reconnectFlow };
      },
    );

    app.post(
      '/connections/:connectionId/sync',
      {
        schema: {
          operationId: 'syncConnection',
          summary: 'Ask for a sync now',
          description:
            'Returns the queued work, never the result: the result is in `sync_runs` and on the ' +
            'event stream. Deduped and singleton on the connection — a webhook, the nightly ' +
            'schedule and an impatient user cannot start three cursor loops on one connection, ' +
            'which 04 §4.4 calls "the fastest way to corrupt cursor state".',
          tags: ['connections'],
          params: z.object({ connectionId: z.uuid() }),
          response: { 202: syncStartedSchema, ...problems(401, 404, 409, 503) },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const { orchestrator } = deps.connections();
        const row = await mapDomainErrors(() =>
          requireConnection(database, session.userId, request.params.connectionId),
        );

        if (PROCESS_LOCAL_PROVIDERS.has(row.provider)) {
          const summary = await mapDomainErrors(() =>
            orchestrator.syncConnection({
              connectionId: row.id,
              userId: session.userId,
              trigger: 'manual',
              correlationId: String(request.id),
            }),
          );
          return reply.code(202).send({
            mode: 'inline' as const,
            jobId: null,
            syncRunId: summary.syncRunId,
            deduped: false,
            status: summary.status,
          });
        }

        const job = await mapDomainErrors(() =>
          database.transaction((tx) =>
            orchestrator.syncNow(tx, {
              connectionId: row.id,
              userId: session.userId,
              trigger: 'manual',
              correlationId: String(request.id),
            }),
          ),
        );
        return reply.code(202).send({
          mode: 'queued' as const,
          jobId: job.jobId,
          syncRunId: null,
          deduped: job.deduped,
          status: null,
        });
      },
    );

    app.get(
      '/connections/:connectionId/sync-runs',
      {
        schema: {
          operationId: 'listSyncRuns',
          summary: 'The sync history',
          description:
            '08 §6.3: "`sync_runs` is the observability surface that matters… this single feature ' +
            "eliminates most 'why is my balance wrong' debugging\". Every attempt leaves a row, " +
            'including the ones that failed before the first page.',
          tags: ['connections'],
          params: z.object({ connectionId: z.uuid() }),
          querystring: z.object({
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
          response: {
            200: z.object({ runs: z.array(syncRun) }),
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        await mapDomainErrors(() =>
          requireConnection(database, session.userId, request.params.connectionId),
        );
        return {
          runs: await listSyncRuns(
            database,
            session.userId,
            request.params.connectionId,
            request.query.limit,
          ),
        };
      },
    );

    app.delete(
      '/connections/:connectionId',
      {
        schema: {
          operationId: 'disconnectConnection',
          summary: 'Disconnect a provider',
          description:
            'Needs a step-up assertion (D21). Revokes at the provider best-effort, then destroys ' +
            'the local credential — the local half always happens, because a provider that is ' +
            'down must not be able to stop a user from disconnecting. **Accounts, transactions ' +
            'and the sync history are kept**: "disconnect" and "delete my data" are different ' +
            'requests and only one of them is reversible. `revokedAtProvider: false` means we ' +
            'could not tell the provider; with Plaid the Item still occupies a billing slot until ' +
            'it is removed there, so the UI should say so.',
          tags: ['connections'],
          params: z.object({ connectionId: z.uuid() }),
          response: {
            200: z.object({
              revokedAtProvider: z.boolean(),
              providerSlotMayRemain: z
                .boolean()
                .describe('True when revocation failed: the provider may still hold the item.'),
            }),
            ...problems(401, 403, 404, 409, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const { registry, secretBox } = deps.connections();
        const result = await mapDomainErrors(async () => {
          const row = await requireConnection(
            database,
            session.userId,
            request.params.connectionId,
          );
          return disconnectConnection(
            database,
            {
              connectionId: row.id,
              connector: registry.get(row.provider),
              secretBox,
            },
            contextOf(deps, session.userId, String(request.id)),
          );
        });
        return {
          revokedAtProvider: result.revokedAtProvider,
          providerSlotMayRemain: !result.revokedAtProvider,
        };
      },
    );

    app.post(
      '/imports/csv',
      {
        schema: {
          operationId: 'importFiles',
          summary: 'Import a CSV, OFX/QFX or QIF file',
          description:
            'Creates a file-import connection on the first upload and stages onto it thereafter, ' +
            'then runs the import **synchronously** — a file upload has no meaningful "come back ' +
            'later", and the adapter stages in this process (see the module comment). ' +
            'Re-importing the same file changes nothing: every row is identified by a hash of its ' +
            'own content, and the ledger’s natural key catches whatever the staging layer misses.',
          tags: ['connections'],
          body: z.object({
            connectionId: z
              .uuid()
              .optional()
              .describe('Omit to create a new file-import connection.'),
            displayName: z.string().min(1).max(120).default('File import'),
            files: z.array(csvFileSchema).min(1).max(20),
          }),
          response: {
            200: z.object({
              connectionId: z.uuid(),
              syncRunId: z.uuid().nullable(),
              staged: z.int().nonnegative(),
              skipped: z.int().nonnegative().describe('Rows already staged by an earlier upload.'),
              status: z.enum(['running', 'success', 'partial', 'failed', 'skipped']).nullable(),
            }),
            ...problems(400, 401, 404, 413, 422, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const { registry, orchestrator } = deps.connections();
        const connector = registry.get(IMPORT_PROVIDER);
        if (!(connector instanceof CsvImportConnector)) {
          throw new AppError({
            status: 503,
            code: 'connections.unknown_provider',
            title: 'Service Unavailable',
            detail: 'The file-import adapter is not registered in this deployment.',
            family: 'internal',
          });
        }

        const files: CsvFileInput[] = request.body.files.map((file) => ({
          name: file.name,
          content: file.content,
          ...(file.format === undefined ? {} : { format: file.format }),
          ...(file.presetId === undefined
            ? file.profile === undefined
              ? {}
              : { profile: file.profile as never }
            : { profile: file.presetId }),
          ...(file.account === undefined
            ? {}
            : {
                account: {
                  providerAccountId: file.account.providerAccountId,
                  name: file.account.name,
                  type: file.account.type,
                  currency: file.account.currency,
                  mask: file.account.mask ?? null,
                },
              }),
        }));

        // A new connection runs `connect`, which stages every file itself and
        // discards the per-file `{staged, skipped}` `addFile` returns — that
        // discard is D2-2 (gate-security-review.md §9.4): the first upload's
        // response always said `staged: 0` even though the rows landed. Fixed
        // by recomputing the same counts here, over the same files, with the
        // same pure parse `addFile` itself uses — see `stagedCountsOf` below.
        // Safe to do *after* `link` returns rather than before: if any file
        // failed to parse, `connect` would already have thrown, and this call
        // never runs.
        if (request.body.connectionId === undefined) {
          const linked = await link(
            session.userId,
            String(request.id),
            {
              provider: IMPORT_PROVIDER,
              input: { displayName: request.body.displayName, files },
            },
            null,
          );
          const { staged, skipped } = stagedCountsOf(files);
          return {
            connectionId: linked.connectionId,
            syncRunId: linked.syncRunId,
            staged,
            skipped,
            status: null,
          };
        }

        const row = await mapDomainErrors(() =>
          requireConnection(database, session.userId, request.body.connectionId as string),
        );
        let staged = 0;
        let skipped = 0;
        await mapDomainErrors(async () => {
          for (const file of files) {
            const result = connector.addFile(row.providerConnectionId, file);
            staged += result.staged;
            skipped += result.skipped;
          }
        });

        const summary = await mapDomainErrors(() =>
          orchestrator.syncConnection({
            connectionId: row.id,
            userId: session.userId,
            trigger: 'manual',
            correlationId: String(request.id),
          }),
        );

        return {
          connectionId: row.id,
          syncRunId: summary.syncRunId,
          staged,
          skipped,
          status: summary.status,
        };
      },
    );
  };
};
