// SPDX-License-Identifier: MIT
/**
 * `WalletAddressStore` — the injected seam this connector uses instead of a
 * database handle, in the same shape `@connector/csv`'s `DurableStore` uses
 * (`packages/connectors/csv/src/connector.ts`'s module comment). "An adapter
 * never writes to the database" (08 §2.3) means never touches Postgres
 * directly; it does not mean an adapter may not own a tiny, injectable
 * abstraction over its own scratch state, and this connector's very reason for
 * existing — one xpub/ypub/zpub or address, and a gap-limit scan horizon — is
 * exactly `wallet_addresses` (migration 0016), the one table this work package
 * owns.
 *
 * **The composition root (`apps/api`) supplies the real implementation**,
 * bound to `wallet_addresses`, exactly as it supplies CSV's `DurableStore`
 * bound to its staging tables. `docs/evidence/phase-3/wp3.6-walletrpc.md` §8
 * names the exact shape that implementation must satisfy. `test/fake.ts` in
 * this package supplies an in-memory one for every test here.
 *
 * One row per connection: this connector watches exactly one descriptor per
 * connection (one xpub, or one address) — the dispatch's "per connection:
 * chain, address or xpub descriptor, derivation scheme, label, gap-limit scan
 * state" describes a single record, not a list. A user who wants to watch two
 * wallets creates two connections, which is also how Coinbase and Plaid work:
 * one connection per credential.
 */
import type { BipScheme } from './btc/scheme.ts';
import type { WalletChain } from './provider.ts';

export interface WalletScanState {
  /** Highest external (receiving)-chain index ever observed with activity. */
  readonly externalHighestUsedIndex: number | null;
  /** Highest internal (change)-chain index ever observed with activity. */
  readonly internalHighestUsedIndex: number | null;
}

export const EMPTY_SCAN_STATE: WalletScanState = Object.freeze({
  externalHighestUsedIndex: null,
  internalHighestUsedIndex: null,
});

export interface WalletAddressRecord {
  /** Keyed by `providerConnectionId` — see this file's header. */
  readonly providerConnectionId: string;
  readonly chain: WalletChain;
  /** The xpub/ypub/zpub (bitcoin) or the `0x…` address (ethereum), verbatim. */
  readonly descriptor: string;
  /** `null` for ethereum — there is no derivation on that side (`eth/address.ts`). */
  readonly derivationScheme: BipScheme | null;
  readonly label: string;
  readonly scanState: WalletScanState;
}

export interface WalletAddressStore {
  get(providerConnectionId: string): Promise<WalletAddressRecord | null>;
  put(record: WalletAddressRecord): Promise<void>;
  updateScanState(providerConnectionId: string, scanState: WalletScanState): Promise<void>;
  delete(providerConnectionId: string): Promise<void>;
}
