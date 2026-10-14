// SPDX-License-Identifier: MIT
import { AlertTriangle } from 'lucide-react';

import type { UnresolvedSecurity } from '../../api/generated/types.gen.ts';
import { Money } from '../../components/finance/Money.tsx';
import { trimDecimal } from './ActivityPanel.tsx';
import { UnresolvedMarker } from './UnresolvedMarker.tsx';

/**
 * WP 10.4: a position whose security nobody could identify is a **named row**, not a footnote.
 *
 * Before this, C-8's notice (gate-security-review.md G3-11) said "N positions could not be identified" under
 * the table, and a holder whose every position was unidentified (Chris's IRA) saw an empty table with "No
 * holdings yet" above that line. Now each one is listed where the holder looks for it - in the holdings table,
 * and in its account's panel - with the provider's own name and ticker, the quantity, the institution's own
 * value for it (labelled as the institution's: it is not a price times a quantity, and it is not in any
 * total), the reasons in plain words, and "Could not identify this security". Price, cost basis, gain and
 * weight are not known for it, and say so; none of them is ever a zero.
 */

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  plaid: 'Plaid',
  coinbase: 'Coinbase',
  manual: 'you',
  csv: 'an import',
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** What the row is called: the provider's ticker first (as the holdings table does), else its name. */
export function unresolvedLabel(item: Pick<UnresolvedSecurity, 'ticker' | 'name'>): string {
  return item.ticker ?? item.name ?? 'An unnamed position';
}

/** "Not known" for a cell this position has no value for: a dash to the eye, words to a screen reader. */
export function NotAvailable() {
  return (
    <span className="text-text-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">not available</span>
    </span>
  );
}

/** The institution's own value, labelled as the institution's - or that it reported none. */
export function InstitutionFigure({ value }: { value: UnresolvedSecurity['institutionValue'] }) {
  if (value === null) {
    return (
      <span className="text-text-muted" data-testid="institution-figure">
        <span aria-hidden="true">—</span>
        <span className="text-caption"> (the institution reported no value)</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex flex-wrap items-baseline justify-end gap-x-1"
      data-testid="institution-figure"
    >
      <Money value={value} signDisplay="auto" colorBySign={false} />
      <span className="text-caption text-text-muted">(institution&apos;s figure)</span>
    </span>
  );
}

/** Why, in the api's plain words. A disclosure, so a long list does not crowd the row. */
function UnresolvedReasons({ item }: { item: UnresolvedSecurity }) {
  const reasons =
    item.reasons.length > 0 ? item.reasons : ['The provider did not give enough to identify it.'];
  return (
    <details className="mt-1 text-caption text-text-secondary">
      <summary className="inline-flex min-h-6 cursor-pointer items-center underline underline-offset-2">
        Why it could not be identified
      </summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </details>
  );
}

function NameAndSource({
  item,
  accountName,
  as: Name = 'span',
}: {
  item: UnresolvedSecurity;
  accountName?: string | undefined;
  /** `h3` in an account's panel, where each position is a card with a heading. */
  as?: 'span' | 'h3';
}) {
  const secondary = item.ticker !== null ? item.name : null;
  return (
    <>
      <Name className="block font-medium text-text-primary">{unresolvedLabel(item)}</Name>
      <span className="block text-caption text-text-muted">
        {secondary !== null && <>{secondary} · </>}
        {accountName !== undefined && <>{accountName} · </>}
        reported by {providerLabel(item.provider)} · as of {item.asOfDate}
      </span>
      <UnresolvedMarker className="mt-1 flex w-fit" />
      <UnresolvedReasons item={item} />
    </>
  );
}

/**
 * Rows for `HoldingsTable`'s seven columns (Security, Quantity, Price, Market value, Cost basis, Unrealized,
 * Weight), under a label row that says they are outside the total.
 */
export function UnresolvedHoldingRows({
  unresolved,
  accountNameOf,
}: {
  unresolved: readonly UnresolvedSecurity[];
  accountNameOf: (accountId: string) => string;
}) {
  if (unresolved.length === 0) return null;
  return (
    <>
      <tr className="border-b border-border-hairline">
        <td colSpan={7} className="pt-4 pb-1 text-caption font-medium text-text-secondary">
          Could not identify ({unresolved.length}) — left out of the portfolio total and every
          figure above
        </td>
      </tr>
      {unresolved.map((item) => (
        <tr
          key={item.id}
          className="border-b border-border-hairline align-top"
          data-testid={`unresolved-row-${item.id}`}
        >
          <th scope="row" className="py-2 pl-5 text-left font-normal">
            <NameAndSource item={item} accountName={accountNameOf(item.accountId)} />
          </th>
          <td className="py-2 text-right tabular-nums">{trimDecimal(item.quantity)}</td>
          <td className="py-2 text-right">
            <NotAvailable />
          </td>
          <td className="py-2 text-right">
            <InstitutionFigure value={item.institutionValue} />
          </td>
          <td className="py-2 text-right">
            <NotAvailable />
          </td>
          <td className="py-2 text-right">
            <NotAvailable />
          </td>
          <td className="py-2 text-right">
            <NotAvailable />
          </td>
        </tr>
      ))}
    </>
  );
}

/** One unidentified position in an account's panel, in the same card shape as the positions above it. */
export function UnresolvedPositionCard({ item }: { item: UnresolvedSecurity }) {
  return (
    <li
      className="rounded-lg border border-border-hairline p-4"
      data-testid={`unresolved-position-${item.id}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-small">
          <NameAndSource item={item} as="h3" />
        </div>
        <span className="tabular-nums text-small text-text-secondary">
          {trimDecimal(item.quantity)} units
        </span>
      </div>
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-caption">
        <div className="flex gap-1">
          <dt className="text-text-muted">Market value:</dt>
          <dd>
            <InstitutionFigure value={item.institutionValue} />
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-text-muted">Price:</dt>
          <dd>
            <NotAvailable />
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-text-muted">Cost basis:</dt>
          <dd>
            <NotAvailable />
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-text-muted">Unrealized:</dt>
          <dd>
            <NotAvailable />
          </dd>
        </div>
      </dl>
    </li>
  );
}

export interface UnresolvedSecuritiesNoticeProps {
  readonly unresolved: readonly UnresolvedSecurity[];
}

/**
 * The one-line summary under the rows: how many, and that they are outside every total. Renders nothing when
 * the list is empty - same "don't check before you render me" contract `ProviderAttribution` uses.
 */
export function UnresolvedSecuritiesNotice({ unresolved }: UnresolvedSecuritiesNoticeProps) {
  if (unresolved.length === 0) return null;
  const one = unresolved.length === 1;
  return (
    <p
      className="flex items-start gap-2 text-caption text-text-secondary"
      data-testid="unresolved-securities"
    >
      <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span>
        {unresolved.length} position{one ? '' : 's'} could not be identified, so{' '}
        {one ? 'it is' : 'they are'} listed with the institution&apos;s own figure and left out of
        the totals, allocation and performance. {one ? 'Its' : 'Their'} movements still show in
        Activity.
      </span>
    </p>
  );
}
