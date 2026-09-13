// SPDX-License-Identifier: MIT
import type { LucideIcon } from 'lucide-react';

import { EmptyState } from './EmptyState.tsx';

export interface PlaceholderRouteProps {
  icon: LucideIcon;
  headline: string;
  description: string;
}

/**
 * Every screen whose feature does not exist yet renders this: a real route, in
 * the real shell, with a first-class empty state rather than a "TODO" string.
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
