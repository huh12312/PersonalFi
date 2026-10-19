// SPDX-License-Identifier: MIT
/**
 * WP 10.15 (V8): the Brief's blocks, over a real database.
 *
 *   * **Figure equality.** Every figure a Brief block carries is the served Brief's own: each card's money block is
 *     the item's headline impact, the overview's bars are the ranked items' impacts, the narration block is the
 *     item's `narration.summaryMd` under the item's `narratedBy`.
 *   * **The narrator payload is untouched.** The narration request's findings envelope
 *     (`@ctx/insights`' `assembleFindings`, the function `buildNarrationRequest` calls) is byte-identical before
 *     and after the Brief — blocks and all — is served, and none of a block's own words appear in it. The payload
 *     builder's files are unchanged by this WP (`git diff --quiet`, in the evidence).
 *   * **R-2 still holds through blocks.** With `NARRATION_TEXT_SHOWN` off, no block carries the narration's text.
 *
 * Project `api-db`; scratch databases `personalfi_wp96_wp1015brief*` (the env harness's prefix).
 */
import { isDeepStrictEqual } from 'node:util';
import { newId, systemClock } from '@core/kernel';
import {
  ADVISOR_SCOPES,
  assembleFindings,
  BUILTIN_CATALOGUE,
  createAdvisorRegistry,
} from '@ctx/insights';
import {
  advisorRuns,
  advisoryBriefItems,
  advisoryBriefs,
  insightEvidence,
  insights,
} from '@ctx/insights/schema';
import { describe, expect, it } from 'vitest';
import { registerBuiltinAdvisors } from '../../src/modules.ts';
import { startApiWithEnv, type EnvApi } from '../helpers/api-with-env.ts';
import { expectStatus, NO_DATABASE } from '../helpers/api-harness.ts';

type Db = EnvApi['database']['db'];

const ADVISOR = 'builtin.cash.emergency_fund_short';
const NARRATION_TEXT = 'A friendlier way to say the same thing, written by the narrator.';

interface BlockWire {
  readonly kind: string;
  readonly id?: string;
  readonly [key: string]: unknown;
}
interface ItemWire {
  readonly insightKey: string;
  readonly summaryMd: string;
  readonly annualizedImpact: { readonly minor: string; readonly currency: string } | null;
  readonly oneTimeImpact: { readonly minor: string; readonly currency: string } | null;
  readonly narration: {
    readonly status: string;
    readonly summaryMd: string | null;
    readonly narratedBy: unknown;
  };
  readonly blocks: { readonly contractVersion: number; readonly blocks: readonly BlockWire[] };
}
interface BriefWire {
  readonly items: readonly ItemWire[];
  readonly blocks: { readonly contractVersion: number; readonly blocks: readonly BlockWire[] };
}

/** The built-in's run the findings came from: the narrator's laundering rule reads its emitted scopes. */
async function seedSourceRun(db: Db, userId: string): Promise<string> {
  const id = newId();
  const at = new Date('2026-10-05T11:59:00.000Z');
  // fixture: advisor_runs row written by the schema insert because the advisor runner is its only writer and needs a full snapshot build; the runner could record a completed built-in run that emitted `cash.summary`, as here, and the narrator's envelope reads only its emitted scopes.
  await db.insert(advisorRuns).values({
    id,
    userId,
    advisorId: ADVISOR,
    advisorVersion: '1.0.0',
    trigger: 'manual',
    status: 'completed',
    inputDigest: `sha256:${'d'.repeat(64)}`,
    grantedScopes: ['cash.summary'],
    emittedScopes: ['cash.summary'],
    proposedCount: 3,
    acceptedCount: 3,
    rejectedCount: 0,
    rejections: [],
    correlationId: newId(),
    startedAt: at,
    finishedAt: at,
  });
  return id;
}

