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
 * ## Holdings: an unvalued quantity, never a fabricated zero (Phase 3 gate C-2)
 *
 * This connector has no price source (01 §3.5's two hosts, Esplora and
 * Etherscan, quote neither). Through the Phase 3 gate a non-zero balance
 * raised `DATA_UNAVAILABLE` on **both** `syncBalances` and `syncHoldings`,
 * which meant a funded watch-only wallet could never become a holding at all
 * (`docs/evidence/phase-3/gate-security-review.md` G3-14) — the "downstream"
 * valuation WP 3.6 deferred to WP 3.4's price ladder was never actually
 * wired, because there was no fact for the ladder to join against.
 *
 * `syncHoldings` now reports the real on-chain **quantity** with `value:
 * null` — `@connector/port`'s `ProviderHoldingFact.value` is `Money | null`
 * precisely for this case (see its doc comment): `null` states "this
 * provider has no fiat quote for it", which is a different claim from a
 * fabricated `$0.00` and a different claim from the position not existing.
 * `costBasis` is `null` for the same pre-existing reason (WP 3.6, this
 * connector never had a basis to report). The security this quantity is
 * *in* still carries the chain's native-asset `chain_contract` identifier
 * (`nativeSecurityIdentifierOf`), so the resolver still merges it onto the
 * same `security_id` a Coinbase sighting of the same asset would use
 * (`one-security.test.ts`), and once resolved, `@ctx/investments`' holdings
 * pipeline values it from WP 3.4's price ladder exactly as every other
 * holding is valued — `institutionValue` (this fact's `value`) is never read
 * for market value or allocation; only `PriceReader` is. See
 * `docs/evidence/phase-4/wp4.12a-gate-conditions.md` C-2 for the traced path
 * and the alternative (widening `Money` itself) that was rejected.
 *
 * **`syncBalances` is unchanged and still raises `DATA_UNAVAILABLE` for a
 * non-zero balance.** `ProviderBalanceFact.current` is `Money`, not `Money |
 * null` — it is `@ctx/ledger`'s own account balance, which has no downstream
 * ladder join at all (a checking account's balance is definitional, not
 * priced), so there is nowhere for an unvalued balance to be rescued the way
 * an unvalued holding now is. This is a deliberate, documented residual:
 * `@ctx/planning`'s `INTERPOLATION_POLICY` values an `investment`-kind
 * account (which is how a crypto wallet's account is classified) from
 * `quantity × price` over its **holdings**, never from `accounts.balance`
 * (`packages/contexts/planning/src/interpolate.ts`), so net worth and
 * allocation are unaffected by this connector's balance leg staying
 * unpriced — only this specific account's own ledger-balance figure (an
 * operational display, not a security boundary) does, and its sync leg will
 * keep retrying and failing for a funded wallet. Widening
 * `ProviderBalanceFact.current` the same way would touch every adapter and
 * every ledger consumer for a display-only field with no ladder to join
 * against; out of scope for this condition — recorded for WP 4.12b.
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
  type ProviderSecurityFact,
  type SyncOptions,
  type TransactionPage,
  securityFingerprintOf,
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
    options: SyncOptions,
  ): Promise<readonly ProviderHoldingFact[]> {
    assertSupports(this.provider, this.capabilities(), 'holdings');
    const record = await this.#recordFor(handle);
    const quantity = await this.#nativeQuantityOf(record);

    // A literal zero is not a position: nothing to report, honestly (mirrors
    // CoinbaseConnector's `syncHoldings`, which skips a zero balance rather
    // than emitting a holding worth nothing).
    if (quantity.minorUnits === 0n) return [];

    // See this file's header (C-2): a real quantity, no fiat value — never a
    // fabricated zero, and never a refusal that hides the position entirely.
    return [
      {
        providerAccountId: record.providerConnectionId,
        security: nativeSecurityFactOf(record.chain),
        quantity: quantity.decimal,
        costBasis: null,
        value: null,
        asOf: options.clock.now(),
        raw: { chain: record.chain, quantity: quantity.decimal },
      },
    ];
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

  /**
   * `syncBalances`' failure path only — see this file's header (C-2) for why
   * `syncHoldings` no longer calls this: a holding now reports its quantity
   * with `value: null` instead of refusing, but a ledger balance has no
   * downstream ladder to rescue it, so it still refuses here.
   */
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

/**
 * The whole `ProviderSecurityFact` a holding needs — `nativeSecurityIdentifierOf`
 * wrapped with the `name`/`type` a resolved security carries, exactly as
 * `@connector/coinbase`'s own `securityFactOf` wraps its ticker identifier
 * (WP 3.7a's whole-fact rule: `ProviderHoldingFact.security` is the whole
 * fact so an adapter never has to pick one name out of several). This
 * connector only ever states one identifier for a native asset, so the set
 * has one member either way — what matters is that `type: 'cryptocurrency'`
 * and a display name ride along with it, the same reason Coinbase's own
 * comment gives.
 *
 * `providerSecurityId` is this connector's own opaque id for the asset — not
 * a real provider id (there is no provider account for a native coin the way
 * Coinbase has a wallet uuid), but evidence, never identity, exactly like
 * every other adapter's (`facts.ts`'s `ProviderSecurityFact` doc comment).
 */
function nativeSecurityFactOf(chain: WalletChain): ProviderSecurityFact {
  const identifiers = [nativeSecurityIdentifierOf(chain)];
  const symbol = chain === 'ethereum' ? 'ETH' : 'BTC';
  return {
    providerSecurityId: `${WALLETRPC_PROVIDER}:${chain}:native`,
    identifiers,
    name: symbol,
    type: 'cryptocurrency',
    subtype: null,
    // No fiat quote of its own — see this file's header. `null` here is the
    // same "the provider does not say" the port's own doc comment states for
    // `currency`, never a guessed 'USD'.
    currency: null,
    isCashEquivalent: null,
    closePrice: null,
    closePriceAsOf: null,
    raw: { chain },
    fingerprint: securityFingerprintOf(identifiers),
  };
}
