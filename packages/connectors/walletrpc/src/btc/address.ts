// SPDX-License-Identifier: MIT
/**
 * BIP44/49/84 address encoding from a compressed public key.
 *
 * Three schemes, chosen by the xpub/ypub/zpub prefix (`scheme.ts`):
 *
 *   * **BIP44 (`xpub`)** — legacy P2PKH. `base58check(0x00 || hash160(pubkey))`.
 *   * **BIP49 (`ypub`)** — P2SH-wrapped P2WPKH. The witness program
 *     `0x00 0x14 hash160(pubkey)` is itself hashed and wrapped in a P2SH
 *     address: `base58check(0x05 || hash160(witnessProgram))`.
 *   * **BIP84 (`zpub`)** — native segwit P2WPKH. `bech32('bc', 0 || toWords(hash160(pubkey)))`.
 *
 * No private key ever passes through here: every function takes a public key
 * (33-byte compressed, from `HDKey.publicKey`) and returns a string. There is
 * no signing primitive imported anywhere in this file or this package — see
 * `docs/evidence/phase-3/wp3.6-walletrpc.md` for the grep that proves it.
 */
import { base58check, bech32 } from '@scure/base';
import { sha256 } from './sha256.ts';
import { hash160 } from './hash160.ts';

const BASE58CHECK = base58check(sha256);

const P2PKH_VERSION = 0x00;
const P2SH_VERSION = 0x05;
const SEGWIT_HRP = 'bc';

function withVersion(version: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 1);
  out[0] = version;
  out.set(payload, 1);
  return out;
}

/** BIP44: legacy P2PKH, `1...`. */
export function p2pkhAddressOf(pubkey: Uint8Array): string {
  return BASE58CHECK.encode(withVersion(P2PKH_VERSION, hash160(pubkey)));
}

/** BIP49: P2SH-wrapped P2WPKH, `3...`. */
export function p2shP2wpkhAddressOf(pubkey: Uint8Array): string {
  const program = new Uint8Array(22);
  program[0] = 0x00; // witness version 0
  program[1] = 0x14; // push 20 bytes
  program.set(hash160(pubkey), 2);
  return BASE58CHECK.encode(withVersion(P2SH_VERSION, hash160(program)));
}

/** BIP84: native segwit P2WPKH, `bc1...`. */
export function p2wpkhAddressOf(pubkey: Uint8Array): string {
  const program = hash160(pubkey);
  const words = bech32.toWords(program);
  return bech32.encode(SEGWIT_HRP, [0, ...words]);
}
