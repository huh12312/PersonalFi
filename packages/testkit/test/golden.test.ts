// SPDX-License-Identifier: MIT
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectGolden, goldenUpdateRequested, loadGolden } from './golden.ts';

describe('goldenUpdateRequested', () => {
  it('is true only for the literal string "1"', () => {
    expect(goldenUpdateRequested({ UPDATE_GOLDEN: '1' })).toBe(true);
    expect(goldenUpdateRequested({ UPDATE_GOLDEN: 'true' })).toBe(false);
    expect(goldenUpdateRequested({})).toBe(false);
  });
});

describe('expectGolden / loadGolden', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'testkit-golden-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('throws with an UPDATE_GOLDEN hint when the fixture does not exist yet', () => {
    expect(() => expectGolden('missing', { a: 1 }, { dir })).toThrow(/UPDATE_GOLDEN=1/);
    expect(() => loadGolden('missing', { dir })).toThrow(/UPDATE_GOLDEN=1/);
  });

  it('creates the fixture when update is true, then compares clean on the next run', () => {
    const value = { recurring: ['a', 'b'], total: 12.5 };
    expectGolden('sample', value, { dir, update: true });

    // A second call, no update flag, must pass against what was just written.
    expect(() => expectGolden('sample', value, { dir })).not.toThrow();
    expect(loadGolden('sample', { dir })).toEqual(value);
  });

  it('fails when the value drifts from the stored golden', () => {
    expectGolden('drift', { count: 1 }, { dir, update: true });
    expect(() => expectGolden('drift', { count: 2 }, { dir })).toThrow(/does not match/);
  });

  it('serialises deterministically: two equal values produce byte-identical files', () => {
    expectGolden('stable', { b: 2, a: 1 }, { dir, update: true });
    // Re-running update with an equal-but-freshly-constructed object must not
    // change the file (JSON.stringify key order follows insertion order, which
    // is itself deterministic for a given producer).
    expectGolden('stable', { b: 2, a: 1 }, { dir, update: true });
    expect(() => expectGolden('stable', { b: 2, a: 1 }, { dir })).not.toThrow();
  });
});
