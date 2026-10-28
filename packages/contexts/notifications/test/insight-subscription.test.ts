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
  it('subscribes to all seven event types, including the unwired insights one', () => {
    expect([...CONSUMED_EVENT_TYPES]).toEqual([
      'budgeting.BudgetThresholdCrossed',
      'recurring.PriceChangeDetected',
      'connections.ConnectionStatusChanged',
      'connections.SyncRunCompleted',
      'investments.SecurityResolutionFailed',
      'insights.InsightProposed',
      'insights.BriefRecapReady',
    ]);

    // The filter the pump actually reads, not just the constant.
    const consumer = createNotificationsConsumer({
      database: null as unknown as NotificationsDatabase,
    });
    expect(consumer.name).toBe(CONSUMER_NAME);
    expect(consumer.filter).toContain('insights.InsightProposed');
    expect(consumer.filter).toContain('investments.SecurityResolutionFailed');
    expect(consumer.filter).toContain('insights.BriefRecapReady');
    expect(consumer.filter).toHaveLength(7);
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

  it('renders investments.SecurityResolutionFailed so a person reads it (C-8’s UI half, G3-11)', () => {
    const rendered = renderNotification('investments.SecurityResolutionFailed', {
      provider: 'plaid',
      syncRunId: '01920000-0000-7000-8000-0000000000b1',
      providerSecurityId: 'sec-plaid-9f2c',
      identifiers: [{ kind: 'ticker', value: 'ZZZQ', chain: null, mic: null }],
      abstentions: [{ tier: 'cusip', reason: 'not_provided', detail: null }],
      name: 'Mystery Fund',
    });
    expect(rendered).not.toBeNull();
    expect(rendered?.title).toContain('could not be identified');
    expect(rendered?.bodyMd).toContain('Mystery Fund');
    expect(rendered?.bodyMd).toContain('plaid');
    expect(rendered?.deepLink).toBe('/investments');
    expect(rendered?.priority).toBe('normal');
  });

  it('the resolution-failure dedupe key is the identity of the failure, not the sync run', () => {
    // The upstream event may fire again for the *same* still-unresolved
    // position on a later sync run (its own doc: "a later sync that fails
    // the same way emits again"). If the notification's dedupe key included
    // syncRunId, every night's retry would notify again — the render case
    // would exist and still fail C-8's "visible" bar by drowning it in
    // repeats.
    const night1 = renderNotification('investments.SecurityResolutionFailed', {
      provider: 'plaid',
      syncRunId: 'run-1',
      providerSecurityId: 'sec-9f2c',
      identifiers: [],
      abstentions: [{ tier: 'cusip', reason: 'not_provided', detail: null }],
      name: 'Mystery Fund',
    });
    const night2 = renderNotification('investments.SecurityResolutionFailed', {
      provider: 'plaid',
      syncRunId: 'run-2',
      providerSecurityId: 'sec-9f2c',
      identifiers: [],
      abstentions: [{ tier: 'cusip', reason: 'not_provided', detail: null }],
      name: 'Mystery Fund',
    });
    expect(night1?.dedupeKey).toBe(night2?.dedupeKey);

    // A genuinely different position is a different dedupe key.
    const otherSecurity = renderNotification('investments.SecurityResolutionFailed', {
      provider: 'plaid',
      syncRunId: 'run-2',
      providerSecurityId: 'sec-different',
      identifiers: [],
      abstentions: [{ tier: 'cusip', reason: 'not_provided', detail: null }],
      name: 'A Different Fund',
    });
    expect(night1?.dedupeKey).not.toBe(otherSecurity?.dedupeKey);
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

describe('the weekly Brief (WP 11.4): the deterministic lines always, the recap only as optional text', () => {
  const base = {
    briefId: '01920000-0000-7000-8000-0000000000c1',
    isoWeek: '2026-W43',
    rankedCount: 3,
    attentionCount: 1,
    nothingMaterial: false,
  };

  it('without a narration: the Brief’s own lines and nothing else', () => {
    const rendered = renderNotification('insights.BriefRecapReady', {
      ...base,
      recap: null,
      recapBy: null,
    });
    expect(rendered).toEqual({
      dedupeKey: 'insights.brief:01920000-0000-7000-8000-0000000000c1',
      groupKey: 'insights.brief',
      title: 'Your weekly Brief is ready',
      bodyMd:
        '3 ranked actions this week (2026-W43), in order of dollar impact. 1 item needs attention.',
      priority: 'low',
      deepLink: '/brief',
    });
  });

  it('with a narration: the same lines first, then the recap under who wrote it', () => {
    const rendered = renderNotification('insights.BriefRecapReady', {
      ...base,
      recap: 'A week of three ranked actions and a score of 72.5 / 100.',
      recapBy: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    });
    expect(rendered?.bodyMd).toBe(
      '3 ranked actions this week (2026-W43), in order of dollar impact. 1 item needs attention.' +
        '\n\nYour week (AI-assisted wording, Anthropic claude-sonnet-5-5): ' +
        'A week of three ranked actions and a score of 72.5 / 100.',
    );
    // A replay of the same Brief is the same notification.
    expect(rendered?.dedupeKey).toBe('insights.brief:01920000-0000-7000-8000-0000000000c1');
  });

  it('a recap with no named author, or an author not on the list, is not carried', () => {
    for (const recapBy of [null, { provider: 'elsewhere', model: 'x' }]) {
      const rendered = renderNotification('insights.BriefRecapReady', {
        ...base,
        recap: 'Some text.',
        recapBy,
      });
      expect(rendered?.bodyMd).not.toContain('Some text.');
    }
  });

  it('a quiet week says so', () => {
    const rendered = renderNotification('insights.BriefRecapReady', {
      ...base,
      rankedCount: 0,
      attentionCount: 0,
      nothingMaterial: true,
      recap: null,
      recapBy: null,
    });
    expect(rendered?.bodyMd).toBe('Nothing material this week (2026-W43).');
  });
});
