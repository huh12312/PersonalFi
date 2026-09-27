/* SPDX-License-Identifier: MIT
 *
 * WP 4.5 — reference vectors for src/engine/prng.ts.
 *
 * splitmix64 and xoshiro256++ transcribed from Blackman & Vigna's public-domain
 * (CC0) reference implementations, https://prng.di.unimi.it/splitmix64.c and
 * https://prng.di.unimi.it/xoshiro256plusplus.c. This file is the independent
 * oracle: it is compiled with a C compiler, not run through the engine.
 *
 *   cc -O2 -o /tmp/xoshiro-reference xoshiro-reference.c && /tmp/xoshiro-reference > xoshiro-vectors.json
 */
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>

static uint64_t x; /* splitmix64 state */
static uint64_t splitmix64_next(void) {
  uint64_t z = (x += 0x9e3779b97f4a7c15);
  z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9;
  z = (z ^ (z >> 27)) * 0x94d049bb133111eb;
  return z ^ (z >> 31);
}

static inline uint64_t rotl(const uint64_t v, int k) { return (v << k) | (v >> (64 - k)); }
static uint64_t s[4];
static uint64_t xoshiro_next(void) {
  const uint64_t result = rotl(s[0] + s[3], 23) + s[0];
  const uint64_t t = s[1] << 17;
  s[2] ^= s[0];
  s[3] ^= s[1];
  s[1] ^= s[2];
  s[0] ^= s[3];
  s[2] ^= t;
  s[3] = rotl(s[3], 45);
  return result;
}

static void hex(uint64_t v) { printf("\"%016" PRIx64 "\"", v); }

int main(void) {
  const uint64_t seeds[] = {0u, 1u, 20260910u, 0x7fffffffffffffffu, 0x8000000000000000u /* -2^63 */, 0xffffffffffffffffu /* -1 */};
  const int nseeds = sizeof seeds / sizeof seeds[0];
  printf("{\n  \"generator\": \"xoshiro256++ seeded by splitmix64, Blackman & Vigna reference C\",\n");
  printf("  \"cases\": [\n");
  for (int c = 0; c < nseeds; c++) {
    /* splitmix64 words 0..11 from this seed: path 0 market (0-3), path 0 crypto (4-7), path 1 market (8-11). */
    x = seeds[c];
    uint64_t words[12];
    for (int k = 0; k < 12; k++) words[k] = splitmix64_next();
    printf("    {\n      \"seed\": "); hex(seeds[c]);
    printf(",\n      \"splitmix64\": [");
    for (int k = 0; k < 12; k++) { hex(words[k]); if (k < 11) printf(", "); }
    printf("],\n");
    /* The engine's (path 0, market) stream: state = words 0..3. */
    s[0] = words[0]; s[1] = words[1]; s[2] = words[2]; s[3] = words[3];
    printf("      \"path0MarketOutputs\": [");
    for (int k = 0; k < 8; k++) { hex(xoshiro_next()); if (k < 7) printf(", "); }
    printf("],\n");
    /* (path 1, market): words 8..11. */
    s[0] = words[8]; s[1] = words[9]; s[2] = words[10]; s[3] = words[11];
    printf("      \"path1MarketOutputs\": [");
    for (int k = 0; k < 8; k++) { hex(xoshiro_next()); if (k < 7) printf(", "); }
    printf("],\n");
    /* The first 70 doubles of (path 0, market): (next >> 11) * 2^-53, printed exactly.
       70 spans the engine's 64-double pool refill, so the pooled path is checked across a boundary. */
    s[0] = words[0]; s[1] = words[1]; s[2] = words[2]; s[3] = words[3];
    printf("      \"path0MarketDoubles\": [");
    for (int k = 0; k < 70; k++) { printf("\"%.17g\"", (double)(xoshiro_next() >> 11) * 0x1.0p-53); if (k < 69) printf(", "); }
    printf("]\n    }%s\n", c < nseeds - 1 ? "," : "");
  }
  printf("  ]\n}\n");
  return 0;
}
