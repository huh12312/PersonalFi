// SPDX-License-Identifier: MIT
/**
 * What a security is *called*, and which of those names may say what it *is*.
 *
 * 08 §1.3 #7 states the problem in one sentence: "Coinbase says `ETH`, Plaid
 * says `ETHEREUM`, a wallet says a contract address, a brokerage says a CUSIP.
 * One resolver, one `securities` table, everything else references
 * `security_id`." This file is the half of that sentence that has nothing to do
 * with the database: normalising a name, deciding whether it is well-formed,
 * and ranking it against the others.
 *
 * ## The rule the whole work package turns on
 *
 * **A provider's own identifier is evidence. It is never identity** — the D25
 * shape applied to securities.
 *
 * A Plaid `security_id`, a Coinbase `product_id`, a brokerage's internal symbol:
 * each is stable within one provider and meaningless across two. Accepting one
 * as identity mints a row per provider for the same asset, and then allocation
 * double-counts it, concentration understates it, and TWR is wrong for both
 * halves. So `proprietary` is stored — it is genuinely useful, because the
 * *second* time that provider mentions the same opaque id it finds the row it
 * corroborated last time — but `identityRankOf` refuses it, the
 * `securities.identity_kind` CHECK has no `proprietary` member, and
 * `identifiers.test.ts` sabotages the refusal to watch it go red.
 *
 * ## Strength order, and why it is here rather than in an `ORDER BY`
 *
 *   1. **figi** — globally unique, permanent, exchange-level, issued by an open
 *      standard rather than by a vendor. There is nothing stronger.
 *   2. **isin** — globally unique at the *issue* level, and therefore blind to
 *      which venue a line is held on: it cannot separate dual listings.
 *   3. **cusip** — North America only, and licensed rather than open.
 *   4. **ticker + MIC** — a *qualified* ticker is an identity. A bare one is
 *      not: `BHP` is a different security on XNYS, XASX and XLON, and tickers
 *      are reused after delistings. An unqualified ticker may corroborate and
 *      may never identify.
 *   5. **chain + contract** — exact for the token it names. Below `ticker` only
 *      for *fingerprint selection* (which single name will two providers most
 *      likely share); as evidence it is as exact as anything here, which is why
 *      a native asset's canonical identity is a `chain_contract`.
 *   6. **proprietary** — see above. Never an identity anywhere.
 *
 * `@connector/port` states this same order as `IDENTIFIER_RANK`, and the two
 * declarations are separate on purpose: the boundary lint denies
 * `packages/connectors/*` → `@ctx/*`, and a context that imported an adapter's
 * package to borrow a constant would be the first crack in that. The test
 * `'the resolution tiers are the port''s identifier rank, stated here'` pins
 * both lists to the same literal, which is what keeps them from drifting.
 */

import {
  IDENTIFIER_KINDS,
  IDENTITY_KINDS,
  type IdentifierKind,
  type IdentityKind,
} from '../schema/index.ts';

export { IDENTIFIER_KINDS, IDENTITY_KINDS, type IdentifierKind, type IdentityKind };

/**
 * One name for a security, as some provider spelled it.
 *
 * Structurally identical to `@connector/port`'s `SecurityIdentifier`, and kept
 * separate for the boundary reason above — the same arrangement `@ctx/ledger`'s
 * seed loader uses for its dataset. The composition root's type-check is what
 * proves the two still line up: `apps/api` sees both.
 */
export interface SecurityIdentifier {
  readonly kind: IdentifierKind;
  readonly value: string;
  /** `chain_contract` only: `ethereum`, `bitcoin`, `solana`. `null` otherwise. */
  readonly chain: string | null;
  /** `ticker` only: the ISO-10383 MIC (`XNAS`, `XNYS`). `null` when unqualified. */
  readonly mic: string | null;
}

/** Build one without writing two `null`s at every call site. */
export function identifierOf(
  kind: IdentifierKind,
  value: string,
  qualifiers: { readonly chain?: string | null; readonly mic?: string | null } = {},
): SecurityIdentifier {
  return { kind, value, chain: qualifiers.chain ?? null, mic: qualifiers.mic ?? null };
}

/**
 * The tiers, strongest first. Identical to `@connector/port`'s `IDENTIFIER_RANK`.
 */
