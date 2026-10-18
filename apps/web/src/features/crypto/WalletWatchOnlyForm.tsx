// SPDX-License-Identifier: MIT
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { linkRefusalDetail } from '../connections/link-refusal.ts';
import { useCreateConnectionMutation } from '../connections/useConnections.ts';
import { useStepUpRetry } from '../../lib/step-up.ts';

type WalletChain = 'bitcoin' | 'ethereum';

const PLACEHOLDER: Record<WalletChain, string> = {
  bitcoin: 'zpub… (or xpub/ypub — an account-level extended public key)',
  ethereum: '0x…',
};

export interface WalletWatchOnlyFormProps {
  onDone: () => void;
}

/**
 * Watch-only Bitcoin/Ethereum wallet entry (dispatch §3, WP 3.12). On the
 * wire this is `POST /connections` with `provider: 'wallet_rpc'` and
 * `input: { chain, value, label? }`
 * (`packages/connectors/walletrpc/src/connect-input.ts#parseConnectInput`).
 *
 * `wp3.6-walletrpc.md` §1: this connector has **no signing primitive and no
 * `HDKey.fromMasterSeed` anywhere in it** — a public xpub/ypub/zpub or a bare
 * `0x` address is structurally all it can ever derive from. §4's guard
 * (`assertNoPrivateMaterial`) refuses a WIF, an `xprv`/`yprv`/`zprv`, a raw
 * 32-byte key or a BIP39-shaped seed phrase before it is stored, logged, or
 * parsed any further, and its refusal message — surfaced verbatim below via
 * `linkRefusalDetail` — names the *kind* of thing it saw without ever echoing the
 * pasted value.
 */
export function WalletWatchOnlyForm({ onDone }: WalletWatchOnlyFormProps) {
  const [chain, setChain] = useState<WalletChain>('bitcoin');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createConnection = useCreateConnectionMutation();
  const stepUp = useStepUpRetry();

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      await stepUp.run(() =>
        createConnection.mutateAsync({
          body: {
            provider: 'wallet_rpc',
            input: { chain, value: value.trim(), ...(label !== '' ? { label } : {}) },
          },
        }),
      );
      setValue('');
      setLabel('');
      onDone();
    } catch (cause) {
      // This is the one place a refusal like "value looks like private key
      // material (bip39_mnemonic_shaped)…" reaches the user — the API's own
      // message, not a paraphrase, and it never contains what was pasted.
      setError(linkRefusalDetail(cause, 'Could not add this wallet.'));
    }
  }

  const busy = createConnection.isPending || stepUp.busy;

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
      <div className="flex items-start gap-2 rounded-md border border-status-success-border bg-status-success-bg p-3 text-small text-text-primary">
        <ShieldCheck size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p>
          This is <strong>watch-only</strong>: paste a public address or extended public key.{' '}
          <strong>We will never ask for a private key or a seed phrase</strong>, and this connector
          has no way to sign a transaction even if one were pasted here.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wallet-chain">Chain</Label>
        <select
          id="wallet-chain"
          className="h-10 rounded-md border border-border-strong bg-bg-surface px-2 text-body text-text-primary focus-visible:outline-none"
          value={chain}
          onChange={(event) => setChain(event.target.value as WalletChain)}
        >
          <option value="bitcoin">Bitcoin</option>
          <option value="ethereum">Ethereum</option>
        </select>
      </div>

      {chain === 'ethereum' && (
        // C-13 (G4-20, docs/evidence/phase-4/gate-security-review.md §3.17):
        // syncing this wallet's balance needs an Etherscan API key configured
        // on the server (`etherscan_api_key`, RUNBOOK.md). Without one the
        // wallet still links, but its balance and holdings will fail to sync
        // every time, silently, until a key is added — stated here in words
        // rather than left for the connections screen to explain after the
        // fact.
        <div className="flex items-start gap-2 rounded-md border border-status-warning-border bg-status-warning-bg p-3 text-small text-text-primary">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p>
            Syncing an Ethereum balance needs an <strong>Etherscan API key</strong> configured on
            the server (<code>etherscan_api_key</code>). This wallet will still link without one,
            but its balance won&rsquo;t sync until a key is added.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wallet-value">
          {chain === 'bitcoin' ? 'Extended public key' : 'Address'}
        </Label>
        <Input
          id="wallet-value"
          required
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={PLACEHOLDER[chain]}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wallet-label">Label (optional)</Label>
        <Input
          id="wallet-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="e.g. Cold storage"
        />
      </div>

      {(error !== null || stepUp.error !== null) && (
        <p className="text-small text-status-danger-text" role="alert">
          {error ?? stepUp.error}
        </p>
      )}

      <Button type="submit" disabled={busy || value.trim() === ''}>
        {busy ? 'Adding…' : 'Add wallet'}
      </Button>
    </form>
  );
}
