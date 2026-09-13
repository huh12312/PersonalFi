// SPDX-License-Identifier: MIT
/**
 * `jest-axe` ships no types and there is no `@types/jest-axe` in the
 * workspace lockfile — a minimal ambient declaration covering the one entry
 * point the kitchen-sink a11y test uses
 * (`src/routes/-dev.kitchen-sink.test.tsx`).
 *
 * This file must stay a *global script* (no top-level `import`/`export`):
 * `declare module 'jest-axe'` here is the module's only type declaration
 * anywhere in the dependency graph, so it has to create it outright rather
 * than merge into an existing one. The `vitest` matcher augmentation lives
 * in the sibling `jest-axe-matchers.d.ts` instead, because that one *is* a
 * merge into vitest's real (already-typed) module and needs the opposite
 * shape — a top-level `export {}` — to avoid replacing vitest's exports.
 */
declare module 'jest-axe' {
  import type { AxeResults, RunOptions } from 'axe-core';

  export function axe(
    container: Element | Document | string,
    options?: RunOptions,
  ): Promise<AxeResults>;

  export function configureAxe(options?: RunOptions): typeof axe;

  export const toHaveNoViolations: {
    toHaveNoViolations(results: AxeResults): {
      pass: boolean;
      message(): string;
    };
  };
}