export const RESOLUTION_TIERS: readonly IdentifierKind[] = Object.freeze([
  'figi',
  'isin',
  'cusip',
  'ticker',
  'chain_contract',
  'proprietary',
]);

/** Rank within `RESOLUTION_TIERS`. Lower is stronger. */
export function tierRankOf(kind: IdentifierKind): number {
  return RESOLUTION_TIERS.indexOf(kind);
}

/**
 * Rank as an *identity*, which is not the same question as rank as evidence.
 *
 * `null` means "this kind may corroborate a security but may never establish
 * one". Today that is `proprietary` and only `proprietary`; an unqualified
 * ticker is rejected by `normaliseIdentifier` before it ever gets here, because
 * the problem there is the *value*, not the kind.
 */
export function identityRankOf(kind: IdentifierKind): number | null {
  const rank = (IDENTITY_KINDS as readonly string[]).indexOf(kind);
  return rank < 0 ? null : tierRankOf(kind);
}

/** Does this kind establish identity at all? The one-line form of the D25 rule. */
export function isIdentityBearing(kind: IdentifierKind): kind is IdentityKind {
  return identityRankOf(kind) !== null;
}

// ---------------------------------------------------------------------------
// Native assets
// ---------------------------------------------------------------------------

/**
 * A chain's own coin, and every spelling the outside world gives it.
 *
 * This table is what makes the §5 exit criterion — "ETH on Coinbase and in a
 * wallet resolves to one security" — reachable at all, because the three
 * sightings have *no identifier kind in common*:
 *
 *   * Coinbase says `ETH`, a bare ticker. There is no MIC: ISO-10383 registers
 *     venues, and a chain is not a venue, so a crypto ticker can never be
 *     qualified the way `BHP.XASX` can.
 *   * Plaid says `ETHEREUM` — also a bare ticker, spelled differently.
 *   * A wallet says a contract address, on a chain.
 *
 * So the canonical identity of a native coin is a **`chain_contract` whose
 * contract is the sentinel `native`**, and every spelling above canonicalises
 * onto it: the tickers through `aliases`, the wallet's address through
 * `sentinelContracts` (the addresses aggregators and wallets conventionally use
 * to mean "the chain's own coin" — `0xEeee…eEEeE` and the zero address — plus
 * the literal string `native`).
 *
 * **What is deliberately *not* here: wrapped tokens.** WETH
 * (`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`) is an ERC-20 contract with its
 * own custody assumption and its own depeg risk. It tracks ETH; it is not ETH.
 * Folding it in would merge two securities that a user can hold *simultaneously*
 * and in different amounts, which is a worse failure than leaving them apart:
 * one of the two balances would silently vanish into the other. `resolver.test.ts`
 * asserts WETH and ETH stay separate, so nobody can add the convenience later
 * without deleting a test that says why not.
 */
export interface NativeAsset {
  readonly chain: string;
  /** The canonical ticker we show. Not an identity by itself. */
  readonly symbol: string;
  readonly name: string;
  /** Every provider spelling, upper-cased, that means this coin. */
  readonly aliases: readonly string[];
  /** Addresses that conventionally mean "the chain's own coin". */
  readonly sentinelContracts: readonly string[];
}

const EVM_NATIVE_SENTINELS = [
  'native',
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  '0x0000000000000000000000000000000000000000',
] as const;

