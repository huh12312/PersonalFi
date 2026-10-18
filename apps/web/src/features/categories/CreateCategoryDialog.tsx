// SPDX-License-Identifier: MIT
import { CHART_HUES, type ChartHue } from '@core/kernel';
import { Check } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';

import type { Category, CategoryVariability } from '../../api/generated/types.gen.ts';
import { CategoryIcon } from '../../components/finance/CategoryIcon.tsx';
import { categoryGlyph } from '../../components/finance/category-icon.ts';
import { chartFillVar } from '../../components/finance/chart-hue.ts';
import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { cn } from '../../lib/cn.ts';
import { ClassifyControl } from '../budget/ClassifyControl.tsx';
import { useUpdateCategoryMutation } from './api.ts';
import {
  checkEmojiInput,
  draftOf,
  emojiChoices,
  HUE_LABEL,
  moveInGrid,
  patchOf,
  type EditorDraft,
} from './editor.ts';
import { useCreateCategoryMutation } from './useCategories.ts';

const KINDS: Array<Category['kind']> = ['expense', 'income', 'transfer', 'investment', 'other'];

export interface CreateCategoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefilled from whatever the user had typed into the combobox before choosing "Create". */
  initialLabel: string;
  /** Every top-level heading, for the "under" picker — the two-level `CHECK` (migration 0006) means a new category may only ever nest one level deep, so the only legal parents are headings, never another leaf. */
  headings: readonly Category[];
  /** Create mode: called with the new row. */
  onCreated?: (category: Category) => void;
  /** WP 10.14: edit this category instead of creating one (`PATCH /categories/{id}`). */
  category?: Category | null;
  /** Edit mode: called with the saved row. */
  onSaved?: (category: Category) => void;
}

/**
 * The category editor (WP 10.14, V7): `POST /categories` to create, `PATCH /categories/{id}` to edit — name, icon,
 * hue and (for an expense) variability, saved in one request with only the fields the holder changed.
 *
 * Create mode keeps the two-level constraint in the form (05 §5.2's escape hatch): the "under" control lists only
 * top-level headings, and `kind` appears only for a new heading. Edit mode shows the group and kind as text, because
 * `PATCH` cannot move a category or change its kind (structural: it would silently move money between totals).
 *
 *  - **Icon**: a radio grid of the default table's emoji, a free-text field validated as exactly one emoji
 *    (`isSingleEmoji`, the server's own rule), and "Use default" to clear — the displayed default is never written.
 *  - **Colour**: the thirteen chart hues as a radio group of swatches, each named by its hue; the current one is
 *    checked and carries a tick (not colour alone).
 *  - **Variability**: the budget screen's own classify control (V4), as a form value.
 *
 * Both grids are one Tab stop each with roving arrow keys (the radio pattern).
 */
