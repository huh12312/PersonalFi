// SPDX-License-Identifier: MIT
/**
 * RIPEMD-160, from scratch.
 *
 * Bitcoin's `HASH160 = RIPEMD160(SHA256(pubkey))` is how every P2PKH, P2SH and
 * P2WPKH address is built (BIP44/49/84 all bottom out here), and `sha256` is
 * available from `@core/secretbox`, but RIPEMD-160 is not exported by anything
 * on this package's dependency list. `@scure/bip32` carries it transitively
 * through `@noble/hashes`, but `@noble/hashes` is not a declared dependency of
 * `package.json` — which this work package is not permitted to edit — and pnpm's
 * isolated `node_modules` does not resolve an undeclared package even when it
 * happens to be on disk for a sibling. Vendoring one pure function is the
 * honest alternative to a phantom import that would work on this machine and
 * nowhere else.
 *
 * This is the reference algorithm (Dobbertin, Bosselaers, Preneel 1996),
 * transcribed directly from its specification — five rounds of two parallel
 * 16-step lines over five 32-bit words, non-linear function `f0..f4`, the
 * message-word permutations `ZL`/`ZR` and rotation amounts `SL`/`SR`, standard
 * MD-style length-padding. It is verified against all three of RFC-independent
 * RIPEMD-160's own published test vectors in `ripemd160.test.ts` — the empty
 * string, `'abc'`, and `'message digest'` — which is what makes this a checked
 * transcription rather than an assertion.
 */

const ZL = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2,
  14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4, 13, 3,
  7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
];

const ZR = [
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4,
  9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2,
  13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
];

const SL = [
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9,
  11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9,
  8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
];

const SR = [
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7,
  6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6,
  14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
];

const KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
const KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function f(round: number, x: number, y: number, z: number): number {
  switch (round) {
    case 0:
      return (x ^ y ^ z) >>> 0;
    case 1:
      return ((x & y) | (~x & z)) >>> 0;
    case 2:
      return ((x | ~y) ^ z) >>> 0;
    case 3:
      return ((x & z) | (y & ~z)) >>> 0;
    default:
      return (x ^ (y | ~z)) >>> 0;
  }
}

/** Pad to a multiple of 64 bytes: 0x80, zeros, then the 64-bit little-endian bit length. */
function pad(message: Uint8Array): Uint8Array {
  const bitLength = BigInt(message.length) * 8n;
  // One byte for 0x80, then zeros until length % 64 === 56, then 8 bytes of length.
  const withOneBit = message.length + 1;
  const zerosNeeded = (((56 - (withOneBit % 64)) % 64) + 64) % 64;
  const total = withOneBit + zerosNeeded + 8;

  const out = new Uint8Array(total);
  out.set(message, 0);
  out[message.length] = 0x80;
  const view = new DataView(out.buffer);
  view.setUint32(out.length - 8, Number(bitLength & 0xffffffffn), true);
  view.setUint32(out.length - 4, Number((bitLength >> 32n) & 0xffffffffn), true);
  return out;
}

/** RIPEMD-160 over raw bytes. Returns a 20-byte digest. */
export function ripemd160(message: Uint8Array): Uint8Array {
  const padded = pad(message);
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const x = new Int32Array(16);

  for (let block = 0; block < padded.length / 64; block += 1) {
    const base = block * 64;
    for (let word = 0; word < 16; word += 1) {
      x[word] = view.getUint32(base + word * 4, true);
    }

    let al = h0;
    let bl = h1;
    let cl = h2;
    let dl = h3;
    let el = h4;
    let ar = h0;
    let br = h1;
    let cr = h2;
    let dr = h3;
    let er = h4;

    for (let j = 0; j < 80; j += 1) {
      const round = Math.floor(j / 16);
      const rroundFn = 4 - round;

      const tl =
        (rotl(
          (al + f(round, bl, cl, dl) + (x[ZL[j] as number] as number) + KL[round]!) | 0,
          SL[j]!,
        ) +
          el) |
        0;
      al = el;
      el = dl;
      dl = rotl(cl, 10);
      cl = bl;
      bl = tl >>> 0;

      const tr =
        (rotl(
          (ar + f(rroundFn, br, cr, dr) + (x[ZR[j] as number] as number) + KR[round]!) | 0,
          SR[j]!,
        ) +
          er) |
        0;
      ar = er;
      er = dr;
      dr = rotl(cr, 10);
      cr = br;
      br = tr >>> 0;
    }

    const t = (h1 + cl + dr) | 0;
    h1 = (h2 + dl + er) | 0;
    h2 = (h3 + el + ar) | 0;
    h3 = (h4 + al + br) | 0;
    h4 = (h0 + bl + cr) | 0;
    h0 = t;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0 >>> 0, true);
  outView.setUint32(4, h1 >>> 0, true);
  outView.setUint32(8, h2 >>> 0, true);
  outView.setUint32(12, h3 >>> 0, true);
  outView.setUint32(16, h4 >>> 0, true);
  return out;
}
