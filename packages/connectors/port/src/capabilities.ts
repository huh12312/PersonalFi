// SPDX-License-Identifier: MIT
/**
 * What an adapter claims it can do (08 §2.2).
 *
 * Capabilities are a *declaration*, and the conformance suite treats them as a
 * testable claim rather than documentation: an adapter that declares
 * `transactions` must return a page from `syncTransactions`, and one that does
 * **not** declare `holdings` must throw `unsupported` from `syncHoldings` rather
 * than quietly returning an empty array. "Honest capabilities" is the first
 * property in `runConnectorConformance` for a reason — a silently-empty dataset
 * is indistinguishable from "this account had no activity", and that is how a
 * user's brokerage disappears from net worth for three weeks.
 *
 * The flags exist so the orchestrator and the UI can be written once. SimpleFIN
 * is the worked example from 01 §2.2: banking only, a 90-day window, a hard
 * daily refresh budget. Every one of those is a field below, so adding SimpleFIN
 * in Phase 2 changes no orchestrator code and no UI code.
 */

export const CAPABILITIES = [
  'accounts',
  'balances',
  'transactions',
  'investment_txns',
  'holdings',
  'liabilities',
  'statements',
  'webhooks',
  'incremental_sync',
  'on_demand_refresh',
  'historical_backfill',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** How a broken connection gets fixed. Drives the reconnect UI, not the sync. */
export const RECONNECT_FLOWS = [
  /** Provider-hosted re-link (Plaid Link in update mode, an OAuth redirect). */
  'provider_hosted',
  /** We collect a credential ourselves: an API key, a token, a file. */
  'credential_form',
  /** Re-upload the file. CSV/OFX imports have no live credential to refresh. */
  'reupload',
  /** Nothing to reconnect: the user is the provider. */
  'none',
] as const;

export type ReconnectFlow = (typeof RECONNECT_FLOWS)[number];

export interface ConnectorCapabilities {
  readonly supports: readonly Capability[];
  /**
   * How far back the provider will go. `'unbounded'` for a file import (the file
   * is the window) and for manual entry.
   *
   * 01 §2.2: SimpleFIN is 90 days. The orchestrator uses this to decide whether a
   * 730-day backfill (D16) is even askable, and the UI uses it to say so before
   * the user connects rather than after.
   */
  readonly historyWindowDays: number | 'unbounded';
  /** Politeness floor. The orchestrator refuses to sync more often than this. */
  readonly minSyncIntervalSeconds: number;
  /** Hard cap the provider enforces, e.g. SimpleFIN's ~24/day. `null` = none. */
  readonly refreshBudgetPerDay: number | null;
  /** `true` when the provider pushes; the orchestrator still schedules nightly. */
  readonly supportsWebhooks: boolean;
  readonly reconnectFlow: ReconnectFlow;
  /** Open-banking style time-boxed consent. `null` when consent does not expire. */
  readonly consentWindowDays: number | null;
  readonly currencies: 'multi' | readonly string[];
}

export function supports(capabilities: ConnectorCapabilities, capability: Capability): boolean {
  return capabilities.supports.includes(capability);
}
