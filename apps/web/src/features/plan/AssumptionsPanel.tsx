// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { groupByTopLevel, walkCitedAssumptions } from './assumptions.ts';
import type { AssumptionsFile, AssumptionsAppliedOverride } from '../../api/generated/types.gen.ts';

export interface AssumptionsPanelProps {
  readonly file: AssumptionsFile;
  readonly overrides: readonly AssumptionsAppliedOverride[];
  readonly overridablePaths: readonly string[];
  readonly version: string;
  /** `PUT /assumptions/overrides` — a decimal string, e.g. `"0.06"`. */
  readonly onOverride: (path: string, value: string) => void;
  readonly savingPath?: string | null;
}

/**
 * Every assumption, with its `source` and `as_of` visible **without a
 * click** (`docs/plan/04-phase-4-dispatch.md` §3: "the §5 exit criterion is
 * *'visible, editable, cited'*, and a disclosure that hides the citation
 * behind a chevron satisfies two of three"). No `<details>`, no accordion,
 * no tab — every cited node in `file` renders in this one scrolling panel;
 * the only interaction is the page's own scroll, which reveals more of the
 * same always-rendered content, plus an inline edit control on the subset
 * `overridablePaths` actually names (the capital-market rates —
 * `packages/contexts/planning/src/assumptions.ts`'s `OVERRIDABLE_PATHS`; tax
 * law and dated facts are not overridable and render with no edit control at
 * all, which is itself the "editable where it should be, not everywhere"
 * property).
 */
export function AssumptionsPanel({
  file,
  overrides,
  overridablePaths,
  version,
  onOverride,
  savingPath = null,
}: AssumptionsPanelProps) {
  const cited = walkCitedAssumptions(file);
  const groups = groupByTopLevel(cited);
  const overrideByPath = new Map(overrides.map((o) => [o.path, o]));
  const overridable = new Set(overridablePaths);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  return (
    <div className="flex flex-col gap-4" data-testid="assumptions-panel">
      <p className="text-caption text-text-muted">
        Assumptions file version <code className="font-mono">{version}</code>. {cited.length} cited
        figures.
      </p>
      <div className="max-h-[480px] overflow-y-auto divide-y divide-border-hairline rounded-md border border-border-hairline">
        {[...groups.entries()].map(([group, items]) => (
          <div key={group} className="p-3">
            <h3 className="mb-2 text-small font-semibold text-text-primary">{group}</h3>
            {/*
              Each group gets its own `<dl>` rather than one `<dl>` for the
              whole panel with an `<h3>` interleaved between its dt/dd pairs
              — a `<dl>`'s only permitted direct children are `<dt>`/`<dd>`,
              optionally wrapped in a `<div>` that itself contains nothing
              else (the item-row `<div>` below, `dt` + `dd`* only, satisfies
              that; the group heading does not, which is exactly what axe's
              `definition-list`/`dlitem` rules caught here).
            */}
            <dl className="flex flex-col gap-3">
              {items.map((item) => {
                const override = overrideByPath.get(item.path);
                const canOverride = overridable.has(item.path);
                const isEditing = editingPath === item.path;
                return (
                  <div key={item.path} className="grid gap-0.5">
                    <dt className="text-small text-text-secondary">{item.label}</dt>
                    <dd className="flex flex-wrap items-baseline gap-2">
                      {isEditing ? (
                        <form
                          className="flex items-center gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            onOverride(item.path, draft);
                            setEditingPath(null);
                          }}
                        >
                          <Input
                            aria-label={`Override ${item.label}`}
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            className="h-8 w-28"
                            inputMode="decimal"
                          />
                          <Button type="submit" size="sm" disabled={savingPath === item.path}>
                            Save
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingPath(null)}
                          >
                            Cancel
                          </Button>
                        </form>
                      ) : (
                        <>
                          <span className="tabular-nums text-body font-medium text-text-primary">
                            {override !== undefined ? override.value : item.value}
                            {item.basis === 'inflation_adjusted' ? ' (real)' : ''}
                          </span>
                          {override !== undefined && (
                            <span
                              className="rounded-full bg-accent-wash px-1.5 py-0.5 text-caption text-text-primary"
                              data-testid={`assumption-overridden-${item.path}`}
                            >
                              overridden — default {item.value}
                            </span>
                          )}
                          {canOverride && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setDraft(override !== undefined ? override.value : item.value);
                                setEditingPath(item.path);
                              }}
                            >
                              Edit
                            </Button>
                          )}
                        </>
                      )}
                    </dd>
                    <dd className="text-caption text-text-muted">
                      Source: {item.source} · As of {item.asOf}
                    </dd>
                    {item.note !== null && (
                      <dd className="text-caption text-text-muted italic">{item.note}</dd>
                    )}
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
