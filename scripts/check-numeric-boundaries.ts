#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * The numeric-boundary check — 08 §6.5's lint rule, mechanised (WP 3.14).
 *
 * > "Never a bare number, never a float, anywhere, ever — a lint rule bans
 * > `number` in any identifier matching `/amount|balance|price|value|cost/`."
 * > — `docs/research/08-system-architecture.md` §6.5
 *
 * Phase 3's dispatch adds `quantity` to that pattern (§3 WP 3.14), because
 * Phase 3 is the first phase with `NUMERIC(38,18)` quantities in it, and the
 * §5 risk table names the failure this exists to stop:
 *
 * > "A float reaches a quantity or a price. D3 is irreversible and Phase 1
 * > already caught `toFixed(18)` manufacturing seventeen digits of garbage
 * > from `268.4`. Portfolio math multiplies quantity × price and then sums —
 * > the error compounds where nobody looks."
 *
 * ## What it reads
 *
 * `packages/**\/*.ts` and `apps/api/src/**\/*.ts`, parsed with the TypeScript
 * parser (syntax only — no `Program`, no type checker, no `tsconfig`). A
 * syntactic pass is deliberate: it is ~1s over the whole tree, it needs no
 * build, and it cannot be defeated by a `tsconfig` change. The cost is that an
 * *inferred* `number` is invisible to it unless the initialiser is literally a
 * number, which is why `NUMERIC_LITERAL` below is a rule of its own.
 *
 * ## The two rules
 *
 *   * **`number-at-a-magnitude-boundary`** — a declaration whose *name* matches
 *     `/amount|balance|price|value|cost|quantity/i` and whose *type* is
 *     `number` (including `number | null`, `number[]`, `readonly number[]`,
 *     `Record<K, number>`), or which has no type annotation and is initialised
 *     with a numeric literal. Properties, parameters, variables, return types
 *     of same-named functions, type aliases, and object-literal properties.
 *   * **`tofixed-on-a-magnitude`** — `<something matching the pattern>.toFixed(…)`.
 *     `toFixed` on a float is how Phase 1 got seventeen digits of garbage out
 *     of `268.4`; the §5 risk table asks the gate to grep for new ones, and a
 *     grep a human runs once is not a control.
 *
 * ## Exemptions, and why they are not a loophole
 *
 * The 08 pattern is a *word* filter, so it necessarily catches identifiers that
 * are not magnitudes at all: a count of price rows, a coefficient of variation
 * over amounts, a confidence score, a duration in milliseconds. Two mechanisms,
 * both narrow, both printed by `--explain`:
 *
 *   1. `DIMENSIONLESS` — name-shape categories (a cardinality, a statistic, a
 *      ratio, a duration, a confidence score, a `toNumberApproximate`-style
 *      presentation helper). §5 names the last two as legal outright.
 *   2. `ALLOW_LIST` — file + identifier + a written reason. Every entry names a
 *      thing that is genuinely not a monetary or quantity magnitude, or is the
 *      one place a provider's JSON number is converted *into* the safe type.
 *
 * Nothing here exempts a whole file or a whole directory, and there is no
 * `// eslint-disable`-shaped escape hatch: adding a violation means editing
 * this file and writing down why, in front of a reviewer.
 *
 *     node scripts/check-numeric-boundaries.ts              # self-test, then the real tree
 *     node scripts/check-numeric-boundaries.ts --self-test  # fixtures only
 *     node scripts/check-numeric-boundaries.ts --explain     # also print every exemption used
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = join(import.meta.dirname, '..');

/** 08 §6.5, plus `quantity` from the Phase 3 dispatch §3. */
export const MAGNITUDE_PATTERN = /amount|balance|price|value|cost|quantity/i;

/** The trees a magnitude can actually cross. `apps/web` is presentation and is out of scope by §6.5's own carve-out for presentation helpers. */
const SCAN_ROOTS = [join('packages'), join('apps', 'api', 'src')];

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage']);

// ---------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------

interface Dimensionless {
  readonly pattern: RegExp;
  readonly why: string;
}

/**
 * Name shapes that are dimensionless by construction. Each is anchored at the
 * end of the identifier so `priceRowsWritten` is exempt and `writtenPrice` is
 * not.
 */