async function seedFinding(
  db: Db,
  userId: string,
  key: string,
  annualMinor: bigint | null,
  runId: string,
): Promise<string> {
  const id = newId();
  const proposed = new Date('2026-10-05T12:00:00.000Z');
  // fixture: insights row written by the schema insert because `upsertInsight` (the nightly advisor run) is its only writer; the run could write it as a pending_review finding with one evidence row (as here), and the Brief route and the narrator's envelope read it back — input_digest is a placeholder nothing recomputes.
  await db.insert(insights).values({
    id,
    userId,
    advisorId: ADVISOR,
    advisorVersion: '1.0.0',
    runId,
    key,
    period: 'all_time',
    type: 'cash.emergency_fund_short',
    severity: 'notable',
    severityClamped: false,
    title: `Finding ${key}`,
    summaryMd: `The template wording for ${key}.`,
    confidence: '0.900000',
    confidenceBasis: 'deterministic',
    horizon: 'this_period',
    status: 'pending_review',
    impactAnnualizedMinor: annualMinor,
    impactOneTimeMinor: null,
    impactCurrency: annualMinor === null ? null : 'USD',
    impactBasis: 'A stated basis.',
    impactDerivationId: null,
    derivations: [],
    caveats: [],
    narratesInsightId: null,
    inputDigest: `sha256:${'b'.repeat(64)}`,
    firstProposedAt: proposed,
    lastProposedAt: proposed,
    reviewedAt: null,
    expiresAt: null,
  });
  // fixture: insight_evidence row written by the schema insert because `upsertInsight` is its only writer; one metric citation, the shape the built-in writes.
  await db.insert(insightEvidence).values({
    id: newId(),
    userId,
    insightId: id,
    position: 0,
    kind: 'metric',
    label: 'Balance',
    value: '500.00',
    sourceRef: 'snapshot:cash_summary.balance',
    resolvedDisplay: '$500.00',
    href: null,
  });
  return id;
}

async function seedNarration(db: Db, userId: string, findingId: string): Promise<void> {
  const proposed = new Date('2026-10-05T18:00:00.000Z');
  // fixture: insights row (the narration) written by the schema insert because the narrator pipeline is its only writer and needs a model run; it could write a narration of the finding (narrates_insight_id) with this run's recorded model, as here.
  await db.insert(insights).values({
    id: newId(),
    userId,
    advisorId: 'local.narrator',
    advisorVersion: '1.0.0',
    runId: null,
    key: `narration.${findingId}`,
    period: 'all_time',
    type: 'cash.emergency_fund_short',
    severity: 'notable',
    severityClamped: false,
    title: 'A narrated title',
    summaryMd: NARRATION_TEXT,
    confidence: '0.700000',
    confidenceBasis: 'model',
    horizon: 'this_period',
    status: 'pending_review',
    impactAnnualizedMinor: null,
    impactOneTimeMinor: null,
    impactCurrency: null,
    impactBasis: '',
    impactDerivationId: null,
    derivations: [],
    caveats: [],
    narratesInsightId: findingId,
    inputDigest: `sha256:${'c'.repeat(64)}`,
    firstProposedAt: proposed,
    lastProposedAt: proposed,
    reviewedAt: null,
    expiresAt: null,
  });
}

async function seedBrief(
  db: Db,
  userId: string,
  week: string,
  items: readonly { insightId: string; key: string; annualMinor: bigint | null }[],
): Promise<void> {
  const briefId = newId();
  const publishedAt = new Date('2026-10-05T12:30:00.000Z');
  // fixture: advisory_briefs row written by the schema insert because `publishWeeklyBrief` is its only writer; the job could write a published week like this one, and the route reads it back through its response schema.
  await db.insert(advisoryBriefs).values({
    id: briefId,
    userId,
    isoWeek: week,
    currency: 'USD',
    nothingMaterial: false,
    coldStart: false,
    coldStartNote: null,
    inputDigest: `sha256:${'a'.repeat(64)}`,
    publishedAt,
    createdAt: publishedAt,
  });
  let position = 0;
  for (const item of items) {
    // fixture: advisory_brief_items row written by the schema insert because `publishWeeklyBrief` is its only writer; a ranked item linked to its finding, snapshotted as publish writes it.
    await db.insert(advisoryBriefItems).values({
      id: newId(),
      userId,
      briefId,
      section: 'ranked',
      position: position++,
      insightId: item.insightId,
      advisorId: ADVISOR,
      insightKey: item.key,
      insightType: 'cash.emergency_fund_short',
      severity: 'notable',
      title: `Item ${item.key}`,
      summaryMd: `The template wording of ${item.key}.`,
      confidence: '0.900000',
      horizon: 'this_period',
      carried: false,
      impactAnnualizedMinor: item.annualMinor,
      impactOneTimeMinor: null,
      impactCurrency: item.annualMinor === null ? null : 'USD',
      evidence: [],
      score: '0.500000',
      scoreFactors: { impact: 0.8 },
      retirementEffect: { kind: 'not_computable', reason: 'no_baseline' },
      createdAt: publishedAt,
    });
  }
}

