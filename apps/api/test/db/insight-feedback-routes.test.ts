// SPDX-License-Identifier: MIT
/**
 * WP 10.15 (V8): an insight's bookmark, its helpfulness and its entity mentions over the wire, against a real
 * database (migration 0051).
 *
 *   * `POST /insights/{id}/bookmark` and `POST /insights/{id}/feedback` persist on the row and read back through
 *     `GET /insights` and `GET /insights/{id}`; another holder's id is a 404; a reason without "not helpful" is a 400.
 *   * `mentions`, `titleSegments`, `bodySegments` and `contextLine` name only the entities the insight's own
 *     evidence cites by id — an id the holder has no category for is not a mention.
 */
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  linkManual,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface Segment {
  readonly text: string;
  readonly entityType?: string;
  readonly entityId?: string;
}

interface WireInsight {
  readonly id: string;
  readonly bookmarkedAt: string | null;
  readonly feedback: string | null;
  readonly feedbackReason: string | null;
  readonly mentions: readonly {
    text: string;
    entityType: string;
    entityId: string;
    evidencePosition: number;
  }[];
  readonly titleSegments: readonly Segment[];
  readonly bodySegments: readonly Segment[];
  readonly contextLine: readonly Segment[] | null;
}

const STRANGER_CATEGORY = '0190a000-0000-7000-8000-00000000dead';
const TRANSACTION = '0190a000-0000-7000-8000-00000000beef';