const DIMENSIONLESS: readonly Dimensionless[] = [
  {
    pattern: /(count|counts|rows|written|changes|buckets|unvalued|calls)$/i,
    why: 'a cardinality',
  },
  {
    pattern: /^(time|memory|parallelism)Cost$/,
    why: 'an Argon2id work factor (`timeCost`/`memoryCost`), which is a KDF parameter and not currency',
  },
  {
    pattern: /(index|length|size|offset|depth|places|digits|scale)$/i,
    why: 'a position or a width',
  },
  {
    pattern: /(cv|mape|mad|stability|precision|recall|pct|percent|ratio|score|weight)$/i,
    why: 'a dimensionless statistic, ratio, weight or precision constant over magnitudes — not a magnitude',
  },
  {
    pattern: /(ms|millis|seconds|minutes|hours|days|months|years)$/i,
    why: 'a duration or a calendar span',
  },
  { pattern: /sign$/i, why: 'a sign (+1/−1): a direction, not a magnitude' },
  { pattern: /confidence/i, why: 'a confidence score (dispatch §5: legal outright)' },
  {
    pattern: /toNumberApproximate$/i,
    why: 'a presentation helper (dispatch §5: legal for presentation and confidence scores)',
  },
];

interface AllowEntry {
  /** Repo-relative path, exact. */
  readonly file: string;
  readonly identifier: string;
  readonly why: string;
}

/**
 * The real tree's exemptions, one line each, each naming why the thing is not
 * a monetary or quantity magnitude. Audited 2026-09-24 (WP 3.14); every entry
 * was read at its declaration, not pattern-matched.
 */
