// SPDX-License-Identifier: MIT
import { Combobox as BaseCombobox } from '@base-ui-components/react/combobox';
import { Check, ChevronDown, X } from 'lucide-react';
import { useEffect } from 'react';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn.ts';

/**
 * Vendored Base UI Combobox (already a dependency — `@base-ui-components/react`,
 * the same package `dialog.tsx`/`tabs.tsx` wrap), styled to the token set. Not
 * a new dependency: 05 §2.5's "vendored source" choice already covers this
 * component, and Base UI is the memo's own recommendation for new work
 * ("I'd take Base UI for new work").
 *
 * Grouped items are `{ value: <group key>, items: T[] }[]` (Base UI's own
 * `Group<T>` shape) — `CategoryCombobox` is the one caller that needs
 * grouping; single-list callers (the split editor, the transfer-pair picker)
 * pass a flat array and never touch `ComboboxGroup`/`ComboboxGroupLabel`.
 */
export const Combobox = BaseCombobox.Root;
export const ComboboxValue = BaseCombobox.Value;
export const ComboboxCollection = BaseCombobox.Collection;
export const ComboboxGroup = BaseCombobox.Group;
export const ComboboxClear = BaseCombobox.Clear;

export function ComboboxInput({ className, ...props }: ComponentProps<typeof BaseCombobox.Input>) {
  return (
    <BaseCombobox.Input
      className={cn(
        // `w-56` (not `w-full`) so a row-based caller (`BulkActionBar`,
        // `InboxScreen`'s uncategorized row) doesn't have this field demand
        // 100% of a flex row's width and squeeze its siblings to zero — the
        // real, only-visible-in-a-real-browser bug this comment exists
        // because of (jsdom/happy-dom never compute flex layout, so no
        // component test caught it). A caller in a vertical column that
        // *does* want the full column width (`TransactionDetailSheet`,
        // `RuleFromTransactionDialog`) opts in with `className="w-full"`.
        'h-9 w-56 rounded-md border border-border-strong bg-bg-surface px-2 pr-8 text-small text-text-primary',
        'placeholder:text-text-muted',
        'focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function ComboboxTrigger({
  className,
  ...props
}: ComponentProps<typeof BaseCombobox.Trigger>) {
  return (
    <BaseCombobox.Trigger
      className={cn(
        'absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-text-muted',
        'hover:bg-bg-subtle focus-visible:outline-none',
        className,
      )}
      {...props}
    >
      <ChevronDown size={14} aria-hidden="true" />
    </BaseCombobox.Trigger>
  );
}

export function ComboboxClearButton({
  className,
  ...props
}: ComponentProps<typeof BaseCombobox.Clear>) {
  return (
    <BaseCombobox.Clear
      className={cn(
        'absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-text-muted',
        'hover:bg-bg-subtle focus-visible:outline-none',
        className,
      )}
      aria-label="Clear"
      {...props}
    >
      <X size={14} aria-hidden="true" />
    </BaseCombobox.Clear>
  );
}

/**
 * While a combobox popup is open, Base UI hides everything outside it from assistive technology with
 * `aria-hidden` (its focus manager is modal when the input is outside the popup) but leaves that content
 * focusable and clickable — which is exactly what WCAG 4.1.2 / axe's `aria-hidden-focus` forbids, and which the
 * first scan of an open combobox (WP 9.8, CF-7) reported on every region of the page. Base UI marks what it
 * hides with `data-base-ui-inert`; this mirrors each mark as `inert` for as long as the popup is mounted, so
 * what is hidden is also unreachable, and takes it off again when the popup goes (the page was not `inert`
 * before this popup opened, so nothing outlives it).
 */
function InertWhereBaseUiHides() {
  useEffect(() => {
    const made = new Set<Element>();
    const sync = (el: Element): void => {
      if (el.hasAttribute('data-base-ui-inert')) {
        if (!el.hasAttribute('inert')) {
          el.setAttribute('inert', '');
          made.add(el);
        }
      } else if (made.has(el)) {
        el.removeAttribute('inert');
        made.delete(el);
      }
    };
    document.querySelectorAll('[data-base-ui-inert]').forEach(sync);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof Element) sync(record.target);
      }
    });
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-base-ui-inert'],
    });
    return () => {
      observer.disconnect();
      made.forEach((el) => {
        el.removeAttribute('inert');
      });
    };
  }, []);
  return null;
}

export function ComboboxPortal({ children, ...props }: ComponentProps<typeof BaseCombobox.Portal>) {
  return (
    <BaseCombobox.Portal {...props}>
      <InertWhereBaseUiHides />
      <BaseCombobox.Positioner className="z-50 outline-none" sideOffset={4} align="start">
        <BaseCombobox.Popup
          className={cn(
            'max-h-72 w-[var(--anchor-width)] min-w-[220px] overflow-auto rounded-md border border-border-strong',
            'bg-bg-surface-raised p-1 shadow-[var(--shadow-elev-2)] outline-none',
            'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
            'transition-opacity duration-fast ease-standard',
          )}
        >
          {children}
        </BaseCombobox.Popup>
      </BaseCombobox.Positioner>
    </BaseCombobox.Portal>
  );
}

export function ComboboxEmpty({ className, ...props }: ComponentProps<typeof BaseCombobox.Empty>) {
  return (
    <BaseCombobox.Empty
      className={cn('px-2 py-3 text-center text-small text-text-muted', className)}
      {...props}
    />
  );
}

export function ComboboxList({ className, ...props }: ComponentProps<typeof BaseCombobox.List>) {
  return <BaseCombobox.List className={cn('flex flex-col gap-0.5', className)} {...props} />;
}

export function ComboboxGroupLabel({
  className,
  ...props
}: ComponentProps<typeof BaseCombobox.GroupLabel>) {
  return (
    <BaseCombobox.GroupLabel
      className={cn(
        'px-2 pb-1 pt-2 text-caption font-semibold uppercase tracking-wide text-text-muted first:pt-1',
        className,
      )}
      {...props}
    />
  );
}

export function ComboboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseCombobox.Item>) {
  return (
    <BaseCombobox.Item
      className={cn(
        'flex cursor-default items-center justify-between gap-2 rounded px-2 py-1.5 text-small text-text-primary',
        'data-[highlighted]:bg-accent-wash data-[highlighted]:text-accent-text',
        'outline-none',
        className,
      )}
      {...props}
    >
      <span className="truncate">{children}</span>
      <BaseCombobox.ItemIndicator className="shrink-0 text-accent-text">
        <Check size={14} aria-hidden="true" />
      </BaseCombobox.ItemIndicator>
    </BaseCombobox.Item>
  );
}
