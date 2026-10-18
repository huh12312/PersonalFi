// SPDX-License-Identifier: MIT
import { ArrowDown, ArrowUp, Settings2 } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog.tsx';
import { Switch } from '../../components/ui/switch.tsx';
import {
  moveWidget,
  setVisible,
  WIDGET_TITLES,
  type LayoutEntry,
  type WidgetId,
} from './layout.ts';

export interface CustomizeDashboardSheetProps {
  readonly layout: readonly LayoutEntry[];
  readonly onChange: (layout: LayoutEntry[]) => void;
  readonly onReset: () => void;
  readonly customised: boolean;
  readonly saving?: boolean;
  readonly error?: string | null;
}

/**
 * Customize (WP 10.9; Monarch's Customize screen): every widget in display order, each with a Show
 * switch and Move up / Move down buttons, and a reset to the default. Keyboard-operable throughout — no drag: a
 * move keeps focus on the button that was pressed (on the widget's new row), so pressing it again keeps moving the
 * same widget. Every change is saved as it is made.
 */
export function CustomizeDashboardSheet({
  layout,
  onChange,
  onReset,
  customised,
  saving = false,
  error = null,
}: CustomizeDashboardSheetProps) {
  const [open, setOpen] = useState(false);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  function move(id: WidgetId, delta: -1 | 1): void {
    const next = moveWidget(layout, id, delta);
    onChange(next);
    const index = next.findIndex((entry) => entry.id === id);
    // Keep the pressed button focused; at an end (where it is now disabled) focus its sibling.
    const atEnd = delta === -1 ? index === 0 : index === next.length - 1;
    const key = `${id}:${atEnd ? (delta === -1 ? 'down' : 'up') : delta === -1 ? 'up' : 'down'}`;
    requestAnimationFrame(() => buttons.current.get(key)?.focus());
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="secondary" size="sm">
            <Settings2 size={16} aria-hidden="true" />
            Customize
          </Button>
        }
      />
      <DialogContent className="max-w-lg">
        <DialogTitle>Customize the dashboard</DialogTitle>
        <DialogDescription>
          Choose which widgets to show and their order. Changes are saved as you make them.
        </DialogDescription>
        <ol
          className="mt-4 flex flex-col divide-y divide-border-hairline"
          data-testid="customize-list"
        >
          {layout.map((entry, index) => {
            const title = WIDGET_TITLES[entry.id];
            const switchId = `customize-${entry.id}`;
            return (
              <li
                key={entry.id}
                className="flex items-center gap-3 py-2"
                data-customize-row={entry.id}
              >
                <Switch
                  id={switchId}
                  checked={entry.visible}
                  onCheckedChange={(checked) => onChange(setVisible(layout, entry.id, checked))}
                  aria-label={`Show ${title}`}
                />
                <label htmlFor={switchId} className="min-w-0 flex-1 text-body text-text-primary">
                  {title}
                  {!entry.visible && (
                    <span className="ml-2 text-caption text-text-muted">Hidden</span>
                  )}
                </label>
                <Button
                  ref={(node) => {
                    if (node === null) buttons.current.delete(`${entry.id}:up`);
                    else buttons.current.set(`${entry.id}:up`, node);
                  }}
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9"
                  disabled={index === 0}
                  aria-label={`Move ${title} up`}
                  onClick={() => move(entry.id, -1)}
                >
                  <ArrowUp size={16} aria-hidden="true" />
                </Button>
                <Button
                  ref={(node) => {
                    if (node === null) buttons.current.delete(`${entry.id}:down`);
                    else buttons.current.set(`${entry.id}:down`, node);
                  }}
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9"
                  disabled={index === layout.length - 1}
                  aria-label={`Move ${title} down`}
                  onClick={() => move(entry.id, 1)}
                >
                  <ArrowDown size={16} aria-hidden="true" />
                </Button>
              </li>
            );
          })}
        </ol>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-caption text-text-muted" aria-live="polite">
            {error ?? (saving ? 'Saving…' : customised ? 'Saved.' : 'The default layout.')}
          </p>
          <Button variant="ghost" size="sm" onClick={onReset} disabled={!customised}>
            Reset to default
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
