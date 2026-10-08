// SPDX-License-Identifier: MIT
import { sql } from 'drizzle-orm';
import type { Executor } from '../executor.ts';

/**
 * Is an event of one of these types, for this holder, waiting after `afterSeq`? (P-4, WP 9.14.)
 *
 * A consumer whose handler is a recompute of current state (the budgeting consumer) can leave the
 * recompute to the last event of a holder's backlog: every earlier recompute is discarded. The
 * `domain_events` table is the platform's, so the read lives here and a context asks through it
 * rather than writing the SQL itself (`check-schema-ownership`). One indexed probe, run in the
 * transaction the caller's receipt is written in.
 */
export async function hasLaterEvent(
  executor: Executor,
  input: {
    readonly afterSeq: bigint;
    readonly userId: string;
    readonly eventTypes: readonly string[];
  },
): Promise<boolean> {
  const result = await executor.execute<{ later: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM domain_events
       WHERE seq > ${input.afterSeq.toString()}::bigint
         AND user_id = ${input.userId}::uuid
         AND event_type = ANY(${sql.param([...input.eventTypes])}::text[])
    ) AS later
  `);
  return result.rows[0]?.later === true;
}
