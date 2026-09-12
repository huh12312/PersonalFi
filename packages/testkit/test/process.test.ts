// SPDX-License-Identifier: MIT
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnProcess } from './process.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/echo-process.ts', import.meta.url));

describe('spawnProcess', () => {
  it('parses line-buffered JSON stdout and resolves await() once seen', async () => {
    const proc = spawnProcess('echo', FIXTURE, { args: ['50'] });
    try {
      await proc.await('the fixture to start', (line) => line['event'] === 'started');
      expect(proc.saw((line) => line['event'] === 'started')).toBe(true);
      expect(typeof proc.lines[0]?.['pid']).toBe('number');

      await proc.await('the fixture to finish its block', (line) => line['event'] === 'done');
      const result = await proc.exited();
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
    } finally {
      if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
    }
  }, 10_000);

  it('reports a SIGKILL as the exit signal, not a clean exit', async () => {
    const proc = spawnProcess('echo', FIXTURE, { args: ['3600000'] });
    try {
      await proc.await('the fixture to start', (line) => line['event'] === 'started');
      proc.child.kill('SIGKILL');
      const result = await proc.exited();
      expect(result.signal).toBe('SIGKILL');
      expect(proc.saw((line) => line['event'] === 'stopped')).toBe(false);
    } finally {
      if (proc.child.exitCode === null && proc.child.signalCode === null) {
        proc.child.kill('SIGKILL');
      }
    }
  }, 10_000);

  it('lets a SIGTERM shut the child down cleanly', async () => {
    const proc = spawnProcess('echo', FIXTURE, { args: ['3600000'] });
    try {
      await proc.await('the fixture to start', (line) => line['event'] === 'started');
      proc.child.kill('SIGTERM');
      await proc.await('the fixture to report stopped', (line) => line['event'] === 'stopped');
      const result = await proc.exited();
      expect(result.code).toBe(0);
    } finally {
      if (proc.child.exitCode === null && proc.child.signalCode === null) {
        proc.child.kill('SIGKILL');
      }
    }
  }, 10_000);

  it('exited() resolves immediately for a process that has already exited', async () => {
    const proc = spawnProcess('echo', FIXTURE, { args: ['0'] });
    await proc.await('the fixture to finish', (line) => line['event'] === 'done');
    // Give the process a moment to actually exit after writing its last line.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await proc.exited();
    expect(result.code).toBe(0);
  }, 10_000);
});
