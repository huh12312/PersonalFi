// SPDX-License-Identifier: MIT
/**
 * The identifier rules: what is well-formed, what is strongest, and — the one
 * this work package turns on — what may never be an identity at all.
 */
import { describe, expect, it } from 'vitest';
import {
  IDENTIFIER_KINDS,
  IDENTITY_KINDS,
  NATIVE_ASSETS,
  RESOLUTION_TIERS,
  cusipIsWellFormed,
  figiIsWellFormed,
  identifierKeyOf,
  identifierOf,
  identityRankOf,
  isIdentityBearing,
  isinIsWellFormed,
  micIsWellFormed,
  nativeAssetForContract,
  nativeAssetForSymbol,
  normaliseChain,
  normaliseIdentifiers,
  strongestIdentity,
} from './identifiers.ts';
import { inMemorySecurityStore, SecurityConstraintError } from './store.ts';

const PLAID = 'plaid';

describe('the tier table', () => {
  it('is the port’s identifier rank, stated here rather than imported', () => {
    // `@connector/port`'s `IDENTIFIER_RANK` is the same list. The two are
    // separate declarations because the boundary lint denies
    // `packages/connectors/*` → `@ctx/*` and a context reaching into an
    // adapter's package to borrow a constant would be the first crack in that.
    // Pinning both to the same literal is what keeps them from drifting.
    expect([...RESOLUTION_TIERS]).toEqual([
      'figi',
      'isin',
      'cusip',
      'ticker',
      'chain_contract',
      'proprietary',
    ]);
    expect([...IDENTIFIER_KINDS]).toEqual([...RESOLUTION_TIERS]);
  });

  it('excludes proprietary from the identity kinds, and nothing else', () => {
    expect([...IDENTITY_KINDS]).toEqual(RESOLUTION_TIERS.filter((kind) => kind !== 'proprietary'));
  });
});

describe('a provider identifier never becomes the identity', () => {
  it('a provider identifier never becomes the identity', () => {
    // 1. The kind itself is refused.
    expect(isIdentityBearing('proprietary')).toBe(false);
    expect(identityRankOf('proprietary')).toBeNull();

    // 2. Normalisation keeps it — it is useful evidence — and marks it.
    const { identifiers, abstentions } = normaliseIdentifiers(
      [identifierOf('proprietary', 'sec-vti-0001')],
      { provider: PLAID },
    );
    const proprietary = identifiers.find((identifier) => identifier.kind === 'proprietary');
    expect(proprietary).toBeDefined();
    expect(proprietary?.identity).toBe(false);
    expect(proprietary?.provider).toBe(PLAID);
    expect(abstentions).toContainEqual({
      tier: 'proprietary',
      reason: 'proprietary_is_not_an_identity',
      detail: 'sec-vti-0001',
    });

    // 3. So the strongest identity in a proprietary-only set is *nothing*.
    expect(strongestIdentity(identifiers)).toBeNull();

    // 4. And the store refuses the row even when a caller insists. This is the
    //    line the sabotage in docs/evidence/phase-3/wp3.1-securities.md §5
    //    attacks: make `canonicalOf` trust its `identity` argument, or drop
    //    `proprietary` from `IDENTITY_KINDS`' complement, and this assertion is
    //    what goes red.
    const store = inMemorySecurityStore();
    expect(() =>
      store.insertSecurity({
        userId: '01920000-0000-7000-8000-000000000001',
        // @ts-expect-error — the type forbids it; the test proves the runtime does too.
        identityKind: 'proprietary',
        identityKey: identifierKeyOf({
          kind: 'proprietary',
          value: 'sec-vti-0001',
          provider: PLAID,
        }),
        ticker: null,
        mic: null,
        cusip: null,
        isin: null,
        figi: null,
        chain: null,
        contract: null,
        name: 'Anonymous',
        type: 'other',
        currency: 'USD',
        expenseRatio: null,
        isCashEquivalent: false,
        assetClass: 'UNCLASSIFIED',
        region: 'UNKNOWN',
        sector: 'UNKNOWN',
        classificationSource: 'UNCLASSIFIED',
        classificationDepth: 0,
        classificationResidual: null,
        classificationFlagged: false,
      }),
    ).toThrow(SecurityConstraintError);
  });

  it('a proprietary identifier with no provider is not even evidence', () => {
    // `security_identifiers_proprietary_names_its_issuer`: an unattributed
    // opaque string belongs to nobody's vocabulary and corroborates nothing.
    const { identifiers, abstentions } = normaliseIdentifiers([
      identifierOf('proprietary', 'sec-1'),
    ]);
    expect(identifiers).toHaveLength(0);
    expect(abstentions).toContainEqual({
      tier: 'proprietary',
      reason: 'malformed',
      detail: 'sec-1',
    });
  });
});

