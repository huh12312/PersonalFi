// SPDX-License-Identifier: MIT
/**
 * The findings `scripts/advisor-eval.ts` narrates (WP 5.3): the correctness
 * seed and WP 4.13's scale seed, each built into a real snapshot by the real
 * `SnapshotBuilder`, run through the real built-in catalogue and the real
 * validator, laundered against the narrator's bound and redacted for a
 * `local_model` reader (`findingsFromSnapshot`).
 *
 * ## The correctness seed
 *
 * `packages/contexts/insights/test/advisors/seed.ts`'s `drift` and `tight`
 * cases — the ones every catalogue golden runs against. Used as they are.
 *
 * ## The scale seed, and what this adapter assumes about it
 *
 * `generatePhase4Scale(1)` is a *performance* dataset (200 positions across
 * eleven accounts, five years of daily prices, two goals) and carries less
 * than the insights ports ask for. The adapter maps what it has and states
 * every gap rather than inventing around it:
 *
 *   * **Positions** — every USD holding at its last close (`quantity × close`,
 *     exact decimal, half-even to the cent). The `cad-brokerage` account's five
 *     positions are left out rather than converted: FX is not what this
 *     evaluation measures.
 *   * **Asset class** — the seed has none. `crypto-wallet` positions are
 *     `crypto` (the account says so); every other position is `us_equity`.
 *     That is a label, not a classification, and it is why no allocation
 *     target is set (no drift finding is manufactured from it).
 *   * **Cost basis, lots, expense ratios** — none in the seed, so `null` /
 *     empty, never zero (the ports' own rule: unknown is not free).
 *   * **Custody** — `crypto-wallet` is an exchange account (`exchangeValue`).
 *   * **Net worth** — the last day of `netWorthDaily`, per account, as the
 *     ledger's account list; its month-ends as the trend.
 *   * **Goals** — the seed's two goals with their monthly contribution as
 *     `plannedMonthly`, and `requiredMonthly` = target ÷ whole months to the
 *     target date with nothing funded (`fundedRatio` 0): a simplification of
 *     WP 4.6's pace, stated here, because the seed links no balance to a goal.
 *
 * Nothing from this file reaches production; it exists so the ≥ 20 findings
 * the dispatch asks for include some the correctness seed does not make.
 */
import { DateOnly, Money } from '../packages/kernel/src/index.ts';
import { generatePhase4Scale } from '../packages/seed/src/index.ts';
import {
  findingsFromSnapshot,
  type EvalCase,
} from '../packages/contexts/insights/src/advisors/local/eval.ts';
import { SnapshotBuilder } from '../packages/contexts/insights/src/snapshot/builder.ts';
import {
  inMemoryBudgetPort,
  inMemoryInvestmentsPort,
  inMemoryLedgerPort,
  inMemoryMarketDataPort,
  inMemoryPlanningPort,
  inMemoryRecurringPort,
  type InsightsGoal,
  type InsightsHoldings,
  type InsightsPosition,
} from '../packages/contexts/insights/src/snapshot/ports.ts';
import { deriveTokenKey } from '../packages/contexts/insights/src/snapshot/tokens.ts';
import { ADVISOR_SCOPES } from '../packages/contexts/insights/src/contract/scopes.ts';
import * as decimal from '../packages/contexts/insights/src/validate/decimal.ts';
import { TODAY, seedSnapshot } from '../packages/contexts/insights/test/advisors/seed.ts';

const SCALE_USER = '01930000-0000-7000-8000-00000000e5ca';

function minorOf(quantity: string, close: string): bigint {
  const q = decimal.parseDecimal(quantity);
  const c = decimal.parseDecimal(close);
  const hundred = decimal.parseDecimal('100');
  if (q === null || c === null || hundred === null) return 0n;
  const product = decimal.multiply(decimal.multiply(q, c) ?? q, hundred);
  const rendered = product === null ? null : decimal.render(product, 0);
  return rendered === null ? 0n : BigInt(rendered);
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return Math.max(1, (ty - fy) * 12 + (tm - fm));
}

