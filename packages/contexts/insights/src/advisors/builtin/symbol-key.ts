// SPDX-License-Identifier: MIT
/**
 * `symbolKeyPart` — the one place a third-party symbol becomes part of an
 * insight key (WP 9.5, F-6; wp5.4-redteam.md §4).
 *
 * A crypto token or a ticker names itself: an airdropped token can carry a
 * bidi override, a zero-width space or a chat-template token in its symbol
 * (`BTC{U+202E}eno{U+200B}`, `<|im_start|>`), and a ticker can carry a space
 * or a slash. The insight key alphabet is `[A-Za-z0-9_.:-]`
 * (`contract/response.ts`), and a key outside it fails step 2 — which refuses
 * the **whole response**: one hostile symbol silenced every finding the rule
 * made, including an `urgent` concentration finding on a clean holding.
 * Fail-closed for the model, fail-silent for the holder.
 *
 * Now: a symbol already inside the alphabet (≤ 32 characters) is used as it
 * is, so every existing key — and the cooldown, dismissal and Brief history
 * keyed by it — is unchanged. Any other symbol becomes a safe slug (its
 * alphabet characters, at most 16) plus `-x` and ten hex characters of a hash
 * of the exact symbol, so two different hostile symbols never share a key and
 * the same symbol always gets the same one. The symbol's own text still
 * appears wherever the rule quotes it, and the validator judges that text per
 * insight (F-5's bidi refusal is per insight, not per response).
 */
import { configHash } from '@core/platform';

const KEY_SAFE = /^[A-Za-z0-9_.:-]{1,32}$/u;

export function symbolKeyPart(symbol: string): string {
  if (KEY_SAFE.test(symbol)) return symbol;
  const slug = symbol
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_-]/gu, '')
    .slice(0, 16);
  return `${slug.length > 0 ? slug : 'symbol'}-x${configHash({ symbol }).slice(0, 10)}`;
}