describe('well-formedness', () => {
  it('validates the CUSIP check digit', () => {
    expect(cusipIsWellFormed('922908769')).toBe(true); // VTI
    expect(cusipIsWellFormed('037833100')).toBe(true); // AAPL
    expect(cusipIsWellFormed('922908768')).toBe(false); // last digit changed
    expect(cusipIsWellFormed('92290876')).toBe(false); // truncated
    expect(cusipIsWellFormed(' 922908769 ')).toBe(true); // a pasted value
  });

  it('validates the ISIN check digit', () => {
    expect(isinIsWellFormed('US9229087690')).toBe(true); // VTI
    expect(isinIsWellFormed('US0378331005')).toBe(true); // AAPL
    expect(isinIsWellFormed('US9229087691')).toBe(false);
    expect(isinIsWellFormed('9229087690US')).toBe(false);
  });

  it('checks a FIGI’s shape and deliberately not its check digit', () => {
    expect(figiIsWellFormed('BBG000BDTF76')).toBe(true);
    expect(figiIsWellFormed('BBG000BPH459')).toBe(true);
    // A vowel is not in FIGI's alphabet, and the 3rd character is always G.
    expect(figiIsWellFormed('BBA000BDTF76')).toBe(false);
    expect(figiIsWellFormed('BAG000BDTF76')).toBe(false);
    expect(figiIsWellFormed('BBG000BDTF7')).toBe(false);
    // The twelfth character is not verified: see the doc comment for why
    // guessing at a modulus would be worse than not checking it.
    expect(figiIsWellFormed('BBG000BDTF70')).toBe(true);
  });

  it('checks a MIC’s shape', () => {
    expect(micIsWellFormed('XNAS')).toBe(true);
    expect(micIsWellFormed('XNYS')).toBe(true);
    expect(micIsWellFormed('NYSE')).toBe(true);
    expect(micIsWellFormed('XNA')).toBe(false);
    expect(micIsWellFormed('')).toBe(false);
  });
});

describe('the ticker tier', () => {
  it('refuses an unqualified ticker as an identity and keeps it as evidence', () => {
    const { identifiers, abstentions } = normaliseIdentifiers([identifierOf('ticker', 'BHP')], {
      provider: PLAID,
    });
    expect(identifiers).toHaveLength(1);
    expect(identifiers[0]?.identity).toBe(false);
    expect(abstentions).toContainEqual({
      tier: 'ticker',
      reason: 'unqualified_ticker',
      detail: 'BHP',
    });
  });

  it('accepts a MIC-qualified ticker as an identity, and keys the venue in', () => {
    const xnys = normaliseIdentifiers([identifierOf('ticker', 'BHP', { mic: 'XNYS' })]);
    const xasx = normaliseIdentifiers([identifierOf('ticker', 'BHP', { mic: 'XASX' })]);
    expect(xnys.identifiers[0]?.identity).toBe(true);
    expect(xasx.identifiers[0]?.identity).toBe(true);
    // Three venues, three securities. If these keys were equal, one company's
    // London line would merge into another's Sydney line.
    expect(xnys.identifiers[0]?.key).not.toBe(xasx.identifiers[0]?.key);
  });

  it('does not normalise a ticker’s punctuation away', () => {
    // BRK.B and BRK-B are two venues' spellings of what is *usually* the same
    // share class — but not always, and folding them together would merge two
    // securities rather than two names for one. Case and whitespace fold;
    // nothing else does.
    const dotted = identifierKeyOf({ kind: 'ticker', value: 'BRK.B', mic: 'XNYS' });
    const dashed = identifierKeyOf({ kind: 'ticker', value: 'BRK-B', mic: 'XNYS' });
    expect(dotted).not.toBe(dashed);
    expect(identifierKeyOf({ kind: 'ticker', value: ' brk.b ', mic: 'xnys' })).toBe(dotted);
  });
});

