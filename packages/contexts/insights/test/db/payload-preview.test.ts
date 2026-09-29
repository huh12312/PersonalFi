// SPDX-License-Identifier: MIT
/**
 * The payload preview gate and payload retention (WP 5.1; 03 §8.3: "show
 * Chris the exact payload before the first send of any new query type").
 *
 * A `local_model` run refuses `payload_not_approved` until an approval exists
 * for the shape it would send; the preview builds that exact request — and,
 * through the `PromptRenderer` port, the exact prompt — without invoking
 * anything; what was sent is retained 30 days and verified by re-digesting it
 * against the run's own `input_digest`, never trusted as stored.
 *
 * The renderer is a pure fake of WP 5.2's port (`run-control-harness.ts`).
 */
import { canonicalJson, type FlagService } from '@core/platform';
import { fixedClock } from '@core/kernel';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { advisorRunPayloads, advisorRuns } from '../../schema/index.ts';
import type { AdvisorManifest } from '../../src/contract/manifest.ts';
import type { AdvisorRequest } from '../../src/contract/request.ts';
import type { InsightsContext } from '../../src/db.ts';
import {
  approvePayload,
  type PreviewError,
  inspectRunPayload,
  previewRequest,
} from '../../src/preview.ts';
import type { Advisor } from '../../src/registry.ts';
import { runAdvisor, type InsightsDependencies } from '../../src/service.ts';
import { grantScopes, pruneRunPayloads, registerAdvisor } from '../../src/store.ts';
import { platformExecutor } from '@core/platform';
import { MODULE_FLAG_KEY } from '../../src/policy/kill-switches.ts';
import { NO_DATABASE, contextFor, insightsDatabase, type TestDatabase } from './harness.ts';
import {
  BUILTIN_ID,
  LOCAL_FLAG,
  LOCAL_ID,
  answerFor,
  armAdvisor,
  builtinManifest,
  dependenciesFor,
  fakeRenderer,
  flagsFor,
  liveSwitches,
  localManifest,
} from './run-control-harness.ts';

interface Capturing extends Advisor {
  readonly seen: AdvisorRequest[];
}

function capturing(manifest: AdvisorManifest): Capturing {
  const seen: AdvisorRequest[] = [];
  return {
    manifest,
    seen,
    run: (request) => {
      seen.push(request);
      return Promise.resolve(answerFor(request, manifest.kind));
    },
  };
}

