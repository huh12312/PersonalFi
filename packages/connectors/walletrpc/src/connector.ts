// SPDX-License-Identifier: MIT
/**
 * `WalletRpcConnector` — watch-only BTC (xpub/ypub/zpub) and ETH (address).
 *
 * ## "No key material exists, therefore none can leak" — enforced, not promised
 *
 * 08 §2.6 states the property; this class is what makes it true structurally
 * rather than by policy:
 *
 *   * **The only input seam is `connect()`**, and `parseConnectInput` runs
 *     `assertNoPrivateMaterial` before anything else touches the string
 *     (`connect-input.ts`, `guard.ts`).
 *   * **There is no signing primitive imported anywhere in this package.**
 *     `grep -rn "sign(" packages/connectors/walletrpc/src` finds exactly
 *     `HDKey.sign`'s *type declaration* inside `@scure/bip32` itself — never
 *     called from this package's own code — and nothing else.
 *   * **`HDKey.fromMasterSeed` does not appear anywhere in this package.**
 *     Every `HDKey` this connector ever constructs comes from
 *     `HDKey.fromExtendedKey` called with a **public**-only `versions` pair
 *     (`btc/scheme.ts`), so even a defect in the string-level refusal could not
 *     produce a signing-capable key — see `btc/derive.ts`'s header for the
 *     second line of defence this is.
 *   * **No credential is stored.** `connect()` returns `credentials: {}`: an
 *     xpub or an address is not a secret Ledger has to protect, so nothing
 *     here is ever sealed with `SecretBox`, and there is no path by which one
 *     could be.
 *
 * ## Why every non-zero balance surfaces as `DATA_UNAVAILABLE`
 *
 * This connector has no price source. `ProviderBalanceFact.current` and
 * `ProviderHoldingFact.value` are `Money` — a *fiat* amount, `@core/kernel`'s
 * `CurrencyCode` defaulting to two decimal places, structurally incapable of
 * holding a native BTC/ETH quantity without ruinous precision loss — so
 * reporting either for a real balance would require a USD price, which this
 * connector does not fetch (01 §3.5's two hosts, Esplora and Etherscan, quote
 * neither). 08 §2.2: "an honest adapter never reports $0.00 for an unpriced
 * asset." So a **non-zero** on-chain balance raises a named
 * `DATA_UNAVAILABLE` naming the asset — exactly `CoinbaseConnector`'s
 * `#pricesFor` failure mode — and only a **literal zero** balance is reported,
 * because zero is true in every currency without needing a price at all. A
 * real fiat valuation for these balances is WP 3.4's `PriceSource` plus the
 * resolver's `security_id` join, joining downstream of this connector rather
 * than inside it.
 */
import {
  ConnectorError,
  assertSupports,
  emptyPage,
  type ConnectResult,
  type ConnectionHandle,
  type Connector,
  type ConnectorCapabilities,
  type Cursor,
  type ProviderAccountFact,
  type ProviderBalanceFact,
  type ProviderHoldingFact,
  type SyncOptions,
  type TransactionPage,
  securityIdentifierOf,
} from '@connector/port';
import { Money, newId, type Clock } from '@core/kernel';
import { parseAccountKey, scanChain } from './btc/derive.ts';
import { createEsploraClient, type EsploraTransport } from './btc/esplora.ts';
import { ETH_NATIVE_SENTINEL_CONTRACT } from './eth/address.ts';
import { createEtherscanClient, type EtherscanTransport } from './eth/etherscan.ts';
import type { EtherscanApiKey } from './eth/api-key.ts';
import { parseConnectInput } from './connect-input.ts';
import {
  WALLETRPC_MANIFEST,
  WALLETRPC_PROVIDER,
  walletRpcCapabilities,
  type WalletChain,
} from './provider.ts';
import { EMPTY_SCAN_STATE, type WalletAddressRecord, type WalletAddressStore } from './store.ts';
import { formatUnits } from './units.ts';

const SATOSHI_DECIMALS = 8;
const WEI_DECIMALS = 18;
const BITCOIN_NATIVE_CONTRACT = 'native';

export interface WalletRpcLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

const silentLogger: WalletRpcLogger = { warn: () => undefined };

