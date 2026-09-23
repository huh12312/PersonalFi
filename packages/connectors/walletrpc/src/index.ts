// SPDX-License-Identifier: MIT
/**
 * `@connector/walletrpc` — watch-only Bitcoin (xpub/ypub/zpub) and Ethereum
 * (address) connector. See `connector.ts` for the security argument and
 * `docs/evidence/phase-3/wp3.6-walletrpc.md` for the full write-up.
 */
export { WalletRpcConnector, nativeSecurityIdentifierOf } from './connector.ts';
export type { WalletRpcConnectorOptions, WalletRpcLogger } from './connector.ts';

export {
  WALLETRPC_CHAINS,
  WALLETRPC_MANIFEST,
  WALLETRPC_PROVIDER,
  walletRpcCapabilities,
  type WalletChain,
} from './provider.ts';

export type { WalletAddressRecord, WalletAddressStore, WalletScanState } from './store.ts';
export { EMPTY_SCAN_STATE } from './store.ts';

export { assertNoPrivateMaterial, classifyPrivateMaterial } from './guard.ts';
export type { PrivateMaterialKind } from './guard.ts';

export { parseConnectInput } from './connect-input.ts';
export type { ParsedConnectInput, WalletRpcConnectInput } from './connect-input.ts';

export { BIP_SCHEMES, XPUB_PREFIXES, xpubPrefixOf, type BipScheme } from './btc/scheme.ts';
export { GAP_LIMIT, parseAccountKey, scanChain, type AddressChain } from './btc/derive.ts';
export {
  ESPLORA_HOST,
  createEsploraClient,
  type EsploraTransport,
  type EsploraRequest,
  type EsploraHttpResponse,
} from './btc/esplora.ts';

export { isEthAddress, parseEthAddress, ETH_NATIVE_SENTINEL_CONTRACT } from './eth/address.ts';
export {
  ETHERSCAN_HOST,
  ETHEREUM_MAINNET_CHAIN_ID,
  createEtherscanClient,
  type EtherscanTransport,
  type EtherscanRequest,
  type EtherscanHttpResponse,
} from './eth/etherscan.ts';
export { etherscanApiKeyOf, missingEtherscanApiKey, type EtherscanApiKey } from './eth/api-key.ts';
