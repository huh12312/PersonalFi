// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';

const PRESET_REASONS = ['Not useful', 'Already handled', "That's wrong"] as const;

export interface DismissReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy?: boolean;
  onDismiss: (reason: string | null) => void;
}

/**
 * The reason capture for a dismissal (05-frontend-architecture.md §5.8:
 * "Dismissal captures a reason when one is offered — cheap to collect,
 * valuable for tuning the rules later"). Feeds `POST /insights/{id}/review`'s
 * `reason` field, which starts the 30/90/permanent cooldown ladder
 * (docs/evidence/phase-2/wp2.6-insights.md §1) regardless of which reason —
 * or none — is given; the reason is recorded, not required.
 */
export function DismissReasonDialog({
  open,
  onOpenChange,
  busy = false,
  onDismiss,
}: DismissReasonDialogProps) {
  const [reason, setReason] = useState<string | null>(null);
  const [customReason, setCustomReason] = useState('');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showClose={false}>
        <DialogTitle>Dismiss this insight?</DialogTitle>
        <DialogDescription>
          You won't see this exact finding again for a while. Telling us why helps tune future
          advice — entirely optional.
        </DialogDescription>

        <fieldset className="mt-4 flex flex-col gap-2">
          <legend className="sr-only">Reason (optional)</legend>
          {PRESET_REASONS.map((preset) => (
            <label key={preset} className="flex items-center gap-2 text-small text-text-secondary">
              <input
                type="radio"
                name="dismiss-reason"
                checked={reason === preset}
                onChange={() => setReason(preset)}
              />
              {preset}
            </label>
          ))}
          <label className="flex items-center gap-2 text-small text-text-secondary">
            <input
              type="radio"
              name="dismiss-reason"
              checked={reason === '__custom__'}
              onChange={() => setReason('__custom__')}
            />
            Something else:
          </label>
          {reason === '__custom__' && (
            <input
              type="text"
              value={customReason}
              onChange={(event) => setCustomReason(event.target.value)}
              aria-label="Dismissal reason"
              className="ml-6 rounded-md border border-border-hairline bg-bg-surface px-2 py-1 text-small text-text-primary"
            />
          )}
        </fieldset>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={() =>
              onDismiss(reason === '__custom__' ? customReason.trim() || null : reason)
            }
          >
            {busy ? 'Dismissing…' : 'Dismiss'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