export interface WalletRpcConnectorOptions {
  readonly store: WalletAddressStore;
  readonly esploraTransport: EsploraTransport;
  readonly etherscanTransport: EtherscanTransport;
  readonly etherscanApiKey: EtherscanApiKey;
  readonly clock: Clock;
  readonly logger?: WalletRpcLogger;
}

export class WalletRpcConnector implements Connector {
  readonly provider = WALLETRPC_PROVIDER;
  readonly displayName = WALLETRPC_MANIFEST.displayName;
  readonly #store: WalletAddressStore;
  readonly #esploraTransport: EsploraTransport;
  readonly #etherscanTransport: EtherscanTransport;
  readonly #etherscanApiKey: EtherscanApiKey;
  readonly #clock: Clock;
  readonly #logger: WalletRpcLogger;

  constructor(options: WalletRpcConnectorOptions) {
    this.#store = options.store;
    this.#esploraTransport = options.esploraTransport;
    this.#etherscanTransport = options.etherscanTransport;
    this.#etherscanApiKey = options.etherscanApiKey;
    this.#clock = options.clock;
    this.#logger = options.logger ?? silentLogger;
  }

  capabilities(): ConnectorCapabilities {
    return walletRpcCapabilities();
  }

  async connect(input: unknown): Promise<ConnectResult> {
    const parsed = parseConnectInput(input);
    const providerConnectionId = newId();
    const record: WalletAddressRecord = {
      providerConnectionId,
      chain: parsed.chain,
      descriptor: parsed.descriptor,
      derivationScheme: parsed.derivationScheme,
      label: parsed.label,
      scanState: EMPTY_SCAN_STATE,
    };
    await this.#store.put(record);

    return {
      providerConnectionId,
      displayName: parsed.label,
      // Nothing here is a secret: an xpub or an address needs no SecretBox
      // envelope. See this class's header.
      credentials: {},
      accounts: [accountFactOf(record)],
      observedCapabilities: null,
      consentExpiresAt: null,
    };
  }

  async listAccounts(handle: ConnectionHandle): Promise<readonly ProviderAccountFact[]> {
    const record = await this.#recordFor(handle);
    return [accountFactOf(record)];
  }

  /** Trivial and terminal — see this file's header and `provider.ts`. */
  async syncTransactions(
    handle: ConnectionHandle,
    cursor: Cursor | null,
    _options: SyncOptions,
  ): Promise<TransactionPage> {
    await this.#recordFor(handle); // asserts the connection has not been disconnected
    return emptyPage(cursor);
  }

  async syncBalances(
    handle: ConnectionHandle,
    options: SyncOptions,
  ): Promise<readonly ProviderBalanceFact[]> {
    assertSupports(this.provider, this.capabilities(), 'balances');
    const record = await this.#recordFor(handle);
    const quantity = await this.#nativeQuantityOf(record);
    const asOf = options.clock.now();

    if (quantity.minorUnits === 0n) {
      return [
        {
          providerAccountId: record.providerConnectionId,
          current: Money.zero('USD'),
          available: null,
          limit: null,
          asOf,
        },
      ];
    }

    throw this.#unpriced(record, quantity.decimal);
  }

  async syncHoldings(
    handle: ConnectionHandle,
    _options: SyncOptions,
  ): Promise<readonly ProviderHoldingFact[]> {
    assertSupports(this.provider, this.capabilities(), 'holdings');
    const record = await this.#recordFor(handle);
    const quantity = await this.#nativeQuantityOf(record);

    // A literal zero is not a position: nothing to report, honestly (mirrors
    // CoinbaseConnector's `syncHoldings`, which skips a zero balance rather
    // than emitting a holding worth nothing).
    if (quantity.minorUnits === 0n) return [];

    throw this.#unpriced(record, quantity.decimal);
  }

  async disconnect(handle: ConnectionHandle): Promise<void> {
    await this.#store.delete(handle.providerConnectionId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #recordFor(handle: ConnectionHandle): Promise<WalletAddressRecord> {
    const record = await this.#store.get(handle.providerConnectionId);
    if (record === null) {
      throw new ConnectorError(
        'this connection has no wallet on record — it may have been disconnected',
        {
          kind: 'invalid_input',
          condition: 'CONFIG_ERROR',
          redactedContext: { connectionId: handle.connectionId },
        },
      );
    }
    return record;
  }

