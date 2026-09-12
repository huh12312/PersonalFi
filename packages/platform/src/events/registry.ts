// SPDX-License-Identifier: MIT
import { newId, systemClock, type Clock } from '@core/kernel';
import type { z } from 'zod';
import { PlatformError } from '../errors.ts';
import {
  eventTypeSchema,
  type EventContext,
  type EventEnvelope,
  type NewEvent,
} from './envelope.ts';

/**
 * The event-type registry.
 *
 * Two jobs. It is the list of every fact the system can state, which is the thing
 * a new contributor reads to understand what the app *does*. And it owns payload
 * versioning: a definition declares its current version and an upcast for every
 * older one, so replaying from `seq = 0` works forever without a data migration
 * over the log. Memo 08 §6.10 asked for an upcast function per event type kept
 * forever, on the grounds that it is ten lines and makes replay always possible.
 * This is that.
 *
 * Payload discipline, enforced by review rather than by the type system because
 * no type can express it: **payloads are thin**. `TransactionsUpserted` carries
 * `{ accountId, addedIds, modifiedIds, removedIds, count }`, not the
 * transactions. Consumers re-read current state through the owning context's
 * reader. A fat payload makes the log big, makes replay resurrect stale data
 * instead of reflecting today's, and quietly turns the event into a second copy
 * of the record that will drift from the first.
 */

export interface EventDefinition<TSchema extends z.ZodType = z.ZodType> {
  readonly type: string;
  readonly version: number;
  readonly aggregateType: string;
  readonly schema: TSchema;
  readonly description: string;
  /** `upcasts[n]` turns a version-`n` payload into a version-`n+1` one. */
  readonly upcasts: Readonly<Record<number, (payload: unknown) => unknown>>;
  /** Build a `NewEvent` ready for `appendEvent`. Validates the payload eagerly. */
  create(payload: z.infer<TSchema>, context: EventContext, clock?: Clock): NewEvent<z.infer<TSchema>>;
  /** Narrow an envelope from the pump to this definition's payload type. */
  parse(envelope: EventEnvelope): EventEnvelope<z.infer<TSchema>>;
  /** Type guard for a handler switching over several event types. */
  matches(envelope: EventEnvelope): envelope is EventEnvelope<z.infer<TSchema>>;
}

export interface DefineEventOptions<TSchema extends z.ZodType> {
  /** `<context>.<EventName>`, e.g. `ledger.TransactionsUpserted`. */
  readonly type: string;
  /** The aggregate this fact is about: `account`, `connection`, `budget_period`. */
  readonly aggregateType: string;
  readonly schema: TSchema;
  /** Why this event exists and what a consumer is expected to do about it. */
  readonly description: string;
  /** Defaults to 1. Bump when the payload shape changes and add an upcast. */
  readonly version?: number;
  /** `{ 1: (v1) => v2 }`. Every version below the current one needs an entry. */
  readonly upcasts?: Readonly<Record<number, (payload: unknown) => unknown>>;
}

/**
 * Declare an event type.
 *
 * ```ts
 * export const TransactionsUpserted = defineEvent({
 *   type: 'ledger.TransactionsUpserted',
 *   aggregateType: 'account',
 *   description: 'Ids only. Re-read the rows through the ledger reader.',
 *   schema: z.object({ accountId: z.uuid(), addedIds: z.array(z.uuid()), count: z.int() }),
 * });
 * ```
 */
export function defineEvent<TSchema extends z.ZodType>(
  options: DefineEventOptions<TSchema>,
): EventDefinition<TSchema> {
  const parsedType = eventTypeSchema.safeParse(options.type);
  if (!parsedType.success) {
    throw new PlatformError(
      'platform.event_type_invalid',
      `${options.type}: ${parsedType.error.issues[0]?.message ?? 'invalid event type'}`,
    );
  }
  const version = options.version ?? 1;
  const upcasts = options.upcasts ?? {};
  for (let older = 1; older < version; older += 1) {
    if (typeof upcasts[older] !== 'function') {
      throw new PlatformError(
        'platform.event_upcast_missing',
        `${options.type} is at v${String(version)} but has no upcast from v${String(older)}. ` +
          'Replay from seq 0 must work forever; keep every upcast.',
      );
    }
  }

  const definition: EventDefinition<TSchema> = {
    type: options.type,
    version,
    aggregateType: options.aggregateType,
    schema: options.schema,
    description: options.description,
    upcasts,

    create(payload, context, clock = systemClock) {
      const validated = options.schema.parse(payload) as z.infer<TSchema>;
      return {
        id: newId(),
        userId: context.userId,
        aggregateType: options.aggregateType,
        aggregateId: context.aggregateId ?? null,
        eventType: options.type,
        eventVersion: version,
        payload: validated,
        occurredAt: context.occurredAt ?? clock.now(),
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
        redaction: context.redaction ?? 'none',
      };
    },

    parse(envelope) {
      if (envelope.eventType !== options.type) {
        throw new PlatformError(
          'platform.event_type_mismatch',
          `expected ${options.type}, got ${envelope.eventType}`,
        );
      }
      if (envelope.redaction === 'purged') {
        throw new PlatformError(
          'platform.event_purged',
          `${options.type} seq ${String(envelope.seq)} was purged; its payload is gone by design. ` +
            'A consumer must skip purged events rather than fail on them.',
        );
      }
      let payload = envelope.payload;
      for (let from = envelope.eventVersion; from < version; from += 1) {
        const upcast = upcasts[from];
        if (upcast === undefined) {
          throw new PlatformError(
            'platform.event_upcast_missing',
            `no upcast from ${options.type} v${String(from)} to v${String(from + 1)}`,
          );
        }
        payload = upcast(payload);
      }
      return { ...envelope, eventVersion: version, payload: options.schema.parse(payload) };
    },

    matches(envelope): envelope is EventEnvelope<z.infer<TSchema>> {
      return envelope.eventType === options.type;
    },
  };

  return definition;
}

export interface EventRegistry {
  register(definition: EventDefinition): EventDefinition;
  registerAll(definitions: readonly EventDefinition[]): void;
  get(type: string): EventDefinition | undefined;
  /** Throws rather than returning undefined; for the paths that cannot continue. */
  require(type: string): EventDefinition;
  list(): readonly EventDefinition[];
  types(): readonly string[];
}

/**
 * A registry instance. The composition root builds one and hands it to the pump;
 * there is no module-level singleton, because a singleton makes two test suites
 * in one process share state and makes "which events does this deployment know
 * about?" unanswerable when half the modules are behind a disabled flag.
 */
export function createEventRegistry(
  definitions: readonly EventDefinition[] = [],
): EventRegistry {
  const byType = new Map<string, EventDefinition>();

  const registry: EventRegistry = {
    register(definition) {
      const existing = byType.get(definition.type);
      if (existing !== undefined && existing !== definition) {
        throw new PlatformError(
          'platform.event_type_duplicate',
          `${definition.type} is already registered. One definition per event type.`,
        );
      }
      byType.set(definition.type, definition);
      return definition;
    },
    registerAll(list) {
      for (const definition of list) registry.register(definition);
    },
    get: (type) => byType.get(type),
    require(type) {
      const found = byType.get(type);
      if (found === undefined) {
        throw new PlatformError(
          'platform.event_type_unknown',
          `${type} is not registered. Declare it with defineEvent() and register it at boot.`,
        );
      }
      return found;
    },
    list: () => [...byType.values()],
    types: () => [...byType.keys()],
  };

  registry.registerAll(definitions);
  return registry;
}
