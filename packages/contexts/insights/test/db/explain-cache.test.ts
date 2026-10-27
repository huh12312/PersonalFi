// SPDX-License-Identifier: MIT
/**
 * WP 11.3 — `runInsightExplain` against a real database: the cache is keyed by
 * the evidence digest (an unchanged digest asks the model nothing), a changed
 * digest is a new row and the old one stays, a refusal is cached as a
 * refusal, a scope outside the narrator's grant sends nothing and records no
 * run, and no run changes an approval or a grant.
 */
import { newId, systemClock } from '@core/kernel';
import { createTestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NARRATOR_MANIFEST,
  approveInsightExplain,
  ensureInsightExplainAdvisor,
  grantScopes,
  insightExplainShape,
  insightSubjectOf,
  listExplanations,
  registerAdvisor,
  runInsightExplain,
  type ExplainModelPort,
  type ExplainTarget,
  type RunSwitches,
} from '../../src/index.ts';
import { NO_DATABASE, type TestDatabase } from './harness.ts';

const ALL_ON: RunSwitches = {
  advisorsEnabled: () => Promise.resolve(true),
  moduleEnabled: () => Promise.resolve(true),
  kindEnabled: () => Promise.resolve(true),
};

function fakeModel(replies: string[]): ExplainModelPort & { calls: number } {
  const model = {
    calls: 0,
    provider: 'ollama',
    label: 'fake@sha256:test',
    templateHash: `sha256:${'e'.repeat(64)}`,
    render: () => ({ text: 'rendered', hash: `sha256:${'a'.repeat(64)}` }),
    run: () => {
      model.calls += 1;
      const content = replies.shift() ?? '{}';
      return Promise.resolve({
        reply: JSON.parse(content) as unknown,
        isJson: true,
        label: 'fake@sha256:test',
        promptHash: `sha256:${'a'.repeat(64)}`,
        warnings: [],
        runtimeMs: 1,
      });
    },
  };
  return model;
}

function target(cash: string, scopes: ExplainTarget['scopes'] = ['cash.summary']): ExplainTarget {
  return {
    entityKind: 'insight',
    entityId: '01930000-0000-7000-8000-00000000e113',
    scopes,
    subject: insightSubjectOf(
      {
        key: 'k',
        period: '2026-10',
        type: 'cash.emergency_fund',
        severity: 'notable',
        title: 'Your cash covers part of a month',
        summaryMd: 'A summary.',
        evidence: [
          {
            label: 'Cash',
            value: cash,
            sourceRef: 'snapshot:cash_summary.total.minor',
            resolvedDisplay: null,
          },
        ],
        derived: [],
        impact: { annualized: null, oneTime: null, basis: 'A basis.' },
      },
      { name: 'Rule', text: 'Reports cash.' },
    ),
  };
}

describe.skipIf(NO_DATABASE)('"Explain this": the cache and the run (0057)', () => {
  let database: TestDatabase;
  const ctx = () => ({ userId: database.userId, clock: systemClock, correlationId: newId() });

  async function digestOf(table: string): Promise<string> {
    const rows = await database.db.execute(
      sql`SELECT md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS d FROM ${sql.raw(table)} t`,
    );
    return String((rows.rows[0] as { d: string }).d);
  }
  async function explainRuns(): Promise<number> {
    const rows = await database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM advisor_runs WHERE advisor_id = 'insight.explain'`,
    );
    return rows.rows[0]?.n ?? -1;
  }

  beforeAll(async () => {
    database = await createTestDatabase('wp113_ins_explain');
    await registerAdvisor(database.db, ctx(), { manifest: NARRATOR_MANIFEST, enabled: false });
    await grantScopes(database.db, ctx(), NARRATOR_MANIFEST.advisor_id, ['cash.summary']);
    await ensureInsightExplainAdvisor(database.db, ctx());
    const model = fakeModel([]);
    await approveInsightExplain(database.db, ctx(), {
      renderer: model,
      queryShape: insightExplainShape(model.templateHash),
    });
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  }, 60_000);

  it('an unchanged digest is a cache hit; a changed one is a new row and the old stays', async () => {
    const model = fakeModel([
      JSON.stringify({ explanation: 'Your cash of $1,000.00 is what this measures.' }),
      JSON.stringify({ explanation: 'Your cash of $1,100.00 is what this measures.' }),
    ]);
    const approvals = await digestOf('advisor_payload_approvals');
    const grants = await digestOf('snapshot_grants');
    const first = await runInsightExplain(
      database.db,
      ctx(),
      { switches: ALL_ON, model },
      { target: target('$1,000.00'), trigger: 'manual' },
    );
    expect(first).toMatchObject({ status: 'completed', replyRefusal: null });
    expect(first.explanation?.text).toContain('$1,000.00');
    expect(model.calls).toBe(1);

    const again = await runInsightExplain(
      database.db,
      ctx(),
      { switches: ALL_ON, model },
      { target: target('$1,000.00'), trigger: 'manual' },
    );
    expect(again).toMatchObject({ status: 'cached', runId: null, digest: first.digest });
    expect(model.calls).toBe(1);

    const moved = await runInsightExplain(
      database.db,
      ctx(),
      { switches: ALL_ON, model },
      { target: target('$1,100.00'), trigger: 'manual' },
    );
    expect(moved.status).toBe('completed');
    expect(moved.digest).not.toBe(first.digest);
    expect(model.calls).toBe(2);
    const rows = await listExplanations(
      database.db,
      database.userId,
      'insight',
      '01930000-0000-7000-8000-00000000e113',
    );
    expect(rows.map((row) => row.evidenceDigest).sort()).toEqual(
      [first.digest, moved.digest].sort(),
    );
    expect(await digestOf('advisor_payload_approvals')).toBe(approvals);
    expect(await digestOf('snapshot_grants')).toBe(grants);
  });

  it('a refused reply is cached as its refusal class and not asked again', async () => {
    const model = fakeModel([JSON.stringify({ explanation: 'Your cash is $9,999.00.' })]);
    const refused = await runInsightExplain(
      database.db,
      ctx(),
      { switches: ALL_ON, model },
      { target: target('$1,200.00'), trigger: 'manual' },
    );
    expect(refused).toMatchObject({ status: 'completed', replyRefusal: 'numeral' });
    expect(refused.explanation).toMatchObject({ text: null, refusal: 'numeral' });
    const again = await runInsightExplain(
      database.db,
      ctx(),
      { switches: ALL_ON, model },
      { target: target('$1,200.00'), trigger: 'manual' },
    );
    expect(again.status).toBe('cached');
    expect(model.calls).toBe(1);
  });

  it('a scope outside the narrator’s grant sends nothing and records no run', async () => {
    const model = fakeModel([JSON.stringify({ explanation: 'Unused.' })]);
    const runs = await explainRuns();
    const outcome = await runInsightExplain(
      database.db,
      ctx(),
      { switches: ALL_ON, model },
      { target: target('$1,300.00', ['cash.summary', 'holdings.detail']), trigger: 'manual' },
    );
    expect(outcome.status).toBe('scope_not_granted');
    expect(model.calls).toBe(0);
    expect(await explainRuns()).toBe(runs);
  });

  it('without an approval for the shape the run is refused payload_not_approved and the model is not called', async () => {
    const model = { ...fakeModel([]), templateHash: `sha256:${'f'.repeat(64)}` };
    const outcome = await runInsightExplain(
      database.db,
      ctx(),
      { switches: ALL_ON, model },
      { target: target('$1,400.00'), trigger: 'manual' },
    );
    expect(outcome).toMatchObject({ status: 'refused', refusal: 'payload_not_approved' });
  });
});
