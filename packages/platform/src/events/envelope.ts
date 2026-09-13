// SPDX-License-Identifier: MIT
import { z } from 'zod';

/**
 * The shape every domain event has, independent of what it says.
 *
 * Events are **past-tense facts, never commands**: `BudgetThresholdCrossed`, not
 * `SendBudgetAlert`. The difference is not stylistic. A command names its
 * handler, which reintroduces exactly the coupling the log exists to remove; a
 * fact can have three consumers today and five next year and the publisher never
 * learns about it.
 */

/** `<context>.<EventName>` — lower-snake context, PascalCase name. */
export const eventTypeSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]*\.[A-Z][A-Za-z0-9]*$/,
    'event type must be <context>.<EventName>, e.g. ledger.TransactionsUpserted',
  );

const redactionSchema = z.enum(['none', 'pii', 'purged']);
export type Redaction = z.infer<typeof redactionSchema>;

const uuidSchema = z.uuid();

/** What a publisher supplies. `seq` and `recordedAt` are assigned by Postgres. */
export const newEventSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
  aggregateType: z.string().min(1),
  aggregateId: uuidSchema.nullable(),
  eventType: eventTypeSchema,
  eventVersion: z.int().min(1),
  payload: z.unknown(),
  occurredAt: z.date(),
  correlationId: uuidSchema,
  causationId: uuidSchema.nullable(),
  redaction: redactionSchema,
});

export type NewEvent<TPayload = unknown> = Omit<z.infer<typeof newEventSchema>, 'payload'> & {
  readonly payload: TPayload;
};

/**
 * A row of the log, as the pump hands it to a handler.
 *
 * A type rather than a schema: `seq` and `recordedAt` are assigned by Postgres,
 * so nothing ever arrives from outside in this shape and there is nothing to
 * validate. `newEventSchema` stays a schema because a publisher's input does
 * cross a trust boundary.
 */
export type EventEnvelope<TPayload = unknown> = Omit<z.infer<typeof newEventSchema>, 'payload'> & {
  readonly seq: bigint;
  readonly recordedAt: Date;
  readonly payload: TPayload;
};

/** A `NewEvent` plus the `seq` Postgres gave it. What `appendEvent` returns. */
export type RecordedEvent<TPayload = unknown> = EventEnvelope<TPayload>;

/**
 * Everything a caller may leave to the platform: the id, the timestamp, the
 * envelope version, the redaction state.
 *
 * `correlationId` is deliberately *not* optional. A background job that mints a
 * fresh one breaks the single property this field exists for — that one id
 * reconstructs an entire sync across HTTP, the queue, and the log — and making it
 * required means forgetting is a type error rather than a silent gap in a trace.
 */
export interface EventContext {
  readonly userId: string;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly aggregateId?: string | null;
  readonly occurredAt?: Date;
  readonly redaction?: Redaction;
}
