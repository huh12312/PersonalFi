// SPDX-License-Identifier: MIT
/**
 * The three lines every adapter would otherwise write for itself.
 *
 * `unsupported` in particular is load-bearing: 08 §2.2's whole argument for
 * declared capabilities is that the orchestrator "skips what isn't advertised
 * rather than catching `NotImplemented`". The corollary is that an adapter which
 * does *not* advertise a dataset must **fail** when asked for it, loudly and
 * typed — not return `[]`. An empty array is indistinguishable from "this
 * account genuinely holds nothing", and that is how a brokerage silently drops
 * out of net worth. Conformance asserts this for every adapter.
 */
import type { Capability, ConnectorCapabilities } from './capabilities.ts';
import { supports } from './capabilities.ts';
import { ConnectorError } from './errors.ts';
import type { TransactionPage } from './connector.ts';

/** The typed refusal for a dataset this adapter never claimed. */
export function unsupported(provider: string, capability: Capability): ConnectorError {
  return ConnectorError.fromCondition(
    'DATA_UNAVAILABLE',
    `${provider} does not support ${capability}`,
    { redactedContext: { provider, capability } },
  );
}

/** Refuse unless the capability was declared. */
export function assertSupports(
  provider: string,
  capabilities: ConnectorCapabilities,
  capability: Capability,
): void {
  if (!supports(capabilities, capability)) throw unsupported(provider, capability);
}

/** A terminal page: nothing changed, nothing more to fetch. */
export function emptyPage(nextCursor: TransactionPage['nextCursor']): TransactionPage {
  return {
    added: [],
    modified: [],
    removed: [],
    accounts: [],
    nextCursor,
    hasMore: false,
  };
}