  async #nativeQuantityOf(
    record: WalletAddressRecord,
  ): Promise<{ readonly minorUnits: bigint; readonly decimal: string }> {
    if (record.chain === 'bitcoin') {
      const sats = await this.#bitcoinBalanceSats(record);
      return { minorUnits: sats, decimal: formatUnits(sats, SATOSHI_DECIMALS) };
    }
    const wei = await this.#etherscanClient().nativeBalanceWei(record.descriptor);
    return { minorUnits: wei, decimal: formatUnits(wei, WEI_DECIMALS) };
  }

  async #bitcoinBalanceSats(record: WalletAddressRecord): Promise<bigint> {
    const account = parseAccountKey(record.descriptor);
    const esplora = this.#esploraClient();

    let total = 0n;
    let externalHighest = record.scanState.externalHighestUsedIndex;
    let internalHighest = record.scanState.internalHighestUsedIndex;

    for (const chain of ['external', 'internal'] as const) {
      const result = await scanChain(account, chain, (address) => esplora.hasActivity(address));
      for (const entry of result.checked) {
        if (!entry.used) continue;
        const activity = await esplora.addressActivity(entry.address);
        total += activity.balanceSats;
      }
      if (result.highestUsedIndex !== null) {
        if (chain === 'external') externalHighest = result.highestUsedIndex;
        else internalHighest = result.highestUsedIndex;
      }
    }

    await this.#store.updateScanState(record.providerConnectionId, {
      externalHighestUsedIndex: externalHighest,
      internalHighestUsedIndex: internalHighest,
    });

    return total;
  }

  #esploraClient() {
    return createEsploraClient({ transport: this.#esploraTransport });
  }

  #etherscanClient() {
    return createEtherscanClient({
      transport: this.#etherscanTransport,
      apiKey: this.#etherscanApiKey,
    });
  }

  #unpriced(record: WalletAddressRecord, quantityDecimal: string): ConnectorError {
    const asset = record.chain === 'bitcoin' ? 'BTC' : 'ETH';
    // The identifier travels even into the failure path: once WP 3.4 supplies
    // a price for this security_id, whatever consumes this error's context has
    // the same chain_contract a priced fact would have carried.
    const security = nativeSecurityIdentifierOf(record.chain);
    this.#logger.warn(
      { provider: WALLETRPC_PROVIDER, chain: record.chain, asOf: this.#clock.now().toISOString() },
      `a non-zero ${asset} balance has no price source and is being reported as unavailable, not $0.00`,
    );
    return ConnectorError.fromCondition(
      'DATA_UNAVAILABLE',
      `this wallet holds ${quantityDecimal} ${asset} but this connector has no price source — ` +
        'reported as unavailable rather than as $0.00. A position worth $0.00 disappears from net ' +
        'worth silently, which is the one outcome an honest adapter must not produce (08 §2.2).',
      { redactedContext: { chain: record.chain, asset, security } },
    );
  }
}

function accountFactOf(record: WalletAddressRecord): ProviderAccountFact {
  return {
    providerAccountId: record.providerConnectionId,
    name: record.label,
    officialName: null,
    type: 'crypto',
    subtype: record.chain,
    currency: 'USD',
    mask: null,
    closed: false,
    capabilities: ['balances', 'holdings'],
  };
}

/**
 * The identifier the resolver merges onto `security_id` (WP 3.1, jointly with
 * WP 3.5). A native coin is reported as a `chain_contract` naming the
 * sentinel address `@ctx/investments`'s `NATIVE_ASSETS` table recognises for
 * that chain — `ETH_NATIVE_SENTINEL_CONTRACT` for Ethereum, the literal
 * string `'native'` for Bitcoin (bitcoin's own entry in that table has no EVM
 * sentinel address to canonicalise, only the string `'native'`) — never a
 * bare ticker, and never this connector's own opaque id. See
 * `one-security.test.ts` and evidence §5 for the worked proof.
 */
export function nativeSecurityIdentifierOf(chain: WalletChain) {
  if (chain === 'ethereum') {
    return securityIdentifierOf('chain_contract', ETH_NATIVE_SENTINEL_CONTRACT, {
      chain: 'ethereum',
    });
  }
  return securityIdentifierOf('chain_contract', BITCOIN_NATIVE_CONTRACT, { chain: 'bitcoin' });
}
