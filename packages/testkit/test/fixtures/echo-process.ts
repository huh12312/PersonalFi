// SPDX-License-Identifier: MIT
/**
 * Fixture for `spawnProcess()`'s own tests (`../process.test.ts`).
 *
 * Emits one line-buffered JSON object per event, blocks for `argv[2]`
 * milliseconds (default 0), then exits 0. A `SIGTERM` in the meantime prints a
 * `stopped` line and exits 0 immediately, so a test can tell "shut down
 * cleanly" apart from "was still running when the process ended".
 */
process.stdout.write(`${JSON.stringify({ event: 'started', pid: process.pid })}\n`);

process.on('SIGTERM', () => {
  process.stdout.write(`${JSON.stringify({ event: 'stopped' })}\n`);
  process.exit(0);
});

const blockMs = Number(process.argv[2] ?? '0');
setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ event: 'done' })}\n`);
}, blockMs);
