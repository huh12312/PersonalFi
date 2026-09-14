// SPDX-License-Identifier: MIT
/**
 * The wire shapes for the connections API, defined here and wired in WP 1.5.
 *
 * No routes. `apps/api`'s route structure, its problem-details mapping and its
 * OpenAPI emission are WP 1.5's, and adding three handlers here would mean
 * touching that structure from a work package that does not own it. What *can*
 * be settled now is the contract — and settling it now is the point, because
 * 1.5 and the frontend's generated client both depend on it.
 *
 * Conventions these encode, each from docs/CONVENTIONS.md:
 *
 *   * **Money on the wire is `{ minor: string, currency }`.** `bigint` cannot
 *     cross `JSON.stringify` and an IEEE-754 number cannot hold a cent.
 *   * **Instants are ISO-8601 strings; business dates are `YYYY-MM-DD`.**
 *   * **A credential never appears in any shape below.** Not as a field, not as
 *     a redacted placeholder, not as a boolean called `hasToken`. The closest
 *     thing is `status`, which is what the UI actually needs.
 *   * **Clients switch on `code`, never on `detail`.** So `status`, `errorKind`
 *     and `capability` are enums, and the human-readable message is not in any
 *     response a client branches on.
 */
import { z } from 'zod';
import {
  CONNECTION_STATUSES,
  SYNC_OPERATIONS,
  SYNC_RUN_STATUSES,
  SYNC_TRIGGERS,
} from '../schema/index.ts';
import { CAPABILITIES, CONNECTOR_ERROR_KINDS, LINK_KINDS, RECONNECT_FLOWS } from './port.ts';

/**
 * What `GET /connectors` returns: the "Add a connection" screen, as data.
 *
 * 08 §2.7's test of the abstraction is that adding a provider needs no UI
 * change. That is only true if the screen renders from a list the server sends,
 * so this schema is the contract that makes WP 1.3's Plaid adapter appear in the
 * UI by being registered rather than by anyone editing a component.
 *
 * `iconKey` is an asset key, never a URL and never markup: this payload is
 * server-controlled and the browser must not be able to be told to fetch or
 * render something arbitrary from it. An unknown key renders a generic glyph.
 */
export const connectorManifestSchema = z.object({
  provider: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  iconKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, 'an icon key is lower_snake and names a bundled asset'),
  linkKind: z.enum(LINK_KINDS),
  docsUrl: z.url().nullable(),
});

export const capabilitiesSchema = z.object({
  supports: z.array(z.enum(CAPABILITIES)),
  historyWindowDays: z.union([z.int().positive(), z.literal('unbounded')]),
  minSyncIntervalSeconds: z.int().nonnegative(),
  refreshBudgetPerDay: z.int().positive().nullable(),
  supportsWebhooks: z.boolean(),
  reconnectFlow: z.enum(RECONNECT_FLOWS),
  consentWindowDays: z.int().positive().nullable(),
  currencies: z.union([z.literal('multi'), z.array(z.string().length(3))]),
});

/** What `GET /connections` returns per row. */
export const connectionSummarySchema = z.object({
  id: z.uuid(),
  provider: z.string().min(1),
  displayName: z.string().min(1),
  status: z.enum(CONNECTION_STATUSES),
  capabilities: capabilitiesSchema,
  accountCount: z.int().nonnegative(),
  lastSyncedAt: z.iso.datetime().nullable(),
  consentExpiresAt: z.iso.datetime().nullable(),
  /** Since when the status has been non-active. Drives "stale for 26 hours". */
  errorSince: z.iso.datetime().nullable(),
  /** The typed kind only. Never the provider's message, never a token. */
  lastErrorKind: z.enum(CONNECTOR_ERROR_KINDS).nullable(),
  createdAt: z.iso.datetime(),
});

export const connectionAccountSchema = z.object({
  id: z.uuid(),
  /** `@ctx/ledger`'s account id, which is what every other endpoint keys on. */
  accountId: z.uuid(),
  providerName: z.string(),
  currency: z.string().length(3),
  capabilities: z.array(z.enum(CAPABILITIES)),
  enabled: z.boolean(),
  linkedAt: z.iso.datetime(),
});

export const syncRunSchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  trigger: z.enum(SYNC_TRIGGERS),
  operation: z.enum(SYNC_OPERATIONS),
  status: z.enum(SYNC_RUN_STATUSES),
  pageCount: z.int().nonnegative(),
  addedCount: z.int().nonnegative(),
  modifiedCount: z.int().nonnegative(),
  removedCount: z.int().nonnegative(),
  restartCount: z.int().nonnegative(),
  errorKind: z.enum(CONNECTOR_ERROR_KINDS).nullable(),
  /** The provider's own code, for the detail view. A code, not a sentence. */
  errorCode: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  durationMs: z.int().nonnegative().nullable(),
});

/** `POST /connections` — the provider decides what `input` means. */
export const createConnectionRequestSchema = z.object({
  provider: z.string().min(1),
  /**
   * Opaque: a Plaid public token, a file upload descriptor, a set of manual
   * accounts. Validated by the adapter, which is the only thing that knows what
   * a valid one looks like — a union here would have to grow with every provider
   * and would be wrong the first time one changed its link flow.
   */
  input: z.unknown(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const createConnectionResponseSchema = z.object({
  connectionId: z.uuid(),
  relinked: z.boolean(),
  accountIds: z.array(z.uuid()),
  /** The backfill this link enqueued, so the UI can follow it. */
  syncJobId: z.uuid().nullable(),
});

/** `POST /connections/:id/sync` — returns the queued job, not the result. */
export const syncNowResponseSchema = z.object({
  jobId: z.uuid(),
  /** True when a sync of this connection was already queued or running. */
  deduped: z.boolean(),
});

export const connectionDetailSchema = connectionSummarySchema.extend({
  accounts: z.array(connectionAccountSchema),
  recentRuns: z.array(syncRunSchema),
});

export type ConnectorManifestView = z.infer<typeof connectorManifestSchema>;
export type ConnectionSummary = z.infer<typeof connectionSummarySchema>;
export type ConnectionAccountView = z.infer<typeof connectionAccountSchema>;
export type ConnectionDetail = z.infer<typeof connectionDetailSchema>;
export type SyncRunView = z.infer<typeof syncRunSchema>;
export type CreateConnectionRequest = z.infer<typeof createConnectionRequestSchema>;
