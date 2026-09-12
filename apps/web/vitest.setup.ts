// SPDX-License-Identifier: MIT
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

/**
 * `test.globals` is deliberately off (vite.config.ts) — every test file
 * imports `describe`/`it`/`expect` explicitly. Testing Library's automatic
 * per-test `cleanup()` normally hooks itself to a *global* `afterEach`, which
 * doesn't exist here, so without this it never runs and DOM from one test
 * leaks into the next (`screen.getByText` then matches stale elements from a
 * prior render). Registered once, for every component test in the suite.
 */
afterEach(() => {
  cleanup();
});

/**
 * happy-dom doesn't implement `matchMedia`; `src/lib/theme.ts` and
 * `src/lib/idle.ts`-adjacent code call it unconditionally at import/render
 * time, so every test needs a stub, not just the ones that exercise theming.
 */
if (typeof window !== 'undefined' && window.matchMedia === undefined) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/**
 * happy-dom has no layout engine, so `ResizeObserver` never fires — fine for
 * `@visx/responsive`'s `ParentSize` (used by `NetWorthAreaChart`), which
 * treats "no size yet" as 0×0 and renders nothing rather than throwing. What
 * it can't tolerate is `ResizeObserver` being entirely undefined.
 */
if (typeof window !== 'undefined' && window.ResizeObserver === undefined) {
  class NoopResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver = NoopResizeObserver;
}
