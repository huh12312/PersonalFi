// SPDX-License-Identifier: MIT
import type { Category } from '../../api/generated/types.gen.ts';
import { cn } from '../../lib/cn.ts';
import { useCategories } from '../categories/useCategories.ts';

/**
 * The group heading, with its `kind` when the kind is news.
 *
 * Almost every category is an expense, so printing "expense" twenty times is
 * noise that hides the four labels that matter: a transfer category means "this
 * will not count as spend", and income and investment change what a Phase 2
 * budget does with the row. So the kind is shown exactly when it is not the
 * default reading.
 */
function groupLabel(parent: Category): string {
  return parent.kind === 'expense' ? parent.label : `${parent.label} · ${parent.kind}`;
}

/**
 * `data-kind` rather than a styled badge: a `<option>` renders as plain text in
 * every browser, so the kind has to be readable from the attribute by a test and
 * by whatever Phase 2 builds on top, not from a span the platform will not draw.
 */
function renderOption(category: Category) {
  return (
    <option key={category.id} value={category.id} data-kind={category.kind}>
      {category.label}
    </option>
  );
}

export interface CategoryPickerProps {
  value: string | null;
  onChange: (categoryId: string | null) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * The category control, over `GET /categories` (gate condition D-6, finding N-3).
 *
 * This used to render exactly one option — "Uncategorized" — and say why in its
 * own doc comment: the taxonomy existed (WP 1.4) and the write path worked, but
 * no route listed categories and the table was empty on a fresh deployment, so
 * the re-gate's browser walk could not set a category at all. Both halves now
 * exist, and the component's contract is unchanged: it still writes
 * `categoryId` on `TransactionOverlayPatchInput`, so `TransactionDetailSheet`'s
 * optimistic update and `BulkActionBar`'s bulk path needed no edit.
 *
 * ## Grouped, and a `<select>` for now
 *
 * The taxonomy is two levels, so the options are grouped parent → children with
 * `<optgroup>`: a native select gives keyboard navigation, type-ahead and mobile
 * pickers for free, and "Dining ▸ Restaurants" is the whole affordance at ~150
 * options. 05 §5.2's searchable combobox with a "create new category" escape
 * hatch is still the destination and still needs a `POST /categories` that does
 * not exist, so building the search half now would be a control whose second
 * half 404s.
 *
 * A heading is never selectable: `assignable` is computed *by the server* from
 * the table's own parent/child shape, and `<optgroup label>` is not a value, so
 * the rule is enforced by the markup rather than by a client-side convention.
 *
 * ## While the list is loading, and if it never arrives
 *
 * The select stays enabled with the current value shown, because disabling it
 * would make a slow network look like a read-only field. If the request fails
 * the user gets "Uncategorized" plus whatever the transaction already had —
 * degraded, but never a picker that silently drops the assignment it is
 * displaying.
 */
export function CategoryPicker({ value, onChange, disabled, id, className }: CategoryPickerProps) {
  const { groups, byId, isLoading } = useCategories();

  // A value the list does not contain — an archived category, or a list that has
  // not arrived yet — still has to be renderable, or the `<select>` would snap
  // to "Uncategorized" and the next blur would silently clear a real assignment.
  const orphanValue = value !== null && !byId.has(value) ? value : null;

  return (
    <select
      id={id}
      aria-label="Category"
      aria-busy={isLoading || undefined}
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
      {orphanValue !== null && <option value={orphanValue}>Current category</option>}
      {groups.map((group) =>
        group.parent === null ? (
          group.children.map(renderOption)
        ) : (
          <optgroup key={group.parent.id} label={groupLabel(group.parent)}>
            {group.children.map(renderOption)}
          </optgroup>
        ),
      )}
    </select>
  );
}
