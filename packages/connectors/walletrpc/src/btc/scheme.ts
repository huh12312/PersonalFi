// SPDX-License-Identifier: MIT
/**
 * The three BIP32 extended-public-key prefixes this connector accepts, and
 * nothing else. Mainnet only — a `tpub`/`upub`/`vpub` testnet key is refused by
 * `parseAccountKey` (`derive.ts`) with the same message as any other
 * unrecognised prefix, because a watch-only *personal-finance* wallet has no
 * legitimate reason to watch a testnet address.
 *
 * `HDKey.fromExtendedKey` takes a `{ private, public }` version pair and
 * refuses to decode unless the payload's own 4-byte version matches whichever
 * half applies (`@scure/bip32`'s `fromExtendedKey`: `if (version !==
 * versions[isPriv ? 'private' : 'public']) throw`). The `private` half here is
 * therefore not a convenience default — it is what makes an `xprv`/`yprv`/
 * `zprv` string decode to a version mismatch instead of a private key, as a
 * second, structural line of defence behind the string-prefix refusal in
 * `no-private-material.ts`, which runs first and is this package's actual
 * refusal seam.
 */
import type { Versions } from '@scure/bip32';

export const BIP_SCHEMES = ['bip44', 'bip49', 'bip84'] as const;
export type BipScheme = (typeof BIP_SCHEMES)[number];

export interface XpubPrefix {
  readonly prefix: string;
  readonly scheme: BipScheme;
  readonly versions: Versions;
  /** BIP44 §"Coin type" account path: `m / purpose' / 0' / 0'` (mainnet BTC). */
  readonly purpose: number;
}

/** Mainnet public/private version pairs, BIP32/49/84. */
export const XPUB_PREFIXES: readonly XpubPrefix[] = Object.freeze([
  {
    prefix: 'xpub',
    scheme: 'bip44',
    versions: { public: 0x0488b21e, private: 0x0488ade4 },
    purpose: 44,
  },
  {
    prefix: 'ypub',
    scheme: 'bip49',
    versions: { public: 0x049d7cb2, private: 0x049d7878 },
    purpose: 49,
  },
  {
    prefix: 'zpub',
    scheme: 'bip84',
    versions: { public: 0x04b24746, private: 0x04b2430c },
    purpose: 84,
  },
]);

export function xpubPrefixOf(value: string): XpubPrefix | null {
  const prefix = value.slice(0, 4);
  return XPUB_PREFIXES.find((candidate) => candidate.prefix === prefix) ?? null;
}
