// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from 'react';

import type { TransactionDetail } from '../../api/generated/types.gen.ts';
import { MerchantNameChip } from './MerchantNameChip.tsx';
import { MerchantNameNote } from './MerchantNameNote.tsx';
import { suggestionFor, unavailableReasonFor, useMerchantNameIndex } from './merchant-name-api.ts';

/**
 * WP 11.6, in the transaction detail sheet: the bank's text exactly as it came (`provenance.providerName`) with the
 * local model's name beside it (Accept / Dismiss), or the one line on why none is suggested. After an Accept or a
 * Dismiss the chip goes and a short confirmation takes its place, and focus lands on it (the button that was
 * pressed is gone). Renders nothing for a merchant the model has no part in.
 */
export function MerchantNameSection({ transaction }: { readonly transaction: TransactionDetail }) {
  const index = useMerchantNameIndex();
  const [message, setMessage] = useState('');
  const statusRef = useRef<HTMLParagraphElement>(null);
  const suggestion = suggestionFor(index, transaction);
  const reason = suggestion === null ? unavailableReasonFor(index, transaction) : null;

  useEffect(() => {
    if (message !== '') statusRef.current?.focus();
  }, [message]);

  if (suggestion === null && reason === null && message === '') return null;
  return (
    <section
      aria-label="Name from the bank’s text"
      data-testid="merchant-name-section"
      className="mt-4 flex flex-col gap-2"
    >
      {(suggestion !== null || reason !== null) && (
        <p className="text-small text-text-muted [overflow-wrap:anywhere]">
          As the bank sent it:{' '}
          <span className="text-text-primary" data-testid="merchant-name-bank-text">
            {transaction.provenance.providerName}
          </span>
        </p>
      )}
      {suggestion !== null && (
        <MerchantNameChip suggestion={suggestion} variant="detail" onResult={setMessage} />
      )}
      {reason !== null && <MerchantNameNote reason={reason} />}
      {message !== '' && (
        <p
          ref={statusRef}
          role="status"
          tabIndex={-1}
          data-testid="merchant-name-status"
          className="text-small text-text-secondary"
        >
          {message}
        </p>
      )}
    </section>
  );
}
