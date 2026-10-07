// SPDX-License-Identifier: MIT
/**
 * The operator path back for a stopped consumer (WP 9.11, G-23 / F-94-5).
 *
 * The pump dead-letters a consumer after `maxAttempts` failures on one event
 * and, by design, never skips it (`pump.ts`). Until WP 9.11 the only way back
 * was SQL. `resumeConsumer` is what `just consumer-resume <name>` runs: it reads
 * the consumer's offset row, refuses an unknown name, says what stopped it, and
 * sets it `running` with its attempt count cleared (`setConsumerStatus`) — the
 * pump then retries the SAME event, so nothing is skipped. If the cause is
 * still there it will dead-letter again after `maxAttempts`, and the answer is
 * to fix the cause, or — on purpose, after reading `failed_error` —
 * `skipFailedEvent`, which this deliberately does not do.
 */
import { sql } from 'drizzle-orm';
import type { Executor } from '../executor.ts';
import { setConsumerStatus, type ConsumerStatus } from './pump.ts';

export type ResumeOutcome =
  | { readonly kind: 'unknown_consumer'; readonly name: string }
  | { readonly kind: 'already_running'; readonly name: string; readonly lastSeq: string }
  | {
      readonly kind: 'resumed';
      readonly name: string;
      readonly previousStatus: ConsumerStatus;
      readonly lastSeq: string;
      readonly failedSeq: string | null;
      readonly failedError: string | null;
    };

export async function resumeConsumer(db: Executor, name: string): Promise<ResumeOutcome> {
  const result = await db.execute<{
    status: ConsumerStatus;
    last_seq: bigint | string;
    failed_seq: bigint | string | null;
    failed_error: string | null;
  }>(sql`
    SELECT status, last_seq, failed_seq, failed_error
    FROM event_consumer_offsets WHERE consumer_name = ${name}
  `);
  const row = result.rows[0];
  if (row === undefined) return { kind: 'unknown_consumer', name };
  const lastSeq = String(row.last_seq);
  if (row.status === 'running') return { kind: 'already_running', name, lastSeq };
  await setConsumerStatus(db, name, 'running');
  return {
    kind: 'resumed',
    name,
    previousStatus: row.status,
    lastSeq,
    failedSeq: row.failed_seq === null ? null : String(row.failed_seq),
    failedError: row.failed_error,
  };
}
