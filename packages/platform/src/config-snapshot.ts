// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import type { Executor } from './executor.ts';

/**
 * Record the effective non-secret configuration at boot.
 *
 * "Nothing changed" is the most common and least true sentence in an incident.
 * This table makes it checkable: the API and the worker each write the hash of
 * their own `describeConfig()` output at startup, and a behaviour shift becomes a
 * diff between two rows with timestamps.
 *
 * Deduplicated by `(role, hash)` rather than appended per boot, so a container in
 * a restart loop bumps a counter instead of filling a table, and the row's
 * `first_seen_at` answers "when did this configuration start?" directly.
 *
 * The payload must come from `describeConfig()`, which omits every secret by
 * construction and reduces them to a list of names. Nothing here may ever be a
 * credential; this table is readable by anyone who can read the database, which
 * in a restore-to-laptop scenario is a wider set than the running process.
 */

export type ProcessRole = 'api' | 'worker' | 'migrator' | 'cli';

export interface RecordConfigSnapshotInput {
  readonly role: ProcessRole;
  /** `describeConfig(config)`. Non-secrets only. */
  readonly payload: Record<string, unknown>;
  readonly appVersion: string;
}

export interface ConfigSnapshotResult {
  readonly id: string;
  readonly hash: string;
  /** False when this exact configuration has been seen before. */
  readonly isNew: boolean;
  readonly bootCount: number;
}

/**
 * Canonical JSON: keys sorted at every level, so two boots with the same settings
 * in a different environment-variable order produce the same hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function configHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

export async function recordConfigSnapshot(
  executor: Executor,
  input: RecordConfigSnapshotInput,
): Promise<ConfigSnapshotResult> {
  const hash = configHash(input.payload);
  const id = newId();

  const result = await executor.execute<{ id: string; boot_count: number; inserted: boolean }>(sql`
    INSERT INTO config_snapshots (id, role, hash, payload, app_version)
    VALUES (${id}::uuid, ${input.role}, ${hash}, ${canonicalJson(input.payload)}::jsonb, ${input.appVersion})
    ON CONFLICT (role, hash) DO UPDATE
      SET last_seen_at = now(),
          boot_count = config_snapshots.boot_count + 1
    RETURNING id, boot_count, (xmax = 0) AS inserted
  `);

  const row = result.rows[0];
  return {
    id: row?.id ?? id,
    hash,
    isNew: row?.inserted ?? true,
    bootCount: row?.boot_count ?? 1,
  };
}

/** The most recent configuration recorded for a role. For the maintenance page. */
export async function latestConfigSnapshot(
  executor: Executor,
  role: ProcessRole,
): Promise<Record<string, unknown> | undefined> {
  const result = await executor.execute(sql`
    SELECT id, role, hash, payload, app_version, first_seen_at, last_seen_at, boot_count
    FROM config_snapshots
    WHERE role = ${role}
    ORDER BY last_seen_at DESC
    LIMIT 1
  `);
  return result.rows[0];
}