async function seedWeek(api: EnvApi): Promise<{ readonly findingIds: readonly string[] }> {
  const { db, userId } = api.database;
  await registerBuiltinAdvisors(db, { userId, clock: systemClock, correlationId: newId() });
  const runId = await seedSourceRun(db, userId);
  const big = await seedFinding(db, userId, 'wp1015-big', 120_000n, runId);
  const small = await seedFinding(db, userId, 'wp1015-small', 30_000n, runId);
  const none = await seedFinding(db, userId, 'wp1015-none', null, runId);
  await seedNarration(db, userId, big);
  await seedBrief(db, userId, '2026-W41', [
    { insightId: big, key: 'wp1015-big', annualMinor: 120_000n },
    { insightId: small, key: 'wp1015-small', annualMinor: 30_000n },
    { insightId: none, key: 'wp1015-none', annualMinor: null },
  ]);
  return { findingIds: [big, small, none] };
}

async function briefOf(api: EnvApi): Promise<BriefWire> {
  const response = await api.request({
    method: 'GET',
    url: '/insights/brief/2026-W41',
    session: api.stale,
  });
  expectStatus(response as never, 200);
  return (response.json() as { brief: BriefWire }).brief;
}

function flatten(blocks: readonly BlockWire[]): BlockWire[] {
  return blocks.flatMap((block) =>
    block.kind === 'group' ? [block, ...flatten(block['blocks'] as BlockWire[])] : [block],
  );
}

/** The envelope the narrator would be sent for these findings — `buildNarrationRequest`'s own call. */
async function narratorEnvelope(api: EnvApi, findingIds: readonly string[]): Promise<unknown> {
  const entry = BUILTIN_CATALOGUE.find((candidate) => candidate.advisorId === ADVISOR);
  if (entry === undefined) throw new Error(`${ADVISOR} is not in the catalogue`);
  const assembled = await assembleFindings(api.database.db, {
    userId: api.database.userId,
    grant: [...ADVISOR_SCOPES],
    kind: 'local_model',
    registry: createAdvisorRegistry([entry.advisor]),
    now: new Date('2026-10-06T09:00:00.000Z'),
    currency: 'USD',
    insightIds: findingIds,
  });
  return JSON.parse(
    JSON.stringify({
      findings: assembled.findings,
      keys: [...assembled.insightIdByKey.entries()],
      excluded: assembled.excluded,
    }),
  ) as unknown;
}

