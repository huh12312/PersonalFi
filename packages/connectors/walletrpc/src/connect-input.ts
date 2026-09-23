// SPDX-License-Identifier: MIT
/**
 * `connect()`'s input parser — the **only input seam** this connector has.
 *
 * `assertNoPrivateMaterial` runs first, on the raw string, before this
 * function does anything else with it: before it is matched against a chain's
 * schema, before it is stored, before it is logged. That ordering is the
 * refusal seam docs/evidence/phase-3/wp3.6-walletrpc.md proves with a grep and
 * a sabotage: there is no path through this file that reaches
 * `btc/derive.ts` or `eth/address.ts` — let alone a store or a log line —
 * without going through `guard.ts` first.
 */
import { ConnectorError } from '@connector/port';
import { parseAccountKey } from './btc/derive.ts';
import { parseEthAddress } from './eth/address.ts';
import { assertNoPrivateMaterial } from './guard.ts';
import { WALLETRPC_CHAINS, type WalletChain } from './provider.ts';
import type { BipScheme } from './btc/scheme.ts';

export interface WalletRpcConnectInput {
  readonly chain: WalletChain;
  readonly value: string;
  readonly label: string;
}

export interface ParsedConnectInput {
  readonly chain: WalletChain;
  readonly descriptor: string;
  readonly derivationScheme: BipScheme | null;
  readonly label: string;
}

export function parseConnectInput(input: unknown): ParsedConnectInput {
  if (typeof input !== 'object' || input === null) {
    throw invalid(['input']);
  }
  const record = input as Record<string, unknown>;
  const chain = record['chain'];
  const value = record['value'];
  const label = record['label'];

  const problems: string[] = [];
  if (typeof chain !== 'string' || !WALLETRPC_CHAINS.includes(chain as WalletChain)) {
    problems.push('chain');
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    problems.push('value');
  }
  if (label !== undefined && typeof label !== 'string') {
    problems.push('label');
  }
  if (problems.length > 0) throw invalid(problems);

  const chainValue = chain as WalletChain;
  const valueString = value as string;

  // The refusal seam. Runs before any chain-specific parsing, logging, or
  // storage — see this file's header.
  assertNoPrivateMaterial(valueString, 'value');

  if (chainValue === 'bitcoin') {
    const account = parseAccountKey(valueString); // throws invalid_input on a bad prefix/decode
    return {
      chain: chainValue,
      descriptor: valueString.trim(),
      derivationScheme: account.scheme,
      label: typeof label === 'string' ? label : `Bitcoin wallet (${account.scheme})`,
    };
  }

  const address = parseEthAddress(valueString);
  return {
    chain: chainValue,
    descriptor: address,
    derivationScheme: null,
    label: typeof label === 'string' ? label : 'Ethereum wallet',
  };
}

function invalid(fields: readonly string[]): ConnectorError {
  return new ConnectorError(
    'a wallet connection needs { chain: "bitcoin" | "ethereum", value: "<xpub/ypub/zpub or 0x address>" }',
    { kind: 'invalid_input', condition: 'CONFIG_ERROR', redactedContext: { fields: [...fields] } },
  );
}
