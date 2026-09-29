// SPDX-License-Identifier: MIT
/**
 * `LOCAL_MODEL_TIMEOUT_MS` must never be configurable above
 * `PLATFORM_LIMITS.timeoutMs` (05-phase-5-dispatch.md §4 item 9). `@core/config`
 * may import nothing but `@core/kernel` (`docs/CONVENTIONS.md`, "The
 * dependency rule"), so `packages/config/src/schema.ts` cannot import this
 * package's `manifest.ts` to read the ceiling — it repeats the number as a
 * literal, `LOCAL_MODEL_TIMEOUT_MS_CEILING`, with a comment naming this file
 * as the source.
 *
 * This test is the other half, and it reads `schema.ts` as text rather than
 * importing `@core/config` — the same reach-across-a-package-boundary-by-file
 * `test/contract-parity.test.ts` already uses for
 * `packages/contracts/advisor/`, in this same directory. `@ctx/insights` does
 * not otherwise depend on `@core/config`, and this shared-file batch may not
 * add a workspace dependency (the orchestrator's lockfile update comes after
 * this batch lands, W-A0's own constraint) — so a text read is not a
 * workaround here, it is the same device this file's sibling already uses for
 * exactly this shape of cross-package pin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLATFORM_LIMITS } from '../src/contract/manifest.ts';

const CONFIG_SCHEMA_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'config',
  'src',
  'schema.ts',
);

/** Parses `export const LOCAL_MODEL_TIMEOUT_MS_CEILING = 300_000;` out of the source text. */
function readLocalModelTimeoutMsCeiling(): number {
  const text = readFileSync(CONFIG_SCHEMA_PATH, 'utf8');
  const match = /LOCAL_MODEL_TIMEOUT_MS_CEILING\s*=\s*([0-9_]+)/u.exec(text);
  if (match?.[1] === undefined) {
    throw new Error(
      `LOCAL_MODEL_TIMEOUT_MS_CEILING not found in ${CONFIG_SCHEMA_PATH} — has it been renamed?`,
    );
  }
  return Number(match[1].replaceAll('_', ''));
}

describe('LOCAL_MODEL_TIMEOUT_MS_CEILING pins PLATFORM_LIMITS.timeoutMs (05 §4 item 9)', () => {
  it('the two numbers are equal', () => {
    expect(readLocalModelTimeoutMsCeiling()).toBe(PLATFORM_LIMITS.timeoutMs);
  });
});
