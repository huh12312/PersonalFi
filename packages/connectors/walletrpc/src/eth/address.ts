// SPDX-License-Identifier: MIT
/**
 * Ethereum address validation. **There is no derivation on the ETH side** —
 * 08 §2.6 and the dispatch both describe this connector's Ethereum half as
 * "by address": the user pastes a public `0x…` address directly, exactly like
 * pointing a block explorer at it. No BIP32 path, no HD key, no seed of any
 * kind — which is one less place private material could ever be asked for.
 */
import { ConnectorError } from '@connector/port';

const ETH_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isEthAddress(value: string): boolean {
  return ETH_ADDRESS_PATTERN.test(value.trim());
}

/** Lower-cased, `0x`-prefixed, 40 hex characters. Throws `invalid_input` otherwise. */
export function parseEthAddress(value: string): string {
  const trimmed = value.trim();
  if (!isEthAddress(trimmed)) {
    throw new ConnectorError(
      `"${trimmed.slice(0, 12)}…" is not a well-formed Ethereum address (expected 0x followed by ` +
        '40 hex characters)',
      { kind: 'invalid_input', condition: 'CONFIG_ERROR' },
    );
  }
  return trimmed.toLowerCase();
}

/**
 * The sentinel contract address `@ctx/investments`'s `NATIVE_ASSETS` table
 * recognises as "the chain's own coin" on every EVM chain
 * (`packages/contexts/investments/src/identifiers.ts`, `EVM_NATIVE_SENTINELS`).
 * This connector reports native ETH balances against this identifier so the
 * resolver canonicalises them onto the same `chain_contract` identity a
 * Coinbase `{kind:'ticker', value:'ETH'}` sighting resolves to — see
 * `one-security.test.ts` and §5 of the evidence doc.
 */
export const ETH_NATIVE_SENTINEL_CONTRACT = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
