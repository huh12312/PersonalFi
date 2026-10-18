// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useId, type ReactNode } from 'react';

import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Card } from '../../components/ui/card.tsx';
import { cn } from '../../lib/cn.ts';

/** The screens a widget's "See all" (or an empty state's fix) can open. */
export type WidgetLinkTarget =
  | '/'
  | '/accounts'
  | '/accounts/connections'
  | '/budget'
  | '/goals'
  | '/inbox'
  | '/insights'
  | '/investments'
  | '/recurring'
  | '/reports'
  | '/transactions';

export interface WidgetLink {
  readonly to: WidgetLinkTarget;
  readonly label: string;
}

/**
 * Every state a widget body can be in. A widget never draws a zero for data it does not have: **empty** says what
 * is missing and links to the screen that fixes it; **error** says the source could not be read; **loading** is a
 * skeleton the size of a few lines (it holds the card's place, so the grid does not jump).
 */
export type WidgetState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'empty'; readonly message: string; readonly fix?: WidgetLink }
  | { readonly kind: 'ready' };

export interface DashboardWidgetCardProps {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: ReactNode;
  /** "See all" — the owning screen. */
  readonly seeAll?: WidgetLink;
  readonly state: WidgetState;
  /** When the source was last refreshed, shown only when it is stale (the widget decides). */
  readonly asOf?: ReactNode;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * The frame every dashboard widget sits in (WP 10.9; Monarch's equivalent): a title (an `h2` — the
 * dashboard's own `h1` is the top bar's page title), an optional subtitle, a "See all" link to the screen that
 * owns the data, and a body that is the widget's content or one of the honest states above. The card is a
 * labelled `section`, so a screen-reader user can move widget to widget by landmark.
 */
export function DashboardWidgetCard({
  id,
  title,
  subtitle,
  seeAll,
  state,
  asOf,
  className,
  children,
}: DashboardWidgetCardProps) {
  const headingId = useId();
  return (
    <Card
      padding="default"
      className={cn('flex min-w-0 flex-col', className)}
      data-widget={id}
      data-widget-state={state.kind}
    >
      <section aria-labelledby={headingId} className="flex min-w-0 flex-1 flex-col">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="min-w-0">
            <h2 id={headingId} className="text-h3 font-semibold text-text-primary">
              {title}
            </h2>
            {subtitle !== undefined && <p className="text-caption text-text-muted">{subtitle}</p>}
          </div>
          {seeAll !== undefined && (
            <Link
              to={seeAll.to}
              className="inline-flex min-h-6 items-center gap-0.5 text-small text-accent-text underline-offset-4 hover:underline"
            >
              {seeAll.label}
              <span className="sr-only"> — {title}</span>
              <ChevronRight size={14} aria-hidden="true" />
            </Link>
          )}
        </div>

        {state.kind === 'loading' && (
          <div role="status" aria-busy="true" aria-label={`Loading ${title}`}>
            <SkeletonText lines={3} />
          </div>
        )}
        {state.kind === 'error' && (
          <p className="text-small text-text-secondary" data-testid="widget-error">
            {state.message}
          </p>
        )}
        {state.kind === 'empty' && (
          <div className="flex flex-col items-start gap-2" data-testid="widget-empty">
            <p className="text-small text-text-secondary">{state.message}</p>
            {state.fix !== undefined && (
              <Link
                to={state.fix.to}
                className="text-small font-medium text-accent-text underline underline-offset-4"
              >
                {state.fix.label}
              </Link>
            )}
          </div>
        )}
        {state.kind === 'ready' && <div className="min-w-0 flex-1">{children}</div>}

        {asOf !== undefined && state.kind === 'ready' && (
          <p className="mt-3 text-caption text-text-muted" data-testid="widget-as-of">
            {asOf}
          </p>
        )}
      </section>
    </Card>
  );
}