const ALLOW_LIST: readonly AllowEntry[] = [
  // --- counters keyed by a name the scanner reads as a magnitude.
  {
    file: 'packages/contexts/insights/src/policy/rule-health.ts',
    identifier: 'WRONG_AMOUNT',
    why: 'A per-reason dismissal COUNT keyed by the reason code `WRONG_AMOUNT` (WP 5.9 rule health); the zero is "no dismissals with this reason yet", never an amount.',
  },
  {
    file: 'packages/advisors/local-model/src/caps.ts',
    identifier: 'value',
    why: "A string LENGTH cap (`maxLength` of the findings envelope's evidence `value` display string, contract 1.5.0) in the adapter's sanitiser table — a character count, never an amount; the table's parity test compares it to the published schema.",
  },
  // --- the provider seam: a JSON number arrives and is converted immediately.
  {
    file: 'packages/connectors/plaid/src/amount.ts',
    identifier: 'value',
    why: "Plaid's wire format is a JSON number; this file is the one place it is converted into Money, and its whole purpose is to refuse NaN/Infinity/overflow at that seam (01 §5.3).",
  },
  {
    file: 'packages/connectors/plaid/src/map.ts',
    identifier: 'value',
    why: 'the same seam for quantities: decimalStringOf() turns one provider JSON number into a Quantity decimal string and is the only caller allowed to see it.',
  },
  // --- generic maths helpers whose parameter happens to be spelled `value`.
  {
    file: 'packages/platform/src/metrics.ts',
    identifier: 'value',
    why: 'a metrics gauge reading (a counter or a latency), never a monetary amount; the metrics port has no currency in it at all.',
  },
  {
    file: 'packages/contexts/recurring/src/stats.ts',
    identifier: 'value',
    why: 'dimensionless helpers (clamp01, sigmoid) over already-derived scores.',
  },
  {
    file: 'packages/contexts/recurring/src/stats.ts',
    identifier: 'values',
    why: 'median/mad/mean over dimensionless score inputs; the Money-valued variants live beside them and take Money.',
  },
  {
    file: 'packages/contexts/recurring/src/store.ts',
    identifier: 'value',
    why: 'scoreText() renders a confidence score for storage as text.',
  },
  {
    file: 'packages/contexts/categorization/src/db.ts',
    identifier: 'value',
    why: 'confidenceText() renders a classifier confidence, which §5 names as legal.',
  },
  {
    file: 'packages/contexts/ledger/src/transfers.ts',
    identifier: 'value',
    why: 'clamp() over a similarity score in [0,1].',
  },
  {
    file: 'packages/contexts/ledger/src/refunds.ts',
    identifier: 'value',
    why: 'round() over a similarity score in [0,1].',
  },
  {
    file: 'packages/connectors/plaid/src/amount.ts',
    identifier: 'plaidAmount',
    why: 'the same seam, named for the provider it comes from; it is a parameter of the function that converts it and never escapes as one.',
  },
  {
    file: 'packages/contexts/insights/src/validate/decimal.ts',
    identifier: 'value',
    why: "fromNumber() is the advisor engine's float -> Decimal conversion seam, and its own header says the toFixed is deliberate: it is the conversion *into* the safe type, the same shape as the Plaid seam above. Nothing downstream of it holds a float.",
  },
  // --- "cost" that is not money.
  {
    file: 'packages/contexts/integrations/src/rate-limit.ts',
    identifier: 'cost',
    why: "a rate-limiter token cost (how many of a provider's per-minute credits a call spends), not currency.",
  },
  {
    file: 'packages/contexts/integrations/src/http.ts',
    identifier: 'cost',
    why: 'the same provider-credit cost, passed to the rate limiter before a request.',
  },
  {
    file: 'packages/contexts/integrations/test/rate-limit.test.ts',
    identifier: 'cost',
    why: 'provider credits again, in the rate limiter own suite.',
  },
  {
    file: 'apps/api/src/domain.ts',
    identifier: 'cost',
    why: 'provider credits read back out of `market_data_runs.units_spent` to hydrate the limiter.',
  },
  // --- counts and ordinals whose names do not end in a cardinality word.
  {
    file: 'apps/api/src/domain.ts',
    identifier: 'seedPriceSourcePriority',
    why: 'returns how many source-priority rows were inserted — a row count, not a price.',
  },
  {
    file: 'apps/api/src/routes/investments.ts',
    identifier: 'unvaluedTransfers',
    why: 'a count of flows left out of a performance window because no FX rate was read for them (D4); the money they represent is deliberately absent.',
  },
  {
    file: 'packages/contexts/integrations/src/market-data.ts',
    identifier: 'writePrices',
    why: 'returns the number of rows written, which is what `PricesUpdated.priceRowsWritten` carries.',
  },
  {
    file: 'packages/contexts/planning/src/net-worth.ts',
    identifier: 'priced',
    why: 'a counter of how many positions carried a price, used to decide whether the day is complete.',
  },
  {
    file: 'packages/contexts/investments/src/identifiers.ts',
    identifier: 'charValue',
    why: 'a character code in the CUSIP/ISIN check-digit algorithm.',
  },
  {
    file: 'packages/connectors/csv/test/config.test.ts',
    identifier: 'amount',
    why: 'a zero-based CSV *column index* in a `mapping` object ({ date: 0, description: 1, amount: 2 }), not an amount.',
  },
  {
    file: 'packages/contexts/recurring/test/corpora/synthetic.ts',
    identifier: 'value',
    why: 'the mutable box `{ value: number }` the corpus generator uses as a monotonic id counter.',
  },
  // --- counts whose names do not end in a cardinality word.
  {
    file: 'packages/seed/src/stats.ts',
    identifier: 'prices',
    why: 'a row count in the seed summary (how many price points were generated), printed beside `transactions` and `accounts`.',
  },
  {
    file: 'packages/seed/src/transactions.ts',
    identifier: 'priceIncreaseAtMonth',
    why: 'a month index into the seed window (0-based), not a price.',
  },
  // --- WP 4.14: alias resolution now sees through `type X = number` (and
  // unions containing it), which surfaces two crossings invisible before.
  {
    file: 'packages/connectors/csv/src/csv.ts',
    identifier: 'amount',
    why: 'CsvColumnMapping.amount names WHICH column (by header text or 0-based index — `ColumnRef = string | number`) holds the signed amount for a row; it is the column reference, never the amount itself. Same shape as the `test/config.test.ts` mapping-literal exemption above, now caught on the source-side interface too because the check resolves the `ColumnRef` alias.',
  },
  {
    file: 'packages/contexts/planning/src/engine/boundary.ts',
    identifier: 'toEngineAmount',
    why: "the named boundary-crossing function itself (dispatch §5 risk 1, WP 4.4's `boundary.ts` header): converts Money -> `EngineDollars`, the interior alias for `number`, at the single legal seam, rounded once on the way back out through `fromEngineAmount`. `fromEngineAmount` takes `EngineDollars` as its `dollars` parameter rather than returning it, and `dollars` does not match the magnitude pattern, so it needs no entry of its own — the crossing is still exactly one named pair. `boundary.test.ts`'s fast-check property is the proof that Money survives the round trip; `test/reference.test.ts` (WP 4.14) is the proof that the numbers it produces are right.",
  },
];

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

export type ViolationKind = 'number-at-a-magnitude-boundary' | 'tofixed-on-a-magnitude';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly identifier: string;
  readonly kind: ViolationKind;
  readonly detail: string;
}

