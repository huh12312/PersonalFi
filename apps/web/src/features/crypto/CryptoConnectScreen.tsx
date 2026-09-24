// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { useConnectorsQuery } from '../connections/useConnections.ts';
import { CoinbaseKeyForm } from './CoinbaseKeyForm.tsx';
import { WalletWatchOnlyForm } from './WalletWatchOnlyForm.tsx';

const COINBASE_PROVIDER = 'coinbase';
const WALLETRPC_PROVIDER = 'wallet_rpc';

/**
 * Crypto connect flows (dispatch §3, WP 3.12): the Coinbase CDP key form and
 * watch-only wallet entry, gated on `GET /connectors` the same way
 * `features/connections/AddConnectionDialog.tsx` gates its own tabs — this
 * work package cannot edit that file (WP 3.12 owns `features/{networth,
 * market-data,crypto}/**` only, and `AddConnectionDialog.tsx` is
 * `features/connections/**`), so this screen is a second, self-contained
 * entry point surfaced from `_app.settings.tsx` instead. See
 * `docs/evidence/phase-3/wp3.12-networth-ui.md` §6 for the seam this leaves
 * for a future work package to close by wiring these two forms into that
 * dialog's `credential_form` branch.
 */
export function CryptoConnectScreen() {
  const connectorsQuery = useConnectorsQuery();
  const [coinbaseDone, setCoinbaseDone] = useState(false);
  const [walletDone, setWalletDone] = useState(false);

  if (connectorsQuery.isLoading) return <SkeletonText lines={6} />;

  const connectors = connectorsQuery.data?.connectors ?? [];
  const coinbaseRegistered = connectors.some((c) => c.provider === COINBASE_PROVIDER);
  const walletRegistered = connectors.some((c) => c.provider === WALLETRPC_PROVIDER);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="text-h3 text-text-primary">Coinbase (read-only)</h2>
        {coinbaseRegistered ? (
          coinbaseDone ? (
            <p className="mt-2 text-small text-status-good" role="status">
              Coinbase connected. It appears in your connections list.
            </p>
          ) : (
            <CoinbaseKeyForm onDone={() => setCoinbaseDone(true)} />
          )
        ) : (
          <p className="mt-2 text-small text-text-muted">
            Not available in this deployment (no Coinbase CDP key configured server-side).
          </p>
        )}
      </section>

      <section>
        <h2 className="text-h3 text-text-primary">Bitcoin / Ethereum wallet (watch-only)</h2>
        {walletRegistered ? (
          walletDone ? (
            <p className="mt-2 text-small text-status-good" role="status">
              Wallet added. It appears in your connections list.
            </p>
          ) : (
            <WalletWatchOnlyForm onDone={() => setWalletDone(true)} />
          )
        ) : (
          <p className="mt-2 text-small text-text-muted">Not available in this deployment.</p>
        )}
      </section>
    </div>
  );
}
