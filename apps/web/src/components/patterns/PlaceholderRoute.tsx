// SPDX-License-Identifier: MIT
import type { LucideIcon } from 'lucide-react';

import { EmptyState } from './EmptyState.tsx';

export interface PlaceholderRouteProps {
  icon: LucideIcon;
  headline: string;
  description: string;
}

/**
 * WP 0.5 ships the app frame and routing, not the features behind it — every
 * screen except the dashboard (which proves the chart pipeline instead) is
 * this: a real route, in the real shell, with a first-class empty state
 * rather than a "TODO" string (§4.4).
 */
export function PlaceholderRoute({ icon, headline, description }: PlaceholderRouteProps) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <EmptyState
        icon={icon}
        headline={headline}
        description={description}
        className="max-w-md border-none"
      />
    </div>
  );
}
