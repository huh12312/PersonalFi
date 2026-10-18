// SPDX-License-Identifier: MIT
import { AlertOctagon, AlertTriangle, Info, Sparkles } from 'lucide-react';

import { Badge, type BadgeProps } from '../ui/badge.tsx';

/** The four severities `packages/contracts/advisor/v1/response.schema.json` names. */
export type InsightSeverity = 'info' | 'notable' | 'warning' | 'urgent';

const SEVERITY_META: Record<
  InsightSeverity,
  { label: string; variant: NonNullable<BadgeProps['variant']>; icon: typeof Info }
> = {
  info: { label: 'Info', variant: 'neutral', icon: Info },
  notable: { label: 'Notable', variant: 'accent', icon: Sparkles },
  warning: { label: 'Warning', variant: 'warning', icon: AlertTriangle },
  urgent: { label: 'Urgent', variant: 'danger', icon: AlertOctagon },
};

function metaOf(severity: string) {
  return SEVERITY_META[severity as InsightSeverity] ?? SEVERITY_META.info;
}

export interface SeverityBadgeProps {
  severity: string;
  className?: string;
}

/**
 * The insight feed's severity chip — shared between the full `/insights`
 * list, the evidence panel, and the dashboard's top-5 widget, so all three
 * read the same colour for the same word (colour is never the only signal:
 * every variant pairs a glyph, per Badge's own convention).
 */
export function SeverityBadge({ severity, className }: SeverityBadgeProps) {
  const meta = metaOf(severity);
  const Icon = meta.icon;
  return (
    <Badge
      variant={meta.variant}
      icon={<Icon size={12} aria-hidden="true" />}
      className={className}
    >
      {meta.label}
    </Badge>
  );
}
