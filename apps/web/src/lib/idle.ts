// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';

/**
 * Idle detection for the soft-lock overlay (05-frontend-architecture.md §7.2).
 *
 * Deliberately `apps/web`-exempt from the kernel `Clock` rule (eslint.config.js:
 * "UI concerns ... need a real wall clock and are not the bug class this rule
 * targets"). The last-activity instant is kept as a timestamp, not a running
 * `setTimeout`, so a backgrounded tab locks correctly the moment it regains
 * visibility instead of trusting a timer that browsers throttle or suspend in
 * the background.
 */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll'] as const;

/**
 * Re-armed by any of `ACTIVITY_EVENTS` plus the tab regaining visibility;
 * `scroll` listens in the capture phase so it fires for scrolling *inside* a
 * nested region.
 */
export function useIdleTimer(timeoutMs: number): boolean {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    let lastActivity = Date.now();
    let idleNow = false;

    function markActive(): void {
      lastActivity = Date.now();
      if (idleNow) {
        idleNow = false;
        setIdle(false);
      }
    }

    function check(): void {
      const elapsed = Date.now() - lastActivity;
      const shouldBeIdle = elapsed >= timeoutMs;
      if (shouldBeIdle !== idleNow) {
        idleNow = shouldBeIdle;
        setIdle(shouldBeIdle);
      }
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === 'visible') markActive();
      check();
    }

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, markActive, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    const interval = window.setInterval(check, 1_000);

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, markActive, { capture: true });
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(interval);
    };
  }, [timeoutMs]);

  return idle;
}
