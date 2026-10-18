// SPDX-License-Identifier: MIT
import { useId, useState } from 'react';
import type { FormEvent } from 'react';

import type { Category } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { useCreateCategoryMutation } from './useCategories.ts';

const KINDS: Array<Category['kind']> = ['expense', 'income', 'transfer', 'investment', 'other'];

export interface CreateCategoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefilled from whatever the user had typed into the combobox before choosing "Create". */
  initialLabel: string;
  /** Every top-level heading, for the "under" picker — the two-level `CHECK` (migration 0006) means a new category may only ever nest one level deep, so the only legal parents are headings, never another leaf. */
  headings: readonly Category[];
  onCreated: (category: Category) => void;
}

/**
 * `POST /categories` (05 §5.2's "create new category" escape hatch), with the
 * two-level constraint reflected directly in the form rather than discovered
 * from a 400: the "under" control only ever lists top-level headings (never a
 * leaf, which the API would refuse as a third level), and `kind` only appears
 * when creating a new heading — a leaf always inherits its parent's kind, so
 * offering the field there would just be a lie the server ignores.
 */
export function CreateCategoryDialog({
  open,
  onOpenChange,
  initialLabel,
  headings,
  onCreated,
}: CreateCategoryDialogProps) {
  const [label, setLabel] = useState(initialLabel);
  const [parentId, setParentId] = useState<string>('');
  const [kind, setKind] = useState<Category['kind']>('expense');
  const [error, setError] = useState<string | null>(null);
  const createCategory = useCreateCategoryMutation();
  const labelId = useId();
  const parentSelectId = useId();
  const kindSelectId = useId();

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      const category = await createCategory.mutateAsync({
        body: {
          parentId: parentId === '' ? null : parentId,
          label,
          ...(parentId === '' ? { kind } : {}),
        },
      });
      onCreated(category.category);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create this category.');
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
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Create a category</DialogTitle>
        <DialogDescription>
          A new heading appears at the top level; a category placed under an existing heading
          inherits its kind.
        </DialogDescription>
        <form className="mt-4 flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={labelId}>Name</Label>
            <Input
              id={labelId}
              required
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Dog grooming"
            />
          </div>

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

          {error !== null && <p className="text-small text-status-danger-text">{error}</p>}

          <Button type="submit" disabled={createCategory.isPending || label.trim() === ''}>
            {createCategory.isPending ? 'Creating…' : 'Create category'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
