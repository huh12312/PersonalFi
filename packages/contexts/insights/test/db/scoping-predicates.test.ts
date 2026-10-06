// SPDX-License-Identifier: MIT
/**
 * C5-6 (Phase 5 gate G5-17, G5-18): every scoping predicate the gate found
 * shadowed or untested, tested on its own.
 *
 * `listGrants` (G5-18), `listBriefItems`, `findRunPayload` (userId and runId)
 * and `latestRuns` are leaf store functions, each callable directly — the
 * same functions `service.ts`/`routes/*.ts` call, never a parallel
 * reconstruction (C5-11). Calling them directly, rather than through the
 * route or service wrapper that happens to sit in front of some of them in
 * production, is exactly what lets each query's *own* predicate be isolated
 * from whatever else incidentally narrows the same request upstream — the
 * gate's point about "shadowed": a predicate that is never exercised on its
 * own is a predicate nobody would notice disappearing.
 *
 * The cancel `UPDATE`'s own `userId` guard sat behind `findRun`'s identical guard
 * inside one function (the gate's R4a/R4b), so it was extracted as
 * `markCancelRequested` — `requestRunCancel` calls it, so the test and the
 * product run one query — and is tested by calling it directly.
 *
 * Every sabotage below is recorded in `docs/evidence/phase-9/
 * wp9.3-carry-overs.md` §2 as it happens, and restored immediately.
 */
import { newId } from '@core/kernel';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { advisoryBriefItems, advisoryBriefs } from '../../schema/index.ts';
import { listBriefItems } from '../../src/brief/store.ts';
import {
  findRun,
  findRunPayload,
  grantScopes,
  latestRuns,
  listGrants,
  markCancelRequested,
  requestRunCancel,
  retainRunPayload,
  startRun,
} from '../../src/store.ts';
import { NO_DATABASE, contextFor, insightsDatabase, type TestDatabase } from './harness.ts';

const ADVISOR_ID = 'local.narrator.c5-6-test';
const QUERY_SHAPE = `sha256:${'0'.repeat(64)}`;

async function insertBrief(
  database: TestDatabase,
  userId: string,
  isoWeek: string,
): Promise<string> {
  const id = newId();
  await database.db.insert(advisoryBriefs).values({
    id,
    userId,
    isoWeek,
    currency: 'USD',
    nothingMaterial: false,
    coldStart: false,
    coldStartNote: null,
    inputDigest: `sha256:${'a'.repeat(64)}`,
    publishedAt: new Date(),
  });
  return id;
}

async function insertBriefItem(
  database: TestDatabase,
  userId: string,
  briefId: string,
  marker: string,
): Promise<void> {
  await database.db.insert(advisoryBriefItems).values({
    id: newId(),
    userId,
    briefId,
    section: 'ranked',
    position: 0,
    insightId: null,
    advisorId: ADVISOR_ID,
    insightKey: `test.${marker}`,
    insightType: 'test.marker',
    severity: 'notable',
    title: `Marker ${marker}`,
    summaryMd: `A test item, marker ${marker}.`,
    confidence: '1',
    horizon: 'this_period',
    carried: false,
    impactAnnualizedMinor: null,
    impactOneTimeMinor: null,
    impactCurrency: null,
    evidence: [],
    score: null,
    scoreFactors: null,
    retirementEffect: { kind: 'not_computable', reason: 'test fixture' },
  });
}

