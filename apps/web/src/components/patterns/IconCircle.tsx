// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

/**
 * Which semantic colour the glyph takes. The circle itself is always
 * `bg-bg-subtle`: the tone is carried by the icon, so the shape stays constant
 * as a screen moves between states and only the meaning changes.
 */
export type IconCircleTone = 'accent' | 'muted' | 'good' | 'warning' | 'critical';

const TONE_CLASS: Record<IconCircleTone, string> = {
  accent: 'text-accent-text',
  muted: 'text-text-secondary',
  good: 'text-status-good',
  warning: 'text-status-warning',
  critical: 'text-status-critical',
};

/**
 * The 48px tinted circle above a heading on every full-screen auth and empty
 * state.
 *
 * One component rather than the seven hand-written copies it replaces, because
 * the size, the background token and the centring are a single design decision
 * — and when they were spelled out per screen, two of the copies had already
 * drifted apart on tone naming.
 */
export function IconCircle({ tone, children }: { tone: IconCircleTone; children: ReactNode }) {
  return (
    <div
      className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-bg-subtle ${TONE_CLASS[tone]}`}
    >
      {children}
    </div>
  );
}
