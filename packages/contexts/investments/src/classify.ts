// SPDX-License-Identifier: MIT
/**
 * 07 §4.3's classification waterfall: what asset class a security is, and
 * **which rung said so**.
 *
 * ```
 * 1. USER_OVERRIDE      -- always wins, never re-derived
 * 2. LOCAL_SEED_TABLE   -- data/asset-classes.json, in-repo, MIT, editable
 * 3. SEC_EDGAR          -- company_tickers.json + N-PORT look-through
 * 4. ISSUER_HOLDINGS    -- iShares/Vanguard/SPDR daily CSVs
 * 5. PROVIDER           -- what the aggregator itself said
 * 6. NAME_HEURISTIC     -- /total bond|aggregate|treasury|TIPS/ -> bonds, ...
 * 7. SIC_SECTOR_MAP     -- an individual equity's SEC SIC code -> sector
 * 8. UNCLASSIFIED       -- an explicit bucket, surfaced in the UI
 * ```
 *
 * First hit wins, and **every row records its `classification_source`** — 07
 * §4.3 states that as a requirement rather than as advice, and
 * `classify.test.ts` holds it: `'every classified row records its
 * classification_source'`. `UNCLASSIFIED` is a *positive* statement that the
 * waterfall ran and fell through every rung. There is no "not yet looked at"
 * value, because a null there would be indistinguishable from a bug.
 *
 * ## Rungs 3 and 4 are ports, and are not implemented here
 *
 * SEC EDGAR and the issuer CSVs are network calls. Market data is Phase 3's
 * second egress surface and the first that runs on a schedule with no human
 * present (dispatch §5, risks table), so every one of those calls belongs
 * behind WP 2.4's allow-list module — **reused, not reimplemented** — which
 * WP 3.4 owns. What this file does is take them as injected lookups and record
 * the rung honestly when they are absent. A waterfall missing two rungs and
 * saying so is a measurable gap; a waterfall that silently skips them and
 * labels the answer `NAME_HEURISTIC` is a wrong number with a plausible
 * provenance, which is worse.
 *
 * ## Multi-asset funds are decomposed, not bucketed
 *
 * 07 §4.3: "Multi-asset funds (target-date, balanced) must be decomposed, not
 * bucketed as 'equity'." So a look-through returns **`weights`** — a class to
 * weight map — and `assetClass` is only a *label*: the dominant class when one
 * holds at least half the fund, and `OTHER` when none does. WP 3.3's allocation
 * math reads `weights`; the column exists so a list can show something short.
 *
 * Three limits are stated here rather than discovered later, because 07 §4.3
 * says to state them in the UI and the UI can only state what the data carries:
 * N-PORT is quarterly with a ~60-day lag so holdings are stale by construction;
 * derivatives report market value rather than notional, so a fund with an
 * overlay genuinely does not add to 1.0; and fund-of-funds need **recursion
 * with cycle detection and a depth cap of 3**. A fund whose classified weights
 * miss 1.0 by more than five percentage points is `flagged`, which is 07's
 * rule verbatim.
 *
 * ## Arithmetic
 *
 * Weights are decimal strings and are summed as integer millionths (`bigint`),
 * never as `number`. A weight is not money and not a quantity, so D3 does not
 * literally reach it — but the sum of eleven weights compared against a 5%
 * threshold is exactly the kind of place where float error turns a flag on and
 * off between runs, and `0.1 + 0.2` is the reason this repo owns a decimal
 * type at all.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ASSET_CLASSES,
  REGIONS,
  SECURITY_TYPES,
  type AssetClass,
  type ClassificationSource,
  type OverlayField,
  type Region,
  type SecurityType,
} from '../schema/index.ts';

/** 07 §4.3's flag threshold: |Σ classified weights − 1| > 5%. */
export const WEIGHT_RESIDUAL_FLAG_THRESHOLD_MICROS = 50_000n;