describe.skipIf(NO_DATABASE)('C5-6 — every scoping predicate tested alone', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database ??= await insightsDatabase('c5_6_predicates');
    await database.truncate();
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  it('listGrants: a second holder granting the same advisor different scopes never crosses (G5-18)', async () => {
    const bobId = await database.createUser('Bob');
    const alice = contextFor(database.userId);
    const bob = contextFor(bobId);

    await grantScopes(database.db, alice, ADVISOR_ID, ['cash.summary']);
    await grantScopes(database.db, bob, ADVISOR_ID, ['cashflow.monthly']);

    expect(await listGrants(database.db, database.userId, ADVISOR_ID)).toEqual(['cash.summary']);
    expect(await listGrants(database.db, bobId, ADVISOR_ID)).toEqual(['cashflow.monthly']);
  }, 30_000);

  it("listBriefItems: a second holder's brief items never cross", async () => {
    const bobId = await database.createUser('Bob');
    const aliceBriefId = await insertBrief(database, database.userId, '2026-W10');
    const bobBriefId = await insertBrief(database, bobId, '2026-W11');
    await insertBriefItem(database, database.userId, aliceBriefId, 'alice');
    await insertBriefItem(database, bobId, bobBriefId, 'bob');

    expect(await listBriefItems(database.db, database.userId, bobBriefId)).toEqual([]);
    expect(await listBriefItems(database.db, bobId, aliceBriefId)).toEqual([]);
    const aliceItems = await listBriefItems(database.db, database.userId, aliceBriefId);
    expect(aliceItems).toHaveLength(1);
    expect(aliceItems[0]?.insightKey).toBe('test.alice');
  }, 30_000);

  it("findRunPayload: a second holder's retained payload never crosses (userId alone: the second holder retains nothing, so only `userId` can refuse)", async () => {
    const bobId = await database.createUser('Bob');
    const alice = contextFor(database.userId);
    const aliceRun = await startRun(database.db, alice, {
      advisorId: ADVISOR_ID,
      advisorVersion: '1.0.0',
      trigger: 'manual',
    });
    await retainRunPayload(database.db, alice, {
      runId: aliceRun.id,
      advisorId: ADVISOR_ID,
      queryShape: QUERY_SHAPE,
      payload: { marker: 'alice' },
      payloadBytes: 16,
    });

    const now = alice.clock.now();
    expect(await findRunPayload(database.db, bobId, aliceRun.id, now)).toBeNull();
    const aliceOwn = await findRunPayload(database.db, database.userId, aliceRun.id, now);
    expect(aliceOwn?.payload).toMatchObject({ marker: 'alice' });
  }, 30_000);

  it("findRunPayload: the run named in the call is the one returned, never another of the same holder's", async () => {
    const context = contextFor(database.userId);
    const first = await startRun(database.db, context, {
      advisorId: ADVISOR_ID,
      advisorVersion: '1.0.0',
      trigger: 'manual',
    });
    const second = await startRun(database.db, context, {
      advisorId: ADVISOR_ID,
      advisorVersion: '1.0.0',
      trigger: 'manual',
    });
    await retainRunPayload(database.db, context, {
      runId: first.id,
      advisorId: ADVISOR_ID,
      queryShape: QUERY_SHAPE,
      payload: { marker: 'first' },
      payloadBytes: 16,
    });
    await retainRunPayload(database.db, context, {
      runId: second.id,
      advisorId: ADVISOR_ID,
      queryShape: QUERY_SHAPE,
      payload: { marker: 'second' },
      payloadBytes: 16,
    });

    const now = context.clock.now();
    const foundFirst = await findRunPayload(database.db, database.userId, first.id, now);
    const foundSecond = await findRunPayload(database.db, database.userId, second.id, now);
    // Both assertions hold only if `runId` genuinely selects between the two
    // rows; with the predicate dropped, both calls read the same `userId`-only
    // result set and at least one of these disagrees with its marker.
    expect(foundFirst?.payload).toMatchObject({ marker: 'first' });
    expect(foundSecond?.payload).toMatchObject({ marker: 'second' });
  }, 30_000);

  it('latestRuns: a run of a different advisor never crosses', async () => {
    const context = contextFor(database.userId);
    const runA = await startRun(database.db, context, {
      advisorId: 'builtin.c5-6-a',
      advisorVersion: '1.0.0',
      trigger: 'manual',
    });
    const runB = await startRun(database.db, context, {
      advisorId: 'builtin.c5-6-b',
      advisorVersion: '1.0.0',
      trigger: 'manual',
    });

    const onlyA = await latestRuns(database.db, database.userId, 'builtin.c5-6-a');
    expect(onlyA.map((run) => run.id)).toEqual([runA.id]);
    const onlyB = await latestRuns(database.db, database.userId, 'builtin.c5-6-b');
    expect(onlyB.map((run) => run.id)).toEqual([runB.id]);
  }, 30_000);

  it("markCancelRequested: the cancel UPDATE's own userId guard — a second holder's started run is never stamped", async () => {
    const bobId = await database.createUser('Bob');
    const bob = contextFor(bobId);
    const bobRun = await startRun(database.db, bob, {
      advisorId: ADVISOR_ID,
      advisorVersion: '1.0.0',
      trigger: 'manual',
    });
    const now = bob.clock.now();

    // Called directly, so `findRun`'s earlier guard is not in front of it.
    expect(await markCancelRequested(database.db, database.userId, bobRun.id, now)).toBe(false);
    expect((await findRun(database.db, bobId, bobRun.id))?.cancelRequestedAt).toBeNull();
    expect(await markCancelRequested(database.db, bobId, bobRun.id, now)).toBe(true);
    expect((await findRun(database.db, bobId, bobRun.id))?.cancelRequestedAt).not.toBeNull();
  }, 30_000);

  it("requestRunCancel: a second holder's run is refused and left unstamped (both guards together)", async () => {
    const bobId = await database.createUser('Bob');
    const alice = contextFor(database.userId);
    const bob = contextFor(bobId);
    const bobRun = await startRun(database.db, bob, {
      advisorId: ADVISOR_ID,
      advisorVersion: '1.0.0',
      trigger: 'manual',
    });

    expect(await requestRunCancel(database.db, alice, bobRun.id)).toBe('not_found');
    expect((await findRun(database.db, bobId, bobRun.id))?.cancelRequestedAt).toBeNull();
    expect(await requestRunCancel(database.db, bob, bobRun.id)).toBe('requested');
  }, 30_000);
});
