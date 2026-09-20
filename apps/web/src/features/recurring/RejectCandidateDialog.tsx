// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { Button } from '../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { Label } from '../../components/ui/label.tsx';

export interface RejectCandidateResult {
  scope: 'MERCHANT' | 'STREAM';
  reason: string | null;
}

export interface RejectCandidateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  merchantName: string;
  busy?: boolean;
  onReject: (result: RejectCandidateResult) => void;
}

/**
 * The permanent-override warning (docs/evidence/phase-2/wp2.3-recurring.md
 * §4): rejecting a candidate is not "dismiss" — it writes a `NOT_RECURRING`
 * override that `loadOverrides` reads *before* any transaction is fetched
 * for every future detection pass, so this payee (or this one stream, at
 * `STREAM` scope) is never proposed again. The dialog says exactly that
 * rather than a generic confirm, because "permanently" is the one word a
 * generic confirm dialog would have hidden.
 */
export function RejectCandidateDialog({
  open,
  onOpenChange,
  merchantName,
  busy = false,
  onReject,
}: RejectCandidateDialogProps) {
  const [scope, setScope] = useState<'MERCHANT' | 'STREAM'>('MERCHANT');
  const [reason, setReason] = useState('');

  function handleReject(): void {
    onReject({ scope, reason: reason.trim().length > 0 ? reason.trim() : null });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showClose={false}>
        <DialogTitle>Reject this as recurring?</DialogTitle>
        <DialogDescription>
          This is permanent. {merchantName} will never be proposed as recurring again — not just
          this once. You can still see its transactions anywhere else in PersonalFi; they simply
          stop being considered for subscriptions, bills, or the upcoming calendar.
        </DialogDescription>

        <fieldset className="mt-4 flex flex-col gap-2">
          <legend className="text-small font-medium text-text-primary">
            What should this cover?
          </legend>
          <label className="flex items-start gap-2 text-small text-text-secondary">
            <input
              type="radio"
              name="reject-scope"
              value="MERCHANT"
              checked={scope === 'MERCHANT'}
              onChange={() => setScope('MERCHANT')}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium text-text-primary">
                Every stream from {merchantName}
              </span>
              <br />
              The usual choice — this payee stops being proposed entirely.
            </span>
          </label>
          <label className="flex items-start gap-2 text-small text-text-secondary">
            <input
              type="radio"
              name="reject-scope"
              value="STREAM"
              checked={scope === 'STREAM'}
              onChange={() => setScope('STREAM')}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium text-text-primary">Only this one pattern</span>
              <br />
              Other, genuinely different streams at the same payee can still be proposed.
            </span>
          </label>
        </fieldset>

        <div className="mt-4">
          <Label htmlFor="reject-reason">Why? (optional)</Label>
          <textarea
            id="reject-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border border-border-hairline bg-bg-surface p-2 text-small text-text-primary"
            placeholder="Not mine / one-off / already tracked elsewhere…"
          />
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleReject} disabled={busy}>
            {busy ? 'Rejecting…' : 'Reject permanently'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
