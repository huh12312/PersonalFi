// SPDX-License-Identifier: MIT
/**
 * WP 11.5e — the Brief and the advisor meet, through the shipped composition
 * (the same harness as WP 11.5d's suite: the real routes, job registrations,
 * catalogue, knowledge base and advisor adapters over the Ollama fake):
 *
 *   * a real goal-pace finding (R6, run over the real ports) is published in a
 *     real Brief, whose item offers "Talk this through"; so does its insight card;
 *   * `POST /advisor/sessions` with the finding's origin builds the question
 *     from the rule family's template, records the origin, asks no model; the
 *     clarify call is sent the title and the rule as a quoted fact; the gather
 *     step's seeded call (`goal.required_savings`) runs first whatever the
 *     compiler asked, and the finding's own figures join the context object as
 *     a result, every figure with a `source_ref` that is one of the finding's
 *     resolved evidence rows; never the goal's name, never an id;
 *   * the plan is tracked; the next Brief carries it as progress — the origin,
 *     the pick date, the baseline and current figures in the template's words
 *     — and the finding is withdrawn and marked being worked on, never shown
 *     twice;
 *   * a windfall in the plan that meets the goal: the watched figure reaches its
 *     target, the session completes and its watcher stops; the Brief reads
 *     "reached";
 *   * the database refuses the origin columns one without the other, and a
 *     completed session whose watcher is not reached.
 */
import {
  ADVISOR_SYSTEM_PROMPTS,
  ASK_COMPILE_SYSTEM_PROMPT,
  type AdvisorModelStep,
} from '@advisor/local-model';
import { startFakeOllama, type FakeOllama } from '@advisor/local-model/test';
import { DateOnly, newId, systemClock, todayIn } from '@core/kernel';
import {
  createFlagService,
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
  platformExecutor,
  PLATFORM_FLAGS,
  type JobContext,
} from '@core/platform';
import {
  createBuiltinRegistry,
  runAdvisors,
  ADVISOR_FOLLOW_UP_JOB_KIND,
  ADVISOR_STEP_JOB_KIND,
  BRIEF_JOB_KIND,
  KIND_FLAG_KEYS,
  MODULE_FLAG_KEY,
  NARRATOR_MANIFEST,
  advisorStepShape,
  approveAdvisorStep,
  grantScopes,
  registerAdvisor,
  type AdvisorStep,
} from '@ctx/insights';
import { computeNetWorth, sealDay, upsertOpenDay } from '@ctx/planning';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdvisorRuntime, type AdvisorRuntime } from '../../src/advisor-mode.ts';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInsightsBudgetPort,
  createInsightsInvestmentsPort,
  createInsightsLedgerPort,
  createInsightsMarketDataPort,
  createInsightsPlanningPort,
  createInsightsRecurringPort,
  createInvestmentSyncPort,
  planningPortsFor,
} from '../../src/domain.ts';
import { appModules, registerBuiltinAdvisors } from '../../src/modules.ts';
import { createNarratorRuntime } from '../../src/narrator-wiring.ts';
import { createNarratorStores } from '../../src/narrator-stores.ts';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS } from '../../src/platform.ts';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const MODEL_NAME = 'qwen2.5:7b-instruct-q4_K_M';
const DIGEST_HEX = '5'.repeat(64);
const TOKEN_SECRET = 'wp115e-brief-advisor'; // gitleaks:allow — synthetic advisor-token secret for a test
/** What the holder grants the narrator: goals, the plan, cash, cash flow — nothing about holdings. */
const SCOPES = ['cash.summary', 'cashflow.monthly', 'goals.list', 'plan.projection'] as const;
const R6 = 'builtin.retirement.goal_pace';
const R6_TITLE = 'A goal is behind the pace that reaches it on time';
const STEPS: readonly AdvisorStep[] = [
  'clarify',
  'gather',
  'options',
  'tradeoffs',
  'plan',
  'judge',
];

function jobContext(userId: string): JobContext {
  return {
    id: newId(),
    userId,
    kind: 'test',
    attempt: 1,
    correlationId: newId(),
    logger: pino({ level: 'silent' }) as unknown as JobContext['logger'],
    clock: systemClock,
    signal: new AbortController().signal,
  };
}

