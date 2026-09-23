// SPDX-License-Identifier: MIT
/**
 * The refusal seam. **This file is the security control the whole work
 * package exists to prove**: "no key material exists, therefore none can
 * leak" (08 §2.6) is enforced here, at the only place private material could
 * ever enter this connector — the string handed to `connect()` — not promised
 * in a comment somewhere downstream.
 *
 * `assertNoPrivateMaterial` runs **before** `parseConnectInput` does anything
 * else: before the string is stored, before it is logged, before it reaches
 * any network call. Three shapes are refused, each with a different,
 * deterministic recognizer — none of them a fuzzy guess:
 *
 *   1. **WIF** — a base58check payload whose version byte is `0x80` (mainnet)
 *      or `0xef` (testnet) and whose length is 33 or 34 bytes. Decoded and
 *      checked structurally, not pattern-matched on the leading character,
 *      because `5`/`K`/`L`/`9`/`c` prefixes are a mnemonic for humans, not a
 *      security boundary.
 *   2. **`xprv`/`yprv`/`zprv` (and testnet `tprv`/`uprv`/`vprv`)** — a
 *      base58check payload 78 bytes long whose 4-byte version matches a known
 *      *private* extended-key version. `scheme.ts` lists the mainnet triple;
 *      `derive.ts` never constructs an `HDKey` from anything this function has
 *      not already cleared.
 *   3. **A raw 32-byte key** — 64 hex characters, optionally `0x`-prefixed.
 *      There is no legitimate reason for this connector's input (an xpub or an
 *      Ethereum address) to look like this.
 *   4. **A BIP39-shaped mnemonic** — 12, 15, 18, 21 or 24 whitespace-separated
 *      lowercase tokens. Those five counts are BIP39's own closed list of
 *      valid mnemonic lengths, and every English BIP39 word is 3–8 lowercase
 *      ASCII letters, so this refuses every real mnemonic (it may also refuse
 *      unrelated word-salad text, which costs nothing: neither an xpub nor an
 *      Ethereum address ever legitimately contains a space).
 *
 * ## What this function deliberately does not do
 *
 * It does not attempt to be a general "is this secret-shaped" classifier. It
 * recognises exactly the four shapes 08 §2.6 and the dispatch name, refuses
 * them with a typed, non-echoing error, and lets everything else through to
 * the schema-specific parser (`btc/derive.ts`, `eth/address.ts`), which has its
 * own, independent reason to reject a string that is not a valid xpub or
 * address. Layering matters here: even if this function had a gap, `derive.ts`
 * only ever constructs an `HDKey` from a *public* extended-key version (see
 * `scheme.ts`'s header), so there is no path from a private key to a derived
 * address either way.
 */
import { base58check } from '@scure/base';
import { sha256 } from './btc/sha256.ts';
import { ConnectorError } from '@connector/port';

const BASE58CHECK = base58check(sha256);

/** WIF version bytes. Mainnet and testnet, both refused. */
const WIF_VERSIONS = new Set([0x80, 0xef]);

/** The private half of every prefix in `scheme.ts`, plus the testnet triple. */
const PRIVATE_EXTENDED_KEY_VERSIONS = new Set([
  0x0488ade4, // xprv
  0x049d7878, // yprv
  0x04b2430c, // zprv
  0x04358394, // tprv
  0x044a4e28, // uprv
  0x045f18bc, // vprv
]);

const RAW_HEX_KEY_PATTERN = /^(0x)?[0-9a-fA-F]{64}$/;

/** BIP39's own closed list of valid mnemonic word counts. */
const MNEMONIC_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

/** Every BIP39 English word is 3–8 lowercase ASCII letters. */
const MNEMONIC_WORD_SHAPE = /^[a-z]{3,8}$/;

export type PrivateMaterialKind =
  'wif_private_key' | 'extended_private_key' | 'raw_private_key_hex' | 'bip39_mnemonic_shaped';

/**
 * Classify a string as private material, or `null` if it is none of the four
 * recognised shapes. Never throws: a string that merely fails to *decode* as
 * base58check is not private material, it is just not that shape.
 */
export function classifyPrivateMaterial(raw: string): PrivateMaterialKind | null {
  const value = raw.trim();

  if (looksLikeMnemonic(value)) return 'bip39_mnemonic_shaped';
  if (RAW_HEX_KEY_PATTERN.test(value)) return 'raw_private_key_hex';

  const decoded = decodeBase58CheckSafe(value);
  if (decoded !== null) {
    if (decoded.length === 78) {
      const version = readUint32BE(decoded, 0);
      if (PRIVATE_EXTENDED_KEY_VERSIONS.has(version)) return 'extended_private_key';
    }
    if (decoded.length === 33 || decoded.length === 34) {
      if (WIF_VERSIONS.has(decoded[0] as number)) return 'wif_private_key';
    }
  }

  return null;
}

function looksLikeMnemonic(value: string): boolean {
  const words = value.split(/\s+/u).filter((word) => word.length > 0);
  if (!MNEMONIC_WORD_COUNTS.has(words.length)) return false;
  return words.every((word) => MNEMONIC_WORD_SHAPE.test(word));
}

function decodeBase58CheckSafe(value: string): Uint8Array | null {
  try {
    return BASE58CHECK.decode(value);
  } catch {
    return null;
  }
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

/**
 * The refusal itself. Called at the top of `parseConnectInput`, before the
 * string is stored, logged or sent anywhere.
 *
 * The message never echoes the input — only the *kind* of thing it looked
 * like, which is safe to log and is exactly what a user needs to fix their
 * mistake ("you pasted a private key, not an xpub").
 */
export function assertNoPrivateMaterial(raw: string, field: string): void {
  const kind = classifyPrivateMaterial(raw);
  if (kind === null) return;
  throw new ConnectorError(
    `${field} looks like private key material (${describe(kind)}), not a watch-only xpub or ` +
      'address. This connector never accepts, stores or derives from private keys — paste the ' +
      'public xpub/ypub/zpub (for Bitcoin) or the address itself (for Ethereum).',
    {
      kind: 'invalid_input',
      condition: 'CONFIG_ERROR',
      // The kind, never the value: `redactedContext` must not carry the string
      // that triggered this.
      redactedContext: { field, privateMaterialKind: kind },
    },
  );
}

function describe(kind: PrivateMaterialKind): string {
  switch (kind) {
    case 'wif_private_key':
      return 'a WIF-encoded private key';
    case 'extended_private_key':
      return 'an xprv/yprv/zprv extended private key';
    case 'raw_private_key_hex':
      return 'a raw 32-byte private key';
    case 'bip39_mnemonic_shaped':
      return 'a BIP39 seed phrase';
  }
}
