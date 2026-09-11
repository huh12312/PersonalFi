// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { InvalidValueError } from './errors.ts';
import { isUuid, isUuidV7, newId, parseId, timestampOfUuidV7 } from './ids.ts';

describe('ids', () => {
  it('generates version 7 UUIDs', () => {
    const id = newId();
    expect(isUuid(id)).toBe(true);
    expect(isUuidV7(id)).toBe(true);
  });

  it('generates ids that sort chronologically as strings', () => {
    // This is the entire reason for v7 over v4: time-ordered keys keep inserts at
    // the right edge of the b-tree instead of scattering them across it.
    const ids = Array.from({ length: 500 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId()));
    expect(ids.size).toBe(10_000);
  });

  it('embeds a timestamp close to now', () => {
    const before = Date.now();
    const embedded = timestampOfUuidV7(newId());
    expect(embedded).toBeGreaterThanOrEqual(before - 1_000);
    expect(embedded).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('refuses to brand something that is not a UUID', () => {
    expect(() => parseId('account', 'not-a-uuid')).toThrow(InvalidValueError);
    expect(() => parseId('account', '')).toThrow(InvalidValueError);
    expect(() => timestampOfUuidV7('00000000-0000-4000-8000-000000000000')).toThrow(
      InvalidValueError,
    );
  });
});
