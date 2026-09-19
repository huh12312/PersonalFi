// SPDX-License-Identifier: MIT
/**
 * The five subscriptions, and the one that is declared before it exists.
 *
 * `insights.InsightProposed` is WP 2.6's event. It is listed in
 * `CONSUMED_EVENT_TYPES` and handled by `renderNotification` *now*, so the
 * wiring lands with this package rather than becoming a later edit to a file
 * somebody has to remember — and until that event type is registered at the
 * composition root, no envelope of it can reach the pump, so the code is inert
 * rather than speculative. `src/render.ts` says this suite fails if the
 * subscription is removed; this is that suite.
 *
 * The rest of the file pins the two derivations that decide whether a user is
 * notified once or two thousand times: the dedupe key (from the fact, never
 * from the event id) and the group key (coarse on purpose).
 */
import { describe, expect, it } from 'vitest';
import { CONSUMER_NAME, createNotificationsConsumer } from '../src/consumer.ts';
import { CONSUMED_EVENT_TYPES, renderNotification } from '../src/render.ts';
import type { NotificationsDatabase } from '../src/db.ts';

describe('the consumer’s subscriptions', () => {
  it('subscribes to all five event types, including the unwired insights one', () => {
    expect([...CONSUMED_EVENT_TYPES]).toEqual([
      'budgeting.BudgetThresholdCrossed',
      'recurring.PriceChangeDetected',
      'connections.ConnectionStatusChanged',
      'connections.SyncRunCompleted',
      'insights.InsightProposed',
    ]);

    // The filter the pump actually reads, not just the constant.
    const consumer = createNotificationsConsumer({
      database: null as unknown as NotificationsDatabase,
    });
    expect(consumer.name).toBe(CONSUMER_NAME);
    expect(consumer.filter).toContain('insights.InsightProposed');
    expect(consumer.filter).toHaveLength(5);
  });

  it('renders an insights.InsightProposed payload of the shape WP 2.6 specifies', () => {
    const rendered = renderNotification('insights.InsightProposed', {
      insightId: '01920000-0000-7000-8000-0000000000a1',
      ruleId: 'U3',
      severity: 'info',
    });
    expect(rendered).not.toBeNull();
    expect(rendered?.dedupeKey).toBe('insights.insight:01920000-0000-7000-8000-0000000000a1');
    expect(rendered?.groupKey).toBe('insights.proposed');
    expect(rendered?.deepLink).toContain('01920000-0000-7000-8000-0000000000a1');
  });

  it('an unsubscribed event type renders nothing rather than throwing', () => {
    // A consumer that threw on an event it merely did not recognise would stall
    // every offset behind it.
    expect(renderNotification('ledger.TransactionsUpserted', { count: 12 })).toBeNull();
  });
});

describe('the derivations that decide how often a user is woken', () => {
  it('the budget dedupe key is the fact, and the group key is coarser than the line', () => {
    const first = renderNotification('budgeting.BudgetThresholdCrossed', {
      periodId: 'p1',
      lineId: 'l1',
      threshold: 'OVERSPENT_CASH',
      available: '-12.34',
      currency: 'USD',
    });
    const secondLine = renderNotification('budgeting.BudgetThresholdCrossed', {
      periodId: 'p1',
      lineId: 'l2',
      threshold: 'OVERSPENT_CASH',
      available: '-1.00',
      currency: 'USD',
    });

    // Two different envelopes overspent → two different notifications…
    expect(first?.dedupeKey).not.toBe(secondLine?.dedupeKey);
    // …that a digest coalesces together. A per-line group key would still
    // produce hundreds of notifications after a backfill.
    expect(first?.groupKey).toBe(secondLine?.groupKey);
    expect(first?.priority, 'overspent is the one 07 §1.9 calls hard').toBe('high');
  });

  it('a price change becomes a different fact when it is confirmed', () => {
    const payload = {
      priceChangeEventId: 'pc1',
      seriesId: 's1',
      direction: 'INCREASE',
      annualImpactMinor: '12000',
      currency: 'USD',
    };
    const provisional = renderNotification('recurring.PriceChangeDetected', {
      ...payload,
      confirmed: false,
    });
    const confirmed = renderNotification('recurring.PriceChangeDetected', {
      ...payload,
      confirmed: true,
    });
    expect(provisional?.dedupeKey).not.toBe(confirmed?.dedupeKey);
    expect(confirmed?.bodyMd).toContain('120.00');
  });

  it('recovery is not news: a connection going back to active renders nothing', () => {
    expect(
      renderNotification('connections.ConnectionStatusChanged', {
        connectionId: 'c1',
        provider: 'Chase',
        from: 'reauth_required',
        to: 'active',
      }),
    ).toBeNull();
    expect(
      renderNotification('connections.SyncRunCompleted', { syncRunId: 'r1', status: 'success' }),
    ).toBeNull();
    // …but a failure is.
    expect(
      renderNotification('connections.SyncRunCompleted', { syncRunId: 'r1', status: 'failed' }),
    ).not.toBeNull();
  });
});
