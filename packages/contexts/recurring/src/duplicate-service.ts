// SPDX-License-Identifier: MIT
/**
 * Duplicate-service detection (07 §2.9).
 *
 * ```
 * SERVICE_TAXONOMY: merchant -> node in a tree
 *   media/music, media/video, cloud/storage, security/vpn,
 *   productivity/ai, fitness, news, ...
 *
 * if count(active streams in node) >= 2:
 *     emit DUPLICATE_SERVICE(node, streams, annual_impact = sum of all but the cheapest)
 * ```
 *
 * The taxonomy node arrives on `MerchantFacts.serviceNode` — a key like
 * `'media/video'`, supplied by the caller. The engine only ever compares two
 * nodes for equality; it has no table of merchant names, because it is not
 * allowed one (D25, and see `types.ts`).
 *
 * Both of 07 §2.9's false-positive refinements are here, because either one
 * missing makes the whole finding untrustworthy:
 *
 *  * **(a) bundles.** Disney+/Hulu/ESPN is one purchase and two streams. A
 *    stream whose merchant carries a `bundleSku` suppresses the node.
 *  * **(b) household.** "This one is for my mother" is permanent, and the
 *    caller carries it as `forSomeoneElse`.
 *
 * And 07's own note that the strictly-better finding is the **same-service**
 * duplicate — two charges from the same merchant at the same cadence is a
 * forgotten second account, and unlike the cross-service case it needs no
 * taxonomy and involves no taste.
 */

import { Money } from '@core/kernel';
import { periodsPerYear } from './cadence.ts';
import type { DuplicateServiceFinding, MerchantFacts, RecurringStream } from './types.ts';

const ACTIVE_STATUSES = new Set(['ACTIVE', 'EARLY_DETECTION', 'AT_RISK']);

function annualCostMinor(stream: RecurringStream): bigint {
  const magnitude =
    stream.typicalAmount.minor < 0n ? -stream.typicalAmount.minor : stream.typicalAmount.minor;
  if (stream.cadence === 'UNKNOWN') return magnitude;
  return magnitude * BigInt(periodsPerYear(stream.cadence));
}

/** Sum of every stream but the cheapest — what cancelling the extras saves. */
function allButCheapest(streams: readonly RecurringStream[], currency: string): Money {
  const costs = streams.map(annualCostMinor).sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
  const total = costs.slice(1).reduce((sum, cost) => sum + cost, 0n);
  return Money.of(total, currency);
}

export function detectDuplicateServices(
  streams: readonly RecurringStream[],
  facts: ReadonlyMap<string, MerchantFacts>,
): DuplicateServiceFinding[] {
  const candidates = streams.filter(
    (stream) =>
      stream.sign === 'OUTFLOW' &&
      ACTIVE_STATUSES.has(stream.status) &&
      (stream.type === 'SUBSCRIPTION' || stream.type === 'RECURRING_BILL') &&
      facts.get(stream.merchantId)?.forSomeoneElse !== true,
  );

  const findings: DuplicateServiceFinding[] = [];

  const byMerchant = new Map<string, RecurringStream[]>();
  for (const stream of candidates) {
    const bucket = byMerchant.get(stream.merchantId);
    if (bucket === undefined) byMerchant.set(stream.merchantId, [stream]);
    else bucket.push(stream);
  }
  for (const [merchantId, group] of [...byMerchant.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    if (group.length < 2) continue;
    findings.push({
      kind: 'SAME_SERVICE',
      node: merchantId,
      streamKeys: group.map((stream) => stream.streamKey).sort(),
      annualImpact: allButCheapest(group, (group[0] as RecurringStream).currency),
    });
  }

  const byNode = new Map<string, RecurringStream[]>();
  for (const stream of candidates) {
    const node = facts.get(stream.merchantId)?.serviceNode;
    if (node === undefined || node === null || node === '') continue;
    const bucket = byNode.get(node);
    if (bucket === undefined) byNode.set(node, [stream]);
    else bucket.push(stream);
  }
  for (const [node, group] of [...byNode.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const merchants = new Set(group.map((stream) => stream.merchantId));
    if (merchants.size < 2) continue;
    const bundled = group.some((stream) => {
      const sku = facts.get(stream.merchantId)?.bundleSku;
      return sku !== undefined && sku !== null && sku !== '';
    });
    if (bundled) continue;
    findings.push({
      kind: 'CROSS_SERVICE',
      node,
      streamKeys: group.map((stream) => stream.streamKey).sort(),
      annualImpact: allButCheapest(group, (group[0] as RecurringStream).currency),
    });
  }

  return findings;
}