export const NATIVE_ASSETS: readonly NativeAsset[] = Object.freeze([
  {
    chain: 'bitcoin',
    symbol: 'BTC',
    name: 'Bitcoin',
    aliases: ['BTC', 'XBT', 'BITCOIN'],
    sentinelContracts: ['native'],
  },
  {
    chain: 'ethereum',
    symbol: 'ETH',
    name: 'Ether',
    aliases: ['ETH', 'ETHER', 'ETHEREUM'],
    sentinelContracts: [...EVM_NATIVE_SENTINELS],
  },
  {
    chain: 'solana',
    symbol: 'SOL',
    name: 'Solana',
    aliases: ['SOL', 'SOLANA'],
    sentinelContracts: ['native', '11111111111111111111111111111111'],
  },
  {
    chain: 'litecoin',
    symbol: 'LTC',
    name: 'Litecoin',
    aliases: ['LTC', 'LITECOIN'],
    sentinelContracts: ['native'],
  },
  {
    chain: 'dogecoin',
    symbol: 'DOGE',
    name: 'Dogecoin',
    aliases: ['DOGE', 'DOGECOIN'],
    sentinelContracts: ['native'],
  },
  {
    chain: 'cardano',
    symbol: 'ADA',
    name: 'Cardano',
    aliases: ['ADA', 'CARDANO'],
    sentinelContracts: ['native'],
  },
  {
    chain: 'avalanche',
    symbol: 'AVAX',
    name: 'Avalanche',
    aliases: ['AVAX', 'AVALANCHE'],
    sentinelContracts: [...EVM_NATIVE_SENTINELS],
  },
  {
    chain: 'polygon',
    symbol: 'POL',
    name: 'Polygon',
    // MATIC was renamed POL in 2024 and providers still disagree; both spellings
    // mean the same coin, and treating them as two would split one position.
    aliases: ['POL', 'MATIC', 'POLYGON'],
    sentinelContracts: [...EVM_NATIVE_SENTINELS],
  },
  {
    chain: 'bitcoin-cash',
    symbol: 'BCH',
    name: 'Bitcoin Cash',
    aliases: ['BCH', 'BITCOIN CASH', 'BITCOINCASH'],
    sentinelContracts: ['native'],
  },
  {
    chain: 'ripple',
    symbol: 'XRP',
    name: 'XRP',
    aliases: ['XRP', 'RIPPLE'],
    sentinelContracts: ['native'],
  },
]);

const NATIVE_BY_ALIAS = new Map<string, NativeAsset>(
  NATIVE_ASSETS.flatMap((asset) => asset.aliases.map((alias) => [alias.toUpperCase(), asset])),
);

const NATIVE_BY_CHAIN = new Map<string, NativeAsset>(
  NATIVE_ASSETS.map((asset) => [asset.chain, asset]),
);

/** The coin a bare symbol names, or `null` if it names no chain we know. */
export function nativeAssetForSymbol(symbol: string): NativeAsset | null {
  return NATIVE_BY_ALIAS.get(symbol.trim().toUpperCase()) ?? null;
}

/** The coin a `chain` + `contract` pair names, when the contract is a sentinel. */
export function nativeAssetForContract(chain: string, contract: string): NativeAsset | null {
  const asset = NATIVE_BY_CHAIN.get(normaliseChain(chain));
  if (asset === undefined) return null;
  return asset.sentinelContracts.includes(contract.trim().toLowerCase()) ? asset : null;
}

/** `Ethereum`, `ETH_MAINNET`, `eth` → `ethereum`. Chain names are not standardised. */
export function normaliseChain(chain: string): string {
  const folded = chain.trim().toLowerCase().replaceAll('_', '-');
  const aliases: Record<string, string> = {
    eth: 'ethereum',
    'eth-mainnet': 'ethereum',
    'ethereum-mainnet': 'ethereum',
    btc: 'bitcoin',
    'btc-mainnet': 'bitcoin',
    xbt: 'bitcoin',
    sol: 'solana',
    matic: 'polygon',
    'polygon-pos': 'polygon',
    bch: 'bitcoin-cash',
    ltc: 'litecoin',
    doge: 'dogecoin',
    ada: 'cardano',
    avax: 'avalanche',
    'avalanche-c': 'avalanche',
    xrp: 'ripple',
    'xrp-ledger': 'ripple',
  };
  return aliases[folded] ?? folded;
}

// ---------------------------------------------------------------------------
// Well-formedness
// ---------------------------------------------------------------------------

/**
 * Character values for the CUSIP/ISIN check-digit algorithms: `0-9`, then
 * `A`=10 … `Z`=35, then CUSIP's three punctuation characters.
 */
function charValue(character: string): number | null {
  const code = character.charCodeAt(0);
  if (character >= '0' && character <= '9') return code - 48;
  if (character >= 'A' && character <= 'Z') return code - 55;
  if (character === '*') return 36;
  if (character === '@') return 37;
  if (character === '#') return 38;
  return null;
}

/**
 * The CUSIP check digit (modulus 10, double-add-double over the first eight).
 *
 * Validated rather than assumed because a CUSIP is the identifier a brokerage
 * CSV most often supplies *alone* (07 §4.3: "Brokerage CSVs frequently give
 * only a CUSIP; without this mapping the whole portfolio module stalls"), so it
 * is also the one most often mistyped, truncated to eight characters, or
 * pasted with a stray space. A malformed CUSIP accepted as an identity is a
 * permanent second `securities` row for an asset that already had one.
 */
