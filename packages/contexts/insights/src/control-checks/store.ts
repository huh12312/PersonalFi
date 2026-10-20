// SPDX-License-Identifier: MIT
/**
 * `ops_control_checks` rows (migration 0052; WP 10.16). Written at the start
 * with every check `pending`, one check at a time as each finishes (an atomic
 * `jsonb_set` on its own index, so the api's and the worker's writes never
 * race on a read-modify-write), and closed once with `finished_at` and
 * `overall` together. A row already closed takes no further writes: a worker
 * that answers after the api's 5-minute ceiling changes nothing.
 */
import { newId } from '@core/kernel';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { opsControlChecks, type OpsControlCheckRow } from '../../schema/index.ts';
import type { InsightsContext, InsightsExecutor } from '../db.ts';
import {
  CONTROL_CHECK_IDS,
  CONTROL_CHECKS,
  CONTROL_CHECKS_EVIDENCE_VERSION,
  overallOf,
  pendingRow,
  type ControlCheckId,
  type ControlCheckRow,
  type ControlChecksOverall,
  type NarratorProviderName,
} from './catalogue.ts';

export interface ControlCheckRun {
  readonly id: string;
  readonly userId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly provider: NarratorProviderName;
  readonly model: string | null;
  readonly results: readonly ControlCheckRow[];
  readonly overall: ControlChecksOverall | null;
  readonly evidenceVersion: string;
}

function runOf(row: OpsControlCheckRow): ControlCheckRun {
  return {
    id: row.id,
    userId: row.userId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    provider: row.provider as NarratorProviderName,
    model: row.model,
    results: row.results as unknown as readonly ControlCheckRow[],
    overall: row.overall as ControlChecksOverall | null,
    evidenceVersion: row.evidenceVersion,
  };
}

export async function startControlCheckRun(
  executor: InsightsExecutor,
  context: InsightsContext,
  input: { readonly provider: NarratorProviderName; readonly model: string | null },
): Promise<ControlCheckRun> {
  const [row] = await executor
    .insert(opsControlChecks)
    .values({
      id: newId(),
      userId: context.userId,
      startedAt: context.clock.now(),
      finishedAt: null,
      provider: input.provider,
      model: input.model,
      results: CONTROL_CHECKS.map((definition) => ({ ...pendingRow(definition) })),
      overall: null,
      evidenceVersion: CONTROL_CHECKS_EVIDENCE_VERSION,
    })
    .returning();
  if (row === undefined) throw new Error('ops_control_checks insert returned no row');
  return runOf(row);
}

/** Write one check's row at its catalogue index, if the run is still open. */
export async function recordControlCheck(
  executor: InsightsExecutor,
  userId: string,
  runId: string,
  row: ControlCheckRow,
): Promise<boolean> {
  const index = CONTROL_CHECK_IDS.indexOf(row.id);
  if (index < 0) throw new Error(`unknown control check ${row.id}`);
  const updated = await executor
    .update(opsControlChecks)
    .set({
      results: sql`jsonb_set(${opsControlChecks.results}, ${`{${String(index)}}`}::text[], ${JSON.stringify(row)}::jsonb)`,
    })
    .where(
      and(
        eq(opsControlChecks.id, runId),
        eq(opsControlChecks.userId, userId),
        isNull(opsControlChecks.finishedAt),
      ),
    )
    .returning({ id: opsControlChecks.id });
  return updated.length > 0;
}

export async function findControlCheckRun(
  executor: InsightsExecutor,
  userId: string,
  runId: string,
): Promise<ControlCheckRun | null> {
  const [row] = await executor
    .select()
    .from(opsControlChecks)
    .where(and(eq(opsControlChecks.id, runId), eq(opsControlChecks.userId, userId)))
    .limit(1);
  return row === undefined ? null : runOf(row);
}

export async function listControlCheckRuns(
  executor: InsightsExecutor,
  userId: string,
  limit = 20,
): Promise<readonly ControlCheckRun[]> {
  const rows = await executor
    .select()
    .from(opsControlChecks)
    .where(eq(opsControlChecks.userId, userId))
    .orderBy(desc(opsControlChecks.startedAt), desc(opsControlChecks.id))
    .limit(Math.max(1, Math.min(limit, 100)));
  return rows.map(runOf);
}

/** Close the run: every check still pending or running is marked skipped with `why`. */
export async function finishControlCheckRun(
  executor: InsightsExecutor,
  context: InsightsContext,
  runId: string,
  why: string,
): Promise<ControlCheckRun | null> {
  const run = await findControlCheckRun(executor, context.userId, runId);
  if (run === null) return null;
  if (run.finishedAt !== null) return run;
  const results = run.results.map((row): ControlCheckRow =>
    row.status === 'pending' || row.status === 'running'
      ? { ...row, status: 'skipped', reason: why, notApplicable: false }
      : row,
  );
  const overall = overallOf(results);
  const [row] = await executor
    .update(opsControlChecks)
    .set({
      results: results.map((entry) => ({ ...entry })),
      overall,
      finishedAt: context.clock.now(),
    })
    .where(
      and(
        eq(opsControlChecks.id, runId),
        eq(opsControlChecks.userId, context.userId),
        isNull(opsControlChecks.finishedAt),
      ),
    )
    .returning();
  return row === undefined ? findControlCheckRun(executor, context.userId, runId) : runOf(row);
}

/** The ids of the checks still to finish. */
export function unfinishedChecks(run: ControlCheckRun): readonly ControlCheckId[] {
  return run.results
    .filter((row) => row.status === 'pending' || row.status === 'running')
    .map((row) => row.id);
}
