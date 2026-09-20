// SPDX-License-Identifier: MIT
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { Category } from '../../api/generated/types.gen.ts';
import {
  Combobox,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPortal,
} from '../../components/ui/combobox.tsx';
import { CreateCategoryDialog } from '../categories/CreateCategoryDialog.tsx';
import { useCategories } from '../categories/useCategories.ts';

/** The pseudo-row for "no category" — never a real row from `GET /categories`, so it can't collide with a system category that happens to share the label. */
const CLEAR_ITEM: Category = {
  id: '',
  key: '__clear__',
  parentId: null,
  label: 'Uncategorized',
  description: '',
  kind: 'other',
  icon: 'circle-help',
  sort: -2,
  isSystem: true,
  archivedAt: null,
  assignable: true,
};

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

interface ComboGroup {
  key: string;
  label: string | null;
  items: Category[];
}

export interface CategoryPickerProps {
  value: string | null;
  onChange: (categoryId: string | null) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/**
 * The category control, over `GET /categories` (gate condition D-6, finding
 * N-3) and `POST /categories` (WP 2.5's carry-over route).
 *
 * ## A combobox, not a `<select>`
 *
 * 05 §5.2 asked for a searchable, grouped combobox with a "create new
 * category" escape hatch; that needed a write route that didn't exist until
 * WP 2.5. Both halves are real now. The combobox is Base UI's (already a
 * dependency — `components/ui/combobox.tsx`), so ARIA and keyboard semantics
 * come for free, matching 05 §5.2's own reasoning for choosing it.
 *
 * A heading is never selectable: it is rendered as a `ComboboxGroupLabel`
 * inside its own `ComboboxGroup`, never as an `Item`, so there is no value a
 * heading could resolve to.
 *
 * ## Two synthetic rows
 *
 * `value=""` is never a real category id — it is `CLEAR_ITEM`, a pseudo-row
 * standing in for "no category", so it can never collide with a real category
 * that happens to be labelled "Uncategorized". A `value` the list does not
 * contain (an archived category, or a list that has not arrived yet) gets its
 * own synthetic "Current category" row for the same reason the old
 * `<select>` rendered an extra `<option>` for it: the alternative is silently
 * snapping the field to "Uncategorized", where the next selection would
 * silently clear a real assignment.
 *
 * ## While the list is loading, and if it never arrives
 *
 * The input stays enabled with the current value shown, because disabling it
 * would make a slow network look like a read-only field. If the request
 * fails the user gets "Uncategorized" plus whatever the transaction already
 * had — degraded, but never a picker that silently drops the assignment it is
 * displaying.
 */
export function CategoryPicker({ value, onChange, disabled, id, className }: CategoryPickerProps) {
  const { groups, byId, isLoading } = useCategories();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingLabel, setPendingLabel] = useState('');
  const [inputValue, setInputValue] = useState('');

  const orphanItem: Category | null = useMemo(() => {
    if (value === null || byId.has(value)) return null;
    return { ...CLEAR_ITEM, id: value, key: '__orphan__', label: 'Current category' };
  }, [value, byId]);

  const comboGroups: ComboGroup[] = useMemo(() => {
    const built: ComboGroup[] = [{ key: '__clear__', label: null, items: [CLEAR_ITEM] }];
    if (orphanItem !== null) built.push({ key: '__orphan__', label: null, items: [orphanItem] });
    for (const group of groups) {
      built.push({
        key: group.parent?.id ?? '__headless__',
        label: group.parent !== null ? groupLabel(group.parent) : null,
        items: [...group.children],
      });
    }
    return built;
  }, [groups, orphanItem]);

  const groupLabelByKey = useMemo(
    () => new Map(comboGroups.map((group) => [group.key, group.label])),
    [comboGroups],
  );

  const selectedItem: Category =
    value === null ? CLEAR_ITEM : (byId.get(value) ?? orphanItem ?? CLEAR_ITEM);

  const headings = useMemo(
    () => groups.map((group) => group.parent).filter((p): p is Category => p !== null),
    [groups],
  );

  return (
    <>
      <Combobox<Category>
        items={comboGroups.map((group) => ({ value: group.key, items: group.items }))}
        value={selectedItem}
        onValueChange={(item) => onChange(item === null || item.id === '' ? null : item.id)}
        itemToStringLabel={(item) => item.label}
        itemToStringValue={(item) => item.id}
        isItemEqualToValue={(item, selected) => item.id === selected.id}
        onInputValueChange={setInputValue}
        disabled={disabled}
      >
        <ComboboxInput
          id={id}
          aria-label="Category"
          aria-busy={isLoading || undefined}
          className={className}
        />
        <ComboboxPortal>
          <ComboboxEmpty>No matching categories.</ComboboxEmpty>
          <ComboboxList>
            {(group: { value: string; items: Category[] }) => (
              <ComboboxGroup key={group.value} items={group.items}>
                {groupLabelByKey.get(group.value) !== null && (
                  <ComboboxGroupLabel>{groupLabelByKey.get(group.value)}</ComboboxGroupLabel>
                )}
                <ComboboxCollection>
                  {(category: Category) => (
                    <ComboboxItem key={category.id} value={category}>
                      {category.label}
                    </ComboboxItem>
                  )}
                </ComboboxCollection>
              </ComboboxGroup>
            )}
          </ComboboxList>
          <div className="mt-1 border-t border-border-hairline pt-1">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-small text-accent-text hover:bg-bg-subtle focus-visible:outline-none"
              onClick={() => {
                setPendingLabel(inputValue);
                setCreateOpen(true);
              }}
            >
              <Plus size={14} aria-hidden="true" />
              Create{inputValue !== '' ? ` "${inputValue}"` : ' a category'}
            </button>
          </div>
        </ComboboxPortal>
      </Combobox>

      <CreateCategoryDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialLabel={pendingLabel}
        headings={headings}
        onCreated={(category) => {
          onChange(category.id);
          setInputValue('');
        }}
      />
    </>
  );
}
