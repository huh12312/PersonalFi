// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

/**
 * The full-screen card every unauthenticated surface renders into: login, the
 * lock screen, KEK unlock, and passkey enrolment.
 *
 * These four screens are the only thing a visitor can see before a session
 * exists, so a difference in width, padding or surface token between them
 * reads as a different application. Sharing the frame is what makes them one.
 *
 * `corner` is for a control that must sit outside the card but inside the
 * viewport — the login screen's theme toggle. The wrapper is `relative`
 * unconditionally so that control can position against it.
 *
 * Not used by `IdleLockOverlay`: that one is a modal over an authenticated
 * shell, with its own raised surface and backdrop, and collapsing the two
 * would mean a frame that is sometimes a page and sometimes a dialog.
 */
export function AuthCard({ children, corner }: { children: ReactNode; corner?: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-bg-page px-4">
      {corner}
      {/* This card *is* the page's main content on every one of these
          screens — axe's `landmark-one-main` flagged its absence, and there
          is never a sidebar/top-bar competing for the role here (`AppShell`
          isn't mounted before a session exists). */}
      <main className="w-full max-w-sm rounded-2xl border border-border-hairline bg-bg-surface p-6 text-center">
        {children}
      </main>
    </div>
  );
}
