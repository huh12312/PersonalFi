// SPDX-License-Identifier: MIT
/**
 * xpub/ypub/zpub parsing, local address derivation, and gap-limit scanning.
 *
 * Everything here operates on a **public** extended key only. `HDKey` is
 * constructed exclusively via `HDKey.fromExtendedKey`, never
 * `HDKey.fromMasterSeed` — that call does not appear anywhere in this package,
 * which is one of the two grep-provable claims in
 * `docs/evidence/phase-3/wp3.6-walletrpc.md` ("no `HDKey.fromMasterSeed`, no
 * private-key field"). `guard.ts`'s `assertNoPrivateMaterial` runs before any
 * string reaches this file at all (see `connect-input.ts`).
 *
 * ## Why no BIP32 hardened derivation happens here
 *
 * The three prefixes carry an **account-level** extended public key — depth 3,
 * `m/purpose'/0'/0'` already applied by whatever wallet exported it. A public
 * key can only derive *unhardened* children (`HDKey.deriveChild` throws
 * "Could not derive hardened child key" without a private key, which is by
 * construction the only key this file ever holds), so the remaining path is
 * always `<chain>/<index>` — chain `0` for receiving addresses, `1` for
 * change — which is exactly BIP44/49/84's own account-extended-key contract.
 */
import { HDKey } from '@scure/bip32';
import { ConnectorError } from '@connector/port';
import { p2pkhAddressOf, p2shP2wpkhAddressOf, p2wpkhAddressOf } from './address.ts';
import { xpubPrefixOf, type BipScheme } from './scheme.ts';

/** BIP44's own gap limit. Neither BIP49 nor BIP84 states a different one. */
export const GAP_LIMIT = 20;

export const ADDRESS_CHAINS = ['external', 'internal'] as const;
export type AddressChain = (typeof ADDRESS_CHAINS)[number];

const CHAIN_INDEX: Readonly<Record<AddressChain, number>> = { external: 0, internal: 1 };

export interface ParsedAccountKey {
  readonly scheme: BipScheme;
  readonly addressAt: (chain: AddressChain, index: number) => string;
}

/**
 * Parse an xpub/ypub/zpub into a scheme and an address-derivation function.
 *
 * Throws `ConnectorError{kind:'invalid_input'}` for anything that is not one
 * of the three recognised mainnet prefixes, or that fails to decode as a
 * BIP32 extended public key of that prefix's version. This is the second,
 * structural line of defence `scheme.ts`'s header describes: even a string
 * that slipped past `guard.ts` (it should not) would fail here with a version
 * mismatch rather than ever reaching `HDKey` as a private key, because the
 * `versions.public` passed below is the *only* version this call will accept.
 */
export function parseAccountKey(value: string): ParsedAccountKey {
  const trimmed = value.trim();
  const prefix = xpubPrefixOf(trimmed);
  if (prefix === null) {
    throw new ConnectorError(
      `"${trimmed.slice(0, 4)}…" is not a recognised extended public key prefix. This connector ` +
        'accepts mainnet xpub (BIP44), ypub (BIP49) or zpub (BIP84) account keys only.',
      {
        kind: 'invalid_input',
        condition: 'CONFIG_ERROR',
        redactedContext: { prefixSeen: trimmed.slice(0, 4) },
      },
    );
  }

  let account: HDKey;
  try {
    account = HDKey.fromExtendedKey(trimmed, prefix.versions);
  } catch (cause) {
    throw new ConnectorError(
      `could not parse this ${prefix.prefix} as a BIP32 extended public key: ${messageOf(cause)}`,
      {
        kind: 'invalid_input',
        condition: 'CONFIG_ERROR',
        cause,
        redactedContext: { scheme: prefix.scheme },
      },
    );
  }

  if (account.publicKey === null || account.privateKey !== null) {
    // Unreachable given `versions` above always selects the public half, but
    // stated and checked rather than assumed: this is the one place a defect
    // in the version check would surface, and it must fail loudly rather than
    // silently derive from a private key it should never have.
    throw new ConnectorError(
      'refusing to derive: the parsed key carries private material or no public key at all',
      { kind: 'invalid_input', condition: 'CONFIG_ERROR' },
    );
  }

  return {
    scheme: prefix.scheme,
    addressAt: (chain, index) => addressFor(prefix.scheme, account, chain, index),
  };
}

function addressFor(scheme: BipScheme, account: HDKey, chain: AddressChain, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`address index must be a non-negative integer, got ${String(index)}`);
  }
  const child = account.derive(`m/${String(CHAIN_INDEX[chain])}/${String(index)}`);
  const pubkey = child.publicKey;
  if (pubkey === null) {
    throw new Error('derived child carries no public key');
  }
  switch (scheme) {
    case 'bip44':
      return p2pkhAddressOf(pubkey);
    case 'bip49':
      return p2shP2wpkhAddressOf(pubkey);
    case 'bip84':
      return p2wpkhAddressOf(pubkey);
  }
}

// ---------------------------------------------------------------------------
// Gap-limit scanning
// ---------------------------------------------------------------------------

export interface ActivityCheck {
  /** `true` when the address has ever appeared in a transaction. */
  (address: string, chain: AddressChain, index: number): Promise<boolean>;
}

export interface ScanResult {
  readonly chain: AddressChain;
  /** Every address checked, in order. Length is bounded by `gapLimit` past the last used one. */
  readonly checked: readonly {
    readonly address: string;
    readonly index: number;
    readonly used: boolean;
  }[];
  /** Highest index with observed activity, or `null` if the chain is entirely empty. */
  readonly highestUsedIndex: number | null;
}

/**
 * Scan one chain (external or internal) from `startIndex`, stopping after
 * `gapLimit` consecutive addresses with no activity.
 *
 * This derives addresses strictly in order and awaits each activity check
 * before deriving the next, so `checked.length` is an exact, observable count
 * — the property `'derivation stops at the gap limit of 20 empty addresses'`
 * asserts directly against a fake `checkActivity` that always answers `false`.
 */
export async function scanChain(
  account: ParsedAccountKey,
  chain: AddressChain,
  checkActivity: ActivityCheck,
  options: { readonly startIndex?: number; readonly gapLimit?: number } = {},
): Promise<ScanResult> {
  const gapLimit = options.gapLimit ?? GAP_LIMIT;
  const startIndex = options.startIndex ?? 0;

  const checked: { address: string; index: number; used: boolean }[] = [];
  let consecutiveEmpty = 0;
  let highestUsedIndex: number | null = null;
  let index = startIndex;

  while (consecutiveEmpty < gapLimit) {
    const address = account.addressAt(chain, index);
    const used = await checkActivity(address, chain, index);
    checked.push({ address, index, used });
    if (used) {
      highestUsedIndex = index;
      consecutiveEmpty = 0;
    } else {
      consecutiveEmpty += 1;
    }
    index += 1;
  }

  return { chain, checked, highestUsedIndex };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
