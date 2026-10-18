// SPDX-License-Identifier: MIT
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { useIdleTimer } from '../../lib/idle.ts';
import { IconCircle } from '../../components/patterns/IconCircle.tsx';
import { useStepUpUnlock } from './use-step-up-unlock.ts';

const WARN_TOAST_ID = 'soft-lock-warning';

/** 05-frontend-architecture.md §7.2: 15 minutes idle by default (configurable 5/15/30/60/never in Settings — not built here), a 60s warning first. */
const LOCK_AFTER_MS = 15 * 60_000;
const WARN_AFTER_MS = LOCK_AFTER_MS - 60_000;

/**
 * The soft-lock overlay: the app does **not** log out on idle. It blurs the
 * UI behind a scrim, preserves route + in-memory state, and unlocks with a
 * single passkey assertion (step-up). Mounted once at the shell root
 * (`AppShell`) — never per-screen.
 */
export function IdleLockOverlay() {
  const queryClient = useQueryClient();
  const nearIdle = useIdleTimer(WARN_AFTER_MS);
  const idle = useIdleTimer(LOCK_AFTER_MS);
  const [locked, setLocked] = useState(false);
  const wasNearIdle = useRef(false);

  useEffect(() => {
    // `locked` is not simply `idle`: once true it *latches* until a
    // successful passkey step-up clears it explicitly (the `useStepUpUnlock`
    // callback below), even though `idle` flips back to `false` the moment the user
    // touches the "Unlock" button — soft-lock must survive the very
    // interaction that reawakens the idle timer. That makes this a real
    // external-system sync (the idle timer is the external system), which is
    // exactly the documented exception to "don't setState in an effect."
    if (idle) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocked(true);
      toast.dismiss(WARN_TOAST_ID);
      // `query-client.ts` sets `refetchOnWindowFocus: true`, so without this a
      // locked session keeps refetching balances behind the scrim — the exact
      // thing a "lock" is supposed to stop. Cancel first, so an in-flight
      // fetch that resolves *after* the lock fires can't repopulate the cache
      // it is racing to clear; only then wipe it. The unlock callback below is
      // the other half — it refetches once the user is back.
      void queryClient.cancelQueries().then(() => queryClient.clear());
    }
  }, [idle, queryClient]);

  useEffect(() => {
    if (nearIdle && !idle && !wasNearIdle.current) {
      toast('You’ll be locked out soon due to inactivity.', {
        id: WARN_TOAST_ID,
        duration: 60_000,
        action: { label: 'Stay signed in', onClick: () => toast.dismiss(WARN_TOAST_ID) },
      });
    }
    if (!nearIdle) toast.dismiss(WARN_TOAST_ID);
    wasNearIdle.current = nearIdle;
  }, [nearIdle, idle]);

  const {
    error,
    busy: unlocking,
    unlock,
  } = useStepUpUnlock(() => {
    setLocked(false);
    // Cache was wiped at lock time; repopulate whatever's still mounted now
    // that the user is verified again instead of leaving every screen behind
    // the (just-removed) overlay showing empty states until its own next
    // natural refetch.
    void queryClient.refetchQueries();
  });

  const overlayRef = useRef<HTMLDivElement>(null);
  const unlockRef = useRef<HTMLButtonElement>(null);

  // A lock that only paints a scrim leaves the whole app behind it reachable by Tab (found by the 9.8 keyboard
  // journey: focus walked onto "Dashboard", covered by the scrim — 2.4.11 — and past it into every control). While
  // locked: everything outside the overlay is `inert`, focus moves to Unlock, and Tab stays there; when the lock
  // lifts, the inertness is undone and focus goes back to where it was.
  useEffect(() => {
    if (!locked) return;
    const overlay = overlayRef.current;
    if (overlay === null) return;
    const before = document.activeElement;
    const made: Element[] = [];
    for (let node: Element | null = overlay; node !== null && node !== document.body;) {
      const parent: Element | null = node.parentElement;
      for (const sibling of parent?.children ?? []) {
        if (sibling === node || sibling.hasAttribute('inert')) continue;
        if (['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) continue;
        sibling.setAttribute('inert', '');
        made.push(sibling);
      }
      node = parent;
    }
    unlockRef.current?.focus();
    // One control to reach: Tab (either way) stays on it rather than leaving for the browser's own chrome.
    function holdFocus(event: KeyboardEvent): void {
      if (event.key === 'Tab') {
        event.preventDefault();
        unlockRef.current?.focus();
      }
    }
    overlay.addEventListener('keydown', holdFocus);
    return () => {
      overlay.removeEventListener('keydown', holdFocus);
      made.forEach((el) => el.removeAttribute('inert'));
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, [locked]);

  if (!locked) return null;

  return (
    <div
      ref={overlayRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="lock-overlay-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgba(11,11,11,0.7)] backdrop-blur-2xl"
    >
      <div className="w-[calc(100vw-2rem)] max-w-sm rounded-2xl border border-border-hairline bg-bg-surface-raised p-6 text-center shadow-[var(--shadow-elev-3)]">
        <IconCircle tone="muted">
          <KeyRound size={22} aria-hidden="true" />
        </IconCircle>
        <h2 id="lock-overlay-title" className="mt-3 text-h3 text-text-primary">
          PersonalFi is locked
        </h2>
        <p className="mt-1 text-small text-text-muted">
          You’ve been away for a while. Unlock with your passkey to continue.
        </p>
        {error !== null && (
          <p role="alert" className="mt-3 text-small text-status-danger-text">
            {error}
          </p>
        )}
        <button
          ref={unlockRef}
          type="button"
          onClick={() => void unlock()}
          disabled={unlocking}
          className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-md bg-accent text-body font-medium text-accent-contrast disabled:opacity-60"
        >
          {unlocking && (
            <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />
          )}
          Unlock
        </button>
      </div>
    </div>
  );
}