/** 07 §4.3: "Fund-of-funds require recursive resolution with ... a depth cap (3)." */
export const MAX_LOOK_THROUGH_DEPTH = 3;

/** Weights are carried at six decimal places, matching `NUMERIC(9,6)`. */
const MICROS = 1_000_000n;

const ratioString = z.string().regex(/^\d+(\.\d{1,6})?$/);

const componentSchema = z.object({
  ticker: z.string().min(1),
  weight: ratioString,
});

const seedFundSchema = z.object({
  ticker: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(SECURITY_TYPES),
  assetClass: z.enum(ASSET_CLASSES),
  region: z.enum(REGIONS),
  sector: z.string().min(1),
  expenseRatio: ratioString.nullish(),
  isCashEquivalent: z.boolean().nullish(),
  components: z.array(componentSchema).nullish(),
});

const seedFileSchema = z.object({
  version: z.string().min(1),
  license: z.string().min(1),
  funds: z.array(seedFundSchema).min(1),
});

export type SeedFund = z.infer<typeof seedFundSchema>;

export interface SeedTable {
  readonly version: string;
  readonly license: string;
  /** Upper-cased ticker → fund. */
  readonly byTicker: ReadonlyMap<string, SeedFund>;
}

let cached: SeedTable | null = null;

/**
 * Read `data/asset-classes.json`, parsed and indexed.
 *
 * Read from disk rather than `import`ed: a JSON import needs an import
 * attribute and a `resolveJsonModule` this repo does not otherwise use, and the
 * file is deliberately a *data* file that a user can extend without a rebuild.
 * Parsed with zod on every load, because a hand-edited data file is exactly the
 * kind of input that arrives malformed, and a silently-missing `assetClass`
 * would surface three layers away as an allocation chart with a hole in it.
 */
export function loadSeedTable(): SeedTable {
  if (cached !== null) return cached;
  const path = join(import.meta.dirname, '..', 'data', 'asset-classes.json');
  const parsed = seedFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  cached = {
    version: parsed.version,
    license: parsed.license,
    byTicker: new Map(parsed.funds.map((fund) => [fund.ticker.toUpperCase(), fund])),
  };
  return cached;
}

/** Build a table from literal rows. The test fixtures' entry point. */
export function seedTableOf(funds: readonly SeedFund[], version = 'test'): SeedTable {
  return {
    version,
    license: 'MIT',
    byTicker: new Map(funds.map((fund) => [fund.ticker.toUpperCase(), fund])),
  };
}

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

export interface ClassifiableSecurity {
  readonly ticker: string | null;
  readonly name: string | null;
  /** Our vocabulary, when the resolver already decided. */
  readonly type: SecurityType | null;
  /** The aggregator's own word: `equity`, `etf`, `cryptocurrency`, `cash`. */
  readonly providerType: string | null;
  readonly isCashEquivalent: boolean | null;
  /** Set for a crypto asset. Its presence is itself a classification. */
  readonly chain: string | null;
  /** SEC SIC code for an individual equity, when something supplied one. */
  readonly sicCode: string | null;
}

/** What the user said, and which fields they actually locked (04 §2.2). */
export interface ClassificationOverride {
  readonly assetClass: AssetClass | null;
  readonly region: Region | null;
  readonly sector: string | null;
  readonly expenseRatio: string | null;
  readonly lockedFields: readonly OverlayField[];
}

/** A rung that talks to the network. WP 3.4 supplies these; absent is fine. */
export interface ExternalLookups {
  /** SEC EDGAR: `company_tickers.json` + N-PORT. */
  readonly edgar?: (ticker: string) => SeedFund | null;
  /** An issuer's published daily holdings CSV. */
  readonly issuer?: (ticker: string) => SeedFund | null;
}

export interface ClassifyOptions {
  readonly seed?: SeedTable;
  readonly overlay?: ClassificationOverride | null;
  readonly lookups?: ExternalLookups;
}

