// SPDX-License-Identifier: MIT
/**
 * WP 9.6 item 1 and 2 — CF-1 / C5-1 (the narrator can be approved through the
 * product) and the kind/module state GETs (G5-14).
 *
 * ## Why this file builds its own api
 *
 * `createApiHarness` hands `buildApp` a fixed config with no local-model pin,
 * and the claim here is precisely about what the api does when a model is
 * configured. The api below is the real `buildApp` (the shipped `app.ts`
 * composition); only the config differs, and the session helper is the
 * harness's own (`security.requireIdentity().sessions.issue`). No route double.
 *
 * ## The worker side
 *
 * `appModules(...)` is the real `modules.ts` composition, built the way
 * `worker.ts` builds it for a configured model (`localModelConfigured`,
 * `narratorModel`, `promptRenderer` from one adapter), and its
 * `insights.run_local` job runs on a real `@core/platform` job runner against
 * a fake Ollama. The adapter comes from `createNarratorWiring`, the constructor
 * `worker.ts` itself builds its adapter through (WP 9.5): the worker and the api's
 * preview renderer cannot disagree on the template hash by construction, and
 * this test is what would turn red if they did.
 */
import { type LocalModelAdapter } from '@advisor/local-model';
import { startFakeOllama, type FakeOllama } from '@advisor/local-model/test';
import { fixedClock, newId, systemClock } from '@core/kernel';
import {
  createJobRunner,
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
  enqueueJob,
  platformExecutor,
  silentLogger,
} from '@core/platform';
import { ADMIN_URL } from '@core/testkit';
import { NARRATOR_MANIFEST, NARRATOR_SCOPES } from '@ctx/insights';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
} from '../../src/domain.ts';
import { appModules, createPreviewModel } from '../../src/modules.ts';
import { createNarratorWiring } from '../../src/narrator-wiring.ts';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import { startApiWithEnv, type EnvApi, type EnvApiSession } from '../helpers/api-with-env.ts';

const NO_DATABASE = ADMIN_URL === undefined;
const ZONE = 'America/Los_Angeles';
const MODEL_NAME = 'qwen2.5:7b-instruct-q4_K_M';
const SERVED_DIGEST_HEX = '845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e';
const PINNED_DIGEST = `sha256:${SERVED_DIGEST_HEX}`;