describe('native assets', () => {
  it('folds every provider spelling of a coin onto one chain_contract', () => {
    for (const spelling of ['ETH', 'eth', 'Ethereum', 'ETHEREUM']) {
      expect(nativeAssetForSymbol(spelling)?.chain).toBe('ethereum');
    }
    expect(nativeAssetForSymbol('MATIC')?.symbol).toBe('POL');
    expect(nativeAssetForSymbol('VTI')).toBeNull();
  });

  it('recognises the sentinel addresses wallets use for a chain’s own coin', () => {
    expect(
      nativeAssetForContract('ethereum', '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')?.symbol,
    ).toBe('ETH');
    expect(
      nativeAssetForContract('ethereum', '0x0000000000000000000000000000000000000000'),
    ).not.toBeNull();
    // WETH is an ERC-20 with its own custody assumption. It tracks ETH; it is
    // not ETH, and a user can hold both at once in different amounts.
    expect(
      nativeAssetForContract('ethereum', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
    ).toBeNull();
  });

  it('normalises the chain names providers disagree about', () => {
    expect(normaliseChain('ETH')).toBe('ethereum');
    expect(normaliseChain('eth_mainnet')).toBe('ethereum');
    expect(normaliseChain('Ethereum')).toBe('ethereum');
    expect(normaliseChain('polygon-pos')).toBe('polygon');
  });

  it('gives every native asset a canonical symbol and at least one sentinel', () => {
    for (const asset of NATIVE_ASSETS) {
      expect(asset.aliases).toContain(asset.symbol);
      expect(asset.sentinelContracts.length).toBeGreaterThan(0);
      expect(asset.sentinelContracts).toContain('native');
      expect(normaliseChain(asset.chain)).toBe(asset.chain);
    }
  });
});

describe('abstentions', () => {
  it('names one reason per tier, even when a tier succeeds elsewhere', () => {
    const { abstentions } = normaliseIdentifiers(
      [identifierOf('cusip', '922908769'), identifierOf('ticker', 'VTI')],
      { provider: PLAID },
    );
    const tiers = abstentions.map((entry) => entry.tier);
    expect(tiers).toContain('figi');
    expect(tiers).toContain('isin');
    expect(tiers).toContain('chain_contract');
    expect(tiers).toContain('ticker');
    expect(abstentions.find((entry) => entry.tier === 'figi')?.reason).toBe('absent');
    expect(abstentions.find((entry) => entry.tier === 'ticker')?.reason).toBe('unqualified_ticker');
    // The CUSIP answered, so it does not abstain.
    expect(tiers).not.toContain('cusip');
  });

  it('reports a malformed identifier as malformed rather than as absent', () => {
    const { identifiers, abstentions } = normaliseIdentifiers([
      identifierOf('isin', 'US9229087691'),
    ]);
    expect(identifiers).toHaveLength(0);
    expect(abstentions).toContainEqual({
      tier: 'isin',
      reason: 'malformed',
      detail: 'US9229087691',
    });
  });
});
