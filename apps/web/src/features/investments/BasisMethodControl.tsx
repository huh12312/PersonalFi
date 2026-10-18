// SPDX-License-Identifier: MIT
import { Lock } from 'lucide-react';
import { useId, useState } from 'react';

import { Button } from '../../components/ui/button.tsx';
import type { ElectBasisMethodData } from '../../api/generated/types.gen.ts';
import { basisMethodLabel } from './labels.ts';
import type { BasisMethodElection } from './api.ts';

type BasisMethod = ElectBasisMethodData['body']['method'];

const METHODS: readonly BasisMethod[] = ['FIFO', 'LIFO', 'HIFO', 'SPECIFIC_ID', 'AVERAGE_COST'];

export interface BasisMethodControlProps {
  readonly accountId: string;
  readonly securityId: string;
  readonly securityLabel: string;
  /** The position's current `basisMethod`, straight from `GET /accounts/{id}/holdings`. */
  readonly current: BasisMethod;
  /**
   * `AggregatedHolding.securityType` for this security. `AVERAGE_COST` is a
   * mutual-fund-only election (07 §4.4 and the IRS); `undefined` when the
   * aggregated response has not arrived, in which case the option is offered
   * and the API's own 422 is what refuses it.
   */
  readonly securityType: string | undefined;
  readonly election: BasisMethodElection;
}

/**
 * The cost-basis method election (`PUT /investments/basis-method`).
 *
 * Three things this control must get right, all of them the server's rules
 * rather than this component's:
 *
 * 1. **`AVERAGE_COST` is mutual-funds-only.** When the security's type is
 *    known and is not `mutual_fund`, the option is not offered — and if it
 *    somehow is submitted anyway, the route answers
 *    `422 investments.average_cost_ineligible` and that refusal is rendered
 *    verbatim. The client never re-states the rule in its own words.
 * 2. **`AVERAGE_COST` is sticky.** A database trigger
 *    (`basis_method_elections_average_cost_is_sticky`) makes it one-way; once
 *    the position reports `AVERAGE_COST`, the control locks itself and says
 *    so, and a race that gets past the lock is refused with
 *    `409 investments.average_cost_is_sticky` — again shown as the server
 *    worded it.
 * 3. **It is step-up gated.** `useBasisMethodElection` runs the passkey
 *    ceremony between the first `403` and the retry; the button reports the
 *    ceremony's own failures separately from the route's refusals.
 */
export function BasisMethodControl({
  accountId,
  securityId,
  securityLabel,
  current,
  securityType,
  election,
}: BasisMethodControlProps) {
  const selectId = useId();
  const [choice, setChoice] = useState<BasisMethod>(current);

  const sticky = current === 'AVERAGE_COST';
  const isPending = election.pendingSecurityId === securityId;
  const refusal = election.refusal?.securityId === securityId ? election.refusal.message : null;
  const averageCostEligible = securityType === undefined || securityType === 'mutual_fund';
  const options = METHODS.filter(
    (method) => method !== 'AVERAGE_COST' || averageCostEligible || method === current,
  );

  if (sticky) {
    return (
      <p
        className="flex items-center gap-1.5 text-caption text-text-muted"
        data-testid="basis-method-sticky"
      >
        <Lock size={12} aria-hidden="true" />
        Cost basis: {basisMethodLabel(current)}. This election is permanent and cannot be changed.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="basis-method-control">
      <div className="flex flex-col gap-1">
        <label htmlFor={selectId} className="text-caption text-text-secondary">
          Cost-basis method for {securityLabel}
        </label>
        <select
          id={selectId}
          className="h-9 rounded-md border border-border-strong bg-bg-surface px-2 text-small"
          value={choice}
          onChange={(event) => setChoice(event.target.value as BasisMethod)}
        >
          {options.map((method) => (
            <option key={method} value={method}>
              {basisMethodLabel(method)}
            </option>
          ))}
        </select>
      </div>
      <Button
        variant="secondary"
        size="sm"
        disabled={isPending || choice === current}
        onClick={() => void election.submit({ accountId, securityId, method: choice })}
      >
        {isPending ? 'Saving…' : 'Save election'}
      </Button>
      {choice === 'AVERAGE_COST' && (
        <p className="w-full text-caption text-status-warning-text">
          Average cost is permanent for this account and security once saved.
        </p>
      )}
      {refusal !== null && (
        <p
          role="alert"
          className="w-full text-caption text-status-danger-text"
          data-testid="basis-method-refusal"
        >
          {refusal}
        </p>
      )}
      {election.stepUpError !== null && election.attemptedSecurityId === securityId && (
        <p role="alert" className="w-full text-caption text-status-danger-text">
          {election.stepUpError}
        </p>
      )}
    </div>
  );
}