/** The fenced subject of a chat body, parsed back. */
function subjectOf(body: unknown): Record<string, unknown> {
  const messages = (body as { messages?: { content: string }[]; system?: string }).messages ?? [];
  const user = messages[messages.length - 1]?.content ?? '';
  const block = user.slice(user.indexOf('\n') + 1, user.indexOf('\n</untrusted_data>'));
  return (JSON.parse(block) as { subject: Record<string, unknown> }).subject;
}

/** Which step a chat body is (by its constant system region). */
function stepOf(body: unknown): AdvisorModelStep | 'gather' | null {
  const record = body as { messages?: { role: string; content: string }[]; system?: string };
  const system = record.system ?? record.messages?.[0]?.content ?? '';
  if (system === ASK_COMPILE_SYSTEM_PROMPT) return 'gather';
  for (const step of ['clarify', 'options', 'tradeoffs', 'plan', 'judge'] as const) {
    if (system === ADVISOR_SYSTEM_PROMPTS[step]) return step;
  }
  return null;
}

type Figure = { ref: string; label: string; text: string };
function figuresOf(subject: Record<string, unknown>): Figure[] {
  const context = (subject['context'] ?? {}) as { results?: { figures: Figure[] }[] };
  return (context.results ?? []).flatMap((result) => result.figures);
}
function figure(subject: Record<string, unknown>, ref: string): Figure {
  const found = figuresOf(subject).find((entry) => entry.ref === ref);
  if (found === undefined)
    throw new Error(
      `no figure ${ref} in ${JSON.stringify(
        (subject['context'] as { results: unknown[] }).results.map((r) => {
          const x = r as Record<string, unknown>;
          return [x['function'], x['status'], x['not_available']];
        }),
      )}`,
    );
  return found;
}

/** The obedient model: each step's scripted reply, built from what it was sent. */

/** The obedient model for a session opened from the goal finding: r1 is the finding, r2 the seeded goal call. */
const script: Record<string, (subject: Record<string, unknown>) => unknown> = {
  clarify: () => ({
    restatement: `What could be done about “${R6_TITLE}”, and what each choice costs.`,
    questions: ['Is there a date the goal must be met by?'],
    assumed: [],
  }),
  // The compiler asks only for contribution room: the seeded goal call runs anyway, first.
  gather: () => ({
    calls: [
      {
        name: 'limits.contribution_room',
        args: JSON.stringify({ year: 2026, account_kind: 'ira' }),
      },
    ],
    unanswerable: null,
  }),
  options: (subject) => ({
    options: [
      {
        label: 'Raise the goal’s monthly saving',
        backed_by: ['r2:monthly'],
        summary: `The goal needs ${figure(subject, 'r2:monthly').text} a month more to reach its target.`,
      },
      {
        label: 'Use the IRA room instead',
        backed_by: ['r3:remaining'],
        summary: `The IRA has ${figure(subject, 'r3:remaining').text} of room left this year.`,
      },
    ],
  }),
  tradeoffs: (subject) => ({
    tradeoffs: [
      {
        option: 'o1',
        benefit: ['r2:monthly'],
        cost: ['r3:remaining'],
        note: `Keeps the goal on pace and leaves ${figure(subject, 'r3:remaining').text} of IRA room unused.`,
      },
      {
        option: 'o2',
        benefit: ['r3:remaining'],
        cost: ['r2:monthly'],
        note: `Uses the IRA room while the goal still needs ${figure(subject, 'r2:monthly').text} a month.`,
      },
    ],
  }),
  judge: () => ({
    scores: [
      { criterion: 'cost_surfaced', met: true, reason: 'Each option names what it gives up.' },
      { criterion: 'non_applicability', met: true, reason: 'It says when this would not suit.' },
      { criterion: 'scope_kept', met: true, reason: 'No security, timing or execution.' },
    ],
  }),
  plan: () => ({
    steps: [
      {
        text: 'The Goals screen holds the goal and its monthly contribution.',
        action_href: '/goals',
      },
    ],
  }),
};