export function cusipIsWellFormed(value: string): boolean {
  const text = value.trim().toUpperCase();
  if (!/^[0-9A-Z*@#]{9}$/.test(text)) return false;
  let sum = 0;
  for (let index = 0; index < 8; index += 1) {
    const digit = charValue(text[index] as string);
    if (digit === null) return false;
    const doubled = index % 2 === 1 ? digit * 2 : digit;
    sum += Math.floor(doubled / 10) + (doubled % 10);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(text[8]);
}

/** The ISIN check digit: expand letters to digit pairs, then Luhn. */
export function isinIsWellFormed(value: string): boolean {
  const text = value.trim().toUpperCase();
  if (!/^[A-Z]{2}[0-9A-Z]{9}[0-9]$/.test(text)) return false;
  let digits = '';
  for (const character of text.slice(0, 11)) {
    const digit = charValue(character);
    if (digit === null) return false;
    digits += String(digit);
  }
  let sum = 0;
  let double = true;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = Number(digits[index]);
    const applied = double ? digit * 2 : digit;
    sum += applied > 9 ? applied - 9 : applied;
    double = !double;
  }
  return (10 - (sum % 10)) % 10 === Number(text[11]);
}

/**
 * A FIGI's shape: two consonants, a literal `G`, eight consonant-or-digit
 * characters, one check digit. `BBG000BDTF76`.
 *
 * The check *digit* is deliberately not verified. OpenFIGI documents the
 * character set and the layout; the exact modulus the twelfth character is
 * computed with is not something this codebase can cite, and rejecting a FIGI a
 * provider actually returned on an algorithm we guessed at would be a worse
 * failure than accepting a malformed one — the shape test already rejects
 * everything a truncation or a typo produces, and a FIGI arrives from a
 * provider's JSON rather than from a human's keyboard.
 */
export function figiIsWellFormed(value: string): boolean {
  return /^[BCDFGHJKLMNPQRSTVWXYZ]{2}G[BCDFGHJKLMNPQRSTVWXYZ0-9]{8}[0-9]$/.test(
    value.trim().toUpperCase(),
  );
}

/** ISO-10383: four alphanumerics, upper case. `XNAS`, `XNYS`, `XASX`. */
export function micIsWellFormed(value: string): boolean {
  return /^[A-Z0-9]{4}$/.test(value.trim().toUpperCase());
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Why a tier could not answer. Every one of these is returned, never swallowed. */
export const ABSTAIN_REASONS = [
  /** The provider gave no identifier of this kind. */
  'absent',
  /** It gave one, and it is not a well-formed identifier of this kind. */
  'malformed',
  /** A bare ticker, with no MIC and no native-asset match. `BHP` is three securities. */
  'unqualified_ticker',
  /** A provider's own id. Corroborates; never identifies. */
  'proprietary_is_not_an_identity',
] as const;
export type AbstainReason = (typeof ABSTAIN_REASONS)[number];

export interface TierAbstention {
  readonly tier: IdentifierKind;
  readonly reason: AbstainReason;
  /** The offending value, when there was one. Carried into the failure event. */
  readonly detail: string | null;
}

/**
 * One identifier, folded to the form the database stores and compares.
 *
 * `canonical` is what a lookup keys on; `identity` says whether this name may
 * *establish* a security or only corroborate one.
 */
export interface NormalisedIdentifier {
  readonly kind: IdentifierKind;
  readonly value: string;
  readonly chain: string | null;
  readonly mic: string | null;
  readonly provider: string | null;
  readonly key: string;
  readonly identity: boolean;
  /**
   * Set when a native-asset alias was rewritten onto its canonical
   * `chain_contract`. Kept so the original spelling can still be attached as
   * corroborating evidence rather than thrown away.
   */
  readonly canonicalisedFrom: SecurityIdentifier | null;
}

/**
 * `U+001F`, the same inner separator `@connector/port`'s key uses.
 *
 * Written as an escape rather than as a literal control byte: a source file
 * containing one is treated as *binary* by git, so it never appears in a diff
 * and silently drops out of code review. The runtime value is identical.
 */
const SEPARATOR = '\u001f';

/**
 * The canonical serialisation: `kind|value|chain|mic|provider`.
 *
 * Case and surrounding whitespace are folded because providers are inconsistent
 * about both — a contract address arrives checksummed from one wallet and
 * lowercased from another, and they are the same address. **Nothing else is
 * touched**: a ticker's punctuation (`BRK.B` versus `BRK-B`) is a genuine
 * difference between venues' spellings, and normalising it away would merge two
 * securities rather than two names for one.
 *
 * `provider` participates only for `proprietary`, where it is part of the
 * identifier's meaning: Plaid's `sec-1` and Coinbase's `sec-1` are not the same
 * string in any sense that matters.
 */
export function identifierKeyOf(input: {
  readonly kind: IdentifierKind;
  readonly value: string;
  readonly chain?: string | null;
  readonly mic?: string | null;
  readonly provider?: string | null;
}): string {
  return [
    input.kind,
    input.value.trim().toLowerCase(),
    (input.chain ?? '').trim().toLowerCase(),
    (input.mic ?? '').trim().toUpperCase(),
    input.kind === 'proprietary' ? (input.provider ?? '').trim().toLowerCase() : '',
  ].join(SEPARATOR);
}

export interface NormaliseResult {
  /** In `RESOLUTION_TIERS` order, strongest first. May be empty. */
  readonly identifiers: readonly NormalisedIdentifier[];
  /** One entry per tier that could not answer, with the reason. */
  readonly abstentions: readonly TierAbstention[];
}

function abstention(
  tier: IdentifierKind,
  reason: AbstainReason,
  detail: string | null,
): TierAbstention {
  return { tier, reason, detail };
}

/**
 * Fold a provider's whole set of names at once, and say what each tier did.
 *
 * Taking the set rather than one name at a time is not a convenience: the
 * resolver walks tiers strongest-first and can only do that if it sees
 * everything the provider volunteered. A brokerage that reports a CUSIP *and* a
 * ticker is how that position joins the row a crypto wallet already created.
 *
 * Every tier that does not answer produces a `TierAbstention` with a reason.
 * WP 3.1's spec asks for "every abstain named and returned", and the reason
 * ends up in the `SecurityResolutionFailed` payload, which is the difference
 * between a user seeing "we could not identify this holding because the only
 * name Plaid gave was its own id" and seeing nothing at all.
 */
export function normaliseIdentifiers(
  identifiers: readonly SecurityIdentifier[],
  options: { readonly provider?: string | null } = {},
): NormaliseResult {
  const provider = options.provider ?? null;
  const normalised: NormalisedIdentifier[] = [];
  const abstentions: TierAbstention[] = [];
  const seen = new Set<string>();

  const push = (candidate: NormalisedIdentifier): void => {
    if (seen.has(candidate.key)) return;
    seen.add(candidate.key);
    normalised.push(candidate);
  };

  for (const tier of RESOLUTION_TIERS) {
    const ofKind = identifiers.filter((identifier) => identifier.kind === tier);
    if (ofKind.length === 0) {
      abstentions.push(abstention(tier, 'absent', null));
      continue;
    }

    let answered = false;
    for (const identifier of ofKind) {
      const value = identifier.value.trim();
      if (value.length === 0) {
        abstentions.push(abstention(tier, 'malformed', identifier.value));
        continue;
      }

      switch (tier) {
        case 'figi': {
          if (!figiIsWellFormed(value)) {
            abstentions.push(abstention(tier, 'malformed', value));
            continue;
          }
          push(canonicalOf('figi', value.toUpperCase(), null, null, provider, true, null));
          answered = true;
          continue;
        }
        case 'isin': {
          if (!isinIsWellFormed(value)) {
            abstentions.push(abstention(tier, 'malformed', value));
            continue;
          }
          push(canonicalOf('isin', value.toUpperCase(), null, null, provider, true, null));
          answered = true;
          continue;
        }
        case 'cusip': {
          if (!cusipIsWellFormed(value)) {
            abstentions.push(abstention(tier, 'malformed', value));
            continue;
          }
          push(canonicalOf('cusip', value.toUpperCase(), null, null, provider, true, null));
          answered = true;
          continue;
        }
        case 'ticker': {
          const symbol = value.toUpperCase();
          const native = nativeAssetForSymbol(symbol);
          if (native !== null) {
            // A crypto ticker can never carry a MIC — a chain is not a venue —
            // so the canonical identity is the coin's own chain_contract, and
            // the ticker itself stays on as corroborating evidence.
            push(
              canonicalOf(
                'chain_contract',
                'native',
                native.chain,
                null,
                provider,
                true,
                identifier,
              ),
            );
            push(canonicalOf('ticker', symbol, null, null, provider, false, null));
            answered = true;
            continue;
          }
          const mic = identifier.mic?.trim().toUpperCase() ?? '';
          if (mic.length === 0) {
            // Stored as evidence, refused as identity. `BHP` on XNYS, XASX and
            // XLON are three different securities.
            push(canonicalOf('ticker', symbol, null, null, provider, false, null));
            abstentions.push(abstention(tier, 'unqualified_ticker', symbol));
            continue;
          }
          if (!micIsWellFormed(mic)) {
            push(canonicalOf('ticker', symbol, null, null, provider, false, null));
            abstentions.push(abstention(tier, 'malformed', `${symbol}@${mic}`));
            continue;
          }
          push(canonicalOf('ticker', symbol, null, mic, provider, true, null));
          answered = true;
          continue;
        }
        case 'chain_contract': {
          const chain = identifier.chain?.trim() ?? '';
          if (chain.length === 0) {
            abstentions.push(abstention(tier, 'malformed', value));
            continue;
          }
          const normalisedChain = normaliseChain(chain);
          const native = nativeAssetForContract(normalisedChain, value);
          const contract = native === null ? value.toLowerCase() : 'native';
          push(
            canonicalOf(
              'chain_contract',
              contract,
              normalisedChain,
              null,
              provider,
              true,
              native === null ? null : identifier,
            ),
          );
          answered = true;
          continue;
        }
        case 'proprietary': {
          if (provider === null) {
            // An unattributed opaque string is not evidence of anything, and
            // the database agrees: `security_identifiers` CHECKs that a
            // proprietary row names its issuer.
            abstentions.push(abstention(tier, 'malformed', value));
            continue;
          }
          push(canonicalOf('proprietary', value, null, null, provider, false, null));
          abstentions.push(abstention(tier, 'proprietary_is_not_an_identity', value));
          continue;
        }
      }
    }

    if (!answered && !abstentions.some((entry) => entry.tier === tier)) {
      abstentions.push(abstention(tier, 'absent', null));
    }
  }

  normalised.sort((a, b) => tierRankOf(a.kind) - tierRankOf(b.kind));
  return { identifiers: normalised, abstentions };
}

function canonicalOf(
  kind: IdentifierKind,
  value: string,
  chain: string | null,
  mic: string | null,
  provider: string | null,
  identity: boolean,
  canonicalisedFrom: SecurityIdentifier | null,
): NormalisedIdentifier {
  return {
    kind,
    value,
    chain,
    mic,
    provider,
    key: identifierKeyOf({ kind, value, chain, mic, provider }),
    // Belt and braces, and deliberately so: a caller that passed `identity:
    // true` for a proprietary kind would be overruled here rather than trusted.
    // This is the line `identifiers.test.ts` sabotages.
    identity: identity && isIdentityBearing(kind),
    canonicalisedFrom,
  };
}

/** The strongest identity-bearing name in a normalised set, or `null`. */
export function strongestIdentity(
  identifiers: readonly NormalisedIdentifier[],
): NormalisedIdentifier | null {
  let best: NormalisedIdentifier | null = null;
  for (const identifier of identifiers) {
    if (!identifier.identity) continue;
    const rank = identityRankOf(identifier.kind);
    if (rank === null) continue;
    if (best === null || rank < (identityRankOf(best.kind) ?? Number.POSITIVE_INFINITY)) {
      best = identifier;
    }
  }
  return best;
}

/** The confidence a name carries as *evidence*, by tier. Recorded per row. */
export function confidenceOf(kind: IdentifierKind, qualified: boolean): string {
  switch (kind) {
    case 'figi':
      return '1.0000';
    case 'isin':
      return '0.9500';
    case 'cusip':
      return '0.9000';
    case 'chain_contract':
      return '0.9500';
    case 'ticker':
      return qualified ? '0.7500' : '0.3000';
    case 'proprietary':
      return '0.2000';
  }
}
