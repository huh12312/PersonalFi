// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';

/**
 * 07-advisory-domain.md §8.3's seven-value dismiss taxonomy (WP 5.9's own
 * `reason_code` CHECK, `packages/db/migrations/0030_insight_feedback_reasons.sql`),
 * replacing the three free-text presets this dialog used to send as
 * `reason` (05-phase-5-dispatch.md §3 WP 5.11 — "`DismissReasonDialog.tsx`'s
 * three presets become 07 §8.3's seven, sent as `reasonCode`"). Order
 * matches 07 §8.3's own listing.
 */
export const DISMISS_REASON_CODES = [
  'NOT_TRUE',
  'ALREADY_KNOW',
  'NOT_ACTIONABLE',
  'DONT_CARE',
  'WRONG_AMOUNT',
  'INTENTIONAL',
  'LATER',
] as const;

export type DismissReasonCode = (typeof DISMISS_REASON_CODES)[number];

const REASON_LABEL: Record<DismissReasonCode, string> = {
  NOT_TRUE: 'The facts are wrong',
  ALREADY_KNOW: 'True, but I already knew',
  NOT_ACTIONABLE: "True, but I can't act on it",
  DONT_CARE: "True, but I don't care about this",
  WRONG_AMOUNT: 'Right finding, wrong amount',
  INTENTIONAL: 'I meant to do that',
  LATER: 'Remind me later',
};

export interface DismissResult {
  readonly reasonCode: DismissReasonCode | null;
  /** Free-text detail, stored as the `reason` note beside `reasonCode` (WP 5.9's "expand, never contract": the code is new, the note is the same field this dialog always sent). */
  readonly note: string | null;
}

export interface DismissReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy?: boolean;
  onDismiss: (result: DismissResult) => void;
  /**
   * WP 10.15: the same reason capture reused for "Not helpful" (`InsightCard`'s feedback). Every prop below
   * defaults to the dismissal's wording and behaviour, so a dismissal is unchanged.
   */
  title?: string;
  description?: string;
  confirmLabel?: string;
  busyLabel?: string;
  /** The reasons offered, in 07 §8.3's order. Defaults to all seven. */
  reasonCodes?: readonly DismissReasonCode[];
  /** Offer the free-text detail field (the dismissal's `reason` note). Default true. */
  showNote?: boolean;
  /** The confirm button's variant: destructive for a dismissal, primary for feedback. */
  confirmVariant?: 'destructive' | 'primary';
}

/**
 * The reason capture for a dismissal (05-frontend-architecture.md §5.8:
 * "Dismissal captures a reason when one is offered — cheap to collect,
 * valuable for tuning the rules later"). Feeds `POST /insights/{id}/review`'s
 * `reasonCode` field (07 §8.3's seven-value taxonomy), which starts the
 * 30/90/permanent cooldown ladder (docs/evidence/phase-2/wp2.6-insights.md
 * §1) regardless of which reason — or none — is given; the reason is
 * recorded, not required.
 */
export function DismissReasonDialog({
  open,
  onOpenChange,
  busy = false,
  onDismiss,
  title = 'Dismiss this insight?',
  description = "You won't see this exact finding again for a while. Telling us why helps tune future advice — entirely optional.",
  confirmLabel = 'Dismiss',
  busyLabel = 'Dismissing…',
  reasonCodes = DISMISS_REASON_CODES,
  showNote = true,
  confirmVariant = 'destructive',
}: DismissReasonDialogProps) {
  const [reasonCode, setReasonCode] = useState<DismissReasonCode | null>(null);
  const [note, setNote] = useState('');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showClose={false}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>

        <fieldset className="mt-4 flex flex-col gap-2">
          <legend className="sr-only">Reason (optional)</legend>
          {reasonCodes.map((code) => (
            <label key={code} className="flex items-center gap-2 text-small text-text-secondary">
              <input
                type="radio"
                name="dismiss-reason"
                checked={reasonCode === code}
                onChange={() => setReasonCode(code)}
              />
              {REASON_LABEL[code]}
            </label>
          ))}
        </fieldset>

        {showNote && (
          <label className="mt-3 block text-small text-text-secondary">
            Add a detail (optional)
            <input
              type="text"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              aria-label="Dismissal note"
              className="mt-1 w-full rounded-md border border-border-hairline bg-bg-surface px-2 py-1 text-small text-text-primary"
            />
          </label>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={confirmVariant}
            disabled={busy}
            onClick={() =>
              onDismiss({
                reasonCode,
                note: !showNote || note.trim() === '' ? null : note.trim(),
              })
            }
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
