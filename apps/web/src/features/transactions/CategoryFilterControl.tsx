// SPDX-License-Identifier: MIT
import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.tsx';
import { useCategories } from '../categories/useCategories.ts';

export interface CategoryFilterControlProps {
  value: readonly string[];
  onChange: (categoryIds: string[] | undefined) => void;
}

/**
 * The `categoryIds` filter control (closeout-architecture.md §4's stale
 * "no category filter" bullet, corrected by WP 2.5: `GET /transactions`
 * already accepts `categoryIds`, plural — only the UI control was missing).
 *
 * A checklist popover rather than a multi-value combobox: the filter bar's
 * existing "Accounts" control is already a plain multi-select, and a grouped
 * checklist gives the same "pick several, see them all at once" affordance
 * with unambiguous keyboard semantics (a native checkbox, `Tab`/`Space`) —
 * `CategoryPicker`'s single-select combobox is the right shape for "choose
 * one category to assign"; this control's job is "narrow the list to several
 * categories at once," which a checklist states more plainly than a combobox
 * whose chips would just be these same checkboxes restated.
 */
export function CategoryFilterControl({ value, onChange }: CategoryFilterControlProps) {
  const { groups, byId } = useCategories();
  const [query, setQuery] = useState('');
  const selected = useMemo(() => new Set(value), [value]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleGroups = useMemo(() => {
    if (normalizedQuery === '') return groups;
    return groups
      .map((group) => ({
        ...group,
        children: group.children.filter((child) =>
          child.label.toLowerCase().includes(normalizedQuery),
        ),
      }))
      .filter((group) => group.children.length > 0);
  }, [groups, normalizedQuery]);

  function toggle(categoryId: string): void {
    const next = new Set(selected);
    if (next.has(categoryId)) next.delete(categoryId);
    else next.add(categoryId);
    onChange(next.size === 0 ? undefined : [...next]);
  }

  const summary =
    selected.size === 0
      ? 'Category'
      : selected.size === 1
        ? (byId.get([...selected][0] ?? '')?.label ?? '1 category')
        : `${String(selected.size)} categories`;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="secondary" size="md" className="gap-1.5">
            {summary}
            <ChevronDown size={14} aria-hidden="true" />
          </Button>
        }
      />
      <PopoverContent align="start" aria-label="Filter by category">
        <Input
          aria-label="Search categories"
          placeholder="Search categories…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="mb-2 h-9"
        />
        <div className="max-h-64 overflow-y-auto">
          {visibleGroups.length === 0 && (
            <p className="px-1 py-2 text-small text-text-muted">No matching categories.</p>
          )}
          {visibleGroups.map((group) => (
            <div key={group.parent?.id ?? 'headless'} className="mb-2 last:mb-0">
              {group.parent !== null && (
                <div className="px-1 pb-1 text-caption font-semibold uppercase tracking-wide text-text-muted">
                  {group.parent.label}
                </div>
              )}
              {group.children.map((category) => (
                <label
                  key={category.id}
                  className="flex items-center gap-2 rounded px-1 py-1.5 text-small text-text-primary hover:bg-bg-subtle"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(category.id)}
                    onChange={() => toggle(category.id)}
                    className="h-4 w-4"
                  />
                  {category.label}
                </label>
              ))}
            </div>
          ))}
        </div>
        {selected.size > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 w-full"
            onClick={() => onChange(undefined)}
          >
            Clear categories
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
