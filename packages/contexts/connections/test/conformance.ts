// SPDX-License-Identifier: MIT
/**
 * The conformance suite, as a vitest `describe`.
 *
 * The checks themselves live in `@connector/port` (`src/conformance.ts`) and are
 * runner-agnostic on purpose: `personalfi/layer-imports` denies
 * `packages/connectors/*` → `@ctx/*`, so a suite that lived here could never be
 * run from `packages/connectors/plaid/test/` in WP 1.3. This file is the vitest
 * wrapper the brief asks for, and it is eleven lines, which is the point — an
 * adapter package that wants the same coverage writes its own eleven.
 */
import { connectorConformanceChecks, type ConformanceSubject } from '@connector/port';
import { describe, it } from 'vitest';

export type { ConformanceSubject };

/**
 * The old name, kept as an alias.
 *
 * Two call sites use it and renaming them is free; the alias exists because
 * WP 1.3's Plaid adapter will be written against whichever name is in the
 * evidence note, and a wrapper that silently disappeared between work packages
 * is a merge conflict nobody needs.
 */
export { describeConnectorConformance as describeConformance };

/**
 * Run every conformance check against one adapter.
 *
 * `subject` is a factory rather than a value so each check gets a clean
 * adapter: `disconnect/revokes` deliberately destroys what it is given, and
 * several checks page a stream to exhaustion.
 */
export function describeConnectorConformance(
  label: string,
  subject: () => Promise<ConformanceSubject> | ConformanceSubject,
): void {
  describe(`conformance: ${label}`, () => {
    // The names are enumerated from a stub so vitest can register the cases up
    // front; each case then builds the real subject. `connectorConformanceChecks`
    // touches nothing until a check runs, which is what makes the stub safe.
    for (const { name } of connectorConformanceChecks({} as ConformanceSubject)) {
      it(name, async () => {
        const built = await subject();
        const check = connectorConformanceChecks(built).find(
          (candidate) => candidate.name === name,
        );
        if (check === undefined) throw new Error(`conformance check ${name} disappeared`);
        await check.run();
      });
    }
  });
}
