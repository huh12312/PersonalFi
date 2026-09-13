// SPDX-License-Identifier: MIT
/**
 * Does the KEK derivation fit in the memory this container is allowed?
 *
 * The Argon2id parameters are deliberately expensive — m = 1 GiB, t = 4, p = 4
 * (03 §2.2, P0-2) — and the floor is enforced at boot, so the operator cannot
 * quietly weaken them. What the floor cannot do is check them against the box.
 * `hash-wasm` allocates the full cost buffer in one go on wasm32, so a container
 * with `mem_limit: 1g` and a 1 GiB derivation does not degrade: the kernel OOM
 * killer takes the process, and because the derivation happens at boot the
 * result is a crash loop whose only symptom is exit code 137. Nothing in the
 * log says "Argon2" and nothing says "memory".
 *
 * So say it, at boot, before the allocation is attempted. This module is a pure
 * assessment plus one file read, kept apart from `loadConfig` because the answer
 * is advisory: a cgroup limit is a property of where the process is running, not
 * of whether its configuration is valid, and refusing to boot on a reading from
 * `/sys` that may be absent, stale, or describing a parent cgroup would trade a
 * loud failure for a different loud failure.
 */
import { readFileSync } from 'node:fs';

/** cgroup v2. `max` means unlimited. */
export const CGROUP_V2_MEMORY_MAX = '/sys/fs/cgroup/memory.max';
/** cgroup v1 fallback; reports a near-`int64` sentinel when unlimited. */
export const CGROUP_V1_MEMORY_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

/**
 * Fraction of the limit above which the derivation is called out.
 *
 * 60% rather than 100% because the KEK buffer is not the only thing resident
 * when it is allocated: Node's heap, the V8 code space and the wasm instance are
 * already there, and the peak is what the OOM killer measures. A derivation at
 * 60% of the limit is not yet fatal, which is precisely when a warning is worth
 * printing.
 */
export const KEK_MEMORY_WARN_RATIO = 0.6;

/**
 * Above this, treat the reading as "no limit". cgroup v1 writes
 * 9223372036854771712 (int64 max rounded down to a page) for unlimited, and a
 * parent cgroup with no limit reports the same shape.
 */
const UNLIMITED_FLOOR_BYTES = 2 ** 53;

export interface KekMemoryBudget {
  /** Argon2id memory cost, as configured. */
  readonly memoryKiB: number;
  /** The cgroup limit, or `null` when there is none (or none readable). */
  readonly limitKiB: number | null;
  /** `memoryKiB / limitKiB`, rounded to three places. `null` without a limit. */
  readonly ratio: number | null;
  /** True when the derivation is at or above {@link KEK_MEMORY_WARN_RATIO}. */
  readonly warn: boolean;
}

/**
 * Compare a configured Argon2id memory cost against a byte limit.
 *
 * Pure: the caller supplies the limit, so the interesting behaviour is testable
 * without a cgroup, a container, or a writable `/sys`.
 */
export function assessKekMemory(memoryKiB: number, limitBytes: number | null): KekMemoryBudget {
  if (limitBytes === null || limitBytes <= 0 || limitBytes >= UNLIMITED_FLOOR_BYTES) {
    return { memoryKiB, limitKiB: null, ratio: null, warn: false };
  }
  const limitKiB = Math.floor(limitBytes / 1_024);
  // A limit smaller than a single KiB of cost is degenerate rather than
  // informative; guard the division so the log line cannot read `Infinity`.
  if (limitKiB <= 0) return { memoryKiB, limitKiB: null, ratio: null, warn: false };

  // Decide on the exact value and round only for display. Rounding first makes
  // the threshold fuzzy by half a permille in whichever direction happens to be
  // wrong, which is not a property a security-adjacent warning should have.
  const exact = memoryKiB / limitKiB;
  const ratio = Math.round(exact * 1_000) / 1_000;
  return { memoryKiB, limitKiB, ratio, warn: exact >= KEK_MEMORY_WARN_RATIO };
}

/**
 * The cgroup memory limit in bytes, or `null` when there is none to read.
 *
 * Never throws. Every failure mode here — no cgroup filesystem (macOS, a bare
 * host), a v1 hierarchy, a permission error, a file containing `max` — means the
 * same thing operationally: we cannot say whether the derivation fits, so say
 * nothing rather than guess.
 */
export function readCgroupMemoryLimitBytes(
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): number | null {
  for (const path of [CGROUP_V2_MEMORY_MAX, CGROUP_V1_MEMORY_LIMIT]) {
    let raw: string;
    try {
      raw = readFile(path).trim();
    } catch {
      continue;
    }
    if (raw === '' || raw === 'max') return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) continue;
    return value >= UNLIMITED_FLOOR_BYTES ? null : value;
  }
  return null;
}

/**
 * The boot log line P0-2 asks for, extended with the box it is running on.
 *
 * Returned as a plain object rather than logged here so `@core/config` keeps its
 * one-way dependency on `@core/kernel` and never acquires a logger.
 */
export function describeKekMemory(budget: KekMemoryBudget): Record<string, unknown> {
  return {
    memoryKiB: budget.memoryKiB,
    cgroupLimitKiB: budget.limitKiB,
    fractionOfCgroupLimit: budget.ratio,
    ...(budget.warn
      ? {
          warning:
            `the Argon2id KEK derivation asks for ${String(budget.memoryKiB)} KiB, which is ` +
            `${String(Math.round((budget.ratio ?? 0) * 100))}% of this container's memory limit. ` +
            'hash-wasm allocates the whole buffer at once, at boot, so the likely failure is the ' +
            'OOM killer and a restart loop reporting exit 137. Raise the container limit or lower ' +
            'KEK_ARGON2_MEMORY_KIB (never below the production floor).',
        }
      : {}),
  };
}
