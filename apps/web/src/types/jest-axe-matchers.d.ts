// SPDX-License-Identifier: MIT
/**
 * Registers `toHaveNoViolations` (from `jest-axe`, `expect.extend`-ed in
 * `src/routes/dev.kitchen-sink.test.tsx`) onto Vitest's `Assertion` type.
 *
 * Kept in its own module file (top-level `export {}`) so `declare module
 * 'vitest'` *augments* vitest's real, already-typed module instead of
 * replacing it outright — see `jest-axe.d.ts` for why that distinction
 * matters and why the two declarations can't share a file.
 */
declare module 'vitest' {
  interface Assertion<T = unknown> {
    toHaveNoViolations(): T;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): unknown;
  }
}

export {};
