// SPDX-License-Identifier: MIT
/**
 * `/advisors/{id}/runs`, `/advisors/runs/{runId}`,
 * `/advisors/runs/{runId}/cancel`, `/advisors/{id}/payload-preview`,
 * `/advisors/{id}/payload-approvals`, `/advisors/kinds/{kind}/enabled` and
 * `/advisors/rule-health` (WP 5.10), over a real database.
 *
 * Run fixtures are inserted directly against the public `advisorRuns` schema
 * export (`@ctx/insights/schema`, the same table `routes/advisor-runs.ts`
 * reads) rather than by driving a real advisor run to completion: WP 5.1's
 * own suites (`kill-ladder.test.ts`, `payload-preview.test.ts`) already prove
 * the run pipeline that produces these rows, and `startRun`/`finishRun`
 * (`store.ts`) are not re-exported through `@ctx/insights`'s barrel the way
 * `retainRunPayload`/`requestRunCancel`/`findRun` are — the same barrel gap
 * `routes/brief.ts`'s header documents for `findBriefByWeek`/`listBriefItems`.
 * Recorded under "Needs the orchestrator" alongside that one. This suite's
 * claim is the *route* that reads these rows back and cancels one in flight,
 * not the run pipeline that writes them.
 */
import { newId, systemClock } from '@core/kernel';
import {
  canonicalRunDigest,
  createBuiltinRegistry,
  effectiveRunScopes,
  findRun,
  grantScopes,
  registerAdvisor,
  retainRunPayload,
  shapeFor,
  type AdvisorManifest,
} from '@ctx/insights';
import { advisorRunPayloads, advisorRuns } from '@ctx/insights/schema';
import { and, eq } from 'drizzle-orm';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const CASH_ADVISOR_ID = 'builtin.cash.emergency_fund_short';

function localModelManifest(advisorId: string): AdvisorManifest {
  return {
    advisor_id: advisorId,
    version: '1.0.0',
    contract_version: 1,
    kind: 'local_model',
    display_name: 'Test narrator fixture',
    purpose: "WP 5.10's preview/approval route tests.",
    requires_scopes: ['cash.summary'],
    triggers: [{ type: 'schedule', cron: '0 4 * * *' }],
    capabilities: {
      deterministic: false,
      produces_impact: false,
      narrates_only: true,
      max_severity: 'notable',
    },
    limits: { timeout_ms: 30_000, max_insights: 10, max_response_bytes: 65_536 },
    egress_allowlist: [],
  };
}

/**
 * An `external` fixture, not `local_model`: `advisor_payload_approvals`'s own
 * CHECK (`advisor_payload_approvals_local_has_template`, migration 0028)
 * requires a `local_model` row to carry a non-null prompt template hash,
 * which this process can never produce (no `PromptRenderer` bound — see
 * `routes/advisor-runs.ts`'s header). An `external` advisor carries no such
 * constraint, so it is what exercises a full preview-then-approve-then-stale
 * cycle; the `local_model` case gets its own dedicated 503 test instead.
 */
function externalManifest(advisorId: string): AdvisorManifest {
  return {
    advisor_id: advisorId,
    version: '1.0.0',
    contract_version: 1,
    kind: 'external',
    display_name: 'Test external fixture',
    purpose: "WP 5.10's preview/approval route tests.",
    // Two scopes declared, only one granted at first — so widening the
    // grant to both actually changes `effectiveRunScopes`'s result (the
    // scope-widening half of the "shape changed" test below).
    requires_scopes: ['cash.summary', 'cashflow.monthly'],
    triggers: [{ type: 'schedule', cron: '0 4 * * *' }],
    capabilities: {
      deterministic: false,
      produces_impact: false,
      narrates_only: false,
      max_severity: 'notable',
    },
    limits: { timeout_ms: 30_000, max_insights: 10, max_response_bytes: 65_536 },
    egress_allowlist: ['example.com'],
  };
}

interface RunOverrides {
  readonly status?: 'started' | 'completed' | 'failed' | 'refused' | 'cancelled';
  readonly inputDigest?: string | null;
  readonly grantedScopes?: readonly string[];
  readonly emittedScopes?: readonly string[];
  readonly proposedCount?: number;
  readonly acceptedCount?: number;
  readonly rejectedCount?: number;
  readonly rejections?: readonly Record<string, unknown>[];
  readonly durationMs?: number | null;
  readonly finishedAt?: Date | null;
  readonly cancelRequestedAt?: Date | null;
  readonly cancelReason?: 'run_cancelled' | null;
}

