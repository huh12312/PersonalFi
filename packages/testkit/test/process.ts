// SPDX-License-Identifier: MIT
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import { waitFor } from './wait.ts';

/**
 * Spawn a real child process and read line-buffered JSON off its stdout.
 *
 * A real process, not a test double: the Phase 0 exit criterion is that a worker
 * killed mid-job resumes cleanly, and that claim can only be tested with a real
 * second OS process and a real `SIGKILL` — nothing in the victim gets to run on
 * the way out, no `finally`, no graceful `stop()`. A `vi.fn()` standing in for a
 * process cannot demonstrate that.
 *
 * Every line the child writes to stdout is parsed as JSON when it can be (a
 * `console.log`-shaped drill/fixture writes one JSON object per line) and kept
 * verbatim otherwise, so a stray `node --watch` banner or a stack trace does not
 * crash the harness.
 */
export interface SpawnedProcess {
  readonly name: string;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  /** Every stdout line successfully parsed as JSON, in arrival order. */
  readonly lines: Record<string, unknown>[];
  /** True if any parsed line so far satisfies `predicate`. */
  saw(predicate: (line: Record<string, unknown>) => boolean): boolean;
  /** Poll until some parsed line satisfies `predicate`, or time out. */
  await(what: string, predicate: (line: Record<string, unknown>) => boolean): Promise<void>;
  /** Resolve once the process has exited (immediately if it already has). */
  exited(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface SpawnProcessOptions {
  readonly args?: readonly string[];
  /**
   * Passed straight through to `child_process.spawn`. Omit it to inherit the
   * current process's environment untouched — the same default `spawn` itself
   * uses. A caller that wants the child to see `DATABASE_URL` *and* one extra
   * variable builds `{ ...process.env, EXTRA: '1' }` itself; reading
   * `process.env` is a test file's job (CONVENTIONS.md — "Configuration can be
   * read anywhere" is exactly the sentence this package must not become true
   * of), not this package's.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Called with every stdout line, parsed if possible, raw either way. */
  readonly onStdout?: (text: string, parsed: Record<string, unknown> | undefined) => void;
  /** Called with every stderr line. Node's type-stripping notices land here. */
  readonly onStderr?: (text: string) => void;
}

/** Split a byte stream into complete `\n`-terminated lines, buffering the rest. */
function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const text = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (text !== '') onLine(text);
    }
  };
}

export function spawnProcess(
  name: string,
  modulePath: string,
  options: SpawnProcessOptions = {},
): SpawnedProcess {
  const child = spawn(process.execPath, [modulePath, ...(options.args ?? [])], {
    ...(options.env === undefined ? {} : { env: options.env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const lines: Record<string, unknown>[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on(
    'data',
    lineSplitter((text) => {
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
        lines.push(parsed);
      } catch {
        // Not every line is ours; a Node warning on stdout is not a failure.
      }
      options.onStdout?.(text, parsed);
    }),
  );

  child.stderr.setEncoding('utf8');
  child.stderr.on(
    'data',
    lineSplitter((text) => {
      options.onStderr?.(text);
    }),
  );

  const saw = (predicate: (line: Record<string, unknown>) => boolean): boolean =>
    lines.some(predicate);

  return {
    name,
    child,
    lines,
    saw,
    async await(what, predicate) {
      await waitFor(() => saw(predicate), { timeoutMs: 30_000, intervalMs: 25, what });
    },
    async exited() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode };
      }
      const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
      return { code, signal };
    },
  };
}
