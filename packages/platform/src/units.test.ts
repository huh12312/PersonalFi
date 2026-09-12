// SPDX-License-Identifier: MIT
import { MIGRATION_ADVISORY_LOCK_KEY } from '@core/db';
import { describe, expect, it } from 'vitest';
import { canonicalJson, configHash } from './config-snapshot.ts';
import {
  EVENT_SEQUENCE_ADVISORY_LOCK_KEY,
  JOB_REAPER_ADVISORY_LOCK_KEY,
  SCHEDULER_ADVISORY_LOCK_KEY,
  lockIdForName,
} from './locks.ts';
import { createMetrics, metricKey } from './metrics.ts';
import { nextCronOccurrence } from './jobs/scheduler.ts';

describe('advisory lock keys', () => {
  it('never collide with the migration lock or with each other', () => {
    // A collision means two subsystems silently exclude each other: the scheduler
    // would block migrations, or worse, would not block a second scheduler.
    const keys = [
      MIGRATION_ADVISORY_LOCK_KEY,
      EVENT_SEQUENCE_ADVISORY_LOCK_KEY,
      SCHEDULER_ADVISORY_LOCK_KEY,
      JOB_REAPER_ADVISORY_LOCK_KEY,
    ];
    expect(new Set(keys.map(String)).size).toBe(keys.length);
  });

  it('fit in a signed int64, which is all Postgres accepts', () => {
    const max = 2n ** 63n - 1n;
    for (const key of [
      EVENT_SEQUENCE_ADVISORY_LOCK_KEY,
      SCHEDULER_ADVISORY_LOCK_KEY,
      JOB_REAPER_ADVISORY_LOCK_KEY,
    ]) {
      expect(key).toBeLessThanOrEqual(max);
      expect(key).toBeGreaterThan(0n);
    }
  });

  it('match the constant compiled into 0003_platform.sql', () => {
    // The SQL function holds a literal. If this drifts, publishers stop
    // serialising and `seq` stops being commit order — silently.
    expect(EVENT_SEQUENCE_ADVISORY_LOCK_KEY.toString()).toBe('5784387008488228177');
  });

  it('derives a stable, signed int32 lock id from a consumer name', () => {
    const id = lockIdForName('budgeting.actuals@v3');
    expect(Number.isInteger(id)).toBe(true);
    expect(id).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(id).toBeLessThan(2 ** 31);
    expect(lockIdForName('budgeting.actuals@v3')).toBe(id);
    expect(lockIdForName('budgeting.actuals@v4')).not.toBe(id);
  });
});

describe('canonicalJson', () => {
  it('is insensitive to key order, so two identical configs hash the same', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(configHash({ LOG_LEVEL: 'info', HTTP_PORT: 8080 })).toBe(
      configHash({ HTTP_PORT: 8080, LOG_LEVEL: 'info' }),
    );
  });

  it('sorts nested keys too', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('preserves array order, because an array is data and not a set', () => {
    expect(canonicalJson({ list: ['b', 'a'] })).toBe('{"list":["b","a"]}');
    expect(configHash({ list: ['b', 'a'] })).not.toBe(configHash({ list: ['a', 'b'] }));
  });

  it('produces a sha-256 hex digest', () => {
    expect(configHash({})).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('metrics', () => {
  it('flattens labels into a stable key regardless of declaration order', () => {
    expect(metricKey('m', { b: '2', a: '1' })).toBe('m{a=1,b=2}');
    expect(metricKey('m')).toBe('m');
  });

  it('accumulates counters and overwrites gauges', () => {
    const metrics = createMetrics();
    metrics.increment('x', { k: 'v' });
    metrics.increment('x', { k: 'v' }, 4);
    metrics.gauge('lag', 10);
    metrics.gauge('lag', 3);
    expect(metrics.snapshot().counters['x{k=v}']).toBe(5);
    expect(metrics.snapshot().gauges['lag']).toBe(3);
  });
});

describe('nextCronOccurrence', () => {
  it('resolves in the given zone, not the container zone', () => {
    // 03:15 New York on a normal day is 07:15 UTC.
    const next = nextCronOccurrence('15 3 * * *', 'America/New_York', new Date('2026-03-01T12:00:00Z'));
    expect(next.toISOString()).toBe('2026-03-02T08:15:00.000Z');
  });

  it('keeps a local wall-clock time fixed across a DST transition', () => {
    // 2026-03-08 is the US spring-forward. 03:15 local must stay 03:15 local,
    // which means the UTC instant moves by an hour. The daily net-worth seal
    // depends on this: sealing at 02:15 local would seal the wrong calendar day.
    const before = nextCronOccurrence('15 3 * * *', 'America/New_York', new Date('2026-03-06T12:00:00Z'));
    const after = nextCronOccurrence('15 3 * * *', 'America/New_York', new Date('2026-03-09T12:00:00Z'));
    expect(before.toISOString()).toBe('2026-03-07T08:15:00.000Z');
    expect(after.toISOString()).toBe('2026-03-10T07:15:00.000Z');
  });

  it('throws a named platform error rather than a parser stack trace', () => {
    expect(() => nextCronOccurrence('not a cron', 'UTC', new Date('2026-03-01T00:00:00Z'))).toThrow(
      /cannot parse cron/,
    );
  });
});