/** One `advisor_runs` row, matching every CHECK in migrations 0012/0028. */
async function insertRun(
  h: ApiHarness,
  userId: string,
  overrides: RunOverrides = {},
): Promise<string> {
  const id = newId();
  const now = systemClock.now();
  const status = overrides.status ?? 'started';
  await h.database.db.insert(advisorRuns).values({
    id,
    userId,
    advisorId: CASH_ADVISOR_ID,
    advisorVersion: '1.0.0',
    trigger: 'manual',
    triggerEventType: null,
    status,
    refusal: null,
    inputDigest: overrides.inputDigest ?? null,
    grantedScopes: [...(overrides.grantedScopes ?? [])],
    emittedScopes: [...(overrides.emittedScopes ?? [])],
    proposedCount: overrides.proposedCount ?? 0,
    acceptedCount: overrides.acceptedCount ?? 0,
    rejectedCount: overrides.rejectedCount ?? 0,
    rejections: [...(overrides.rejections ?? [])],
    errorCode: null,
    durationMs: overrides.durationMs ?? null,
    correlationId: newId(),
    causationId: null,
    startedAt: now,
    finishedAt: status === 'started' ? null : (overrides.finishedAt ?? now),
    createdAt: now,
    cancelRequestedAt: overrides.cancelRequestedAt ?? null,
    cancelReason: overrides.cancelReason ?? null,
    llmModel: null,
    llmPromptHash: null,
  });
  return id;
}

/** A tiny HTTP server standing in for Ollama, counting every request it receives. */
function countingFakeModel(): { server: Server; port: Promise<number>; hits: () => number } {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const port = new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  return { server, port, hits: () => hits };
}