describe.skipIf(NO_DATABASE)(
  'WP 11.5e — the Brief and the advisor meet, through the composition',
  () => {
    let h: ApiHarness;
    let fake: FakeOllama;
    let modules: ReturnType<typeof appModules>;
    let localRuntime: AdvisorRuntime;
    const overrides: Partial<Record<string, (subject: Record<string, unknown>) => unknown>> = {};
    let goalId = '';

    const respond = (body: unknown): string => {
      const step = stepOf(body);
      if (step === null) return '{}';
      const subject = subjectOf(body);
      const reply = (overrides[step] ?? script[step])?.(subject);
      return JSON.stringify(reply ?? {});
    };

    function registration(kind: string) {
      const insightsModule = modules.find((module) => module.flagKey === 'module.insights');
      const found = insightsModule?.jobs?.find((entry) => entry.kind === kind);
      if (found === undefined) throw new Error(`${kind} is not registered`);
      return found;
    }

    async function runPending(kind = ADVISOR_STEP_JOB_KIND): Promise<number> {
      const pending = await h.database.db.execute<{ id: string; payload: unknown }>(sql`
      SELECT id, payload FROM jobs WHERE kind = ${kind} AND status = 'pending' ORDER BY created_at
    `);
      for (const row of pending.rows) {
        await h.database.db.execute(
          sql`UPDATE jobs SET status = 'running' WHERE id = ${row.id}::uuid`,
        );
        await registration(kind).handler(row.payload, jobContext(h.userId));
        await h.database.db.execute(
          sql`UPDATE jobs SET status = 'succeeded' WHERE id = ${row.id}::uuid`,
        );
      }
      return pending.rows.length;
    }

    const get = (url: string) => h.request({ method: 'GET', url, session: h.stale });
    const post = (url: string, body: unknown = {}) =>
      h.request({ method: 'POST', url, session: h.stale, body });
    const chats = () => fake.chats.length;
    const stepsOfChats = () =>
      fake.requests
        .filter(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/chat' &&
            (request.body as { stream?: boolean }).stream !== false,
        )
        .map((request) => stepOf(request.body));

    type Session = {
      id: string;
      status: string;
      engine: { provider: string; providerName: string; model: string; egress: string } | null;
      clarification: {
        restatement: string;
        questions: string[];
        assumed: { about: string; valueRef: string; value: string }[];
      } | null;
      options:
        | {
            id: string;
            label: string;
            cost: { label: string; text: string }[];
            benefit: { label: string; text: string }[];
          }[]
        | null;
      plan: { text: string; href: string; label: string }[] | null;
      tracked: {
        kind: string;
        baseline: { text: string };
        latest: { text: string } | null;
        brief: { outcome: string };
      } | null;
      judge: { score: string | null; error: string | null; runId: string | null } | null;
      refusal: { step: string; class: string } | null;
      unanswerable: { reason: string; topic: string | null } | null;
      failure: { code: string } | null;
      fallback: boolean;
      lookedAt: { items: { function: string }[] } | null;
      knowledge: { pagesRead: string[]; withheld: { key: string; code: string }[] } | null;
      tokens: { used: number; budget: number; hostedWindowLeft: number | null };
      disclaimer: string;
      inspector: {
        contextDigest: string | null;
        steps: {
          step: string;
          runId: string;
          inputDigest: string;
          provider: string;
          model: string;
          egress: string;
          outcome: string | null;
          refusal: string | null;
          knowledgeRead: Record<string, unknown> | null;
          inspectorPath: string;
        }[];
      };
    };

    async function approveAll(
      runtime: AdvisorRuntime,
      steps: readonly AdvisorStep[] = STEPS,
    ): Promise<void> {
      const resolution = await runtime.resolve(h.userId);
      if (resolution.models === null) throw new Error('no advisor models');
      const ctx = { userId: h.userId, clock: systemClock, correlationId: newId() };
      for (const step of steps) {
        const renderer = resolution.models[step];
        await approveAdvisorStep(h.database.db, ctx, {
          step,
          renderer,
          queryShape: advisorStepShape(step, renderer.templateHash),
        });
      }
    }

    beforeAll(async () => {
      h = await createApiHarness({
        suite: 'wp115e_brief_advisor',
        env: { LOCAL_MODEL_PIN_NAME: MODEL_NAME, LOCAL_MODEL_PIN_DIGEST: `sha256:${DIGEST_HEX}` },
        extraSecrets: { advisor_token_secret: TOKEN_SECRET },
      });
      fake = await startFakeOllama({
        models: [{ name: MODEL_NAME, digest: DIGEST_HEX }],
        chat: { kind: 'respond', respond },
      });
      await registerBuiltinAdvisors(h.database.db, {
        userId: h.userId,
        clock: systemClock,
        correlationId: newId(),
      });
      const ctx = { userId: h.userId, clock: systemClock, correlationId: newId() };
      await registerAdvisor(h.database.db, ctx, { manifest: NARRATOR_MANIFEST, enabled: false });

      const endpoint = `ollama:${String(fake.port)}`;
      const localTransport = createLocalEndpointTransport(
        createLocalEndpointPolicy({ endpoint, timeoutMs: 20_000, maxResponseBytes: 512 * 1024 }),
        { resolve: () => Promise.resolve(['127.0.0.1']) },
      );
      const localModel = {
        endpoint,
        name: MODEL_NAME,
        digest: `sha256:${DIGEST_HEX}`,
        timeoutMs: 20_000,
        allowRemote: false,
      };
      const stores = createNarratorStores({
        database: h.database.db,
        secretBox: () => h.security.requireSecretBox(),
      });
      const narratorRuntime = createNarratorRuntime({
        mode: 'run',
        stores,
        localModel,
        timeoutMs: 20_000,
        allowRemote: false,
        fileKeys: {},
        localTransport,
        clock: systemClock,
      });
      localRuntime = createAdvisorRuntime({
        mode: 'run',
        database: h.database.db,
        narrator: narratorRuntime,
        stores,
        localModel,
        timeoutMs: 20_000,
        allowRemote: false,
        fileKeys: {},
        localTransport,
        clock: systemClock,
      });
      const denyAll = createEgressPolicy({ allowedHosts: [] });
      const domain = createDomainRuntime({
        database: h.database.db,
        clock: systemClock,
        logger: pino({ level: 'silent' }),
        registry: createConnectorRegistry(),
        secretBox: h.security.requireSecretBox(),
      });
      modules = appModules({
        advisorsEnabled: true,
        database: h.database.db,
        userId: h.userId,
        orchestrator: domain.orchestrator,
        timezone: 'UTC',
        notificationChannels: {
          ntfy: createNtfyChannel({ policy: denyAll }),
          smtp: createSmtpChannel({ policy: denyAll }),
        },
        secretBox: h.security.requireSecretBox(),
        investmentSyncPort: createInvestmentSyncPort(h.database.db),
        advisorTokenSecret: TOKEN_SECRET,
        localModelConfigured: true,
        narratorRuntime,
        advisor: { runtime: localRuntime },
      });
      const flags = createFlagService({
        db: platformExecutor(h.database.db),
        defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS, ...ADVISOR_KIND_FLAGS],
        ttlMs: 0,
      });
      const platformDb = platformExecutor(h.database.db);
      await flags.set(platformDb, h.userId, MODULE_FLAG_KEY, true);
      await flags.set(
        platformDb,
        h.userId,
        KIND_FLAG_KEYS.local_model ?? 'advisors.kind.local_model',
        true,
      );
      await grantScopes(h.database.db, ctx, NARRATOR_MANIFEST.advisor_id, [...SCOPES]);
      // A goal the holder named: the advisor resolves "my house goal" to its ref.
      const created = await h.request({
        method: 'POST',
        url: '/goals',
        session: h.stale,
        body: {
          kind: 'purchase',
          name: 'House deposit',
          target: { minor: '6000000', currency: 'USD' },
          targetDate: DateOnly.addDays(todayIn(systemClock, 'UTC'), 1_100),
          priority: 1,
        },
      });
      expectStatus(created, 201);
      goalId = (created.json() as { id: string }).id;
      // A baseline plan (the goal's required saving is solved over it), as the 11.5b suite states one.
      const sealed = DateOnly.addDays(todayIn(systemClock, 'UTC'), -2);
      const planningPorts = planningPortsFor(h.database.db, {
        userId: h.userId,
        timeZone: 'UTC',
        clock: systemClock,
      });
      const worth = await computeNetWorth(planningPorts, {
        userId: h.userId,
        asOfDate: sealed,
        baseCurrency: 'USD',
      });
      await upsertOpenDay(h.database.db, { userId: h.userId, snapshot: worth, clock: systemClock });
      await sealDay(h.database.db, { userId: h.userId, asOfDate: sealed, clock: systemClock });
      const baseline = await h.request({
        method: 'POST',
        url: '/plan/scenarios',
        session: h.stale,
        body: {
          kind: 'baseline',
          name: 'Baseline',
          profile: {
            birthDate: '1980-01-01',
            retirementAge: 65,
            planEndAge: 95,
            currency: 'USD',
            glidepath: { kind: 'age_based' },
            contributionGrowth: 'flat',
            annualSpending: { minor: '4000000', currency: 'USD' },
            withdrawalPolicy: 'constant_real',
            spendingFloor: 'none',
            taxDeferredRate: '0.15',
            socialSecurity: {
              monthlyPia: { minor: '250000', currency: 'USD' },
              claimAge: { years: 67, months: 0 },
              stressAfter2034: false,
            },
            pensions: [],
            contributions: { TAXABLE: { minor: '600000', currency: 'USD' } },
          },
        },
      });
      expectStatus(baseline, 201);
    }, 180_000);

    afterAll(async () => {
      await fake?.close();
      await h?.close();
    }, 60_000);

    function portsOf() {
      return {
        ledger: createInsightsLedgerPort(h.database.db, systemClock),
        budget: createInsightsBudgetPort(h.database.db),
        recurring: createInsightsRecurringPort(h.database.db),
        investments: createInsightsInvestmentsPort(h.database.db, systemClock),
        marketData: createInsightsMarketDataPort({ source: undefined }),
        planning: createInsightsPlanningPort(h.database.db, systemClock, { timeZone: 'UTC' }),
      };
    }

    /** R6 over the real ports, as the nightly pass runs it. */
    async function runGoalPace(): Promise<void> {
      const ctx = {
        userId: h.userId,
        clock: systemClock,
        correlationId: newId(),
        causationId: null,
      };
      await grantScopes(h.database.db, ctx, R6, ['goals.list']);
      const results = await runAdvisors(
        h.database.db,
        ctx,
        {
          registry: createBuiltinRegistry(),
          ports: portsOf(),
          settings: {
            advisorsEnabled: true,
            moduleEnabled: true,
            timeZone: 'UTC',
            baseCurrency: 'USD',
            tokenSecret: TOKEN_SECRET,
          },
        },
        { advisorIds: [R6], trigger: 'manual' },
      );
      expect(results[0]).toMatchObject({ status: 'completed', accepted: 1 });
    }

    /** "The next Brief": this week's is withdrawn and published again by the real job. */
    async function publishBrief(): Promise<BriefWire> {
      await h.database.db.execute(
        sql`DELETE FROM advisory_briefs WHERE user_id = ${h.userId}::uuid`,
      );
      await registration(BRIEF_JOB_KIND).handler({}, jobContext(h.userId));
      const brief = await get('/insights/brief/current');
      expectStatus(brief, 200);
      return (brief.json() as { brief: BriefWire }).brief;
    }

    type BriefWire = {
      isoWeek: string;
      items: {
        insightId: string | null;
        advisorId: string;
        section: string;
        talkThrough: { insightId: string; briefWeek: string } | null;
        progress: {
          sessionId: string;
          origin: {
            insightId: string;
            ruleId: string;
            title: string;
            briefWeek: string | null;
          } | null;
          pickedAt: string | null;
          baseline: { text: string };
          latest: { text: string } | null;
          target: { text: string } | null;
          state: string;
          wording: string;
          workedOn: { insightId: string; title: string } | null;
        } | null;
      }[];
    };
    type Pregathered = {
      status: string;
      question: string;
      origin: { insightId: string; ruleId: string; title: string; briefWeek: string | null } | null;
      pregathered: { seeded: string[]; finding: string | null } | null;
      lookedAt: { items: { function: string; label: string }[] } | null;
      tracked:
        | (Session['tracked'] & {
            target: { text: string } | null;
            pickedAt: string | null;
            reached: boolean;
            wording: string;
          })
        | null;
      finishedAt: string | null;
    };
    const sessionWith = async (id: string) =>
      (await get(`/advisor/sessions/${id}`)).json() as Session & Pregathered;

    let findingId = '';
    let briefWeek = '';
    let sessionId = '';

    it('a Brief item and its insight card offer "Talk this through"; the session it opens is built from the finding — no model asked', async () => {
      await runGoalPace();
      const finding = await h.database.db.execute<{ id: string; title: string }>(
        sql`SELECT id, title FROM insights WHERE advisor_id = ${R6} AND status = 'pending_review'`,
      );
      expect(finding.rows).toHaveLength(1);
      findingId = finding.rows[0]?.id ?? '';
      expect(finding.rows[0]?.title).toBe(R6_TITLE);

      const brief = await publishBrief();
      briefWeek = brief.isoWeek;
      const item = brief.items.find((entry) => entry.insightId === findingId);
      expect(item?.talkThrough).toEqual({ insightId: findingId, briefWeek });
      expect(item?.progress).toBeNull();
      const cards = (await get('/insights')).json() as {
        list: { id: string; talkThrough: boolean }[];
        dashboard: { id: string; talkThrough: boolean }[];
      };
      const card = [...cards.dashboard, ...cards.list].find((entry) => entry.id === findingId);
      expect(card?.talkThrough).toBe(true);

      await approveAll(localRuntime);
      const before = chats();
      // Neither, or both: refused before anything is written.
      expectStatus(await post('/advisor/sessions', {}), 400);
      expectStatus(
        await post('/advisor/sessions', { question: 'x', origin: { insightId: findingId } }),
        400,
      );
      expectStatus(
        await post('/advisor/sessions', { origin: { insightId: newId(), briefWeek } }),
        404,
      );
      expectStatus(
        await post('/advisor/sessions', {
          origin: { insightId: findingId, briefWeek: '2001-W01' },
        }),
        400,
      );
      const opened = await post('/advisor/sessions', {
        origin: { insightId: findingId, briefWeek },
      });
      expectStatus(opened, 202);
      const body = opened.json() as Session & Pregathered;
      sessionId = body.id;
      expect(body).toMatchObject({
        status: 'clarifying',
        origin: { insightId: findingId, ruleId: 'R6', title: R6_TITLE, briefWeek },
        pregathered: null,
      });
      expect(body.question).toBe(
        `My Brief flagged “${R6_TITLE}” (A goal below the pace that reaches it on time). What are my options for reaching this goal, and what would each choice cost?`,
      );
      expect(chats()).toBe(before);
      const row = await h.database.db.execute<{
        origin_insight_ref: string;
        origin_rule_id: string;
        origin_brief_week: string;
      }>(
        sql`SELECT origin_insight_ref, origin_rule_id, origin_brief_week FROM advisor_sessions WHERE id = ${sessionId}::uuid`,
      );
      expect(row.rows[0]).toEqual({
        origin_insight_ref: findingId,
        origin_rule_id: 'R6',
        origin_brief_week: briefWeek,
      });
    }, 120_000);

    it('the session is pre-gathered: clarify is told the finding as a quoted fact; the seeded call runs first; the finding’s figures join the context, each resolving', async () => {
      const before = chats();
      expect(await runPending()).toBe(1);
      expect(chats() - before).toBe(1);
      const clarifyBody = fake.requests
        .filter((request) => request.path === '/api/chat' && stepOf(request.body) === 'clarify')
        .at(-1)?.body;
      const clarify = subjectOf(clarifyBody);
      expect(clarify['about']).toEqual({
        title: R6_TITLE,
        rule: {
          name: 'A goal below the pace that reaches it on time',
          text: expect.stringContaining('Reports each goal'),
        },
      });
      let current = await sessionWith(sessionId);
      expect(current.clarification?.restatement).toContain(R6_TITLE);

      expectStatus(
        await post(`/advisor/sessions/${sessionId}/answers`, { answers: ['No fixed date.'] }),
        202,
      );
      await runPending();
      expect(stepsOfChats().slice(-4)).toEqual(['gather', 'options', 'tradeoffs', 'judge']);
      current = await sessionWith(sessionId);
      expect(current.status).toBe('awaiting_pick');
      // The seeded call is always included, first; the compiler's own call follows.
      expect(current.pregathered).toEqual({ seeded: ['goal.required_savings'], finding: 'joined' });
      expect(current.lookedAt?.items.map((entry) => entry.function)).toEqual([
        'finding.evidence',
        'goal.required_savings',
        'limits.contribution_room',
      ]);

      // What the options call was sent: the finding as r1, every figure with a source_ref that is one of the
      // finding's own resolved evidence rows; never the goal's name, never an id.
      const optionsBody = fake.requests
        .filter((request) => request.path === '/api/chat' && stepOf(request.body) === 'options')
        .at(-1)?.body;
      const options = subjectOf(optionsBody);
      const results = (options['context'] as { results: Record<string, unknown>[] }).results;
      expect(results[0]).toMatchObject({ id: 'r1', function: 'finding.evidence' });
      const figures = (results[0]?.['figures'] ?? []) as {
        ref: string;
        text: string;
        source_refs: string[];
      }[];
      expect(figures.length).toBeGreaterThan(0);
      const evidence = await h.database.db.execute<{
        source_ref: string;
        resolved_display: string;
      }>(
        sql`SELECT source_ref, resolved_display FROM insight_evidence
           WHERE insight_id = ${findingId}::uuid AND resolved_display IS NOT NULL`,
      );
      const resolved = new Set(evidence.rows.map((entry) => entry.source_ref));
      for (const entry of figures) {
        expect(entry.source_refs).toHaveLength(1);
        expect(resolved.has(entry.source_refs[0] ?? ''), entry.ref).toBe(true);
      }
      const sent = JSON.stringify(options);
      // The finding's own result carries figures only: the goal's name (an identity field) never enters it.
      expect(JSON.stringify(results[0])).not.toContain('House deposit');
      expect(sent).not.toContain(findingId);
      expect(sent).not.toContain(goalId);
      expect((options['context'] as { results: unknown[] }).results).toHaveLength(3);
    }, 120_000);

    it('the plan is tracked; the next Brief carries it as progress, and the finding is withdrawn and marked being worked on — never shown twice', async () => {
      expectStatus(await post(`/advisor/sessions/${sessionId}/pick`, { optionId: 'o1' }), 202);
      await runPending();
      let current = await sessionWith(sessionId);
      expect(current.status).toBe('tracked');
      const today = todayIn(systemClock, 'UTC');
      expect(current.tracked).toMatchObject({
        kind: 'goal_pace',
        target: { text: '$0.00' },
        pickedAt: today,
        reached: false,
      });
      await registration(ADVISOR_FOLLOW_UP_JOB_KIND).handler({}, jobContext(h.userId));
      current = await sessionWith(sessionId);
      expect(current.tracked?.brief.outcome).toBe('written');

      const brief = await publishBrief();
      const progressItems = brief.items.filter((entry) => entry.progress !== null);
      expect(progressItems).toHaveLength(1);
      const progress = progressItems[0]?.progress;
      expect(progressItems[0]?.advisorId).toBe('advisor.follow_up');
      expect(progressItems[0]?.talkThrough).toBeNull();
      expect(progress).toMatchObject({
        sessionId,
        origin: { insightId: findingId, ruleId: 'R6', title: R6_TITLE, briefWeek },
        pickedAt: today,
        target: { text: '$0.00' },
        state: 'tracking',
        workedOn: { insightId: findingId, title: R6_TITLE },
      });
      const baseline = progress?.baseline.text ?? '';
      const latest = progress?.latest?.text ?? '';
      expect(progress?.wording).toBe(
        `Needed per month was ${baseline} when you picked this plan on ${today}. It is ${latest} now: ${
          baseline === latest ? 'no change since then' : 'down since then'
        }.`,
      );
      // The finding that opened the session is not in this Brief: it is the progress item's "being worked on".
      expect(brief.items.some((entry) => entry.insightId === findingId)).toBe(false);
    }, 120_000);

    it('a windfall in the plan that meets the goal: the watched figure reaches its target, the session completes and its watcher stops', async () => {
      // The plan now reaches the goal's target by its date on its own: the extra a month it needs is $0.00.
      const windfall = await post('/plan/life-events', {
        kind: 'windfall',
        name: 'A windfall',
        occursOn: DateOnly.addDays(todayIn(systemClock, 'UTC'), 60),
        amount: { minor: '20000000', currency: 'USD' },
      });
      expectStatus(windfall, 201);
      const before = chats();
      await registration(ADVISOR_FOLLOW_UP_JOB_KIND).handler({}, jobContext(h.userId));
      expect(chats()).toBe(before);
      const current = await sessionWith(sessionId);
      expect(current.status, JSON.stringify(current.tracked)).toBe('completed');
      expect(current.finishedAt).not.toBeNull();
      expect(current.tracked).toMatchObject({ reached: true, latest: { text: '$0.00' } });
      expect(current.tracked?.wording).toContain('which reaches the plan’s target of $0.00');
      const watcher = await h.database.db.execute<{ status: string; checked_at: string }>(
        sql`SELECT watcher ->> 'status' AS status, watcher ->> 'checked_at' AS checked_at
            FROM advisor_sessions WHERE id = ${sessionId}::uuid`,
      );
      expect(watcher.rows[0]?.status).toBe('reached');
      // Stopped: the next check does not look at it again.
      await registration(ADVISOR_FOLLOW_UP_JOB_KIND).handler({}, jobContext(h.userId));
      const again = await h.database.db.execute<{ checked_at: string }>(
        sql`SELECT watcher ->> 'checked_at' AS checked_at FROM advisor_sessions WHERE id = ${sessionId}::uuid`,
      );
      expect(again.rows[0]?.checked_at).toBe(watcher.rows[0]?.checked_at);
      // A completed session cannot be cancelled: it is final.
      expect((await post(`/advisor/sessions/${sessionId}/cancel`)).statusCode).toBe(409);

      const brief = await publishBrief();
      const progress = brief.items.find((entry) => entry.progress !== null)?.progress;
      expect(progress?.state).toBe('reached');
      expect(progress?.wording).toContain('which reaches the plan’s target of $0.00');
    }, 120_000);

    it('a finding the advisor cannot work from is refused by name; the database refuses the origin one without the other', async () => {
      const followUp = await h.database.db.execute<{ id: string }>(
        sql`SELECT id FROM insights WHERE advisor_id = 'advisor.follow_up' LIMIT 1`,
      );
      const refused = await post('/advisor/sessions', {
        origin: { insightId: followUp.rows[0]?.id ?? newId() },
      });
      expect(refused.statusCode).toBe(409);
      expect((refused.json() as { code: string }).code).toBe(
        'insights.advisor_finding_not_supported',
      );

      const attempt = async (statement: ReturnType<typeof sql>): Promise<string | null> => {
        try {
          await h.database.db.execute(statement);
          return null;
        } catch (error) {
          const cause = (error as { cause?: { code?: string } }).cause;
          return cause?.code ?? (error as { code?: string }).code ?? 'error';
        }
      };
      // The pair: one without the other is a CHECK violation (23514), either way round.
      expect(
        await attempt(
          sql`UPDATE advisor_sessions SET origin_rule_id = NULL WHERE id = ${sessionId}::uuid`,
        ),
      ).toBe('23514');
      expect(
        await attempt(
          sql`UPDATE advisor_sessions SET origin_insight_ref = NULL WHERE id = ${sessionId}::uuid`,
        ),
      ).toBe('23514');
      expect(
        await attempt(
          sql`UPDATE advisor_sessions SET origin_insight_ref = NULL, origin_rule_id = NULL
             WHERE id = ${sessionId}::uuid`,
        ),
      ).toBe('23514'); // the title rides with the pair
      // Completed only with the watcher reached.
      expect(
        await attempt(
          sql`UPDATE advisor_sessions SET watcher = jsonb_set(watcher, '{status}', '"watching"')
             WHERE id = ${sessionId}::uuid`,
        ),
      ).toBe('23514');
      // All three cleared together is a session from a typed question: accepted.
      expect(
        await attempt(
          sql`UPDATE advisor_sessions
               SET origin_insight_ref = NULL, origin_rule_id = NULL, origin_title = NULL, origin_brief_week = NULL
             WHERE id = ${sessionId}::uuid`,
        ),
      ).toBeNull();
    }, 60_000);
  },
);
