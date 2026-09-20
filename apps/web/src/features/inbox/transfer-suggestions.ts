// SPDX-License-Identifier: MIT
import { Money } from '@core/kernel';

import type { Transaction } from '../../api/generated/types.gen.ts';
import { findTransferCandidates } from '../transactions/transfer-candidates.ts';

export interface TransferSuggestion {
  outflow: Transaction;
  inflow: Transaction;
}

/**
 * Every plausible transfer pair in one pool of transactions, for the review
 * inbox's "pending transfer-pair suggestions" queue (wp1.6-ui.md §7's
 * carried-over item). Built on `findTransferCandidates` (one target against a
 * pool) rather than a second matching algorithm: each not-yet-claimed outflow
 * is greedily paired with its closest not-yet-claimed same-amount inflow, so
 * the same transaction is never offered in two suggestions at once.
 */
export function findTransferSuggestions(
  pool: readonly Transaction[],
  windowDays?: number,
): TransferSuggestion[] {
  const claimed = new Set<string>();
  const suggestions: TransferSuggestion[] = [];

  const outflows = pool
    .filter(
      (t) =>
        !t.isTransfer && t.transferLinkId === null && Money.isNegative(Money.fromJSON(t.amount)),
    )
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const outflow of outflows) {
    if (claimed.has(outflow.id)) continue;
    const candidates = findTransferCandidates(outflow, pool, { windowDays }).filter(
      (candidate) => !claimed.has(candidate.id),
    );
    const best = candidates[0];
    if (best === undefined) continue;
    suggestions.push({ outflow, inflow: best });
    claimed.add(outflow.id);
    claimed.add(best.id);
  }

  return suggestions;
}
