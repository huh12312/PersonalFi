// SPDX-License-Identifier: MIT
import type { MoneyJson } from '@core/kernel';

import { Money } from '../../components/finance/Money.tsx';
import type { UnrealizedGain } from '../../api/generated/types.gen.ts';
import { unrealizedReasonLabel } from './labels.ts';

/**
 * The word `unavailable`, in the one visual weight this app uses for "we do
 * not know", with the server's reason beside it.
 *
 * This component exists so that **no unknown number is ever rendered as
 * `$0.00`** — the WP 3.11 exit test `'a holding with unknown basis renders
 * "unavailable" and not "$0.00"'`, and the reason
 * `UnrealizedGain.gain` is typed `… | null` with "Never a zero standing in
 * for unknown" written on the wire schema itself.
 */
export function Unavailable({ reason }: { reason?: string | null }) {
  const label = unrealizedReasonLabel(reason ?? null);
  return (
    <span className="text-text-muted">
      <span className="italic">unavailable</span>
      {label !== null && <span className="text-caption"> ({label})</span>}
    </span>
  );
}

/** A `Money | null` cell: the amount, or `unavailable` — never a zero. */
export function MoneyOrUnavailable({
  value,
  reason,
  signDisplay = 'auto',
  colorBySign = false,
  ...rest
}: {
  value: MoneyJson | null;
  reason?: string | null;
  signDisplay?: 'exceptZero' | 'auto' | 'never';
  colorBySign?: boolean;
  'data-testid'?: string;
}) {
  if (value === null) return <Unavailable {...(reason === undefined ? {} : { reason })} />;
  return <Money value={value} signDisplay={signDisplay} colorBySign={colorBySign} {...rest} />;
}

/**
 * `UnrealizedGain` as one cell. `status: 'unavailable'` always renders the
 * word and the server's `reason`; the `gain` field is `null` in that branch
 * by contract, so there is no path here that can print a zero for an unknown.
 */
export function UnrealizedCell({
  unrealized,
  ...rest
}: {
  unrealized: UnrealizedGain;
  'data-testid'?: string;
}) {
  if (unrealized.status === 'unavailable' || unrealized.gain === null) {
    return (
      <span {...rest}>
        <Unavailable reason={unrealized.reason} />
      </span>
    );
  }
  return <Money value={unrealized.gain} signDisplay="exceptZero" {...rest} />;
}
