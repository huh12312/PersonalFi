// SPDX-License-Identifier: MIT
import {
  useDashboardLayoutQuery,
  useResetDashboardLayout,
  useSaveDashboardLayout,
  toWire,
} from './api.ts';
import { CustomizeDashboardSheet } from './CustomizeDashboardSheet.tsx';
import { defaultLayout, normaliseLayout, visibleWidgets, WIDE_WIDGETS } from './layout.ts';
import { renderWidget, type WidgetContext } from './widgets/registry.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import { cn } from '../../lib/cn.ts';

/**
 * The dashboard as a widget grid (WP 10.9; docs/research/10-visual-design-notes.md §3 V2).
 *
 * The grid is sized by its own width (`@container`), not the viewport, so the sidebar and zoom change it the same
 * way a phone does: one column, two from 42 rem, three from 56 rem (a 1280 px desktop with the sidebar open); a wide widget (net worth) spans two where there
 * are two. Only the widgets the holder shows are rendered at all — a hidden widget mounts nothing and fetches
 * nothing. So until the layout has been read, no widget mounts (a placeholder grid holds the space): drawing the
 * default meanwhile would mount, and fetch for, the very widgets the holder hid. If the layout cannot be read, the
 * default is drawn.
 */
export function DashboardScreen(context: WidgetContext) {
  const layoutQuery = useDashboardLayoutQuery();
  const save = useSaveDashboardLayout();
  const reset = useResetDashboardLayout();
  const layout =
    layoutQuery.data === undefined ? defaultLayout() : normaliseLayout(layoutQuery.data.widgets);
  const shown = visibleWidgets(layout);

  if (layoutQuery.isPending) {
    return (
      <div
        className="flex flex-col gap-4"
        role="status"
        aria-busy="true"
        aria-label="Loading the dashboard"
      >
        <div className="h-8" />
        <div className="@container">
          <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @4xl:grid-cols-3">
            <Skeleton variant="block" height={260} className="@2xl:col-span-2" />
            <Skeleton variant="block" height={260} />
            <Skeleton variant="block" height={180} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end gap-2">
        <CustomizeDashboardSheet
          layout={layout}
          customised={layoutQuery.data?.customised ?? false}
          saving={save.isPending || reset.isPending}
          error={save.isError || reset.isError ? "Couldn't save the layout. Try again." : null}
          onChange={(next) => save.mutate({ body: toWire(next) })}
          onReset={() => reset.mutate({})}
        />
      </div>
      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong px-6 py-10 text-center text-small text-text-secondary">
          Every widget is hidden. Choose Customize to show some.
        </p>
      ) : (
        <div className="@container">
          <div
            className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @4xl:grid-cols-3"
            data-testid="dashboard-grid"
          >
            {shown.map((id) => (
              <div
                key={id}
                className={cn(
                  'flex min-w-0 flex-col [&>*]:flex-1',
                  WIDE_WIDGETS.has(id) && '@2xl:col-span-2',
                )}
                data-grid-widget={id}
                // One unit of reading for the Tab-order check (e2e/support/keyboard.ts): the grid reads row by row.
                data-reading-cell={id}
              >
                {renderWidget(id, context)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
