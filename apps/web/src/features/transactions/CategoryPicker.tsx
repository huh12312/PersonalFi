// SPDX-License-Identifier: MIT
import { cn } from '../../lib/cn.ts';

export interface CategoryPickerProps {
  value: string | null;
  onChange: (categoryId: string | null) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * A placeholder until `@ctx/categorization`'s taxonomy is exposed over REST
 * (no `GET /categories`-shaped route exists in
 * `packages/contracts/openapi/openapi.json` yet, even though the taxonomy
 * itself already exists — WP 1.4 built it, but did not route it). A real
 * combobox needs a list of `{id, name}` to search and a "create new category"
 * escape hatch (05-frontend-architecture.md §5.2); neither is possible
 * without that endpoint, and fabricating category names the API cannot
 * resolve would be worse than an honest placeholder.
 *
 * This still writes the real field — `categoryId` on
 * `TransactionOverlayPatchInput` — so the wiring (including the optimistic
 * update and the bulk-edit path) is real and needs no rework once the route
 * ships; only the single "Uncategorized" option is temporary.
 */
export function CategoryPicker({ value, onChange, disabled, id, className }: CategoryPickerProps) {
  return (
    <select
      id={id}
      aria-label="Category"
      className={cn(
        'h-9 rounded-md border border-border-strong bg-bg-surface px-2 text-small text-text-primary',
        'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
    >
      <option value="">Uncategorized</option>
    </select>
  );
}