/** WP 4.13's scale seed, as an insights snapshot. See the header for every assumption. */
export async function scaleSnapshot(): Promise<{
  readonly snapshot: object;
  readonly today: string;
}> {
  const data = generatePhase4Scale(1);
  const today = data.asOf.toString();
  const accounts = new Map(data.accounts.map((account) => [account.id, account]));
  const symbols = new Map(data.securities.map((security) => [security.id, security.symbol]));
  const lastClose = new Map<string, string>();
  for (const price of data.prices) lastClose.set(price.securityId, price.close);

  const positions: InsightsPosition[] = [];
  for (const holding of data.holdings) {
    const account = accounts.get(holding.accountId);
    if (account === undefined || account.currency !== 'USD') continue;
    const crypto = account.name === 'crypto-wallet';
    const value = Money.of(
      minorOf(holding.quantity, lastClose.get(holding.securityId) ?? '0'),
      'USD',
    );
    positions.push({
      securityId: holding.securityId,
      symbol: symbols.get(holding.securityId) ?? null,
      assetClass: crypto ? 'crypto' : 'us_equity',
      accountType:
        account.bucket === 'TAXABLE'
          ? 'taxable'
          : account.bucket === 'TAX_DEFERRED'
            ? 'tax_deferred'
            : 'tax_free',
      quantity: holding.quantity,
      costBasis: null,
      marketValue: value,
      unrealized: null,
      oldestLotDays: 365,
      isCrypto: crypto,
      isStablecoin: false,
      employerStock: false,
      expenseRatio: null,
      peerExpenseRatio: null,
      annualFeeCost: null,
      highFee: false,
      lots: [],
    });
  }
  const total = positions.reduce((sum, position) => sum + position.marketValue.minor, 0n);
  const weight = (minor: bigint): number =>
    total === 0n ? 0 : Number((minor * 1_000_000n) / total) / 1_000_000;
  const byClass = new Map<string, bigint>();
  const byTreatment = new Map<string, bigint>();
  for (const position of positions) {
    byClass.set(
      position.assetClass,
      (byClass.get(position.assetClass) ?? 0n) + position.marketValue.minor,
    );
    byTreatment.set(
      position.accountType,
      (byTreatment.get(position.accountType) ?? 0n) + position.marketValue.minor,
    );
  }
  const cryptoMinor = byClass.get('crypto') ?? 0n;
  const holdings: InsightsHoldings = {
    currency: 'USD',
    positions,
    aggregate: {
      investableTotal: Money.of(total, 'USD'),
      unclassifiedPct: 0,
      byAssetClass: [...byClass.entries()].map(([assetClass, minor]) => ({
        assetClass,
        value: Money.of(minor, 'USD'),
        weight: weight(minor),
      })),
      positions: positions.map((position) => ({
        securityId: position.securityId,
        symbol: position.symbol,
        value: position.marketValue,
        weight: weight(position.marketValue.minor),
        assetClass: position.assetClass,
        employerStock: false,
        isCrypto: position.isCrypto,
      })),
      targets: [],
      accountTypeMix: Object.fromEntries(
        [...byTreatment.entries()].map(([treatment, minor]) => [treatment, weight(minor)]),
      ),
      idleCash: null,
      cryptoCustody: {
        exchangeValue: Money.of(cryptoMinor, 'USD'),
        selfCustodyValue: Money.zero('USD'),
        unknownValue: Money.zero('USD'),
      },
    },
  };

  const last = data.netWorthDaily[data.netWorthDaily.length - 1];
  const ledgerAccounts = (last?.byAccount ?? []).map((row) => ({
    id: row.accountId,
    type: 'other' as const,
    isCash: false,
    balance: Money.of(BigInt(row.baseMinor), 'USD'),
    apy: null,
    closed: false,
  }));
  const monthEnds = new Map<string, bigint>();
  for (const point of data.netWorthDaily) {
    monthEnds.set(point.date.toString().slice(0, 7), BigInt(point.netWorthMinor));
  }
  const trend = [...monthEnds.entries()].map(([month, minor]) => ({
    month,
    netWorth: Money.of(minor, 'USD'),
  }));

  const goals: InsightsGoal[] = data.goals.map((goal) => {
    const months = monthsBetween(today, goal.targetDate.toString());
    const targetMinor = BigInt(goal.target.minor);
    const planned = data.contributions.find((entry) => entry.goalId === goal.id);
    const plannedMinor = planned === undefined ? 0n : BigInt(planned.amount.minor);
    const requiredMinor = (targetMinor + BigInt(months) - 1n) / BigInt(months);
    return {
      id: goal.id,
      name: goal.name,
      target: Money.of(targetMinor, goal.target.currency),
      monthsRemaining: months,
      fundedRatio: '0.000000',
      status: plannedMinor >= requiredMinor ? 'on_track' : 'off_track',
      requiredMonthly: Money.of(requiredMinor, goal.target.currency),
      plannedMonthly: Money.of(plannedMinor, goal.target.currency),
    };
  });

  const built = await new SnapshotBuilder({
    ledger: inMemoryLedgerPort({ accounts: ledgerAccounts, netWorthTrend: trend }),
    budget: inMemoryBudgetPort(null),
    recurring: inMemoryRecurringPort([]),
    investments: inMemoryInvestmentsPort({ holdings }),
    marketData: inMemoryMarketDataPort(null),
    planning: inMemoryPlanningPort({ goals }),
  }).build({
    userId: SCALE_USER,
    kind: 'builtin',
    grantedScopes: ADVISOR_SCOPES,
    today: DateOnly.parse(today),
    baseCurrency: 'USD',
    tokenKey: deriveTokenKey('wp-5-3-scale', SCALE_USER),
  });
  return { snapshot: built.snapshot, today };
}

/** Every case, in a fixed order: drift, tight, then scale. */
export async function evalCases(): Promise<{
  readonly cases: readonly EvalCase[];
  readonly today: string;
}> {
  const drift = await findingsFromSnapshot('drift', await seedSnapshot('drift'), TODAY);
  const tight = await findingsFromSnapshot('tight', await seedSnapshot('tight'), TODAY);
  const scale = await scaleSnapshot();
  const scaleCases = await findingsFromSnapshot('scale', scale.snapshot, scale.today);
  return { cases: [...drift, ...tight, ...scaleCases], today: TODAY };
}
