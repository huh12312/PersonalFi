// SPDX-License-Identifier: MIT
/**
 * Linked, never ranked (WP 5.3; migration 0031; 07 §7.5 rules 1 and 3).
 *
 * Everything here runs through the real `runAdvisor` over a scratch Postgres:
 * a built-in stub proposes a finding in the built-in lane, then the real
 * `local.narrator` (`createNarratorAdvisor`) runs in the local lane over a
 * **recorded-reply model** — the adapter port answered from a script instead
 * of from Ollama, the same seam `apps/api/src/worker.ts` binds WP 5.2's
 * adapter to. The findings envelope is assembled from the database, laundered
 * against the narrator's real grant, and the reply goes through the real
 * validator; the switches, the approval and the write barrier are real too.
 *
 * "The Brief" in the first test's name is read through `listInsights`: WP
 * 5.6's Brief assembles its candidates through it (`src/brief/assembly.ts`'s
 * header), exactly as the feed and the dashboard slice do, so a narration
 * excluded there takes no Brief slot either.
 */
import { platformExecutor, type FlagService } from '@core/platform';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { advisorRuns, insights } from '../../schema/index.ts';
import { narrationsFor } from '../../src/advisors/local/link.ts';
import { NARRATOR_ADVISOR_ID, NARRATOR_MANIFEST } from '../../src/advisors/local/manifest.ts';
import { createNarratorAdvisor } from '../../src/advisors/local/narrator.ts';
import type { AdvisorRequest, NarratedFinding } from '../../src/contract/request.ts';
import type { Insight } from '../../src/contract/response.ts';
import type { InsightsContext } from '../../src/db.ts';
import { insightFeed, listInsights } from '../../src/read.ts';
import type { Advisor } from '../../src/registry.ts';
import { MODULE_FLAG_KEY } from '../../src/policy/kill-switches.ts';
import { approvePayload, previewRequest } from '../../src/preview.ts';
import type { AdvisorScope } from '../../src/contract/scopes.ts';
import { runAdvisor, type InsightsDependencies } from '../../src/service.ts';
import { grantScopes, registerAdvisor } from '../../src/store.ts';
import { baseManifest, responseFor } from '../fixtures.ts';
import {
  NO_DATABASE,
  clockAt,
  contextFor,
  insightsDatabase,
  selfCiting,
  type TestDatabase,
} from './harness.ts';
import {
  LOCAL_FLAG,
  armAdvisor,
  dependenciesFor,
  fakeRenderer,
  flagsFor,
  liveSwitches,
} from './run-control-harness.ts';

const BUILTIN = 'builtin.cash.account_count';
const LATER = '2026-09-26T09:00:00.000Z';

/** A built-in whose one finding carries a figure and a date, both from `cash_summary`. */
function countingBuiltin(): Advisor {
  const manifest = baseManifest({ advisor_id: BUILTIN, requires_scopes: ['cash.summary'] });
  return {
    manifest,
    run: (request: AdvisorRequest) =>
      Promise.resolve(
        responseFor(request, [
          selfCiting(request, {
            key: 'cash.account_count',
            type: 'cash.account_count',
            title: 'Your cash is in one place',
            summary_md: `You hold 1 cash account, as of ${request.today}.`,
            evidence: [
              {
                kind: 'metric',
                label: 'Cash accounts',
                value: '1',
                source_ref: 'snapshot:cash_summary.account_count',
                url: null,
              },
              {
                kind: 'metric',
                label: 'As of',
                value: request.today,
                source_ref: 'snapshot:cash_summary.as_of',
                url: null,
              },
            ],
          }),
        ]),
      ),
  };
}

/** WP 5.2's adapter port, answered from a script: a recorded reply per call. */
function recordedModel(reply: (finding: NarratedFinding) => Partial<Insight>) {
  const calls: AdvisorRequest[] = [];
  return {
    calls,
    run: (request: AdvisorRequest) => {
      calls.push(request);
      const narrations = (request.findings ?? []).map((finding) => ({
        key: finding.key,
        period: finding.period,
        type: finding.type,
        severity: finding.severity,
        title: 'In plain words',
        summary_md: 'Wording.',
        confidence: 0.7,
        confidence_basis: 'model' as const,
        horizon: 'this_period' as const,
        requires_review: true as const,
        impact: { annualized: null, one_time: null, basis: '', derivation_id: null },
        evidence: [
          {
            kind: 'metric' as const,
            label: finding.evidence[0]?.label ?? 'x',
            value: finding.evidence[0]?.value ?? null,
            source_ref: finding.evidence[0]?.source_ref ?? null,
            url: null,
          },
        ],
        derivations: [],
        proposed_actions: [],
        caveats: [],
        expires_at: null,
        ...reply(finding),
      }));
      return Promise.resolve(responseFor(request, narrations));
    },
  };
}