describe.skipIf(NO_DATABASE)('insight bookmark, feedback and mentions (WP 10.15)', () => {
  let h: ApiHarness;
  let insightId: string;
  let categoryId: string;
  let categoryLabel: string;
  let accountId: string;

  async function get(id: string): Promise<WireInsight> {
    const response = await h.request({ method: 'GET', url: `/insights/${id}`, session: h.stale });
    expectStatus(response, 200);
    return (response.json() as { insight: WireInsight }).insight;
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp1015_insight_feedback' });
    await linkManual(h, {
      providerConnectionId: 'wp1015-conn',
      displayName: 'Mentions Bank',
      accounts: [
        {
          providerAccountId: 'chk',
          name: 'Everyday Checking',
          type: 'depository',
          currency: 'USD',
        },
      ],
    });
    const accounts = await h.request({ method: 'GET', url: '/accounts', session: h.stale });
    expectStatus(accounts, 200);
    accountId = (accounts.json() as { accounts: { id: string }[] }).accounts[0]!.id;
    const categories = await h.request({ method: 'GET', url: '/categories', session: h.stale });
    expectStatus(categories, 200);
    const first = (categories.json() as { categories: { id: string; label: string }[] })
      .categories[0]!;
    categoryId = first.id;
    categoryLabel = first.label;

    insightId = newId();
    // fixture: insights and insight_evidence rows written by the schema insert because upsertInsight needs a
    // ValidatedInsight from a full advisor run; an in-process advisor could write exactly this — a title naming the
    // category, evidence citing the category, the account and a transaction by their snapshot refs (uuids for a
    // builtin, snapshot/tokens.ts) and one citing a category id this holder does not have.
    await h.database.db.execute(sql`
      INSERT INTO insights (
        id, user_id, advisor_id, advisor_version, key, period, type, severity,
        title, summary_md, confidence, confidence_basis, horizon, input_digest
      ) VALUES (
        ${insightId}::uuid, ${h.userId}::uuid, 'builtin.example', '1.0.0', 'wp1015', 'all_time',
        'example.finding', 'notable', ${`${categoryLabel} ran higher than usual`},
        ${`Spending in ${categoryLabel} from Everyday Checking rose.`}, 0.9, 'deterministic', 'this_year',
        ${'sha256:' + '0'.repeat(64)}
      )
    `);
    const evidence: [number, string, string][] = [
      [0, 'snapshot:spending_summary.by_category[0].category_ref', categoryId],
      [1, 'snapshot:cash_summary.accounts[0].account_ref', accountId],
      [2, 'snapshot:transactions.uncategorised[0].transaction_ref', TRANSACTION],
      [3, 'snapshot:spending_summary.by_category[1].category_ref', STRANGER_CATEGORY],
      [4, 'snapshot:recurring_list.streams[0].merchant_ref', 'MERCHANT_a7f31c9d0e42'],
    ];
    for (const [position, ref, resolved] of evidence) {
      await h.database.db.execute(sql`
        INSERT INTO insight_evidence (id, user_id, insight_id, position, kind, label, value, source_ref, resolved_display)
        VALUES (${newId()}::uuid, ${h.userId}::uuid, ${insightId}::uuid, ${position}, 'metric',
                ${position === 2 ? 'A transaction with no category' : 'A cited row'}, NULL, ${ref}, ${resolved})
      `);
    }
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('names only the entities the evidence cites by an id this holder has', async () => {
    const insight = await get(insightId);
    expect(insight.mentions).toEqual([
      { text: categoryLabel, entityType: 'category', entityId: categoryId, evidencePosition: 0 },
      {
        text: 'Everyday Checking',
        entityType: 'account',
        entityId: accountId,
        evidencePosition: 1,
      },
      {
        text: 'A transaction with no category',
        entityType: 'transaction',
        entityId: TRANSACTION,
        evidencePosition: 2,
      },
    ]);
    expect(insight.mentions.some((m) => m.entityId === STRANGER_CATEGORY)).toBe(false);
    expect(insight.titleSegments).toEqual([
      { text: categoryLabel, entityType: 'category', entityId: categoryId },
      { text: ' ran higher than usual' },
    ]);
    expect(insight.bodySegments.map((s) => s.text).join('')).toBe(
      `Spending in ${categoryLabel} from Everyday Checking rose.`,
    );
    expect(
      insight.bodySegments.filter((s) => s.entityId !== undefined).map((s) => s.entityType),
    ).toEqual(['category', 'account']);
    expect(insight.contextLine?.map((s) => s.text).join('')).toBe(
      `About ${categoryLabel}, Everyday Checking · transaction 1`,
    );
  });

  it('a bookmark persists through the feed and the single read, and clears', async () => {
    expect((await get(insightId)).bookmarkedAt).toBeNull();
    const set = await h.request({
      method: 'POST',
      url: `/insights/${insightId}/bookmark`,
      session: h.stale,
      body: { bookmarked: true },
    });
    expectStatus(set, 200);
    const at = (set.json() as { bookmarkedAt: string | null }).bookmarkedAt;
    expect(at).not.toBeNull();
    expect((await get(insightId)).bookmarkedAt).toBe(at);
    const feed = await h.request({ method: 'GET', url: '/insights', session: h.stale });
    expectStatus(feed, 200);
    const list = (feed.json() as { list: WireInsight[]; dashboard: WireInsight[] }).list;
    expect(list.find((i) => i.id === insightId)?.bookmarkedAt).toBe(at);

    const clear = await h.request({
      method: 'POST',
      url: `/insights/${insightId}/bookmark`,
      session: h.stale,
      body: { bookmarked: false },
    });
    expectStatus(clear, 200);
    expect((await get(insightId)).bookmarkedAt).toBeNull();
  });

  it('feedback persists with its reason, and a reason without "not helpful" is refused', async () => {
    const answer = await h.request({
      method: 'POST',
      url: `/insights/${insightId}/feedback`,
      session: h.stale,
      body: { feedback: 'not_helpful', reasonCode: 'ALREADY_KNOW' },
    });
    expectStatus(answer, 200);
    expect(answer.json()).toEqual({
      insightId,
      feedback: 'not_helpful',
      feedbackReason: 'ALREADY_KNOW',
    });
    const read = await get(insightId);
    expect([read.feedback, read.feedbackReason]).toEqual(['not_helpful', 'ALREADY_KNOW']);

    const bad = await h.request({
      method: 'POST',
      url: `/insights/${insightId}/feedback`,
      session: h.stale,
      body: { feedback: 'helpful', reasonCode: 'NOT_TRUE' },
    });
    expect(bad.statusCode).toBe(400);
    expect((await get(insightId)).feedback).toBe('not_helpful');

    const helpful = await h.request({
      method: 'POST',
      url: `/insights/${insightId}/feedback`,
      session: h.stale,
      body: { feedback: 'helpful' },
    });
    expectStatus(helpful, 200);
    const after = await get(insightId);
    expect([after.feedback, after.feedbackReason]).toEqual(['helpful', null]);
    // Persisted on the row, never the review-action log: the insight is still waiting for review.
    const log = await h.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM insight_feedback WHERE insight_id = ${insightId}::uuid`,
    );
    expect(log.rows[0]?.n).toBe(0);
  });

  it("another holder's session cannot bookmark or answer it (404), and an unknown id is 404", async () => {
    const otherId = await h.database.createUser('Other Holder');
    const other = await h.issueSession({ userId: otherId, fresh: false });
    for (const [url, body] of [
      [`/insights/${insightId}/bookmark`, { bookmarked: true }],
      [`/insights/${insightId}/feedback`, { feedback: 'helpful' }],
      [`/insights/${newId()}/bookmark`, { bookmarked: true }],
    ] as const) {
      const response = await h.request({
        method: 'POST',
        url,
        session: url.includes(insightId) ? other : h.stale,
        body,
      });
      expect(response.statusCode).toBe(404);
    }
    expect((await get(insightId)).bookmarkedAt).toBeNull();
    expect((await get(insightId)).feedback).toBe('helpful');
  });
});