export function CreateCategoryDialog({
  open,
  onOpenChange,
  initialLabel,
  headings,
  onCreated,
  category = null,
  onSaved,
}: CreateCategoryDialogProps) {
  const editing = category !== null;
  const [draft, setDraft] = useState<EditorDraft>(() => draftOf(category, initialLabel));
  const [emojiText, setEmojiText] = useState('');
  const [emojiError, setEmojiError] = useState<string | null>(null);
  const [parentId, setParentId] = useState<string>('');
  const [kind, setKind] = useState<Category['kind']>('expense');
  const [error, setError] = useState<string | null>(null);
  const createCategory = useCreateCategoryMutation();
  const updateCategory = useUpdateCategoryMutation();
  const labelId = useId();
  const parentSelectId = useId();
  const kindSelectId = useId();
  const emojiInputId = useId();
  const emojiErrorId = useId();

  // A reopened editor starts from the stored row again, not from an abandoned draft — but a background refetch of
  // the categories while it is open never resets what the holder is typing.
  const wasOpen = useRef(open);
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening) return;
    setDraft(draftOf(category, initialLabel));
    setEmojiText('');
    setEmojiError(null);
    setError(null);
  }, [open, category, initialLabel]);

  const pending = createCategory.isPending || updateCategory.isPending;
  const effectiveKind: Category['kind'] = editing
    ? category.kind
    : parentId === ''
      ? kind
      : (headings.find((heading) => heading.id === parentId)?.kind ?? kind);
  const preview = {
    id: category?.id ?? null,
    label: draft.label === '' ? '?' : draft.label,
    key: category?.key ?? null,
    isSystem: category?.isSystem ?? false,
    hue: draft.hue ?? category?.hue ?? null,
    emoji: draft.emoji,
  };
  const glyph = categoryGlyph(preview);

  function chooseEmojiFromText(text: string): void {
    setEmojiText(text);
    const check = checkEmojiInput(text);
    if (!check.ok) {
      setEmojiError(check.message);
      return;
    }
    setEmojiError(null);
    if (check.value !== null) setDraft((prev) => ({ ...prev, emoji: check.value }));
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    if (emojiError !== null) return;
    try {
      if (editing) {
        const patch = patchOf(category, draft);
        if (Object.keys(patch).length === 0) {
          onOpenChange(false);
          return;
        }
        const saved = await updateCategory.mutateAsync({
          path: { categoryId: category.id },
          body: patch,
        });
        onSaved?.(saved.category);
      } else {
        const created = await createCategory.mutateAsync({
          body: {
            parentId: parentId === '' ? null : parentId,
            label: draft.label.trim(),
            ...(parentId === '' ? { kind } : {}),
            ...(draft.emoji === null ? {} : { emoji: draft.emoji }),
            ...(draft.hue === null ? {} : { hue: draft.hue }),
            ...(effectiveKind === 'expense' && draft.variability !== null
              ? { variability: draft.variability }
              : {}),
          },
        });
        onCreated?.(created.category);
      }
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : editing
            ? 'Could not save this category.'
            : 'Could not create this category.',
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent aria-describedby={undefined} className="max-h-[90vh] overflow-y-auto">
        <DialogTitle>{editing ? `Edit ${category.label}` : 'Create a category'}</DialogTitle>
        <DialogDescription>
          {editing
            ? 'Rename it, choose its icon and colour, and say how its spending behaves.'
            : 'A new heading appears at the top level; a category placed under an existing heading inherits its kind.'}
        </DialogDescription>
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => void handleSubmit(event)}
          data-testid="category-editor"
        >
          <div className="flex items-center gap-3">
            <CategoryIcon category={preview} size="md" />
            <p className="text-caption text-text-muted" data-testid="category-editor-preview">
              {glyph.kind === 'emoji' && glyph.source === 'stored'
                ? 'Its own icon.'
                : glyph.kind === 'emoji'
                  ? 'The default icon for this category (not saved unless you choose one).'
                  : 'Its initials, until you choose an icon.'}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={labelId}>Name</Label>
            <Input
              id={labelId}
              required
              value={draft.label}
              onChange={(event) => setDraft((prev) => ({ ...prev, label: event.target.value }))}
              placeholder="e.g. Dog grooming"
            />
          </div>

          {editing ? (
            <p className="text-small text-text-secondary" data-testid="category-editor-structure">
              {category.parentId === null ? 'Top-level category' : 'Inside its group'} ·{' '}
              {category.kind}. The group and kind can't be changed here: moving a category would
              move its history between totals.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={parentSelectId}>Under</Label>
                <select
                  id={parentSelectId}
                  className="h-10 rounded-md border border-border-strong bg-bg-surface px-2 text-body text-text-primary focus-visible:outline-none"
                  value={parentId}
                  onChange={(event) => setParentId(event.target.value)}
                >
                  <option value="">New top-level category</option>
                  {headings.map((heading) => (
                    <option key={heading.id} value={heading.id}>
                      {heading.label}
                    </option>
                  ))}
                </select>
              </div>

              {parentId === '' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={kindSelectId}>Kind</Label>
                  <select
                    id={kindSelectId}
                    className="h-10 rounded-md border border-border-strong bg-bg-surface px-2 text-body text-text-primary focus-visible:outline-none"
                    value={kind}
                    onChange={(event) => setKind(event.target.value as Category['kind'])}
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-small font-medium text-text-primary">Icon</legend>
            <RadioGrid
              label="Icon"
              options={emojiChoices().map((emoji) => ({ value: emoji, label: emoji }))}
              value={draft.emoji}
              onChange={(emoji) => {
                setDraft((prev) => ({ ...prev, emoji }));
                setEmojiText('');
                setEmojiError(null);
              }}
              renderOption={(option) => (
                <span className="text-[18px] leading-none">{option.value}</span>
              )}
              testId="category-emoji-grid"
            />
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Label htmlFor={emojiInputId}>Or type one emoji</Label>
                <Input
                  id={emojiInputId}
                  value={emojiText}
                  onChange={(event) => chooseEmojiFromText(event.target.value)}
                  aria-invalid={emojiError !== null}
                  aria-describedby={emojiError === null ? undefined : emojiErrorId}
                  className="max-w-40"
                  autoComplete="off"
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                disabled={draft.emoji === null}
                onClick={() => {
                  setDraft((prev) => ({ ...prev, emoji: null }));
                  setEmojiText('');
                  setEmojiError(null);
                }}
              >
                Use default
              </Button>
            </div>
            {emojiError !== null && (
              <p id={emojiErrorId} role="alert" className="text-small text-status-danger-text">
                {emojiError}
              </p>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-small font-medium text-text-primary">Colour</legend>
            <RadioGrid
              label="Colour"
              options={CHART_HUES.map((hue) => ({ value: hue, label: HUE_LABEL[hue] }))}
              value={draft.hue}
              onChange={(hue) => setDraft((prev) => ({ ...prev, hue: hue as ChartHue }))}
              renderOption={(option, checked) => (
                <span
                  className="flex h-6 w-6 items-center justify-center rounded-full"
                  style={{ background: chartFillVar(option.value as ChartHue) }}
                >
                  {checked && (
                    <Check
                      size={14}
                      strokeWidth={3}
                      aria-hidden="true"
                      className="rounded-full bg-bg-primary text-text-primary"
                    />
                  )}
                </span>
              )}
              withAccessibleLabel
              testId="category-hue-grid"
            />
            <p className="text-caption text-text-muted">
              {draft.hue === null
                ? 'Not chosen: one is assigned when the category is created.'
                : `${HUE_LABEL[draft.hue]} — every chart draws this category in it.`}
            </p>
          </fieldset>

          {effectiveKind === 'expense' && (
            <div className="flex flex-col gap-0.5">
              <p className="text-small font-medium text-text-primary">How its spending behaves</p>
              <ClassifyControl
                categoryId={category?.id ?? 'new'}
                categoryLabel={draft.label === '' ? 'this category' : draft.label}
                current={draft.variability ?? 'unclassified'}
                suggested={false}
                onChoose={(variability: CategoryVariability | null) =>
                  setDraft((prev) => ({ ...prev, variability }))
                }
              />
            </div>
          )}

          {error !== null && (
            <p role="alert" className="text-small text-status-danger-text">
              {error}
            </p>
          )}

          <Button
            type="submit"
            disabled={pending || draft.label.trim() === '' || emojiError !== null}
          >
            {pending
              ? editing
                ? 'Saving…'
                : 'Creating…'
              : editing
                ? 'Save changes'
                : 'Create category'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface RadioOption {
  readonly value: string;
  readonly label: string;
}

/**
 * A radio group laid out as a grid: one Tab stop (the checked option, else the first), arrows move and select,
 * Home/End jump. `withAccessibleLabel` names each option by its label (a swatch has no text of its own); an emoji
 * option is named by its own content.
 */
function RadioGrid({
  label,
  options,
  value,
  onChange,
  renderOption,
  withAccessibleLabel = false,
  testId,
}: {
  readonly label: string;
  readonly options: readonly RadioOption[];
  readonly value: string | null;
  readonly onChange: (value: string) => void;
  readonly renderOption: (option: RadioOption, checked: boolean) => ReactNode;
  readonly withAccessibleLabel?: boolean;
  readonly testId: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const checkedIndex = options.findIndex((option) => option.value === value);
  const tabIndexAt = checkedIndex >= 0 ? checkedIndex : 0;

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const next = moveInGrid(options.length, index, event.key);
    if (next === null) return;
    event.preventDefault();
    const option = options[next];
    if (option === undefined) return;
    onChange(option.value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-wrap gap-1.5"
      data-testid={testId}
    >
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={withAccessibleLabel ? option.label : undefined}
            title={option.label}
            tabIndex={index === tabIndexAt ? 0 : -1}
            data-value={option.value}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'flex h-9 w-9 items-center justify-center rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-focus-ring',
              checked
                ? 'border-border-primary bg-bg-secondary'
                : 'border-transparent hover:bg-bg-secondary',
            )}
          >
            {renderOption(option, checked)}
          </button>
        );
      })}
    </div>
  );
}