describe.skipIf(NO_DATABASE)('narrations are linked, never ranked', () => {
  let database: TestDatabase;
  let flags: FlagService;
  let context: InsightsContext;

  beforeEach(async () => {
    database ??= await insightsDatabase('narration_link');
    await database.truncate();
    flags = flagsFor(database);
    context = contextFor(database.userId);
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  /** Both advisors armed — every switch yes — with the narrator granted `narratorGrant`. */
  async function setUp(
    model: ReturnType<typeof recordedModel>,
    narratorGrant: readonly AdvisorScope[] = ['cash.summary'],
  ): Promise<InsightsDependencies> {
    const builtin = countingBuiltin();
    const narrator = createNarratorAdvisor({ model });
    const dependencies = dependenciesFor([builtin, narrator], liveSwitches(flags), fakeRenderer());
    await armAdvisor(database, context, dependencies, flags, builtin.manifest);
    await registerAdvisor(database.db, context, { manifest: NARRATOR_MANIFEST, enabled: true });
    await grantScopes(database.db, context, NARRATOR_ADVISOR_ID, narratorGrant);
    await flags.set(platformExecutor(database.db), context.userId, MODULE_FLAG_KEY, true);
    await flags.set(platformExecutor(database.db), context.userId, LOCAL_FLAG, true);
    const preview = await previewRequest(database.db, context, dependencies, NARRATOR_ADVISOR_ID);
    await approvePayload(database.db, context, dependencies, {
      advisorId: NARRATOR_ADVISOR_ID,
      queryShape: preview.queryShape,
    });
    return dependencies;
  }

  const runBuiltin = (dependencies: InsightsDependencies, at: InsightsContext = context) =>
    runAdvisor(database.db, at, dependencies, { advisorId: BUILTIN, trigger: 'manual' });
  const runNarrator = (dependencies: InsightsDependencies, at: InsightsContext = context) =>
    runAdvisor(database.db, at, dependencies, {
      advisorId: NARRATOR_ADVISOR_ID,
      trigger: 'manual',
      lane: 'local',
    });

  async function narrationRows() {
    return database.db
      .select()
      .from(insights)
      .where(and(eq(insights.userId, database.userId), isNotNull(insights.narratesInsightId)));
  }

  it('a narration never takes a feed, dashboard or Brief slot of its own', async () => {
    const model = recordedModel(() => ({
      title: 'All your cash sits in one account',
      summary_md: 'There is 1 cash account here.',
    }));
    const dependencies = await setUp(model);
    expect((await runBuiltin(dependencies)).accepted).toBe(1);
    const [finding] = await listInsights(database.db, { userId: database.userId, now: null });
    if (finding === undefined) throw new Error('the built-in wrote nothing');

    const narrated = await runNarrator(dependencies);
    expect(narrated.status).toBe('completed');
    expect(narrated.accepted).toBe(1);
    expect(narrated.rejected).toBe(0);
    // One model call, carrying the envelope and an empty snapshot.
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.snapshot).toEqual({});
    expect(model.calls[0]?.findings?.map((entry) => entry.key)).toEqual(['cash.account_count']);

    // The row exists, and it is linked to the finding it narrates.
    const [narration, ...more] = await narrationRows();
    expect(more).toHaveLength(0);
    expect(narration?.advisorId).toBe(NARRATOR_ADVISOR_ID);
    expect(narration?.narratesInsightId).toBe(finding.id);

    // No slot of its own: not in the list (the Brief's source), not in any
    // slice of the budgeted feed (the dashboard is its first slice), not even
    // when the narrator is asked for by name.
    const listed = await listInsights(database.db, { userId: database.userId, now: null });
    expect(listed.map((view) => view.id)).toEqual([finding.id]);
    const feed = await insightFeed(database.db, {
      userId: database.userId,
      now: null,
      currency: 'USD',
    });
    const everySlot = [...feed.dashboard, ...feed.list, ...feed.overflow, ...feed.belowFloor];
    expect(everySlot.map((view) => view.id)).toContain(finding.id);
    expect(everySlot.map((view) => view.id)).not.toContain(narration?.id);
    expect(
      await listInsights(database.db, {
        userId: database.userId,
        now: null,
        advisorIds: [NARRATOR_ADVISOR_ID],
        statuses: [],
      }),
    ).toEqual([]);

    // A narration is not a finding: no InsightProposed for it.
    const proposed = await database.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM domain_events
           WHERE event_type = 'insights.InsightProposed' AND aggregate_id = ${narration?.id}::uuid`,
    );
    expect(proposed.rows[0]?.n).toBe('0');

    // It is carried on its finding's card instead — the wording, never a figure of its own.
    const cards = await narrationsFor(database.db, database.userId, [finding.id]);
    expect(cards.get(finding.id)?.summaryMd).toBe('There is 1 cash account here.');

    // The run's record: the grant it was laundered against, the scopes that
    // actually reached the model, the pinned model and the prompt's hash.
    const [run] = await database.db
      .select()
      .from(advisorRuns)
      .where(eq(advisorRuns.id, narrated.runId));
    expect(run?.grantedScopes).toEqual(['cash.summary']);
    expect(run?.emittedScopes).toEqual(['cash.summary']);
    expect(run?.llmModel).toMatch(/^fake-model@sha256:[0-9a-f]{64}$/);
    expect(run?.llmPromptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("a rejected narration leaves the builtin's text in place and the run records the step", async () => {
    let fabricate = false;
    const model = recordedModel(() =>
      fabricate
        ? // A figure the finding never rendered.
          { summary_md: 'There are 7 cash accounts here.' }
        : { summary_md: 'There is 1 cash account here.' },
    );
    const dependencies = await setUp(model);
    await runBuiltin(dependencies);

    // A good narration first, so there is something a bad one could displace.
    expect((await runNarrator(dependencies)).accepted).toBe(1);

    // A week later the built-in re-proposes the finding (its own text moves
    // with its date), and this time the model fabricates.
    const later = contextFor(database.userId, clockAt(LATER));
    await runBuiltin(dependencies, later);
    const [before] = await listInsights(database.db, { userId: database.userId, now: null });
    if (before === undefined) throw new Error('the built-in wrote nothing');
    expect(before.summaryMd).toBe('You hold 1 cash account, as of 2026-09-26.');
    fabricate = true;
    const rejected = await runNarrator(dependencies, later);

    // Exactly one call — no retry-until-valid — and one refusal, at step 7.
    expect(model.calls).toHaveLength(2);
    expect(rejected.status).toBe('completed');
    expect(rejected.accepted).toBe(0);
    expect(rejected.rejected).toBe(1);
    expect(rejected.rejections.map((entry) => `${entry.step}:${entry.reason}`)).toEqual([
      'numerals:numeral_not_in_finding',
    ]);
    const [run] = await database.db
      .select()
      .from(advisorRuns)
      .where(eq(advisorRuns.id, rejected.runId));
    expect(run?.status).toBe('completed');
    expect(run?.rejectedCount).toBe(1);
    expect(run?.rejections).toEqual([
      expect.objectContaining({ step: 'numerals', reason: 'numeral_not_in_finding' }),
    ]);
    expect(run?.llmPromptHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The built-in's text stands, untouched, and nothing fabricated was written.
    const [after] = await listInsights(database.db, { userId: database.userId, now: null });
    expect(after?.id).toBe(before.id);
    expect(after?.title).toBe(before.title);
    expect(after?.summaryMd).toBe(before.summaryMd);
    const written = await narrationRows();
    expect(written.map((row) => row.summaryMd)).toEqual(['There is 1 cash account here.']);
    // And the week-old wording no longer describes the re-proposed finding,
    // so the card offers none: the template text is what shows.
    expect((await narrationsFor(database.db, database.userId, [before.id])).size).toBe(0);
  });

  it("a narrator whose grant does not cover a finding's source scopes is never called", async () => {
    const model = recordedModel(() => ({ summary_md: 'There is 1 cash account here.' }));
    // Granted recurring.list; the only finding was built from cash.summary.
    const dependencies = await setUp(model, ['recurring.list']);
    expect((await runBuiltin(dependencies)).accepted).toBe(1);

    const result = await runNarrator(dependencies);
    expect(result.status).toBe('completed');
    expect(result.proposed).toBe(0);
    expect(model.calls).toHaveLength(0);
    expect(await narrationRows()).toHaveLength(0);
    const [run] = await database.db
      .select()
      .from(advisorRuns)
      .where(eq(advisorRuns.id, result.runId));
    expect(run?.grantedScopes).toEqual(['recurring.list']);
    expect(run?.emittedScopes).toEqual([]);
    expect(run?.llmPromptHash ?? null).toBeNull();
  });
});