export interface Exemption {
  readonly file: string;
  readonly line: number;
  readonly identifier: string;
  readonly why: string;
}

export interface CheckResult {
  readonly violations: readonly Violation[];
  readonly exemptions: readonly Exemption[];
  readonly filesScanned: number;
}

/**
 * `value` / `values` as a **parameter** name is the generic-helper idiom
 * (`clamp01(value)`, `median(values)`, `gauge(name, value)`), not a claim about
 * money — and the exemption is deliberately confined to parameters: a
 * *property* named `value: number` on an interface is exactly the shape 08 §6.5
 * bans, and stays a violation. Audited 2026-09-24: every parameter this exempts
 * in the real tree is an index, a ratio, a day number, or the documented
 * float → decimal-string conversion seam.
 */
const GENERIC_PARAMETER_NAMES = new Set(['value', 'values']);
const GENERIC_PARAMETER_WHY =
  'a generic parameter binding (`value`/`values`); this repo names magnitudes for what they are ' +
  '(`amountMinor`, `balanceMinor`, `closePrice`), and the same name on a *property* is still a violation';

function exemptionFor(file: string, identifier: string, isParameter = false): string | null {
  if (isParameter && GENERIC_PARAMETER_NAMES.has(identifier)) return GENERIC_PARAMETER_WHY;
  for (const rule of DIMENSIONLESS) {
    if (rule.pattern.test(identifier)) return rule.why;
  }
  for (const entry of ALLOW_LIST) {
    if (entry.file === file && entry.identifier === identifier) return entry.why;
  }
  return null;
}

/**
 * Every `type X = <TypeNode>` declared in this file, name → its right-hand
 * side. Local only — a syntactic pass has no module graph to resolve an
 * imported alias, which is why `boundary.ts`'s `EngineDollars` (declared and
 * used in the same file) is exactly the case this closes and an alias
 * re-exported from elsewhere is not: see the file header on the alias hole.
 */
function collectTypeAliases(source: ts.SourceFile): ReadonlyMap<string, ts.TypeNode> {
  const aliases = new Map<string, ts.TypeNode>();
  function visit(node: ts.Node): void {
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node.type);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return aliases;
}

/**
 * `number`, `number | null`, `number[]`, `readonly number[]`, `Record<K, number>`,
 * `(number)` — **and, since WP 4.14, a local type alias that resolves to any
 * of those**, however many hops away (cycle-safe via `seen`).
 *
 * Before WP 4.14 this was purely syntactic on `ts.SyntaxKind.NumberKeyword`
 * and could not see `type EngineDollars = number` used as a return type: the
 * "alias hole" the Phase 4 dispatch (§5 risk 1) names by name. WP 4.4's
 * `boundary.ts` is the one place that hole is meant to be walked through on
 * purpose, which is why closing it here does not delete the crossing — it
 * turns it into a visible, written-down `ALLOW_LIST` entry instead of an
 * invisible one.
 */
function mentionsNumber(
  type: ts.TypeNode | undefined,
  aliases: ReadonlyMap<string, ts.TypeNode> = new Map(),
  seen: ReadonlySet<string> = new Set(),
): boolean {
  if (type === undefined) return false;
  if (type.kind === ts.SyntaxKind.NumberKeyword) return true;
  if (ts.isParenthesizedTypeNode(type)) return mentionsNumber(type.type, aliases, seen);
  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.some((member) => mentionsNumber(member, aliases, seen));
  }
  if (ts.isArrayTypeNode(type)) return mentionsNumber(type.elementType, aliases, seen);
  if (ts.isTypeOperatorNode(type)) return mentionsNumber(type.type, aliases, seen);
  if (ts.isTypeReferenceNode(type)) {
    if (
      type.typeArguments !== undefined &&
      // Record<string, number>, Map<string, number>, ReadonlyArray<number>, ...
      type.typeArguments.some((argument) => mentionsNumber(argument, aliases, seen))
    ) {
      return true;
    }
    const name = ts.isIdentifier(type.typeName) ? type.typeName.text : null;
    if (name !== null && !seen.has(name)) {
      const resolved = aliases.get(name);
      if (resolved !== undefined) {
        return mentionsNumber(resolved, aliases, new Set([...seen, name]));
      }
    }
  }
  return false;
}