export interface Classification {
  readonly assetClass: AssetClass;
  readonly region: Region;
  readonly sector: string;
  readonly expenseRatio: string | null;
  readonly isCashEquivalent: boolean | null;
  /** The rung that answered. Never absent — that is 07 §4.3's normative bit. */
  readonly source: ClassificationSource;
  /** How many levels of fund-of-funds look-through were walked. 0–3. */
  readonly depth: number;
  /** `|Σ weights − 1|` as a decimal string, or `null` when nothing was decomposed. */
  readonly residual: string | null;
  /** 07 §4.3: residual over 5%, a cycle, or the depth cap. */
  readonly flagged: boolean;
  /** Class → weight, for a decomposed fund. Empty for a single-class security. */
  readonly weights: ReadonlyMap<AssetClass, string>;
  /** One line a human can read. Not parsed by anything. */
  readonly detail: string;
}

function microsOf(value: string): bigint {
  const [whole = '0', fraction = ''] = value.trim().split('.');
  return BigInt(whole) * MICROS + BigInt(fraction.padEnd(6, '0').slice(0, 6));
}

function ratioOf(micros: bigint): string {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const whole = absolute / MICROS;
  const fraction = (absolute % MICROS).toString().padStart(6, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

function single(assetClass: AssetClass): ReadonlyMap<AssetClass, string> {
  return new Map([[assetClass, '1.000000']]);
}

// ---------------------------------------------------------------------------
// Look-through
// ---------------------------------------------------------------------------

interface LookThrough {
  readonly weights: ReadonlyMap<AssetClass, string>;
  readonly residual: string;
  readonly depth: number;
  readonly cycle: boolean;
  readonly depthCapped: boolean;
}

/**
 * Decompose a fund into asset-class weights, recursively.
 *
 * `path` is the chain of tickers currently being expanded — a *path*, not a
 * global visited set, because the same component legitimately appears in two
 * sleeves of the same portfolio and that is not a cycle. A ticker that appears
 * in its own path is one, and it is real: a fund-of-funds holding a sibling
 * that holds it back will otherwise recurse until the stack gives out.
 */
function lookThrough(
  fund: SeedFund,
  resolveFund: (ticker: string) => SeedFund | null,
  path: readonly string[],
): LookThrough {
  const components = fund.components ?? [];
  const accumulator = new Map<AssetClass, bigint>();
  let claimed = 0n;
  let deepest = path.length;
  let cycle = false;
  let depthCapped = false;

  for (const component of components) {
    const weight = microsOf(component.weight);
    claimed += weight;
    const ticker = component.ticker.toUpperCase();

    if (path.includes(ticker)) {
      // A cycle. Its weight is deliberately *not* added to any class: a fund
      // that (transitively) holds itself has no defensible decomposition, and
      // inventing one would hide the loop behind a plausible pie chart.
      cycle = true;
      continue;
    }

    const child = resolveFund(ticker);
    if (child === null) {
      // Unknown component: its weight is counted as claimed but classified
      // nowhere, which is precisely what `residual` is for.
      continue;
    }

    const childComponents = child.components ?? [];
    if (childComponents.length === 0) {
      accumulator.set(child.assetClass, (accumulator.get(child.assetClass) ?? 0n) + weight);
      deepest = Math.max(deepest, path.length + 1);
      continue;
    }

    if (path.length + 1 >= MAX_LOOK_THROUGH_DEPTH) {
      // At the cap we stop *recursing* but still use the child's own label,
      // which is a coarser answer rather than no answer. `depthCapped` says so.
      depthCapped = true;
      accumulator.set(child.assetClass, (accumulator.get(child.assetClass) ?? 0n) + weight);
      deepest = Math.max(deepest, path.length + 1);
      continue;
    }

    const nested = lookThrough(child, resolveFund, [...path, ticker]);
    deepest = Math.max(deepest, nested.depth);
    cycle = cycle || nested.cycle;
    depthCapped = depthCapped || nested.depthCapped;
    for (const [assetClass, share] of nested.weights) {
      const scaled = (weight * microsOf(share)) / MICROS;
      accumulator.set(assetClass, (accumulator.get(assetClass) ?? 0n) + scaled);
    }
  }

  const classified = [...accumulator.values()].reduce((sum, value) => sum + value, 0n);
  // Measured against 1.0, not against what the fund claimed: a fund listing
  // components that sum to 0.88 is exactly the case 07 §4.3 wants flagged, and
  // comparing the classified total to `claimed` would quietly excuse it.
  void claimed;
  const residual = classified > MICROS ? classified - MICROS : MICROS - classified;

  return {
    weights: new Map([...accumulator].map(([key, value]) => [key, ratioOf(value)])),
    residual: ratioOf(residual),
    depth: deepest,
    cycle,
    depthCapped,
  };
}

/** The class that holds at least half the fund, or `OTHER`. A label, not the math. */
function dominantClassOf(weights: ReadonlyMap<AssetClass, string>): AssetClass {
  let best: AssetClass = 'OTHER';
  let bestWeight = 0n;
  for (const [assetClass, weight] of weights) {
    const micros = microsOf(weight);
    if (micros > bestWeight) {
      best = assetClass;
      bestWeight = micros;
    }
  }
  return bestWeight * 2n >= MICROS ? best : 'OTHER';
}

// ---------------------------------------------------------------------------
// Rung 6: name heuristics (07 §4.3, verbatim patterns)
// ---------------------------------------------------------------------------

interface NameRule {
  readonly pattern: RegExp;
  readonly assetClass: AssetClass;
  readonly region: Region;
}

const NAME_RULES: readonly NameRule[] = Object.freeze([
  { pattern: /\btips\b|inflation[- ]protected/i, assetClass: 'TIPS', region: 'US' },
  {
    pattern: /\b(total bond|aggregate bond|treasury|government bond|bond index|bond market)\b/i,
    assetClass: 'US_BOND',
    region: 'US',
  },
  { pattern: /\b(reit|real estate)\b/i, assetClass: 'REAL_ESTATE', region: 'UNKNOWN' },
  { pattern: /\b(gold|silver|commodit)\w*/i, assetClass: 'COMMODITY', region: 'GLOBAL' },
  { pattern: /\b(money market|cash reserves|treasury bill)\b/i, assetClass: 'CASH', region: 'US' },
  { pattern: /\bemerging\b/i, assetClass: 'EM_EQUITY', region: 'EM' },
  {
    pattern: /\b(ex[- ]us|international|developed markets|world ex)\b/i,
    assetClass: 'INTL_DEV_EQUITY',
    region: 'DEV_EX_US',
  },
  {
    pattern: /\b(s&p 500|total stock market|total market|us equity|russell)\b/i,
    assetClass: 'US_EQUITY',
    region: 'US',
  },
]);

/**
 * SEC SIC major-group → GICS-like sector.
 *
 * Deliberately coarse and deliberately incomplete: SIC's divisions do not map
 * cleanly onto GICS, and a table that pretended they did would produce
 * confident nonsense for the codes it guessed at. An unmapped code yields
 * `UNKNOWN`, which the UI shows as unclassified — 07 §4.3 wants that number
 * visible rather than absorbed.
 */
const SIC_SECTORS: readonly (readonly [number, number, string])[] = Object.freeze([
  [100, 999, 'Consumer Staples'],
  [1000, 1299, 'Materials'],
  [1300, 1399, 'Energy'],
  [1400, 1799, 'Industrials'],
  [2000, 2199, 'Consumer Staples'],
  [2800, 2899, 'Materials'],
  [2830, 2836, 'Health Care'],
  [3570, 3579, 'Information Technology'],
  [3600, 3699, 'Information Technology'],
  [3800, 3899, 'Health Care'],
  [4000, 4799, 'Industrials'],
  [4800, 4899, 'Communication Services'],
  [4900, 4999, 'Utilities'],
  [5200, 5999, 'Consumer Discretionary'],
  [6000, 6499, 'Financials'],
  [6500, 6599, 'Real Estate'],
  [7370, 7379, 'Information Technology'],
  [8000, 8099, 'Health Care'],
]);

function sectorForSic(code: string): string | null {
  const numeric = Number.parseInt(code.trim(), 10);
  if (!Number.isInteger(numeric)) return null;
  // Last match wins, so the narrow ranges above override the broad ones they
  // sit inside (pharmaceuticals inside chemicals, software inside services).
  let sector: string | null = null;
  for (const [low, high, name] of SIC_SECTORS) {
    if (numeric >= low && numeric <= high) sector = name;
  }
  return sector;
}

// ---------------------------------------------------------------------------
// The waterfall
// ---------------------------------------------------------------------------

function classificationOf(
  fields: Partial<Classification> & { readonly source: ClassificationSource },
): Classification {
  const assetClass = fields.assetClass ?? 'UNCLASSIFIED';
  return {
    assetClass,
    region: fields.region ?? 'UNKNOWN',
    sector: fields.sector ?? 'UNKNOWN',
    expenseRatio: fields.expenseRatio ?? null,
    isCashEquivalent: fields.isCashEquivalent ?? null,
    source: fields.source,
    depth: fields.depth ?? 0,
    residual: fields.residual ?? null,
    flagged: fields.flagged ?? false,
    weights: fields.weights ?? (assetClass === 'UNCLASSIFIED' ? new Map() : single(assetClass)),
    detail: fields.detail ?? '',
  };
}

function fromSeedFund(
  fund: SeedFund,
  source: ClassificationSource,
  resolveFund: (ticker: string) => SeedFund | null,
): Classification {
  const components = fund.components ?? [];
  if (components.length === 0) {
    return classificationOf({
      assetClass: fund.assetClass,
      region: fund.region,
      sector: fund.sector,
      expenseRatio: fund.expenseRatio ?? null,
      isCashEquivalent: fund.isCashEquivalent ?? null,
      source,
      detail: `${fund.ticker}: ${fund.name}`,
    });
  }

  const walked = lookThrough(fund, resolveFund, [fund.ticker.toUpperCase()]);
  const flagged =
    microsOf(walked.residual) > WEIGHT_RESIDUAL_FLAG_THRESHOLD_MICROS ||
    walked.cycle ||
    walked.depthCapped;
  const reasons = [
    microsOf(walked.residual) > WEIGHT_RESIDUAL_FLAG_THRESHOLD_MICROS
      ? `weights miss 1.0 by ${walked.residual}`
      : null,
    walked.cycle ? 'a component holds one of its own ancestors' : null,
    walked.depthCapped ? `look-through stopped at depth ${String(MAX_LOOK_THROUGH_DEPTH)}` : null,
  ].filter((reason): reason is string => reason !== null);

  return classificationOf({
    assetClass: dominantClassOf(walked.weights),
    region: fund.region,
    sector: fund.sector,
    expenseRatio: fund.expenseRatio ?? null,
    isCashEquivalent: fund.isCashEquivalent ?? null,
    source,
    depth: walked.depth,
    residual: walked.residual,
    flagged,
    weights: walked.weights,
    detail:
      reasons.length === 0
        ? `${fund.ticker}: decomposed into ${String(walked.weights.size)} asset classes`
        : `${fund.ticker}: ${reasons.join('; ')}`,
  });
}

/**
 * Run the waterfall. First hit wins; the winner is named in `source`.
 *
 * A user override wins outright and is never re-derived (07 §4.3 rung 1), which
 * is the whole reason `security_overlay` is a separate table a provider re-sync
 * cannot reach: `test/db/overlay.test.ts` proves the survival, and this
 * function is the half of it that decides the effective value.
 */
export function classify(
  security: ClassifiableSecurity,
  options: ClassifyOptions = {},
): Classification {
  const seed = options.seed ?? loadSeedTable();
  const lookups = options.lookups ?? {};
  const ticker = security.ticker?.trim().toUpperCase() ?? null;

  const resolveFund = (candidate: string): SeedFund | null =>
    seed.byTicker.get(candidate.toUpperCase()) ??
    lookups.edgar?.(candidate) ??
    lookups.issuer?.(candidate) ??
    null;

  // --- rung 1: USER_OVERRIDE ------------------------------------------------
  const overlay = options.overlay ?? null;
  const locked = new Set<OverlayField>(overlay?.lockedFields ?? []);
  const derived = classifyWithoutOverride(security, ticker, seed, lookups, resolveFund);
  if (overlay !== null && locked.has('asset_class') && overlay.assetClass !== null) {
    return classificationOf({
      assetClass: overlay.assetClass,
      region: locked.has('region') && overlay.region !== null ? overlay.region : derived.region,
      sector: locked.has('sector') && overlay.sector !== null ? overlay.sector : derived.sector,
      expenseRatio:
        locked.has('expense_ratio') && overlay.expenseRatio !== null
          ? overlay.expenseRatio
          : derived.expenseRatio,
      isCashEquivalent: derived.isCashEquivalent,
      source: 'USER_OVERRIDE',
      // A user's single answer replaces the decomposition rather than being
      // blended into it: "this target-date fund is bonds to me" is a statement
      // about the whole line, and half-applying it would produce a chart the
      // user cannot reconcile with what they typed.
      weights: single(overlay.assetClass),
      detail: 'the user set this; the waterfall never re-derives it (07 §4.3 rung 1)',
    });
  }

  void locked;
  return derived;
}

function classifyWithoutOverride(
  security: ClassifiableSecurity,
  ticker: string | null,
  seed: SeedTable,
  lookups: ExternalLookups,
  resolveFund: (ticker: string) => SeedFund | null,
): Classification {
  // --- rung 2: LOCAL_SEED_TABLE --------------------------------------------
  if (ticker !== null) {
    const fund = seed.byTicker.get(ticker);
    if (fund !== undefined) return fromSeedFund(fund, 'LOCAL_SEED_TABLE', resolveFund);
  }

  // --- rung 3: SEC_EDGAR (injected; absent in WP 3.1) ----------------------
  if (ticker !== null && lookups.edgar !== undefined) {
    const fund = lookups.edgar(ticker);
    if (fund !== null) return fromSeedFund(fund, 'SEC_EDGAR', resolveFund);
  }

  // --- rung 4: ISSUER_HOLDINGS (injected; absent in WP 3.1) ----------------
  if (ticker !== null && lookups.issuer !== undefined) {
    const fund = lookups.issuer(ticker);
    if (fund !== null) return fromSeedFund(fund, 'ISSUER_HOLDINGS', resolveFund);
  }

  // --- rung 5: PROVIDER -----------------------------------------------------
  // A chain is not an opinion: if this security lives on one, it is crypto.
  // `providerType` is read as well as our own `type`, because a caller that has
  // not resolved the security yet (a dry-run classification, a CSV preview) has
  // only the aggregator's word — Plaid's `cryptocurrency`, Coinbase's `CRYPTO`
  // — and answering UNCLASSIFIED for a row that plainly says what it is would
  // inflate `% unclassified`, which is the number I1 suppresses itself on.
  const providerType = (security.providerType ?? '').trim().toLowerCase();
  if (security.chain !== null || security.type === 'crypto' || providerType.includes('crypto')) {
    return classificationOf({
      assetClass: 'CRYPTO',
      region: 'GLOBAL',
      source: 'PROVIDER',
      detail: security.chain === null ? 'typed crypto' : `on chain ${security.chain}`,
    });
  }
  if (security.isCashEquivalent === true || providerType === 'cash') {
    return classificationOf({
      assetClass: 'CASH',
      region: 'UNKNOWN',
      isCashEquivalent: true,
      source: 'PROVIDER',
      detail: 'the provider reported a cash equivalent',
    });
  }

  // --- rung 6: NAME_HEURISTIC ----------------------------------------------
  const name = security.name?.trim() ?? '';
  if (name.length > 0) {
    for (const rule of NAME_RULES) {
      if (rule.pattern.test(name)) {
        return classificationOf({
          assetClass: rule.assetClass,
          region: rule.region,
          source: 'NAME_HEURISTIC',
          detail: `"${name}" matched ${String(rule.pattern)}`,
        });
      }
    }
  }

  // --- rung 7: SIC_SECTOR_MAP ----------------------------------------------
  if (security.sicCode !== null) {
    const sector = sectorForSic(security.sicCode);
    if (sector !== null) {
      return classificationOf({
        // An individual equity's *class* is not in doubt once we know it is one;
        // the SIC map's contribution is the sector. Region stays UNKNOWN because
        // state of incorporation is not something any of our sources supplies.
        assetClass: 'US_EQUITY',
        region: 'UNKNOWN',
        sector,
        source: 'SIC_SECTOR_MAP',
        detail: `SIC ${security.sicCode} → ${sector}`,
      });
    }
  }

  // --- rung 8: UNCLASSIFIED -------------------------------------------------
  return classificationOf({
    assetClass: 'UNCLASSIFIED',
    source: 'UNCLASSIFIED',
    detail: 'the waterfall ran and every rung abstained',
  });
}

// ---------------------------------------------------------------------------
// The effective value
// ---------------------------------------------------------------------------

/** The derived half: what a provider re-sync writes onto `securities`. */
export interface DerivedClassification {
  readonly assetClass: AssetClass;
  readonly region: Region;
  readonly sector: string;
  readonly expenseRatio: string | null;
  readonly classificationSource: ClassificationSource;
}

/** The user half: what they set, and which fields they locked. */
export interface StoredOverlay {
  readonly assetClass: AssetClass | null;
  readonly region: Region | null;
  readonly sector: string | null;
  readonly expenseRatio: string | null;
  readonly lockedFields: readonly OverlayField[];
}

export interface EffectiveClassification {
  readonly assetClass: AssetClass;
  readonly region: Region;
  readonly sector: string;
  readonly expenseRatio: string | null;
  readonly source: ClassificationSource;
  /** Which fields came from the user rather than from the waterfall. */
  readonly overridden: readonly OverlayField[];
}

/**
 * What a security *is*, given what we derived and what the user said.
 *
 * 04 §2.2's resolution rule, field by field: `effective(field) = overlay[field]`
 * when the field is locked, otherwise the derived value. This is the function
 * that makes `security_overlay` worth having a separate table for — a provider
 * re-sync rewrites the `securities` row freely and this answer does not move,
 * which is what `'a user asset-class override survives a provider re-sync'`
 * asserts against a real database.
 *
 * `source` reports `USER_OVERRIDE` whenever *any* field came from the user,
 * because a chart labelled with the rung that produced the half we discarded
 * would be a lie about provenance, and provenance is the entire reason 07 §4.3
 * makes `classification_source` mandatory.
 */
export function effectiveClassificationOf(
  derived: DerivedClassification,
  overlay: StoredOverlay | null,
): EffectiveClassification {
  const locked = new Set<OverlayField>(overlay?.lockedFields ?? []);
  const overridden: OverlayField[] = [];
  const pick = <T>(field: OverlayField, value: T | null, fallback: T): T => {
    if (overlay === null || !locked.has(field) || value === null) return fallback;
    overridden.push(field);
    return value;
  };

  const assetClass = pick('asset_class', overlay?.assetClass ?? null, derived.assetClass);
  const region = pick('region', overlay?.region ?? null, derived.region);
  const sector = pick('sector', overlay?.sector ?? null, derived.sector);
  const expenseRatio = pick('expense_ratio', overlay?.expenseRatio ?? null, derived.expenseRatio);

  return {
    assetClass,
    region,
    sector,
    expenseRatio,
    source: overridden.length > 0 ? 'USER_OVERRIDE' : derived.classificationSource,
    overridden,
  };
}
