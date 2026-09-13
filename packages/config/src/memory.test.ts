// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  CGROUP_V1_MEMORY_LIMIT,
  CGROUP_V2_MEMORY_MAX,
  KEK_MEMORY_WARN_RATIO,
  assessKekMemory,
  describeKekMemory,
  readCgroupMemoryLimitBytes,
} from './memory.ts';

const GIB = 1_024 * 1_024 * 1_024;
/** The production Argon2id floor (03 §2.2, P0-2): m = 1 GiB. */
const PRODUCTION_MEMORY_KIB = 1_048_576;

function files(contents: Record<string, string>): (path: string) => string {
  return (path) => {
    const value = contents[path];
    if (value === undefined) {
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    }
    return value;
  };
}

describe('assessKekMemory', () => {
  it('warns when the KEK derivation is the majority of the container limit', () => {
    // The case this exists for: `mem_limit: 1g` with the production Argon2id
    // floor. The derivation alone is the entire limit, so the boot allocation is
    // an OOM kill and a restart loop reporting nothing but exit 137.
    const budget = assessKekMemory(PRODUCTION_MEMORY_KIB, GIB);

    expect(budget.warn).toBe(true);
    expect(budget.ratio).toBe(1);
    expect(budget.limitKiB).toBe(1_048_576);
  });

  it('stays quiet when the limit leaves comfortable headroom', () => {
    const budget = assessKekMemory(PRODUCTION_MEMORY_KIB, 4 * GIB);

    expect(budget.warn).toBe(false);
    expect(budget.ratio).toBe(0.25);
  });

  it('decides on the exact ratio, not the rounded one', () => {
    // 60% of 1 GiB is 629 145.6 KiB. Both values below round to 0.6 for display,
    // so a threshold applied to the rounded number would fire on both — fuzzy by
    // half a permille in whichever direction happens to be wrong.
    const atThreshold = assessKekMemory(629_146, GIB);
    const justUnder = assessKekMemory(629_145, GIB);

    expect(KEK_MEMORY_WARN_RATIO).toBe(0.6);
    expect(atThreshold.warn).toBe(true);
    expect(justUnder.warn).toBe(false);
    expect(atThreshold.ratio).toBe(justUnder.ratio);
  });

  it('reports no ratio when there is no limit to compare against', () => {
    const budget = assessKekMemory(PRODUCTION_MEMORY_KIB, null);

    expect(budget).toEqual({
      memoryKiB: PRODUCTION_MEMORY_KIB,
      limitKiB: null,
      ratio: null,
      warn: false,
    });
  });

  it('treats the cgroup "unlimited" sentinel as no limit rather than as 8 EiB', () => {
    // cgroup v1 writes int64-max-rounded-to-a-page for unlimited. Taking it
    // literally yields a ratio of ~1e-13 and a silent pass, which is the right
    // answer by luck; taking it as a limit anywhere else would not be.
    const budget = assessKekMemory(PRODUCTION_MEMORY_KIB, 9_223_372_036_854_771_712);

    expect(budget.limitKiB).toBeNull();
    expect(budget.warn).toBe(false);
  });
});

describe('readCgroupMemoryLimitBytes', () => {
  it('reads a cgroup v2 byte limit', () => {
    expect(readCgroupMemoryLimitBytes(files({ [CGROUP_V2_MEMORY_MAX]: `${String(GIB)}\n` }))).toBe(
      GIB,
    );
  });

  it('maps cgroup v2 "max" to no limit', () => {
    expect(readCgroupMemoryLimitBytes(files({ [CGROUP_V2_MEMORY_MAX]: 'max\n' }))).toBeNull();
  });

  it('falls back to the v1 hierarchy when v2 is absent', () => {
    expect(
      readCgroupMemoryLimitBytes(files({ [CGROUP_V1_MEMORY_LIMIT]: `${String(2 * GIB)}` })),
    ).toBe(2 * GIB);
  });

  it('returns null rather than throwing when no cgroup filesystem exists', () => {
    // macOS, a bare host, or a container without /sys mounted. "We cannot say"
    // must not be a boot failure.
    expect(readCgroupMemoryLimitBytes(files({}))).toBeNull();
  });

  it('ignores an unparseable reading instead of logging Infinity', () => {
    expect(
      readCgroupMemoryLimitBytes(files({ [CGROUP_V2_MEMORY_MAX]: 'not-a-number' })),
    ).toBeNull();
  });
});

describe('describeKekMemory', () => {
  it('carries an actionable warning only when the budget is tight', () => {
    const tight = describeKekMemory(assessKekMemory(PRODUCTION_MEMORY_KIB, GIB));
    const roomy = describeKekMemory(assessKekMemory(PRODUCTION_MEMORY_KIB, 8 * GIB));

    expect(String(tight['warning'])).toContain('KEK_ARGON2_MEMORY_KIB');
    expect(tight['fractionOfCgroupLimit']).toBe(1);
    expect(roomy['warning']).toBeUndefined();
    expect(roomy['memoryKiB']).toBe(PRODUCTION_MEMORY_KIB);
  });
});
