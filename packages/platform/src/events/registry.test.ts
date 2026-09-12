// SPDX-License-Identifier: MIT
import { fixedClock, newId } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PlatformError } from '../errors.ts';
import type { EventEnvelope } from './envelope.ts';
import { createEventRegistry, defineEvent } from './registry.ts';

const clock = fixedClock('2026-03-01T08:00:00.000Z');

const TransactionsUpserted = defineEvent({
  type: 'ledger.TransactionsUpserted',
  aggregateType: 'account',
  description: 'Ids only; re-read the rows through the ledger reader.',
  schema: z.object({ accountId: z.uuid(), addedIds: z.array(z.uuid()), count: z.int() }),
});

function context(): { userId: string; correlationId: string; aggregateId: string } {
  return { userId: newId(), correlationId: newId(), aggregateId: newId() };
}

describe('defineEvent', () => {
  it('builds a complete envelope from a payload and a context', () => {
    const accountId = newId();
    const ctx = context();
    const event = TransactionsUpserted.create({ accountId, addedIds: [], count: 0 }, ctx, clock);

    expect(event.eventType).toBe('ledger.TransactionsUpserted');
    expect(event.aggregateType).toBe('account');
    expect(event.aggregateId).toBe(ctx.aggregateId);
    expect(event.eventVersion).toBe(1);
    expect(event.redaction).toBe('none');
    expect(event.occurredAt.toISOString()).toBe('2026-03-01T08:00:00.000Z');
    // The id is minted here, before the INSERT, which is what lets the aggregate
    // and its event share one transaction.
    expect(event.id).not.toBe(event.correlationId);
  });

  it('rejects a payload that does not match its schema, at the publisher', () => {
    // Better here than three weeks later in a consumer replaying from seq 0.
    expect(() =>
      TransactionsUpserted.create({ accountId: 'not-a-uuid', addedIds: [], count: 0 }, context(), clock),
    ).toThrow();
  });

  it('refuses an event type that is not <context>.<EventName>', () => {
    expect(() =>
      defineEvent({
        type: 'TransactionsUpserted',
        aggregateType: 'account',
        description: 'unnamespaced',
        schema: z.object({}),
      }),
    ).toThrow(PlatformError);
  });

  it('refuses a versioned definition with a missing upcast', () => {
    // Replay from seq 0 must work forever. A v2 definition that cannot read a v1
    // payload turns the oldest events in the log into a permanent landmine.
    expect(() =>
      defineEvent({
        type: 'ledger.Renamed',
        aggregateType: 'account',
        description: 'v2 with no upcast',
        version: 2,
        schema: z.object({ name: z.string() }),
      }),
    ).toThrow(/upcast/i);
  });

  it('upcasts an old payload on read so replay never needs a data migration', () => {
    const Renamed = defineEvent({
      type: 'ledger.Renamed',
      aggregateType: 'account',
      description: 'v1 carried `label`; v2 renamed it to `name` and added a source.',
      version: 2,
      upcasts: {
        1: (payload) => ({ name: (payload as { label: string }).label, source: 'user' }),
      },
      schema: z.object({ name: z.string(), source: z.string() }),
    });

    const stored: EventEnvelope = {
      seq: 7n,
      id: newId(),
      userId: newId(),
      aggregateType: 'account',
      aggregateId: null,
      eventType: 'ledger.Renamed',
      eventVersion: 1,
      payload: { label: 'Checking' },
      occurredAt: clock.now(),
      recordedAt: clock.now(),
      correlationId: newId(),
      causationId: null,
      redaction: 'none',
    };

    const parsed = Renamed.parse(stored);
    expect(parsed.payload).toEqual({ name: 'Checking', source: 'user' });
    expect(parsed.eventVersion).toBe(2);
  });

  it('refuses to hand a purged payload to a handler', () => {
    const purged: EventEnvelope = {
      seq: 9n,
      id: newId(),
      userId: newId(),
      aggregateType: 'account',
      aggregateId: null,
      eventType: 'ledger.TransactionsUpserted',
      eventVersion: 1,
      payload: {},
      occurredAt: clock.now(),
      recordedAt: clock.now(),
      correlationId: newId(),
      causationId: null,
      redaction: 'purged',
    };
    expect(() => TransactionsUpserted.parse(purged)).toThrow(/purged/i);
  });
});

describe('createEventRegistry', () => {
  it('is a per-instance catalogue, not a module singleton', () => {
    const a = createEventRegistry([TransactionsUpserted]);
    const b = createEventRegistry();
    expect(a.types()).toEqual(['ledger.TransactionsUpserted']);
    expect(b.types()).toEqual([]);
  });

  it('refuses two different definitions of one event type', () => {
    const registry = createEventRegistry([TransactionsUpserted]);
    const impostor = defineEvent({
      type: 'ledger.TransactionsUpserted',
      aggregateType: 'account',
      description: 'a second, incompatible definition',
      schema: z.object({}),
    });
    expect(() => registry.register(impostor)).toThrow(/already registered/);
  });

  it('registering the same definition twice is a no-op, so boot order does not matter', () => {
    const registry = createEventRegistry([TransactionsUpserted]);
    expect(() => registry.register(TransactionsUpserted)).not.toThrow();
  });

  it('names an unknown type in the error rather than returning undefined', () => {
    const registry = createEventRegistry();
    expect(() => registry.require('budgeting.Nope')).toThrow(/budgeting.Nope/);
  });
});
