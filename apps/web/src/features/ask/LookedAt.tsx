// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';

import { cn } from '../../lib/cn.ts';
import { isKnownScreen, type AskLookedAt, type AskLookedAtItem } from './ask-words.ts';

/** A link to one of the app's own screens by the path the api names; a path that is not a screen is only a label. */
export function ScreenLink({ path, label }: { readonly path: string; readonly label: string }) {
  if (!isKnownScreen(path)) return <span className="text-text-secondary">{label}</span>;
  return (
    <Link
      // The api names the path at run time; the allow-list above is what makes it one of the app's routes.
      to={path as '/'}
      className="text-accent-text underline underline-offset-2"
      data-testid="ask-screen-link"
    >
      {label}
    </Link>
  );
}

const ITEM_STATUS_WORDS: Readonly<Record<AskLookedAtItem['status'], string>> = {
  ok: '',
  not_available: 'Not available',
  refused: 'Refused',
};

function LookedAtItem({
  item,
  defaultOpen,
}: {
  readonly item: AskLookedAtItem;
  readonly defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const statusWords = ITEM_STATUS_WORDS[item.status];
  return (
    <li
      className="rounded-md border border-border-hairline bg-bg-surface"
      data-testid="ask-looked-at-item"
      data-function={item.function}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((prev) => !prev)}
        className="flex min-h-10 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-small font-medium text-text-primary hover:bg-bg-subtle"
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {item.label}
          {statusWords !== '' && (
            <span className="ml-2 text-caption font-normal text-text-muted">({statusWords})</span>
          )}
        </span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={cn(
            'shrink-0 transition-transform duration-fast ease-standard',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && (
        <div id={panelId} className="border-t border-border-hairline px-3 py-2">
          {item.figures.length > 0 && (
            <dl
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-small"
              data-testid="ask-figures"
            >
              {item.figures.map((figure, index) => (
                <div key={`${figure.label}-${String(index)}`} className="contents">
                  <dt className="text-text-secondary [overflow-wrap:anywhere]">{figure.label}</dt>
                  <dd className="text-right font-medium tabular-nums text-text-primary">
                    {figure.text}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {item.figures.length === 0 && item.note === null && (
            <p className="text-small text-text-muted">No figures were produced.</p>
          )}
          {item.asOf !== null && (
            <p className="mt-1 text-caption text-text-muted">As of {item.asOf}</p>
          )}
          {item.note !== null && (
            <p className="mt-1 text-small text-text-secondary" data-testid="ask-item-note">
              {item.note}
            </p>
          )}
          <p className="mt-2 text-small text-text-secondary">
            Where to find it: <ScreenLink path={item.screen.path} label={item.screen.label} />
          </p>
        </div>
      )}
    </li>
  );
}

export interface LookedAtProps {
  readonly lookedAt: AskLookedAt;
  /** Every item opens showing its figures (the arithmetic-only state). */
  readonly defaultOpen?: boolean;
}

/**
 * The evidence line under every answer ("I looked at: contribution room (2026, IRA), as of 2026-10-28.") and, under
 * it, one disclosure per calculation: its figures as a label/value list, its note, and the screen it lives on.
 */
export function LookedAt({ lookedAt, defaultOpen = false }: LookedAtProps) {
  return (
    <div className="mt-3" data-testid="ask-looked-at">
      <p className="text-small text-text-secondary" data-testid="ask-looked-at-line">
        {lookedAt.line}
      </p>
      {lookedAt.items.length > 0 && (
        <ul className="mt-2 flex flex-col gap-2">
          {lookedAt.items.map((item, index) => (
            <LookedAtItem
              key={`${item.function}-${String(index)}`}
              item={item}
              defaultOpen={defaultOpen}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
