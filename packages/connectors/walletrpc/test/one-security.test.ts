// SPDX-License-Identifier: MIT
/**
 * Exit test for `docs/plan/03-phase-3-dispatch.md` §3 "WP 3.6" / §5, jointly
 * with WP 3.5: `'a wallet ETH balance and a Coinbase ETH balance land on one
 * securityId'`.
 *
 * ## Why this does not import `@ctx/investments`
 *
 * The dispatch asks to "drive both identifiers through the real resolver's
 * merge rule from `@ctx/investments` if importable from a test, else through
 * the port's identifier equality — say which." It is **not importable**:
 * `scripts/eslint-boundaries.js`'s `connectors` layer allow-list is
 * `['@core/kernel', '@core/secretbox', '@connector/port', 'zod']` with no
 * `@ctx/*` member, and the test-file exemption (`TEST_ONLY`) only adds
 * `vitest`/`fast-check` — it does not widen the context boundary. So this test
 * uses **the port's identifier equality**, checked against a verbatim
 * transcription of the one fact that makes the merge possible at all:
 * `packages/contexts/investments/src/identifiers.ts`'s `NATIVE_ASSETS` table,
 * whose own header states the exact claim this test exists to exercise —
 *
 * > "So the canonical identity of a native coin is a `chain_contract` whose
 * > contract is the sentinel `native`, and every spelling above canonicalises
 * > onto it: the tickers through `aliases` … the wallet's address through
 * > `sentinelContracts` …"
 *
 * and whose worked proof (`docs/evidence/phase-3/wp3.1-securities.md` §3,
 * "The one-security proof, all three identifiers shown") states the Coinbase
 * and wallet sightings verbatim:
 *
 * | Provider  | What it said | Kind after normalisation                    |
 * |-----------|--------------|----------------------------------------------|
 * | coinbase  | `ETH`        | `chain_contract ethereum/native` + `ticker ETH` |
 * | walletrpc | `0xEeee…eEEeE` on chain `ETH` | `chain_contract ethereum/native` |
 *
 * This test proves three things without crossing the boundary:
 *
 *   1. `nativeSecurityIdentifierOf('ethereum')` — this connector's real,
 *      wired-in output (`connector.ts`, reached from the `DATA_UNAVAILABLE`
 *      path today and from a priced `ProviderHoldingFact.security` once WP 3.4
 *      supplies a price) — is a `chain_contract` on `ethereum` naming the
 *      exact sentinel address the transcribed table recognises.
 *   2. The literal Coinbase-shaped identifier from wp3.5's evidence,
 *      `{kind:'ticker', value:'ETH', chain:null, mic:null}`, is a member of
 *      that same table's `aliases` for the same `ethereum` entry.
 *   3. Therefore both sightings canonicalise onto **the same table row** —
 *      which is the resolver's actual merge rule, transcribed and cited
 *      rather than re-invented, and is what makes them land on one
 *      `security_id`. `@ctx/investments`'s own `'the resolution tiers are the
 *      port''s identifier rank, stated here'`-style pinning test is what keeps
 *      the transcription from drifting; this test's job is only to show that
 *      *this connector's* identifier is the one that table expects.
 */
import { describe, expect, it } from 'vitest';
import type { SecurityIdentifier } from '@connector/port';
import { nativeSecurityIdentifierOf } from '../src/connector.ts';

// Verbatim transcription of the `ethereum` entry in
// packages/contexts/investments/src/identifiers.ts's `NATIVE_ASSETS` table —
// cited above, not reconstructed from scratch. A change to that table is
// exactly what `@ctx/investments`'s own pinning test would need to catch; this
// is this connector's half of the same claim.
const ETHEREUM_NATIVE_ASSET = Object.freeze({
  chain: 'ethereum',
  aliases: Object.freeze(['ETH', 'ETHER', 'ETHEREUM']),
  sentinelContracts: Object.freeze([
    'native',
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    '0x0000000000000000000000000000000000000000',
  ]),
});

/** What `packages/connectors/coinbase`'s wp3.5 evidence §10 item 6 states verbatim. */
const COINBASE_ETH_IDENTIFIER: SecurityIdentifier = {
  kind: 'ticker',
  value: 'ETH',
  chain: null,
  mic: null,
};

describe('a wallet ETH balance and a Coinbase ETH balance land on one securityId', () => {
  it("this connector's native-ETH identifier is a chain_contract the resolver's NATIVE_ASSETS table recognises", () => {
    const walletIdentifier = nativeSecurityIdentifierOf('ethereum');
    expect(walletIdentifier.kind).toBe('chain_contract');
    expect(walletIdentifier.chain).toBe(ETHEREUM_NATIVE_ASSET.chain);
    expect(ETHEREUM_NATIVE_ASSET.sentinelContracts).toContain(walletIdentifier.value.toLowerCase());
  });

  it("Coinbase's bare ETH ticker is an alias the same table entry recognises", () => {
    expect(COINBASE_ETH_IDENTIFIER.kind).toBe('ticker');
    expect(COINBASE_ETH_IDENTIFIER.chain).toBeNull(); // a crypto ticker carries no MIC (01 §identifiers.ts)
    expect(ETHEREUM_NATIVE_ASSET.aliases).toContain(COINBASE_ETH_IDENTIFIER.value);
  });

  it('both sightings canonicalise onto the same NATIVE_ASSETS row — one chain, one identity', () => {
    const walletIdentifier = nativeSecurityIdentifierOf('ethereum');
    const walletResolvesTo = nativeAssetFor(walletIdentifier);
    const coinbaseResolvesTo = nativeAssetFor(COINBASE_ETH_IDENTIFIER);

    expect(walletResolvesTo).not.toBeNull();
    expect(coinbaseResolvesTo).toBe(walletResolvesTo);
  });

  it('a bitcoin wallet identifier resolves to bitcoin, not the ethereum entry', () => {
    const btcIdentifier = nativeSecurityIdentifierOf('bitcoin');
    expect(btcIdentifier.chain).toBe('bitcoin');
    expect(btcIdentifier.value).toBe('native'); // bitcoin's own NATIVE_ASSETS entry: sentinelContracts: ['native']
    expect(nativeAssetFor(btcIdentifier)).toBeNull(); // this test's transcription only covers ethereum
    expect(nativeAssetFor(btcIdentifier)).not.toBe(ETHEREUM_NATIVE_ASSET.chain);
  });
});

/**
 * The transcribed half of `@ctx/investments`'s `nativeAssetByAlias` /
 * `nativeAssetByContract` — enough of the real function's behaviour (ticker
 * alias lookup, sentinel-contract lookup, both case-insensitive) to prove the
 * merge, without importing the context that owns it.
 */
function nativeAssetFor(identifier: SecurityIdentifier): string | null {
  if (identifier.kind === 'ticker') {
    return ETHEREUM_NATIVE_ASSET.aliases.includes(identifier.value.toUpperCase())
      ? ETHEREUM_NATIVE_ASSET.chain
      : null;
  }
  if (identifier.kind === 'chain_contract' && identifier.chain === 'ethereum') {
    return ETHEREUM_NATIVE_ASSET.sentinelContracts.includes(identifier.value.toLowerCase())
      ? ETHEREUM_NATIVE_ASSET.chain
      : null;
  }
  return null;
}
