// SPDX-License-Identifier: MIT
/**
 * SHA-256, from scratch — for the same reason `ripemd160.ts` is: this package
 * is not permitted to edit `package.json`, and `@core/secretbox`'s `sha256`
 * (which `@connector/port`'s own `fingerprint.ts` uses) is not a declared
 * dependency of this package, so it does not resolve under pnpm's isolated
 * `node_modules` — importing it fails at runtime, not merely at lint time.
 *
 * Bitcoin needs SHA-256 twice: once inside `HASH160` (`hash160.ts`) and once
 * as the checksum function `@scure/base`'s `base58check(sha256)` calls
 * internally (which itself double-hashes — this file supplies one round).
 * FIPS 180-4, transcribed directly and checked against the standard's own
 * vectors (`''`, `'abc'`, and the 448-bit two-block vector) in
 * `sha256.test.ts`.
 */

const K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** Pad to a multiple of 64 bytes: 0x80, zeros, then the 64-bit big-endian bit length. */
function pad(message: Uint8Array): Uint8Array {
  const bitLength = BigInt(message.length) * 8n;
  const withOneBit = message.length + 1;
  const zerosNeeded = (((56 - (withOneBit % 64)) % 64) + 64) % 64;
  const total = withOneBit + zerosNeeded + 8;

  const out = new Uint8Array(total);
  out.set(message, 0);
  out[message.length] = 0x80;
  const view = new DataView(out.buffer);
  view.setUint32(out.length - 8, Number((bitLength >> 32n) & 0xffffffffn), false);
  view.setUint32(out.length - 4, Number(bitLength & 0xffffffffn), false);
  return out;
}

export function sha256(message: Uint8Array): Uint8Array {
  const padded = pad(message);
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);

  let [h0, h1, h2, h3, h4, h5, h6, h7] = H0;
  const w = new Int32Array(64);

  for (let block = 0; block < padded.length / 64; block += 1) {
    const base = block * 64;
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(base + t * 4, false);
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] as number;
      const w2 = w[t - 2] as number;
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) | 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) | 0;
      w[t] = (((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) | 0) as number;
    }

    let a = h0 as number;
    let b = h1 as number;
    let c = h2 as number;
    let d = h3 as number;
    let e = h4 as number;
    let f = h5 as number;
    let g = h6 as number;
    let h = h7 as number;

    for (let t = 0; t < 64; t += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) | 0;
      const ch = ((e & f) ^ (~e & g)) | 0;
      const temp1 = (h + s1 + ch + (K[t] as number) + (w[t] as number)) | 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) | 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) | 0;
      const temp2 = (s0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h0 = (h0 as number) + a;
    h1 = (h1 as number) + b;
    h2 = (h2 as number) + c;
    h3 = (h3 as number) + d;
    h4 = (h4 as number) + e;
    h5 = (h5 as number) + f;
    h6 = (h6 as number) + g;
    h7 = (h7 as number) + h;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, index) => {
    outView.setUint32(index * 4, (word as number) >>> 0, false);
  });
  return out;
}