async function until(
  check: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

/** The worker's adapter: `modules.ts`'s own constructor, pointed at the fake Ollama. */
function workerAdapter(port: number): LocalModelAdapter {
  const endpoint = `ollama:${String(port)}`;
  const policy = createLocalEndpointPolicy({
    endpoint,
    timeoutMs: 20_000,
    maxResponseBytes: 512 * 1024,
  });
  const transport = createLocalEndpointTransport(policy, {
    resolve: () => Promise.resolve(['127.0.0.1']),
  });
  const wiring = createNarratorWiring(
    { endpoint, name: MODEL_NAME, digest: PINNED_DIGEST, timeoutMs: 20_000, allowRemote: false },
    { transport, clock: systemClock },
  );
  if (wiring === undefined) throw new Error('no wiring for a configured model');
  return wiring.localModel;
}

describe.skipIf(NO_DATABASE)(
  'WP 9.6 — the narrator is approved through the api (CF-1, C5-1)',
  () => {
    let api: EnvApi;
    let fake: FakeOllama;

    beforeAll(async () => {
      api = await startApiWithEnv('prev', {
        LOCAL_MODEL_PIN_NAME: MODEL_NAME,
        LOCAL_MODEL_PIN_DIGEST: PINNED_DIGEST,
      });
      fake = await startFakeOllama({
        models: [{ name: MODEL_NAME, digest: SERVED_DIGEST_HEX }],
        chat: { kind: 'reply', reply: '{}' },
      });
    }, 120_000);

    afterAll(async () => {
      await fake.close();
      await api.close();
    }, 60_000);

    it("a local-model payload is previewed and approved through the api, and the worker's next run proceeds on that approval", async () => {
      const adapter = workerAdapter(fake.port);

      // The worker side, built the way `worker.ts` builds it for a configured
      // model: the real `appModules`, the narrator bound to one adapter, the
      // schedules hook that registers `local.narrator` for the holder.
      const logger = pino({ level: 'silent' });
      const denyAll = createEgressPolicy({ allowedHosts: [] });
      const runtime = createDomainRuntime({
        database: api.database.db,
        clock: systemClock,
        logger,
        registry: createConnectorRegistry(),
        secretBox: api.security.requireSecretBox(),
      });
      const modules = appModules({
        advisorsEnabled: true,
        localModelConfigured: true,
        promptRenderer: adapter.promptRenderer,
        narratorModel: adapter,
        advisorTokenSecret: 'wp96-worker-secret',
        database: api.database.db,
        userId: api.database.userId,
        orchestrator: runtime.orchestrator,
        timezone: ZONE,
        clock: fixedClock('2026-10-06T12:00:00.000Z'),
        notificationChannels: {
          ntfy: createNtfyChannel({ policy: denyAll }),
          smtp: createSmtpChannel({ policy: denyAll }),
        },
        secretBox: api.security.requireSecretBox(),
        investmentSyncPort: createInvestmentSyncPort(api.database.db),
      });
      const insightsModule = modules.find((module) => module.flagKey === 'module.insights');
      await insightsModule?.schedules?.(api.database.userId);
      const runLocal = insightsModule?.jobs?.find((job) => job.kind === 'insights.run_local');
      if (runLocal === undefined) throw new Error('the worker did not register insights.run_local');

      // Consent and switches, all through the api: the grant (step-up), the
      // kind switch (step-up), the advisor switch (step-up).
      const grants = await api.request({
        method: 'PUT',
        url: '/advisors/local.narrator/grants',
        session: api.fresh,
        body: { scopes: [...NARRATOR_SCOPES], perRunConsent: true },
      });
      expect(grants.statusCode).toBe(200);
      expect(
        (
          await api.request({
            method: 'PUT',
            url: '/advisors/kinds/local_model/enabled',
            session: api.fresh,
            body: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await api.request({
            method: 'POST',
            url: '/advisors/local.narrator/enabled',
            session: api.fresh,
            body: { enabled: true },
          })
        ).statusCode,
      ).toBe(200);

      // The worker's run lane, over the real job runner.
      const runner = createJobRunner({
        pool: api.database.pool,
        db: platformExecutor(api.database.db),
        handlers: [runLocal],
        concurrency: 1,
        pollIntervalMs: 25,
        logger: silentLogger,
      });
      async function workerRun(): Promise<{ status: string; refusal: string | null }> {
        const before = await runCount();
        await enqueueJob(platformExecutor(api.database.db), {
          kind: 'insights.run_local',
          userId: api.database.userId,
          payload: { advisorId: 'local.narrator', trigger: 'manual' },
          correlationId: newId(),
        });
        // The run is recorded when it starts; wait until it has an outcome.
        // Newest by id (uuidv7), not by `started_at`: the module clock here is
        // fixed, so every run shares one instant.
        let latest: { status: string; refusal: string | null } | undefined;
        await until(
          async () => {
            // One statement, so the newest run and the count are one snapshot: a
            // second read could see a run the first did not and return the old row.
            const rows = await api.database.db.execute<{
              status: string;
              refusal: string | null;
              n: number;
            }>(sql`
              SELECT status, refusal,
                     (SELECT count(*)::int FROM advisor_runs
                       WHERE user_id = ${api.database.userId}::uuid
                         AND advisor_id = 'local.narrator') AS n
                FROM advisor_runs
               WHERE user_id = ${api.database.userId}::uuid AND advisor_id = 'local.narrator'
               ORDER BY id DESC LIMIT 1
            `);
            const row = rows.rows[0];
            if (row === undefined || row.n <= before || row.status === 'started') return false;
            latest = { status: row.status, refusal: row.refusal };
            return true;
          },
          15_000,
          'the worker run to finish',
        );
        if (latest === undefined) throw new Error('no narrator run recorded');
        return latest;
      }
      async function runCount(): Promise<number> {
        const rows = await api.database.db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM advisor_runs
           WHERE user_id = ${api.database.userId}::uuid AND advisor_id = 'local.narrator'
        `);
        return rows.rows[0]?.n ?? 0;
      }

      await runner.start();
      try {
        // 1. Before any approval the worker refuses: the gate holds.
        const refused = await workerRun();
        expect(refused.status).toBe('refused');
        expect(refused.refusal).toBe('payload_not_approved');

        // 2. The preview, through the api. The prompt is shown, the template
        //    hash is the worker's own, and nothing is approved yet.
        const previewResponse = await api.request({
          method: 'GET',
          url: '/advisors/local.narrator/payload-preview',
          session: api.stale,
        });
        expect(previewResponse.statusCode).toBe(200);
        const preview = previewResponse.json() as {
          kind: string;
          queryShape: string;
          promptTemplateHash: string | null;
          prompt: { text: string; hash: string } | null;
          approvalRequired: boolean;
          approved: boolean;
        };
        expect(preview.kind).toBe('local_model');
        expect(preview.approvalRequired).toBe(true);
        expect(preview.approved).toBe(false);
        expect(preview.prompt).not.toBeNull();
        expect(preview.promptTemplateHash).toBe(adapter.promptRenderer.templateHash);

        // 3. "Approve this payload" — a step-up act; a stale session is refused.
        const staleApproval = await api.request({
          method: 'POST',
          url: '/advisors/local.narrator/payload-approvals',
          session: api.stale,
          body: { queryShape: preview.queryShape },
        });
        expect(staleApproval.statusCode).toBe(403);
        const approval = await api.request({
          method: 'POST',
          url: '/advisors/local.narrator/payload-approvals',
          session: api.fresh,
          body: { queryShape: preview.queryShape },
        });
        expect(approval.statusCode).toBe(200);
        expect((approval.json() as { queryShape: string }).queryShape).toBe(preview.queryShape);

        const after = await api.request({
          method: 'GET',
          url: '/advisors/local.narrator/payload-preview',
          session: api.stale,
        });
        expect((after.json() as { approved: boolean }).approved).toBe(true);

        // 4. The worker's next run proceeds: not refused, on the strength of
        //    an approval the api wrote and no SQL.
        const proceeded = await workerRun();
        if (proceeded.refusal !== null)
          console.log(
            'DBG',
            JSON.stringify(
              (
                await api.database.db.execute(
                  sql`SELECT id, status, refusal, started_at, finished_at FROM advisor_runs ORDER BY id`,
                )
              ).rows,
            ),
            JSON.stringify(
              (
                await api.database.db.execute(
                  sql`SELECT id, kind, status, attempts, last_error FROM jobs ORDER BY created_at`,
                )
              ).rows,
            ),
          );
        expect(proceeded.refusal).toBeNull();
        expect(proceeded.status).toBe('completed');
      } finally {
        await runner.stop();
      }

      // The api never reached for the model: its preview and approval sent no
      // chat request, and the api's config holds no endpoint at all.
      expect(fake.requests.filter((request) => request.path === '/api/chat')).toHaveLength(0);
      expect(api.config.localModel).toBeUndefined();
      expect(api.config.localModelPin).toEqual({ name: MODEL_NAME, digest: PINNED_DIGEST });
    }, 120_000);

    it('the preview model the api binds holds a manifest and a renderer and nothing that can run or dial', async () => {
      const model = createPreviewModel({ name: MODEL_NAME, digest: PINNED_DIGEST });
      if (model === undefined) throw new Error('a configured pin must yield a preview model');
      // Manifest only: the narrator's own, with an executor that refuses.
      expect(model.narrator.manifest).toBe(NARRATOR_MANIFEST);
      await expect(model.narrator.run({} as never, new AbortController().signal)).rejects.toThrow(
        /never executes an advisor/,
      );
      // A pure renderer whose template hash is the worker adapter's own.
      expect(model.promptRenderer.templateHash).toBe(
        workerAdapter(fake.port).promptRenderer.templateHash,
      );
      expect(model.promptRenderer.model).toBe(`${MODEL_NAME}@${PINNED_DIGEST}`);
      // Nothing else is reachable from it: no `run`, no `checkModel`, no endpoint.
      expect(Object.keys(model.promptRenderer).sort()).toEqual(['model', 'render', 'templateHash']);
      expect(Object.keys(model).sort()).toEqual(['narrator', 'promptRenderer']);
      // No pin, no model.
      expect(createPreviewModel(undefined)).toBeUndefined();
      expect(fake.requests).toHaveLength(0);
    }, 30_000);

    it('the api registers local.narrator for approval when the worker has not yet (no row, no 500)', async () => {
      const other = await startApiWithEnv('prevnorow', {
        LOCAL_MODEL_PIN_NAME: MODEL_NAME,
        LOCAL_MODEL_PIN_DIGEST: PINNED_DIGEST,
      });
      try {
        const preview = await other.request({
          method: 'GET',
          url: '/advisors/local.narrator/payload-preview',
          session: other.stale,
        });
        expect(preview.statusCode).toBe(200);
        const shape = (preview.json() as { queryShape: string }).queryShape;
        const approval = await other.request({
          method: 'POST',
          url: '/advisors/local.narrator/payload-approvals',
          session: other.fresh,
          body: { queryShape: shape },
        });
        expect(approval.statusCode).toBe(200);
        const rows = await other.database.db.execute<{ enabled: boolean }>(sql`
        SELECT enabled FROM advisors
         WHERE user_id = ${other.database.userId}::uuid AND advisor_id = ${NARRATOR_MANIFEST.advisor_id}
      `);
        expect(rows.rows).toHaveLength(1);
        // Registered the way the worker registers it: off. The approval is not a switch.
        expect(rows.rows[0]?.enabled).toBe(false);
      } finally {
        await other.close();
      }
    }, 120_000);

    it('with no model configured the api still refuses, named, and registers nothing', async () => {
      const bare = await startApiWithEnv('prevnone');
      try {
        const preview = await bare.request({
          method: 'GET',
          url: '/advisors/local.narrator/payload-preview',
          session: bare.stale,
        });
        // No pin, no registration: the same 404 any unregistered advisor gets.
        expect(preview.statusCode).toBe(404);
        const rows = await bare.database.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM advisors
         WHERE user_id = ${bare.database.userId}::uuid AND advisor_id = 'local.narrator'
      `);
        expect(rows.rows[0]?.n).toBe(0);
      } finally {
        await bare.close();
      }
    }, 120_000);
  },
);

describe.skipIf(NO_DATABASE)('WP 9.6 item 2 — the kill levels report their real state', () => {
  it('the kind state reported by GET follows both the PUT and the config switch', async () => {
    const pinned = await startApiWithEnv('kindpin', {
      LOCAL_MODEL_PIN_NAME: MODEL_NAME,
      LOCAL_MODEL_PIN_DIGEST: PINNED_DIGEST,
    });
    const unpinned = await startApiWithEnv('kindnone');
    try {
      type KindState = { kind: string; enabled: boolean; configured: boolean; effective: boolean };
      const get = async (api: EnvApi): Promise<KindState> => {
        const response = await api.request({
          method: 'GET',
          url: '/advisors/kinds/local_model/enabled',
          session: api.stale,
        });
        expect(response.statusCode).toBe(200);
        return response.json() as KindState;
      };
      const put = async (api: EnvApi, enabled: boolean, session: EnvApiSession): Promise<number> =>
        (
          await api.request({
            method: 'PUT',
            url: '/advisors/kinds/local_model/enabled',
            session,
            body: { enabled },
          })
        ).statusCode;

      // The default: the flag is off, the model is configured, so effectively off.
      expect(await get(pinned)).toEqual({
        kind: 'local_model',
        enabled: false,
        configured: true,
        effective: false,
      });

      // Follows the PUT, both ways; a stale session cannot move it.
      expect(await put(pinned, true, pinned.stale)).toBe(403);
      expect((await get(pinned)).enabled).toBe(false);
      expect(await put(pinned, true, pinned.fresh)).toBe(200);
      expect(await get(pinned)).toEqual({
        kind: 'local_model',
        enabled: true,
        configured: true,
        effective: true,
      });
      expect(await put(pinned, false, pinned.fresh)).toBe(200);
      expect((await get(pinned)).enabled).toBe(false);

      // Follows the config switch: the flag is on, but no model is configured,
      // so the kind is effectively off and the screen can say why.
      expect(await put(unpinned, true, unpinned.fresh)).toBe(200);
      expect(await get(unpinned)).toEqual({
        kind: 'local_model',
        enabled: true,
        configured: false,
        effective: false,
      });

      // A kind with no flag of its own has no state to report.
      const builtin = await pinned.request({
        method: 'GET',
        url: '/advisors/kinds/builtin/enabled',
        session: pinned.stale,
      });
      expect(builtin.statusCode).toBe(404);
      expect((builtin.json() as { code: string }).code).toBe('insights.kind_flag_not_found');

      // Unauthenticated: 401.
      expect(
        (await pinned.request({ method: 'GET', url: '/advisors/kinds/local_model/enabled' }))
          .statusCode,
      ).toBe(401);
    } finally {
      await pinned.close();
      await unpinned.close();
    }
  }, 180_000);

  it("each holder's kill-level state is their own, and level 1's key is not level 2's (predicates alone and together)", async () => {
    const api = await startApiWithEnv('levelsown', {
      LOCAL_MODEL_PIN_NAME: MODEL_NAME,
      LOCAL_MODEL_PIN_DIGEST: PINNED_DIGEST,
    });
    try {
      const bobId = await api.database.createUser('a second holder');
      const bob = {
        fresh: await api.issueSession({ fresh: true, userId: bobId }),
        stale: await api.issueSession({ fresh: false, userId: bobId }),
      };
      const read = async (
        url: string,
        session: EnvApiSession,
      ): Promise<Record<string, unknown>> => {
        const response = await api.request({ method: 'GET', url, session });
        expect(response.statusCode).toBe(200);
        return response.json() as Record<string, unknown>;
      };
      const write = async (url: string, session: EnvApiSession, enabled: boolean) =>
        (await api.request({ method: 'PUT', url, session, body: { enabled } })).statusCode;
      const moduleOf = async (session: EnvApiSession) =>
        (await read('/advisors/module/enabled', session))['user'] as { enabled: boolean };
      const kindOf = async (session: EnvApiSession) =>
        (await read('/advisors/kinds/local_model/enabled', session))['enabled'] as boolean;

      // Alice (the harness's holder) turns the module off and the kind on.
      expect(await write('/advisors/module/enabled', api.fresh, false)).toBe(200);
      expect(await write('/advisors/kinds/local_model/enabled', api.fresh, true)).toBe(200);

      // userId alone: Bob reads his own defaults, not hers.
      expect(await moduleOf(bob.stale)).toEqual({ enabled: true });
      expect(await kindOf(bob.stale)).toBe(false);
      // key alone: her module flag and her kind flag are each their own.
      expect(await moduleOf(api.stale)).toEqual({ enabled: false });
      expect(await kindOf(api.stale)).toBe(true);

      // Together, in the other direction: Bob's writes move only Bob's flags.
      expect(await write('/advisors/module/enabled', bob.fresh, true)).toBe(200);
      expect(await write('/advisors/kinds/local_model/enabled', bob.fresh, false)).toBe(200);
      expect(await moduleOf(bob.stale)).toEqual({ enabled: true });
      expect(await kindOf(bob.stale)).toBe(false);
      expect(await moduleOf(api.stale)).toEqual({ enabled: false });
      expect(await kindOf(api.stale)).toBe(true);
    } finally {
      await api.close();
    }
  }, 180_000);

  it('level 1 reports both halves, and the user half can be set with a step-up (G5-14)', async () => {
    const on = await startApiWithEnv('modon');
    const off = await startApiWithEnv('modoff', { ADVISORS_ENABLED: 'false' });
    try {
      type ModuleState = {
        operator: { advisorsEnabled: boolean };
        user: { enabled: boolean };
        effective: boolean;
      };
      const get = async (api: EnvApi): Promise<ModuleState> => {
        const response = await api.request({
          method: 'GET',
          url: '/advisors/module/enabled',
          session: api.stale,
        });
        expect(response.statusCode).toBe(200);
        return response.json() as ModuleState;
      };
      expect(await get(on)).toEqual({
        operator: { advisorsEnabled: true },
        user: { enabled: true },
        effective: true,
      });

      // The user half follows a PUT; a stale session is refused.
      expect(
        (
          await on.request({
            method: 'PUT',
            url: '/advisors/module/enabled',
            session: on.stale,
            body: { enabled: false },
          })
        ).statusCode,
      ).toBe(403);
      expect((await get(on)).user.enabled).toBe(true);
      expect(
        (
          await on.request({
            method: 'PUT',
            url: '/advisors/module/enabled',
            session: on.fresh,
            body: { enabled: false },
          })
        ).statusCode,
      ).toBe(200);
      expect(await get(on)).toEqual({
        operator: { advisorsEnabled: true },
        user: { enabled: false },
        effective: false,
      });

      // The operator half follows the config: ADVISORS_ENABLED=false is off
      // whatever the user's flag says.
      expect(await get(off)).toEqual({
        operator: { advisorsEnabled: false },
        user: { enabled: true },
        effective: false,
      });
    } finally {
      await on.close();
      await off.close();
    }
  }, 180_000);
});
