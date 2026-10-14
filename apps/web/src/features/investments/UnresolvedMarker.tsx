// SPDX-License-Identifier: MIT
import { AlertTriangle } from 'lucide-react';

import { Badge } from '../../components/ui/badge.tsx';

/**
 * WP 10.4: the marker every position and every Activity movement in a security nobody could identify carries
 * (the holdings table, an account's panel, the Activity tab). Words and a glyph, never colour alone (1.4.1).
 */
export function UnresolvedMarker({ className }: { className?: string }) {
  return (
    <Badge
      variant="warning"
      icon={<AlertTriangle size={12} aria-hidden="true" />}
      data-testid="unresolved-marker"
      {...(className === undefined ? {} : { className })}
    >
      Could not identify this security
    </Badge>
  );
}