describe.skipIf(NO_DATABASE)('/advisors/{id}/runs and the run inspector (WP 5.10)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp510-advisor-runs' });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it('401s every route without a session', async () => {
    // `POST`/`PUT` carry a syntactically valid (but not a real) CSRF pair —
    // the same trick `advisor-grants.test.ts` uses — so the CSRF gate
    // mounted at the app root (`advisor-grants.test.ts`'s own header) never
    // intercepts first and reports its own 403 instead of the route's 401.
    const noSession = { accessToken: 'not-a-real-token', csrf: 'x'.repeat(40), fresh: false };

    const list = await h.request({ method: 'GET', url: `/advisors/${CASH_ADVISOR_ID}/runs` });
    expect(list.statusCode).toBe(401);
    const inspect = await h.request({ method: 'GET', url: `/advisors/runs/${newId()}` });
    expect(inspect.statusCode).toBe(401);
    const cancel = await h.request({
      method: 'POST',
      url: `/advisors/runs/${newId()}/cancel`,
      session: noSession,
    });
    expect(cancel.statusCode).toBe(401);
    const preview = await h.request({
      method: 'GET',
      url: `/advisors/${CASH_ADVISOR_ID}/payload-preview`,
    });
    expect(preview.statusCode).toBe(401);
    const approve = await h.request({
      method: 'POST',
      url: `/advisors/${CASH_ADVISOR_ID}/payload-approvals`,
      session: noSession,
      body: { queryShape: 'sha256:' + 'a'.repeat(64) },
    });
    expect(approve.statusCode).toBe(401);
    const kind = await h.request({
      method: 'PUT',
      url: '/advisors/kinds/local_model/enabled',
      session: noSession,
      body: { enabled: true },
    });
    expect(kind.statusCode).toBe(401);
    const health = await h.request({ method: 'GET', url: '/advisors/rule-health' });
    expect(health.statusCode).toBe(401);
  });

  it('404s runs for an advisor the caller has none of', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/advisors/builtin.does.not_exist/runs',
      session: h.stale,
    });
    expect(response.statusCode).toBe(404);
    expect(problemOf(response)['code']).toBe('insights.advisor_not_found');
  });

  it('GET /advisors/rule-health answers 200 with every registered advisor', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/advisors/rule-health',
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as { advisors: readonly { advisorId: string }[] };
    expect(body.advisors.some((row) => row.advisorId === CASH_ADVISOR_ID)).toBe(true);
  });

  describe('the run inspector', () => {
    let runId: string;
    let secondUserRunId: string;
    const context = () => ({ userId: h.userId, clock: systemClock, correlationId: newId() });

    beforeAll(async () => {
      const snapshot = { cash_summary: { totalMinor: '1000', currency: 'USD' } };
      const grantedScopes = ['cash.summary'];
      // C5-5 (G5-16): the digest covers the whole canonical request — here,
      // `snapshot` and `granted_scopes`, the same two fields the retained
      // payload below carries. Computed through the production
      // `canonicalRunDigest` (never re-derived by this test) so this fixture
      // cannot silently drift from what `inspectRunPayload` actually checks.
      const digest = canonicalRunDigest({ snapshot, granted_scopes: grantedScopes });
      runId = await insertRun(h, h.userId, {
        status: 'completed',
        inputDigest: digest,
        grantedScopes,
        emittedScopes: ['cash.summary'],
        proposedCount: 1,
        acceptedCount: 0,
        rejectedCount: 1,
        rejections: [{ step: 'evidence', reason: 'test-fixture', index: 0 }],
        durationMs: 42,
      });
      await retainRunPayload(h.database.db, context(), {
        runId,
        advisorId: CASH_ADVISOR_ID,
        queryShape: 'sha256:' + 'b'.repeat(64),
        payload: { snapshot, granted_scopes: grantedScopes },
        payloadBytes: JSON.stringify({ snapshot, granted_scopes: grantedScopes }).length,
      });
    });

    it('lists the run for its advisor', async () => {
      const response = await h.request({
        method: 'GET',
        url: `/advisors/${CASH_ADVISOR_ID}/runs`,
        session: h.stale,
      });
      expectStatus(response, 200);
      const body = response.json() as { runs: readonly { id: string; status: string }[] };
      expect(body.runs.some((row) => row.id === runId && row.status === 'completed')).toBe(true);
    });

    it('404s an unknown run', async () => {
      const response = await h.request({
        method: 'GET',
        url: `/advisors/runs/${newId()}`,
        session: h.stale,
      });
      expect(response.statusCode).toBe(404);
      expect(problemOf(response)['code']).toBe('insights.run_not_found');
    });

    it('shows inputDigest, scopes, per-step rejections, duration and a verified retained payload', async () => {
      const response = await h.request({
        method: 'GET',
        url: `/advisors/runs/${runId}`,
        session: h.stale,
      });
      expectStatus(response, 200);
      const body = response.json() as {
        run: {
          id: string;
          inputDigest: string;
          grantedScopes: readonly string[];
          emittedScopes: readonly string[];
          durationMs: number;
        };
        rejections: readonly Record<string, unknown>[];
        payload: {
          digestVerified: boolean;
          recordedDigest: string;
          recomputedDigest: string;
        } | null;
      };
      expect(body.run.grantedScopes).toEqual(['cash.summary']);
      expect(body.run.emittedScopes).toEqual(['cash.summary']);
      expect(body.run.durationMs).toBe(42);
      expect(body.rejections).toHaveLength(1);
      expect(body.payload).not.toBeNull();
      expect(body.payload?.digestVerified).toBe(true);
      expect(body.payload?.recordedDigest).toBe(body.run.inputDigest);
      expect(body.payload?.recomputedDigest).toBe(body.run.inputDigest);
    });

    it('the inspector reports digestVerified false when a retained payload was altered', async () => {
      // Alter the stored bytes directly — simulating tampering or corruption —
      // without touching `advisor_runs.input_digest`, which was written
      // *before* the call from the request actually sent (WP 5.1). The route
      // must recompute from the (now-altered) bytes and disagree.
      await h.database.db
        .update(advisorRunPayloads)
        .set({ payload: { snapshot: { cash_summary: { totalMinor: '999999', currency: 'USD' } } } })
        .where(and(eq(advisorRunPayloads.userId, h.userId), eq(advisorRunPayloads.runId, runId)));

      const response = await h.request({
        method: 'GET',
        url: `/advisors/runs/${runId}`,
        session: h.stale,
      });
      expectStatus(response, 200);
      const body = response.json() as {
        run: { inputDigest: string };
        payload: { digestVerified: boolean; recordedDigest: string; recomputedDigest: string };
      };
      expect(body.payload.digestVerified).toBe(false);
      expect(body.payload.recordedDigest).toBe(body.run.inputDigest);
      expect(body.payload.recomputedDigest).not.toBe(body.run.inputDigest);
    });

    it('a run belonging to one holder is invisible to another, in the list and the inspector', async () => {
      const otherUserId = await h.database.createUser('Runs Second Holder');
      const otherSession = await h.issueSession({ userId: otherUserId, fresh: true });
      // `h.database.createUser` is a raw test-only insert, not the production
      // path `bootstrap-seed.ts`'s `seedUserState` registers the catalogue
      // through — so Bob has no `advisors` row for this id at all yet. Give
      // him one (the real builtin manifest, same as the catalogue would)
      // so the list route's existence check passes and what is actually
      // under test — the *run* scoping, not advisor existence — is isolated.
      const cashManifest = createBuiltinRegistry().get(CASH_ADVISOR_ID)?.manifest;
      if (cashManifest === undefined) throw new Error(`no builtin manifest for ${CASH_ADVISOR_ID}`);
      await registerAdvisor(
        h.database.db,
        { userId: otherUserId, clock: systemClock, correlationId: newId() },
        { manifest: cashManifest, enabled: false },
      );

      const inspect = await h.request({
        method: 'GET',
        url: `/advisors/runs/${runId}`,
        session: otherSession,
      });
      expect(inspect.statusCode).toBe(404);

      const list = await h.request({
        method: 'GET',
        url: `/advisors/${CASH_ADVISOR_ID}/runs`,
        session: otherSession,
      });
      expectStatus(list, 200);
      const body = list.json() as { runs: readonly { id: string }[] };
      expect(body.runs.some((row) => row.id === runId)).toBe(false);
    });

    it("cancelling a run needs a fresh session and reaches only the caller's run", async () => {
      const otherUserId = await h.database.createUser('Cancel Second Holder');
      const otherFresh = await h.issueSession({ userId: otherUserId, fresh: true });

      secondUserRunId = await insertRun(h, h.userId, { status: 'started' });

      const stale = await h.request({
        method: 'POST',
        url: `/advisors/runs/${secondUserRunId}/cancel`,
        session: h.stale,
      });
      expect(stale.statusCode).toBe(403);
      expect(problemOf(stale)['code']).toBe('step_up_required');

      // Bob, with a fresh session, cannot reach Alice's run: 404, not a
      // leaked "requested" for someone else's in-flight work.
      const bob = await h.request({
        method: 'POST',
        url: `/advisors/runs/${secondUserRunId}/cancel`,
        session: otherFresh,
      });
      expect(bob.statusCode).toBe(404);

      const owner = await h.request({
        method: 'POST',
        url: `/advisors/runs/${secondUserRunId}/cancel`,
        session: h.fresh,
      });
      expectStatus(owner, 200);
      expect((owner.json() as { outcome: string }).outcome).toBe('requested');

      const row = await findRun(h.database.db, h.userId, secondUserRunId);
      expect(row?.cancelRequestedAt).not.toBeNull();

      // Now finished — as the run watcher would close it, from the outside:
      // a second cancel on a run that is no longer in flight is a named
      // conflict, not a silent no-op.
      await h.database.db
        .update(advisorRuns)
        .set({ status: 'cancelled', cancelReason: 'run_cancelled', finishedAt: systemClock.now() })
        .where(and(eq(advisorRuns.userId, h.userId), eq(advisorRuns.id, secondUserRunId)));
      const afterFinish = await h.request({
        method: 'POST',
        url: `/advisors/runs/${secondUserRunId}/cancel`,
        session: h.fresh,
      });
      expect(afterFinish.statusCode).toBe(409);
      expect(problemOf(afterFinish)['code']).toBe('insights.run_not_in_flight');
    });

    it('404s cancelling an unknown run', async () => {
      const response = await h.request({
        method: 'POST',
        url: `/advisors/runs/${newId()}/cancel`,
        session: h.fresh,
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('payload preview and approval', () => {
    let fakeModel: ReturnType<typeof countingFakeModel>;

    beforeAll(async () => {
      fakeModel = countingFakeModel();
      await fakeModel.port;
      const context = { userId: h.userId, clock: systemClock, correlationId: newId() };
      await grantScopes(h.database.db, context, CASH_ADVISOR_ID, ['cash.summary']);
    });

    afterAll(async () => {
      fakeModel.server.close();
    });

    it('the preview route sends nothing to the model', async () => {
      const response = await h.request({
        method: 'GET',
        url: `/advisors/${CASH_ADVISOR_ID}/payload-preview`,
        session: h.stale,
      });
      expectStatus(response, 200);
      const body = response.json() as {
        advisorId: string;
        kind: string;
        approvalRequired: boolean;
        approved: boolean;
        prompt: unknown;
        request: { advisor_id: string };
      };
      expect(body.advisorId).toBe(CASH_ADVISOR_ID);
      expect(body.kind).toBe('builtin');
      expect(body.approvalRequired).toBe(false); // builtins send nothing anywhere to approve
      expect(body.approved).toBe(true);
      expect(body.prompt).toBeNull();
      expect(body.request.advisor_id).toBe(CASH_ADVISOR_ID);
      // The counting fake endpoint: whatever this route did, it never reached
      // a model — not through any configured endpoint, not at all.
      expect(fakeModel.hits()).toBe(0);
    });

    it("a local_model advisor's preview never reaches a model either — even where its prompt can't be shown", async () => {
      const localId = `test.local.${newId().replaceAll('-', '').slice(0, 8)}`;
      const context = { userId: h.userId, clock: systemClock, correlationId: newId() };
      await registerAdvisor(h.database.db, context, {
        manifest: localModelManifest(localId),
        enabled: false,
      });
      await grantScopes(h.database.db, context, localId, ['cash.summary']);

      const response = await h.request({
        method: 'GET',
        url: `/advisors/${localId}/payload-preview`,
        session: h.stale,
      });
      // This process binds no `PromptRenderer` (see routes/advisor-runs.ts's
      // header) — a known, named gap, not a silent failure.
      expect(response.statusCode).toBe(503);
      expect(problemOf(response)['code']).toBe('insights.prompt_renderer_unavailable');
      expect(fakeModel.hits()).toBe(0);
    });

    it("a local_model advisor's payload cannot be approved on this process either — named, not a raw 500", async () => {
      // `advisor_payload_approvals`'s own CHECK
      // (`advisor_payload_approvals_local_has_template`, migration 0028)
      // requires a `local_model` row to carry a non-null prompt template
      // hash, which this process can never produce (no `PromptRenderer`
      // bound). The route refuses this before `approvePayload` ever runs —
      // see `routes/advisor-runs.ts`'s header — so the same 503 that gates
      // preview gates approval, and an insert that would violate the CHECK
      // never happens.
      const localId = `test.local.${newId().replaceAll('-', '').slice(0, 8)}`;
      const context = { userId: h.userId, clock: systemClock, correlationId: newId() };
      const manifest = localModelManifest(localId);
      await registerAdvisor(h.database.db, context, { manifest, enabled: false });
      await grantScopes(h.database.db, context, localId, ['cash.summary']);
      const scopes = effectiveRunScopes(manifest, ['cash.summary']);
      const shape = shapeFor(manifest, scopes, {});

      const response = await h.request({
        method: 'POST',
        url: `/advisors/${localId}/payload-approvals`,
        session: h.fresh,
        body: { queryShape: shape },
      });
      expect(response.statusCode).toBe(503);
      expect(problemOf(response)['code']).toBe('insights.prompt_renderer_unavailable');
    });

    it('an approval for a shape that changed since its preview is refused', async () => {
      // An `external` fixture, not `local_model`: see `externalManifest`'s
      // own doc comment for why the full preview-approve-stale cycle needs a
      // kind this process can actually complete an approval for.
      const externalId = `test.external.${newId().replaceAll('-', '').slice(0, 8)}`;
      const context = { userId: h.userId, clock: systemClock, correlationId: newId() };
      const manifest = externalManifest(externalId);
      await registerAdvisor(h.database.db, context, { manifest, enabled: false });
      await grantScopes(h.database.db, context, externalId, ['cash.summary']);

      // The exact shape a preview would return right now.
      // `effectiveRunScopes`/`shapeFor` are both public, the same functions
      // the route calls.
      const initialScopes = effectiveRunScopes(manifest, ['cash.summary']);
      const initialShape = shapeFor(manifest, initialScopes, {});

      // An unrelated, never-previewed shape is refused, named — not a 500.
      const wrong = await h.request({
        method: 'POST',
        url: `/advisors/${externalId}/payload-approvals`,
        session: h.fresh,
        body: { queryShape: 'sha256:' + 'c'.repeat(64) },
      });
      expect(wrong.statusCode).toBe(409);
      expect(problemOf(wrong)['code']).toBe('insights.payload_shape_changed');

      // The shape actually previewed is approved.
      const approved = await h.request({
        method: 'POST',
        url: `/advisors/${externalId}/payload-approvals`,
        session: h.fresh,
        body: { queryShape: initialShape },
      });
      expectStatus(approved, 200);
      expect((approved.json() as { queryShape: string }).queryShape).toBe(initialShape);

      // Widening the grant changes the shape — the approval was for what was
      // shown, never for "whatever this advisor sends next" (05 §3 WP 5.10).
      await grantScopes(h.database.db, context, externalId, ['cash.summary', 'cashflow.monthly']);
      const stale = await h.request({
        method: 'POST',
        url: `/advisors/${externalId}/payload-approvals`,
        session: h.fresh,
        body: { queryShape: initialShape }, // the shape from before the grant widened
      });
      expect(stale.statusCode).toBe(409);
      expect(problemOf(stale)['code']).toBe('insights.payload_shape_changed');
    });

    it('a builtin advisor refuses an approval — it sends no payload to approve', async () => {
      // The *current* shape must be named for the route to reach the
      // kind check at all: `approvePayload` refuses a mismatched shape
      // (`shape_changed`) before it ever asks whether this kind needs
      // approval, so an arbitrary shape would prove the wrong thing.
      const manifest = createBuiltinRegistry().get(CASH_ADVISOR_ID)?.manifest;
      if (manifest === undefined) throw new Error(`no builtin manifest for ${CASH_ADVISOR_ID}`);
      const scopes = effectiveRunScopes(manifest, ['cash.summary']);
      const shape = shapeFor(manifest, scopes, {});

      const response = await h.request({
        method: 'POST',
        url: `/advisors/${CASH_ADVISOR_ID}/payload-approvals`,
        session: h.fresh,
        body: { queryShape: shape },
      });
      expect(response.statusCode).toBe(422);
      expect(problemOf(response)['code']).toBe('insights.advisor_kind_needs_no_approval');
    });

    it('approvals need a fresh session', async () => {
      const response = await h.request({
        method: 'POST',
        url: `/advisors/${CASH_ADVISOR_ID}/payload-approvals`,
        session: h.stale,
        body: { queryShape: 'sha256:' + 'e'.repeat(64) },
      });
      expect(response.statusCode).toBe(403);
      expect(problemOf(response)['code']).toBe('step_up_required');
    });
  });

  describe('PUT /advisors/kinds/{kind}/enabled', () => {
    it('needs a fresh session', async () => {
      const response = await h.request({
        method: 'PUT',
        url: '/advisors/kinds/local_model/enabled',
        session: h.stale,
        body: { enabled: true },
      });
      expect(response.statusCode).toBe(403);
    });

    it('flips the kind-2 kill switch, and only for the kind that has one', async () => {
      const on = await h.request({
        method: 'PUT',
        url: '/advisors/kinds/local_model/enabled',
        session: h.fresh,
        body: { enabled: true },
      });
      expectStatus(on, 200);
      expect((on.json() as { enabled: boolean }).enabled).toBe(true);

      const flagRow = await h.database.pool.query<{ enabled: boolean }>(
        `SELECT enabled FROM feature_flags WHERE user_id = $1 AND key = 'advisors.kind.local_model'`,
        [h.userId],
      );
      expect(flagRow.rows[0]?.enabled).toBe(true);

      const off = await h.request({
        method: 'PUT',
        url: '/advisors/kinds/local_model/enabled',
        session: h.fresh,
        body: { enabled: false },
      });
      expectStatus(off, 200);
      expect((off.json() as { enabled: boolean }).enabled).toBe(false);

      const noFlag = await h.request({
        method: 'PUT',
        url: '/advisors/kinds/builtin/enabled',
        session: h.fresh,
        body: { enabled: false },
      });
      expect(noFlag.statusCode).toBe(404);
      expect(problemOf(noFlag)['code']).toBe('insights.kind_flag_not_found');
    });

    it("one holder's kind switch never reaches another's", async () => {
      const otherUserId = await h.database.createUser('Kind Switch Second Holder');
      const otherFresh = await h.issueSession({ userId: otherUserId, fresh: true });

      await h.request({
        method: 'PUT',
        url: '/advisors/kinds/local_model/enabled',
        session: h.fresh,
        body: { enabled: true },
      });
      await h.request({
        method: 'PUT',
        url: '/advisors/kinds/local_model/enabled',
        session: otherFresh,
        body: { enabled: false },
      });

      const aliceFlag = await h.database.pool.query<{ enabled: boolean }>(
        `SELECT enabled FROM feature_flags WHERE user_id = $1 AND key = 'advisors.kind.local_model'`,
        [h.userId],
      );
      const bobFlag = await h.database.pool.query<{ enabled: boolean }>(
        `SELECT enabled FROM feature_flags WHERE user_id = $1 AND key = 'advisors.kind.local_model'`,
        [otherUserId],
      );
      expect(aliceFlag.rows[0]?.enabled).toBe(true);
      expect(bobFlag.rows[0]?.enabled).toBe(false);
    });
  });
});
