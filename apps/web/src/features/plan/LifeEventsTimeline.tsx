// SPDX-License-Identifier: MIT
import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';
import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';

import { Money } from '../../components/finance/Money.tsx';
import { Button } from '../../components/ui/button.tsx';
import type { PlanLifeEvent } from '../../api/generated/types.gen.ts';

/**
 * Draggable, keyboard-operable life events on a timeline
 * (`docs/plan/04-phase-4-dispatch.md` §3: "Draggable life events on the
 * timeline, each a typed dated amount, keyboard-operable (a drag that only
 * works with a pointer fails WCAG 2.2 AA, 05 §8.1)").
 *
 * The drag surface is a native `<input type="range">`, not a hand-rolled
 * pointer+`onKeyDown` widget. A native range input is simultaneously the
 * pointer-drag affordance *and* its own required keyboard alternative
 * (WCAG 2.5.7 — arrow keys, Home/End, Page Up/Down all move it with zero
 * extra code) and is what `05-frontend-architecture.md` §5.6 already
 * prescribes for the conceptually adjacent "drag-to-allocate" budget slider.
 * Committing on every keystroke/pointer tick would flood
 * `PATCH /plan/life-events/{id}`, so a change debounces 300ms and always
 * flushes on blur, so a keyboard user tabbing away never loses the last
 * unsent move.
 */

const COMMIT_DEBOUNCE_MS = 300;

export interface LifeEventsTimelineProps {
  readonly lifeEvents: readonly PlanLifeEvent[];
  readonly rangeStart: Date;
  readonly rangeEnd: Date;
  readonly onMove: (lifeEventId: string, occursOn: string) => void;
  readonly onDelete: (lifeEventId: string) => void;
  readonly pendingDeleteId?: string | null;
}

function dateToOffset(date: Date, rangeStart: Date): number {
  return differenceInCalendarDays(date, rangeStart);
}

function offsetToIso(offset: number, rangeStart: Date): string {
  return format(addDays(rangeStart, offset), 'yyyy-MM-dd');
}

const KIND_LABEL: Record<PlanLifeEvent['kind'], string> = {
  inheritance: 'Inheritance',
  home_purchase: 'Home purchase',
  college: 'College',
  sabbatical: 'Sabbatical',
  windfall: 'Windfall',
  other: 'Other',
};

interface RowProps {
  readonly event: PlanLifeEvent;
  readonly rangeStart: Date;
  readonly totalDays: number;
  readonly onMove: (lifeEventId: string, occursOn: string) => void;
  readonly onDelete: (lifeEventId: string) => void;
  readonly pendingDelete: boolean;
}

function LifeEventRow({ event, rangeStart, totalDays, onMove, onDelete, pendingDelete }: RowProps) {
  const [offset, setOffset] = useState(() => dateToOffset(parseISO(event.occursOn), rangeStart));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleCommit(nextOffset: number): void {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      onMove(event.id, offsetToIso(nextOffset, rangeStart));
    }, COMMIT_DEBOUNCE_MS);
  }

  function flushCommit(nextOffset: number): void {
    if (timer.current !== null) clearTimeout(timer.current);
    onMove(event.id, offsetToIso(nextOffset, rangeStart));
  }

  const displayDate = format(addDays(rangeStart, offset), 'MMM d, yyyy');

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border-hairline p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-small font-medium text-text-primary">{event.name}</p>
          <p className="text-caption text-text-muted">{KIND_LABEL[event.kind]}</p>
        </div>
        <div className="flex items-center gap-3">
          <Money value={event.amount} />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${event.name}`}
            disabled={pendingDelete}
            onClick={() => onDelete(event.id)}
          >
            <Trash2 size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <label htmlFor={`life-event-date-${event.id}`} className="sr-only">
          {event.name} date
        </label>
        <input
          id={`life-event-date-${event.id}`}
          type="range"
          min={0}
          max={totalDays}
          value={offset}
          onChange={(e) => {
            const next = Number(e.target.value);
            setOffset(next);
            scheduleCommit(next);
          }}
          onBlur={() => flushCommit(offset)}
          onKeyUp={(e) => {
            // Arrow/Home/End/PageUp/PageDown all fire `onChange` already;
            // this only guarantees a fast final commit without waiting out
            // the debounce when a keyboard user stops on this exact value.
            if (['Enter'].includes(e.key)) flushCommit(offset);
          }}
          className="h-2 flex-1 accent-[var(--accent)]"
          aria-valuetext={displayDate}
        />
        <span className="w-28 shrink-0 text-caption tabular-nums text-text-secondary">
          {displayDate}
        </span>
      </div>
    </li>
  );
}

export function LifeEventsTimeline({
  lifeEvents,
  rangeStart,
  rangeEnd,
  onMove,
  onDelete,
  pendingDeleteId = null,
}: LifeEventsTimelineProps) {
  const totalDays = Math.max(differenceInCalendarDays(rangeEnd, rangeStart), 1);

  if (lifeEvents.length === 0) {
    return <p className="text-small text-text-muted">No life events yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {lifeEvents.map((event) => (
        <LifeEventRow
          key={event.id}
          event={event}
          rangeStart={rangeStart}
          totalDays={totalDays}
          onMove={onMove}
          onDelete={onDelete}
          pendingDelete={pendingDeleteId === event.id}
        />
      ))}
    </ul>
  );
}
