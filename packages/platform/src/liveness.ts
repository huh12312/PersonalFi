// SPDX-License-Identifier: MIT
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock, type Clock } from '@core/kernel';

/**
 * Liveness heartbeats for the worker's container healthcheck (D-3,
 * gate-security-review.md §8.5 N-4/N-6, §8.11 D-3).
 *
 * The worker's healthcheck used to be `node -e 'process.exit(0)'` — a check
 * that asserts the Node binary exists and nothing else. It reported `healthy`
 * through 189 silent restarts in which the consumer pump, the job runner and
 * the scheduler never started at all (N-4): the process was alive, so the one
 * thing the healthcheck looked at was true, and the thing an operator actually
 * cares about — is this process doing the work it exists to do? — was never
 * asked.
 *
 * `createLivenessWriter` gives the job runner and the scheduler a place to
 * record "I just polled", as a small file under a writable tmpfs mount, so a
 * healthcheck reading that file's contents can tell "the job runner claimed a
 * job three seconds ago" apart from "the job runner has not moved since the
 * KEK derivation OOM-killed it four minutes ago." It has no opinion on what
 * counts as "stale" — that threshold lives in the healthcheck (compose.yml),
 * next to the poll intervals it compares against, so the two cannot drift the
 * way harden-secrets' hand-written secret list, the image prune's hand-written
 * delete set, and the Caddyfile's hand-written proxy prefixes each drifted
 * from their computed twin.
 *
 * Written under `/tmp` (a tmpfs mount on both `api` and `worker` in
 * compose.yml), so it works unmodified under `read_only: true` — nothing here
 * writes to the container's root filesystem, and nothing here needs a network
 * port, so it costs no capability against `cap_drop: [ALL]` +
 * `no-new-privileges:true`. An in-process HTTP `/healthz` was the other option
 * this condition named; a file is simpler, needs no listener, and survives the
 * same hardening with one fewer moving part (no port to bind, no HTTP stack to
 * keep alive under load — a file write is the one operation that cannot itself
 * block on a saturated event loop the way accepting a socket connection can).
 */
export interface LivenessWriter {
  /** Refresh `<dir>/<component>.heartbeat`'s contents to "now". */
  touch(component: string): void;
}

export interface LivenessWriterOptions {
  readonly dir: string;
  readonly clock?: Clock;
}

export function createLivenessWriter(options: LivenessWriterOptions): LivenessWriter {
  const { dir, clock = systemClock } = options;
  let dirReady = false;

  function ensureDir(): void {
    if (dirReady) return;
    // 0700: only this process (and root) ever needs to see these files.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    dirReady = true;
  }

  return {
    touch(component: string): void {
      ensureDir();
      const target = join(dir, `${component}.heartbeat`);
      // Write-then-rename, not a direct write: a healthcheck reading this file
      // mid-write on a slow or contended tmpfs would otherwise risk a
      // truncated timestamp. `rename(2)` within the same directory is atomic,
      // so a reader always sees either the old value or the new one, never a
      // partial one.
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, String(clock.nowMs()));
      renameSync(tmp, target);
    },
  };
}
