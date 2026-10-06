// SPDX-License-Identifier: MIT
/**
 * C5-5 (Phase 5 gate G5-16, Medium): the run inspector's `input_digest` must
 * cover the whole canonical request the advisor actually read — its
 * `snapshot`, its `findings` envelope (a narrator only) and its
 * `granted_scopes` — and `inspectRunPayload` must re-digest the same bytes.
 *
 * Before the fix, `advisor_runs.input_digest` was `inputDigest(snapshot)`
 * alone (`snapshot/builder.ts`'s `build()`). A narrator's `snapshot` is
 * always `{}` by design (`advisors/local/request.ts`'s header), so every
 * narrator run carried the *same* digest regardless of what it was actually
 * sent, and the gate showed live (`gate-security-review.md` §3.6) that
 * tampering a retained payload's `findings` left `digestVerified: true` and
 * the screen reading "Verified".
 *
 * This suite reproduces that tamper directly over `store.ts`'s own
 * `startRun`/`finishRun`/`retainRunPayload` and `preview.ts`'s
 * `canonicalRunDigest`/`inspectRunPayload` — the exact functions
 * `service.ts`'s run path calls — rather than driving a full narrator run
 * (`advisors/local/**` is WP 9.5's). Sabotage record: `docs/evidence/
 * phase-9/wp9.3-carry-overs.md` §2.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { InsightsContext } from '../../src/db.ts';
import { canonicalRunDigest, inspectRunPayload } from '../../src/preview.ts';
import { finishRun, retainRunPayload, startRun } from '../../src/store.ts';
import { NO_DATABASE, contextFor, insightsDatabase, type TestDatabase } from './harness.ts';

const ADVISOR_ID = 'local.narrator.c5-5-test';
const QUERY_SHAPE = `sha256:${'0'.repeat(64)}`;

/** A narration-shaped request: an empty snapshot, a findings envelope, a grant. */
function narrationRequest(): {
  readonly snapshot: Record<string, never>;
  readonly granted_scopes: readonly string[];
  readonly findings: readonly { readonly key: string; readonly summary_md: string }[];
} {
  return {
    snapshot: {},
    granted_scopes: ['fees.summary'],
    findings: [{ key: 'spending.fees', summary_md: 'Bank, card and ATM fees came to $7.00.' }],
  };
}

async function retainOne(
  database: TestDatabase,
  context: InsightsContext,
  request: ReturnType<typeof narrationRequest>,
): Promise<{ readonly runId: string; readonly digest: string }> {
  const run = await startRun(database.db, context, {
    advisorId: ADVISOR_ID,
    advisorVersion: '1.0.0',
    trigger: 'manual',
  });
  const digest = canonicalRunDigest(request);
  await finishRun(database.db, context, {
    runId: run.id,
    status: 'completed',
    inputDigest: digest,
    grantedScopes: request.granted_scopes,
  });
  const canonical = JSON.stringify(request);
  await retainRunPayload(database.db, context, {
    runId: run.id,
    advisorId: ADVISOR_ID,
    queryShape: QUERY_SHAPE,
    payload: request as unknown as Record<string, unknown>,
    payloadBytes: new TextEncoder().encode(canonical).byteLength,
  });
  return { runId: run.id, digest };
}

describe.skipIf(NO_DATABASE)('C5-5 — the inspector digests the whole canonical request', () => {
  let database: TestDatabase;
  let context: InsightsContext;

  beforeEach(async () => {
    database ??= await insightsDatabase('c5_5_digest');
    await database.truncate();
    context = contextFor(database.userId);
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  it('a retained payload with its findings intact verifies', async () => {
    const { runId } = await retainOne(database, context, narrationRequest());
    const inspected = await inspectRunPayload(
      database.db,
      database.userId,
      runId,
      context.clock.now(),
    );
    expect(inspected?.verified).toBe(true);
  }, 30_000);

  it('tampering only the findings envelope is caught: digestVerified turns false', async () => {
    const { runId, digest } = await retainOne(database, context, narrationRequest());

    // The gate's own §3.6 tamper (`gate-security-review.md`), replayed on
    // `findings` rather than `snapshot` — the field the Phase 5 digest never
    // covered. `snapshot` is untouched and stays `{}`, so a digest computed
    // over `snapshot` alone (the pre-fix formula) would not move.
    await database.db.execute(sql`
      UPDATE advisor_run_payloads
         SET payload = jsonb_set(
           payload,
           '{findings,0,summary_md}',
           '"TAMPERED BY WP9.3 EVIDENCE: you could save $9,999.00 a year."'
         )
       WHERE run_id = ${runId}::uuid`);

    const after = await inspectRunPayload(database.db, database.userId, runId, context.clock.now());
    expect(after?.recordedDigest).toBe(digest);
    expect(after?.verified).toBe(false);
  }, 30_000);
});
