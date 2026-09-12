// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { waitFor } from './wait.ts';

describe('waitFor', () => {
  it('resolves as soon as the predicate is true', async () => {
    let calls = 0;
    await waitFor(
      () => {
        calls += 1;
        return calls >= 3;
      },
      { intervalMs: 1 },
    );
    expect(calls).toBe(3);
  });

  it('times out with a message naming what it waited for', async () => {
    await expect(
      waitFor(() => false, { timeoutMs: 30, intervalMs: 5, what: 'the impossible' }),
    ).rejects.toThrow(/timed out waiting for the impossible/);
  });

  it('accepts an async predicate', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 10);
    await waitFor(async () => Promise.resolve(ready), { intervalMs: 1, timeoutMs: 1_000 });
    expect(ready).toBe(true);
  });
});