describe.skipIf(NO_DATABASE)('WP 10.15 the Brief as blocks', () => {
  it('every block figure is the served Brief’s own, and the narration block keeps the badge data', async () => {
    const api = await startApiWithEnv('wp1015briefon', { NARRATION_TEXT_SHOWN: 'true' });
    try {
      await seedWeek(api);
      const brief = await briefOf(api);
      expect(brief.blocks.contractVersion).toBe(1);

      for (const item of brief.items) {
        expect(item.blocks.contractVersion).toBe(1);
        const money = item.blocks.blocks.find((block) => block.kind === 'money');
        if (item.annualizedImpact === null) {
          expect(money?.['amountMinor']).toBeNull();
          expect(money?.['withheld']).toMatch(/No dollar figure/u);
        } else {
          expect(money?.['amountMinor']).toBe(item.annualizedImpact.minor);
          expect(money?.['currency']).toBe(item.annualizedImpact.currency);
          expect(money?.['label']).toBe('Per year');
        }
        const body = item.blocks.blocks[0];
        if (item.narration.status === 'narrated') {
          expect(body?.['role']).toBe('narration');
          expect(body?.['content']).toBe(item.narration.summaryMd);
          expect(body?.['narration']).toEqual({
            status: 'narrated',
            narratedBy: item.narration.narratedBy,
            templateContent: item.summaryMd,
          });
        } else {
          expect(body?.['content']).toBe(item.summaryMd);
        }
      }
      const narrated = brief.items.find((item) => item.insightKey === 'wp1015-big');
      expect(narrated?.narration.summaryMd).toBe(NARRATION_TEXT);

      // The overview's bars are the ranked items' impacts, in the Brief's order, each figure the item's own.
      const bars = flatten(brief.blocks.blocks).find((block) => block.kind === 'horizontal-bars');
      const drawn = (
        bars?.['bars'] as { label: string; rightLabel: { amountMinor: string } }[]
      ).map((bar) => [bar.label, bar.rightLabel.amountMinor]);
      expect(drawn).toEqual([
        ['Item wp1015-big', '120000'],
        ['Item wp1015-small', '30000'],
      ]);
      // The item with no figure is named, never drawn as zero.
      const unfigured = flatten(brief.blocks.blocks).find(
        (block) => block.id === 'ranked-unfigured',
      );
      expect(unfigured?.['content']).toBe('No dollar figure: Item wp1015-none.');
      // No health score yet: withheld with the reason, not a zero.
      const health = flatten(brief.blocks.blocks).find(
        (block) => block.id === 'brief-health-score',
      );
      expect(health?.['value']).toBeNull();
      expect(health?.['withheld']).toMatch(/Not computed yet/u);
    } finally {
      await api.close();
    }
  }, 120_000);

  it('the narrator’s envelope is byte-identical before and after the Brief and its blocks are served', async () => {
    const api = await startApiWithEnv('wp1015briefpay', { NARRATION_TEXT_SHOWN: 'true' });
    try {
      const { findingIds } = await seedWeek(api);
      const before = await narratorEnvelope(api, findingIds);
      expect(
        (before as { findings: unknown[] }).findings.length,
        JSON.stringify(before),
      ).toBeGreaterThan(0);

      const brief = await briefOf(api);
      await briefOf(api);
      const after = await narratorEnvelope(api, findingIds);
      expect(isDeepStrictEqual(before, after)).toBe(true);

      // No block's own words reach the envelope: the narrator is never handed a block. (Only words that exist
      // nowhere but in a block are checked — "Per year" is also the envelope's own impact label, by design.)
      const envelope = JSON.stringify(after);
      const blockOnlyText = flatten(brief.blocks.blocks)
        .filter((block) => ['group', 'cta', 'horizontal-bars'].includes(block.kind))
        .flatMap((block) => [block['title'], block['label']])
        .filter((text): text is string => typeof text === 'string');
      expect(blockOnlyText).toEqual(
        expect.arrayContaining(['The week', 'By dollar impact', 'Open Financial health']),
      );
      for (const text of new Set(blockOnlyText)) expect(envelope).not.toContain(text);
      expect(envelope).not.toContain('contractVersion');
    } finally {
      await api.close();
    }
  }, 120_000);

  it('with NARRATION_TEXT_SHOWN off no block carries the narration’s text; the badge says it exists', async () => {
    const api = await startApiWithEnv('wp1015briefoff');
    try {
      await seedWeek(api);
      const brief = await briefOf(api);
      expect(JSON.stringify(brief)).not.toContain(NARRATION_TEXT);
      const narrated = brief.items.find((item) => item.insightKey === 'wp1015-big');
      const body = narrated?.blocks.blocks[0];
      expect(body?.['role']).toBe('narration');
      expect(body?.['content']).toBe(narrated?.summaryMd);
      expect((body?.['narration'] as { status: string }).status).toBe('withheld');
    } finally {
      await api.close();
    }
  }, 120_000);
});