describe.skipIf(NO_DATABASE)('the payload preview gate', () => {
  let database: TestDatabase;
  let flags: FlagService;
  let context: InsightsContext;

  beforeEach(async () => {
    database ??= await insightsDatabase('payload_preview');
    await database.truncate();
    flags = flagsFor(database);
    context = contextFor(database.userId);
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  /** Every switch on — except the approval. */
  async function unapproved(
    manifest: AdvisorManifest,
    scopes: readonly string[] = ['cash.summary'],
  ) {
    await registerAdvisor(database.db, context, { manifest, enabled: true });
    await grantScopes(database.db, context, manifest.advisor_id, scopes as never);
    await flags.set(platformExecutor(database.db), context.userId, MODULE_FLAG_KEY, true);
    await flags.set(platformExecutor(database.db), context.userId, LOCAL_FLAG, true);
  }

  const run = (dependencies: InsightsDependencies, perRunConsent?: readonly string[]) =>
    runAdvisor(database.db, context, dependencies, {
      advisorId: LOCAL_ID,
      trigger: 'manual',
      lane: 'local',
      ...(perRunConsent === undefined ? {} : { perRunConsent: perRunConsent as never }),
    });

  it('a local-model run refuses until the current query shape has been previewed and approved', async () => {
    const advisor = capturing(localManifest());
    const renderer = fakeRenderer();
    const dependencies = dependenciesFor([advisor], liveSwitches(flags), renderer);
    await unapproved(advisor.manifest);

    // Every other switch says yes; the gate alone refuses, before any data is built.
    const refused = await run(dependencies);
    expect(refused.status).toBe('refused');
    expect(refused.refusal).toBe('payload_not_approved');
    expect(advisor.seen).toHaveLength(0);

    // The preview: the exact request and prompt, and nothing invoked.
    const preview = await previewRequest(database.db, context, dependencies, LOCAL_ID);
    expect(advisor.seen).toHaveLength(0);
    expect(preview.approvalRequired).toBe(true);
    expect(preview.approved).toBe(false);
    expect(preview.queryShape).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(preview.scopes).toEqual(['cash.summary']);
    expect(preview.promptTemplateHash).toBe(renderer.templateHash);
    expect(preview.request.snapshot).toHaveProperty('cash_summary');
    expect(preview.prompt?.text).toContain(canonicalJson(preview.request.snapshot));

    // Still refused: previewing is not approving.
    expect((await run(dependencies)).refusal).toBe('payload_not_approved');

    await approvePayload(database.db, context, dependencies, {
      advisorId: LOCAL_ID,
      queryShape: preview.queryShape,
    });
    const ran = await run(dependencies);
    expect(ran.status).toBe('completed');
    expect(advisor.seen).toHaveLength(1);

    // What it was sent is what the preview showed: same snapshot, same scopes,
    // and the prompt hash and model recorded on the run are the preview's.
    const sent = advisor.seen[0];
    expect(canonicalJson(sent?.snapshot)).toBe(canonicalJson(preview.request.snapshot));
    expect(sent?.granted_scopes).toEqual(preview.request.granted_scopes);
    const [row] = await database.db.select().from(advisorRuns).where(eq(advisorRuns.id, ran.runId));
    expect(row?.llmPromptHash).toBe(preview.prompt?.hash);
    expect(row?.llmModel).toBe(renderer.model);
  }, 60_000);

  it('a changed scope set or prompt template is a new query shape and needs a new approval', async () => {
    const manifest = localManifest({ requires_scopes: ['cash.summary', 'cashflow.monthly'] });
    const advisor = capturing(manifest);
    const v1 = dependenciesFor([advisor], liveSwitches(flags), fakeRenderer('template-v1'));
    await unapproved(manifest, ['cash.summary']);

    const first = await previewRequest(database.db, context, v1, LOCAL_ID);
    await approvePayload(database.db, context, v1, {
      advisorId: LOCAL_ID,
      queryShape: first.queryShape,
    });
    expect((await run(v1)).status).toBe('completed');

    // A scope granted since: a new shape. The old approval does not cover it,
    // and approving the stale shape is refused.
    await grantScopes(database.db, context, LOCAL_ID, ['cashflow.monthly']);
    expect((await run(v1)).refusal).toBe('payload_not_approved');
    const widened = await previewRequest(database.db, context, v1, LOCAL_ID);
    expect(widened.queryShape).not.toBe(first.queryShape);
    expect(widened.scopes).toEqual(['cash.summary', 'cashflow.monthly']);
    await expect(
      approvePayload(database.db, context, v1, {
        advisorId: LOCAL_ID,
        queryShape: first.queryShape,
      }),
    ).rejects.toMatchObject({ code: 'shape_changed' } satisfies Partial<PreviewError>);
    await approvePayload(database.db, context, v1, {
      advisorId: LOCAL_ID,
      queryShape: widened.queryShape,
    });
    expect((await run(v1)).status).toBe('completed');

    // An edited prompt template: a new shape again, same scopes.
    const v2 = dependenciesFor([advisor], liveSwitches(flags), fakeRenderer('template-v2'));
    expect((await run(v2)).refusal).toBe('payload_not_approved');
    const retemplated = await previewRequest(database.db, context, v2, LOCAL_ID);
    expect(retemplated.queryShape).not.toBe(widened.queryShape);
    await approvePayload(database.db, context, v2, {
      advisorId: LOCAL_ID,
      queryShape: retemplated.queryShape,
    });
    expect((await run(v2)).status).toBe('completed');

    // A new advisor version: a new shape.
    const bumped = capturing({ ...manifest, version: '1.1.0' });
    const v3 = dependenciesFor([bumped], liveSwitches(flags), fakeRenderer('template-v2'));
    expect((await run(v3)).refusal).toBe('payload_not_approved');

    // Scope *order* is not a shape: revoking and re-granting in the other order changes nothing.
    await database.db.execute(sql`DELETE FROM snapshot_grants`);
    await grantScopes(database.db, context, LOCAL_ID, ['cashflow.monthly']);
    await grantScopes(database.db, context, LOCAL_ID, ['cash.summary']);
    expect((await previewRequest(database.db, context, v2, LOCAL_ID)).queryShape).toBe(
      retemplated.queryShape,
    );
  }, 60_000);

  it("the retained payload re-digests to the run's input_digest", async () => {
    const advisor = capturing(localManifest());
    const builtin = capturing(builtinManifest());
    const dependencies = dependenciesFor([advisor, builtin], liveSwitches(flags));
    await armAdvisor(database, context, dependencies, flags, advisor.manifest);
    await armAdvisor(database, context, dependencies, flags, builtin.manifest);

    const ran = await run(dependencies);
    expect(ran.status).toBe('completed');

    const inspected = await inspectRunPayload(
      database.db,
      database.userId,
      ran.runId,
      context.clock.now(),
    );
    expect(inspected).not.toBeNull();
    expect(inspected?.recordedDigest).toBe(ran.inputDigest);
    expect(inspected?.recomputedDigest).toBe(ran.inputDigest);
    expect(inspected?.verified).toBe(true);
    // What is retained is the request as sent.
    expect(canonicalJson(inspected?.payload)).toBe(canonicalJson(advisor.seen[0]));

    // The stored bytes are not trusted: tamper with one value and it no longer verifies.
    await database.db.execute(sql`
      UPDATE advisor_run_payloads
         SET payload = jsonb_set(payload, '{snapshot,cash_summary,as_of}', '"1999-01-01"')
       WHERE run_id = ${ran.runId}::uuid`);
    const tampered = await inspectRunPayload(
      database.db,
      database.userId,
      ran.runId,
      context.clock.now(),
    );
    expect(tampered?.verified).toBe(false);
    expect(tampered?.recordedDigest).toBe(ran.inputDigest);

    // Thirty days, and not a day more: the table refuses a longer bound…
    const [kept] = await database.db
      .select()
      .from(advisorRunPayloads)
      .where(eq(advisorRunPayloads.runId, ran.runId));
    expect(kept && kept.expiresAt.getTime() - kept.retainedAt.getTime()).toBe(30 * 86_400_000);
    await expect(
      database.db.execute(sql`
        UPDATE advisor_run_payloads SET expires_at = retained_at + INTERVAL '31 days'
         WHERE run_id = ${ran.runId}::uuid`),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23514' }) });
    // …an expired one is not served, and the lane's prune deletes it.
    const later = fixedClock('2026-10-20T09:00:00.000Z').now();
    expect(await inspectRunPayload(database.db, database.userId, ran.runId, later)).toBeNull();
    expect(await pruneRunPayloads(database.db, database.userId, later)).toBe(1);

    // A builtin sends nothing anywhere and retains nothing.
    const plain = await runAdvisor(database.db, context, dependencies, {
      advisorId: BUILTIN_ID,
      trigger: 'manual',
    });
    expect(plain.status).toBe('completed');
    expect(
      await inspectRunPayload(database.db, database.userId, plain.runId, context.clock.now()),
    ).toBeNull();
  }, 60_000);

  it('a standing grant of a per-run-consent scope is never emitted without a consent for that run (G4-22)', async () => {
    const manifest = localManifest({ requires_scopes: ['cash.summary', 'transactions.raw'] });
    const advisor = capturing(manifest);
    const dependencies = dependenciesFor([advisor], liveSwitches(flags));
    // A standing grant of `transactions.raw` — what the Phase 4 gate wrote live.
    await unapproved(manifest, ['cash.summary', 'transactions.raw']);

    const standing = await previewRequest(database.db, context, dependencies, LOCAL_ID);
    expect(standing.scopes).toEqual(['cash.summary']);
    await approvePayload(database.db, context, dependencies, {
      advisorId: LOCAL_ID,
      queryShape: standing.queryShape,
    });
    const without = await run(dependencies);
    expect(without.status).toBe('completed');
    expect(advisor.seen[0]?.granted_scopes).toEqual(['cash.summary']);
    const [row] = await database.db
      .select()
      .from(advisorRuns)
      .where(eq(advisorRuns.id, without.runId));
    expect(row?.grantedScopes).toEqual(['cash.summary']);

    // With a consent for this run it is carried — and it is a different shape,
    // so it needs its own preview and approval first.
    const consented = ['transactions.raw'];
    expect((await run(dependencies, consented)).refusal).toBe('payload_not_approved');
    const withConsent = await previewRequest(database.db, context, dependencies, LOCAL_ID, {
      perRunConsent: consented as never,
    });
    expect(withConsent.scopes).toEqual(['cash.summary', 'transactions.raw']);
    await approvePayload(database.db, context, dependencies, {
      advisorId: LOCAL_ID,
      queryShape: withConsent.queryShape,
      perRunConsent: consented as never,
    });
    const withIt = await run(dependencies, consented);
    expect(withIt.status).toBe('completed');
    expect(advisor.seen.at(-1)?.granted_scopes).toEqual(['cash.summary', 'transactions.raw']);
  }, 60_000);
});
