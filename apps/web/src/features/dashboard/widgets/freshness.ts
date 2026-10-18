// SPDX-License-Identifier: MIT
import { formatDistanceStrict } from 'date-fns';

/** A source older than this is shown with its as-of time. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * "Last synced 3 days ago" when the newest sync is older than a day, "No account has synced yet" when none has,
 * nothing otherwise. `now` is injectable for tests; the default is the browser's clock, which is the right clock
 * for "how long ago" (the server's `asOf` is when it computed, not when the data arrived).
 */
export function staleNote(lastSyncedAt: string | null, now: Date = new Date()): string | undefined {
  if (lastSyncedAt === null) return undefined;
  const synced = new Date(lastSyncedAt);
  if (Number.isNaN(synced.getTime())) return undefined;
  if (now.getTime() - synced.getTime() < STALE_AFTER_MS) return undefined;
  return `Last synced ${formatDistanceStrict(synced, now, { addSuffix: true })}: anything since is not counted yet.`;
}