function isNumericLiteralish(node: ts.Expression | undefined): boolean {
  if (node === undefined) return false;
  if (ts.isNumericLiteral(node)) return true;
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) {
    return node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken;
  }
  return false;
}

function nameTextOf(name: ts.Node | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  return null;
}

/**
 * Every violation in one file's text. Exported so the vitest suite can drive it
 * over fixture *strings* as well as fixture files.
 */
export function checkSource(file: string, text: string): CheckResult {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: Violation[] = [];
  const exemptions: Exemption[] = [];
  // Collected once, up front, so a `type X = number` alias is seen through
  // regardless of whether its declaration appears above or below its use.
  const aliases = collectTypeAliases(source);

  function lineOf(node: ts.Node): number {
    return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  }

  function report(node: ts.Node, identifier: string, kind: ViolationKind, detail: string): void {
    if (!MAGNITUDE_PATTERN.test(identifier)) return;
    const why = exemptionFor(file, identifier, ts.isParameter(node));
    if (why !== null) {
      exemptions.push({ file, line: lineOf(node), identifier, why });
      return;
    }
    violations.push({ file, line: lineOf(node), identifier, kind, detail });
  }

  function visit(node: ts.Node): void {
    // --- declarations with a name and a type annotation.
    if (
      ts.isPropertySignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isVariableDeclaration(node)
    ) {
      const identifier = nameTextOf(node.name);
      if (identifier !== null) {
        if (mentionsNumber(node.type, aliases)) {
          report(
            node,
            identifier,
            'number-at-a-magnitude-boundary',
            `\`${identifier}\` is typed \`number\`. Money is \`bigint\` minor units + a currency; a quantity, a price and an FX rate are decimal strings (08 §6.5).`,
          );
        } else if (
          node.type === undefined &&
          (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
          isNumericLiteralish(node.initializer)
        ) {
          report(
            node,
            identifier,
            'number-at-a-magnitude-boundary',
            `\`${identifier}\` is initialised with a numeric literal, so it infers \`number\`. ` +
              'Money is `bigint` minor units + a currency; a quantity, a price and an FX rate are decimal strings (08 §6.5).',
          );
        }
      }
    }

    // --- a same-named function that returns `number`.
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node)) &&
      mentionsNumber(node.type, aliases)
    ) {
      const identifier = nameTextOf(node.name);
      if (identifier !== null) {
        report(
          node,
          identifier,
          'number-at-a-magnitude-boundary',
          `\`${identifier}()\` returns \`number\`.`,
        );
      }
    }

    // --- `type Price = number`.
    if (ts.isTypeAliasDeclaration(node) && mentionsNumber(node.type, aliases)) {
      report(
        node,
        node.name.text,
        'number-at-a-magnitude-boundary',
        `\`type ${node.name.text}\` resolves to \`number\`.`,
      );
    }

    // --- `{ price: 268.42 }` — a float in an object literal, the fixture shape.
    if (ts.isPropertyAssignment(node) && isNumericLiteralish(node.initializer)) {
      const identifier = nameTextOf(node.name);
      if (identifier !== null) {
        report(
          node,
          identifier,
          'number-at-a-magnitude-boundary',
          `\`${identifier}\` is assigned the numeric literal \`${node.initializer.getText(source)}\`.`,
        );
      }
    }

    // --- `<magnitude>.toFixed(...)`.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'toFixed'
    ) {
      const receiver = node.expression.expression;
      const identifier = ts.isIdentifier(receiver)
        ? receiver.text
        : ts.isPropertyAccessExpression(receiver)
          ? receiver.name.text
          : null;
      if (identifier !== null) {
        report(
          node,
          identifier,
          'tofixed-on-a-magnitude',
          `\`${identifier}.toFixed(…)\` formats a float. Phase 1 caught \`toFixed(18)\` manufacturing seventeen digits of garbage from \`268.4\` (§5 risk table).`,
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return { violations, exemptions, filesScanned: 1 };
}

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

export function collectFiles(root: string): string[] {
  const found: string[] = [];
  function walk(directory: string): void {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
      const full = join(directory, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        found.push(full);
      }
    }
  }
  walk(root);
  return found;
}

export function checkTree(repoRoot: string, roots: readonly string[] = SCAN_ROOTS): CheckResult {
  const violations: Violation[] = [];
  const exemptions: Exemption[] = [];
  let filesScanned = 0;

  for (const root of roots) {
    for (const absolute of collectFiles(join(repoRoot, root))) {
      const file = relative(repoRoot, absolute).split(sep).join('/');
      const result = checkSource(file, readFileSync(absolute, 'utf8'));
      violations.push(...result.violations);
      exemptions.push(...result.exemptions);
      filesScanned += 1;
    }
  }

  return { violations, exemptions, filesScanned };
}

// ---------------------------------------------------------------------------
// --self-test: the fixtures, never the real tree.
// ---------------------------------------------------------------------------

export const BAD_FIXTURE = 'scripts/fixtures/numeric-bad.ts';
export const GOOD_FIXTURE = 'scripts/fixtures/numeric-good.ts';

/** Every identifier `numeric-bad.ts` must be caught on, so a weakened rule cannot pass the self-test by catching only one of them. */
export const EXPECTED_BAD_IDENTIFIERS: readonly string[] = [
  'price',
  'quantity',
  'costBasis',
  'marketValue',
  'balanceMinor',
  'amounts',
  'totalValue',
  'rawQuantity',
];

export function runSelfTest(repoRoot: string): string[] {
  const failures: string[] = [];

  const bad = checkSource(BAD_FIXTURE, readFileSync(join(repoRoot, BAD_FIXTURE), 'utf8'));
  const caught = new Set(bad.violations.map((violation) => violation.identifier));
  for (const identifier of EXPECTED_BAD_IDENTIFIERS) {
    if (!caught.has(identifier)) {
      failures.push(
        `${BAD_FIXTURE}: expected a violation on \`${identifier}\` and found none — the rule is weaker than it was.`,
      );
    }
  }
  if (!bad.violations.some((violation) => violation.kind === 'tofixed-on-a-magnitude')) {
    failures.push(`${BAD_FIXTURE}: expected a tofixed-on-a-magnitude violation and found none.`);
  }

  const good = checkSource(GOOD_FIXTURE, readFileSync(join(repoRoot, GOOD_FIXTURE), 'utf8'));
  for (const violation of good.violations) {
    failures.push(
      `${GOOD_FIXTURE}:${String(violation.line)}: expected clean, but \`${violation.identifier}\` was flagged — the rule now catches things that are not magnitudes.`,
    );
  }
  if (good.exemptions.length === 0) {
    failures.push(
      `${GOOD_FIXTURE}: expected the dimensionless categories to be exercised and none were.`,
    );
  }

  return failures;
}

function main(): number {
  const selfTestOnly = process.argv.includes('--self-test');
  const explain = process.argv.includes('--explain');

  const failures = runSelfTest(REPO_ROOT);
  if (failures.length > 0) {
    console.error('check-numeric-boundaries: SELF-TEST FAILED');
    for (const failure of failures) console.error(`  - ${failure}`);
    return 1;
  }
  console.log(
    `check-numeric-boundaries: self-test PASS (${String(EXPECTED_BAD_IDENTIFIERS.length)} bad ` +
      'declarations caught, the good fixture clean)',
  );
  if (selfTestOnly) return 0;

  const result = checkTree(REPO_ROOT);

  if (explain) {
    const seen = new Set<string>();
    for (const exemption of result.exemptions) {
      const key = `${exemption.file}:${exemption.identifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  exempt ${key} — ${exemption.why}`);
    }
  }

  if (result.violations.length > 0) {
    console.error(
      `check-numeric-boundaries: FAIL — ${String(result.violations.length)} violation(s) ` +
        `in ${String(result.filesScanned)} file(s)\n`,
    );
    for (const violation of result.violations) {
      console.error(`  ${violation.file}:${String(violation.line)} [${violation.kind}]`);
      console.error(`    ${violation.detail}`);
    }
    console.error(
      "\n  Money is `bigint` minor units + a currency (`@core/kernel`'s Money); a quantity is a\n" +
        '  decimal string (`Quantity`, NUMERIC(38,18)); a price and an FX rate are decimal strings\n' +
        '  (NUMERIC(20,10)). If the identifier is genuinely not a magnitude, add it to ALLOW_LIST in\n' +
        '  scripts/check-numeric-boundaries.ts with a reason.',
    );
    return 1;
  }

  console.log(
    `check-numeric-boundaries: PASS — ${String(result.filesScanned)} file(s) scanned, ` +
      `0 violations, ${String(new Set(result.exemptions.map((e) => `${e.file}:${e.identifier}`)).size)} ` +
      'exempt identifier(s) (run with --explain to list them).',
  );
  return 0;
}

if (process.argv[1] === import.meta.filename) {
  process.exit(main());
}
