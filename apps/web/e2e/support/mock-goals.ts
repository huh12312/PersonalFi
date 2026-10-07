// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * The goals / risk-profile / scenario-fork routes (WP 9.7, C-10), as a layerable mock: moved out of
 * `goals.spec.ts` by WP 9.8 so `a11y-sweep.spec.ts` can visit `/goals` and `/plan` with the same
 * field-for-field bodies. Install it **after** `installPlanMocks` (`page.route` handlers registered later win;
 * `route.fallback()` hands everything else down).
 *
 * Every body below is a field-for-field instance of the contract's own schema (the generated client's
 * types), and the instrument is the real `risk-v1`'s six questions.
 */

export const usd = (minor: string) => ({ minor, currency: 'USD' });

export interface GoalRow {
  id: string;
  kind: string;
  name: string;
  target: { minor: string; currency: string };
  targetDate: string;
  priority: number;
  fundedFromAccountIds: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContributionRow {
  id: string;
  goalId: string;
  cadence: string;
  amount: { minor: string; currency: string };
  escalationPct: string;
  startsOn: string;
  endsOn: string | null;
  source: string;
  derivedAsOf: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `risk-v1`'s six questions, option ids and points exactly as `packages/contexts/planning/src/risk-profile.ts` ships them. */
const INSTRUMENT_ITEMS = [
  {
    id: 'drawdown.stated',
    disposition: 'drawdown',
    framing: 'stated',
    prompt:
      'Suppose your long-term investments fell 25% over a few months, and nobody could tell you whether they would fall further. What would you do?',
    options: [
      { id: 'sell_all', label: 'Sell everything and move to cash', points: 1 },
      { id: 'sell_some', label: 'Sell some of it to limit further losses', points: 2 },
      { id: 'hold_pause', label: 'Hold, but stop adding new money until it recovers', points: 3 },
      { id: 'hold', label: 'Hold and keep contributing as planned', points: 4 },
      { id: 'buy_more', label: 'Invest extra while prices are lower', points: 5 },
    ],
  },
  {
    id: 'drawdown.revealed',
    disposition: 'drawdown',
    framing: 'revealed',
    prompt:
      'Think of the last time investments you held fell sharply — 2022, March 2020, or any fall of 20% or more. What did you actually do at the time?',
    options: [
      { id: 'sold_all', label: 'I sold all or most of it', points: 1 },
      { id: 'sold_some', label: 'I sold some of it', points: 2 },
      { id: 'paused', label: 'I kept it but stopped or cut my contributions', points: 3 },
      { id: 'held', label: 'I changed nothing', points: 4 },
      { id: 'bought', label: 'I added money on purpose because prices had fallen', points: 5 },
      {
        id: 'no_evidence',
        label: "I haven't held investments through a fall like that",
        points: null,
      },
    ],
  },
  {
    id: 'volatility.stated',
    disposition: 'volatility',
    framing: 'stated',
    prompt:
      'You invest $10,000 for one year. Which range of possible outcomes would you choose? Wider ranges have higher average outcomes.',
    options: [
      { id: 'range_narrowest', label: '$9,800 to $10,600', points: 1 },
      { id: 'range_narrow', label: '$9,200 to $11,000', points: 2 },
      { id: 'range_middle', label: '$8,500 to $11,500', points: 3 },
      { id: 'range_wide', label: '$7,500 to $12,200', points: 4 },
      { id: 'range_widest', label: '$6,500 to $13,000', points: 5 },
    ],
  },
  {
    id: 'volatility.revealed',
    disposition: 'volatility',
    framing: 'revealed',
    prompt:
      'Roughly what share of your long-term savings is in stocks or stock funds today, counting retirement accounts?',
    options: [
      { id: 'stocks_under_20', label: 'Less than a fifth', points: 1 },
      { id: 'stocks_20_to_40', label: 'A fifth to two fifths', points: 2 },
      { id: 'stocks_40_to_60', label: 'About half', points: 3 },
      { id: 'stocks_60_to_80', label: 'Three fifths to four fifths', points: 4 },
      { id: 'stocks_over_80', label: 'More than four fifths', points: 5 },
      { id: 'no_evidence', label: "I don't have long-term savings invested yet", points: null },
    ],
  },
  {
    id: 'risk_identity.stated',
    disposition: 'risk_identity',
    framing: 'stated',
    prompt: 'How would you describe yourself when it comes to financial risk?',
    options: [
      { id: 'avoid', label: 'I avoid it wherever I can', points: 1 },
      { id: 'cautious', label: 'I accept a little, reluctantly', points: 2 },
      { id: 'balanced', label: 'I weigh it against the reward, case by case', points: 3 },
      { id: 'willing', label: 'I am comfortable with it for a better long-run return', points: 4 },
      { id: 'seek', label: 'I look for it; higher risk is how returns are earned', points: 5 },
    ],
  },
  {
    id: 'risk_identity.revealed',
    disposition: 'risk_identity',
    framing: 'revealed',
    prompt:
      'Over the last few years, when you had money to set aside, where did most of it actually go?',
    options: [
      { id: 'cash', label: 'A savings account or cash', points: 1 },
      { id: 'mostly_safe', label: 'Mostly cash or bonds, a little in stocks', points: 2 },
      { id: 'split', label: 'Roughly even between safe savings and stock investments', points: 3 },
      { id: 'mostly_stocks', label: 'Mostly stock investments', points: 4 },
      {
        id: 'concentrated',
        label: 'Individual stocks, crypto, or other concentrated bets',
        points: 5,
      },
      { id: 'no_evidence', label: 'I have not had money to set aside', points: null },
    ],
  },
];

const TOLERANCES = [
  'conservative',
  'moderate_conservative',
  'moderate',
  'moderate_aggressive',
  'aggressive',
] as const;

/**
 * A stand-in for the server's derivation with the property the exit test is about: when what the holder
 * says and what they did disagree, the score follows the lower of the two and a penalty is recorded. (The
 * real derivation is `deriveTolerance`, proven in `packages/contexts/planning/test/risk-profile.test.ts`.)
 */
function derive(answers: Record<string, string>) {
  const points = (itemId: string): number | null => {
    const item = INSTRUMENT_ITEMS.find((candidate) => candidate.id === itemId);
    return item?.options.find((option) => option.id === answers[itemId])?.points ?? null;
  };
  let unpenalised = 0;
  let credited = 0;
  for (const disposition of ['drawdown', 'volatility', 'risk_identity']) {
    const stated = points(`${disposition}.stated`) ?? 3;
    const revealed = points(`${disposition}.revealed`) ?? 3;
    unpenalised += Math.round((stated + revealed) / 2);
    credited += Math.min(stated, revealed);
  }
  const band = Math.min(4, Math.max(0, Math.floor((credited - 3) / 3)));
  const averagedBand = Math.min(4, Math.max(0, Math.floor((unpenalised - 3) / 3)));
  return {
    unpenalised,
    credited,
    penalty: unpenalised - credited,
    tolerance: TOLERANCES[band] as (typeof TOLERANCES)[number],
    averaged: TOLERANCES[averagedBand] as (typeof TOLERANCES)[number],
  };
}

export interface GoalsServer {
  goals: GoalRow[];
  contributions: ContributionRow[];
  riskCurrent: Record<string, unknown> | null;
  riskPuts: unknown[];
  goalPosts: unknown[];
  goalPatches: unknown[];
  contributionPosts: unknown[];
  forkPosts: unknown[];
  scenarios: Array<Record<string, unknown>>;
}

const BASELINE = {
  kind: 'baseline',
  id: 'scenario-baseline',
  name: 'Baseline',
  profile: {
    birthDate: '1985-04-12',
    retirementAge: 65,
    planEndAge: 95,
    currency: 'USD',
    glidepath: { kind: 'age_based' },
    contributionGrowth: 'wage',
    annualSpending: null,
    withdrawalPolicy: 'guardrails',
    spendingFloor: 'essential_spend',
    taxDeferredRate: '0.22',
    socialSecurity: null,
    pensions: [],
    contributions: null,
  },
  seed: 'seed-baseline-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function percentiles() {
  return [
    { index: 0, age: 41, calendarYear: 2026, p50: 4_000_000 },
    { index: 1, age: 53, calendarYear: 2038, p50: 11_000_000 },
    { index: 2, age: 65, calendarYear: 2050, p50: 18_000_000 },
  ].map((row) => ({
    index: row.index,
    age: row.age,
    calendarYear: row.calendarYear,
    p5: usd(String(Math.round(row.p50 * 0.6))),
    p10: usd(String(Math.round(row.p50 * 0.7))),
    p25: usd(String(Math.round(row.p50 * 0.85))),
    p50: usd(String(row.p50)),
    p75: usd(String(Math.round(row.p50 * 1.15))),
    p90: usd(String(Math.round(row.p50 * 1.3))),
    p95: usd(String(Math.round(row.p50 * 1.45))),
  }));
}

function projection(scenarioId: string, successProbability: string) {
  return {
    status: 'computed',
    run: {
      id: `run-${scenarioId}`,
      scenarioId,
      scenarioKind: scenarioId === 'scenario-baseline' ? 'baseline' : 'fork',
      method: 'monte_carlo',
      seed: 'seed-baseline-1',
      paths: 10_000,
      engineVersion: 'engine-1',
      assumptionsVersion: 'assumptions-1',
      asOfDate: '2026-10-03',
      balancesSealed: true,
      currency: 'USD',
      successProbability,
      durationMs: 400,
      createdAt: '2026-10-04T00:00:00.000Z',
    },
    percentiles: percentiles(),
    staleness: null,
  };
}

export async function installGoalsMocks(page: Page): Promise<GoalsServer> {
  const server: GoalsServer = {
    goals: [],
    contributions: [],
    riskCurrent: null,
    riskPuts: [],
    goalPosts: [],
    goalPatches: [],
    contributionPosts: [],
    forkPosts: [],
    scenarios: [BASELINE],
  };

  await page.route('**/api/goals**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname.replace(/^\/api/, '');

    if (path === '/goals' && method === 'GET') return route.fulfill(json({ goals: server.goals }));
    if (path === '/goals' && method === 'POST') {
      const body = request.postDataJSON() as Omit<GoalRow, 'id' | 'status'>;
      server.goalPosts.push(body);
      const created: GoalRow = {
        ...body,
        id: `00000000-0000-4000-8000-00000000000${String(server.goals.length + 1)}`,
        fundedFromAccountIds: [],
        status: 'active',
        priority: body.priority ?? 3,
        createdAt: '2026-10-06T00:00:00.000Z',
        updatedAt: '2026-10-06T00:00:00.000Z',
      };
      server.goals.push(created);
      return route.fulfill(json(created, 201));
    }

    const goalMatch = /^\/goals\/([^/]+)$/.exec(path);
    if (goalMatch !== null && method === 'PATCH') {
      const body = request.postDataJSON() as Partial<GoalRow>;
      server.goalPatches.push(body);
      const goal = server.goals.find((g) => g.id === goalMatch[1]);
      if (goal === undefined) return route.fulfill(json({ code: 'planning.goal_not_found' }, 404));
      Object.assign(goal, body);
      return route.fulfill(json(goal));
    }
    if (goalMatch !== null && method === 'DELETE') {
      server.goals = server.goals.filter((g) => g.id !== goalMatch[1]);
      server.contributions = server.contributions.filter((c) => c.goalId !== goalMatch[1]);
      return route.fulfill(json({ deleted: true }));
    }

    const contributionsMatch = /^\/goals\/([^/]+)\/contributions$/.exec(path);
    if (contributionsMatch !== null && method === 'GET') {
      return route.fulfill(
        json({
          contributions: server.contributions.filter((c) => c.goalId === contributionsMatch[1]),
        }),
      );
    }
    if (contributionsMatch !== null && method === 'POST') {
      const body = request.postDataJSON() as Partial<ContributionRow>;
      server.contributionPosts.push(body);
      const created: ContributionRow = {
        id: `00000000-0000-4000-8000-0000000000c${String(server.contributions.length + 1)}`,
        goalId: contributionsMatch[1] as string,
        cadence: body.cadence as string,
        amount: body.amount as ContributionRow['amount'],
        escalationPct: body.escalationPct ?? '0',
        startsOn: body.startsOn as string,
        endsOn: body.endsOn ?? null,
        source: body.source as string,
        derivedAsOf: null,
        createdAt: '2026-10-06T00:00:00.000Z',
        updatedAt: '2026-10-06T00:00:00.000Z',
      };
      server.contributions.push(created);
      return route.fulfill(json(created, 201));
    }
    const contributionMatch = /^\/goals\/([^/]+)\/contributions\/([^/]+)$/.exec(path);
    if (contributionMatch !== null && method === 'DELETE') {
      server.contributions = server.contributions.filter((c) => c.id !== contributionMatch[2]);
      return route.fulfill(json({ deleted: true }));
    }
    return route.fallback();
  });

  await page.route('**/api/risk-profile', async (route: Route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      return route.fulfill(
        json({ instrument: 'risk-v1', items: INSTRUMENT_ITEMS, current: server.riskCurrent }),
      );
    }
    if (request.method() === 'PUT') {
      const body = request.postDataJSON() as {
        answers: Record<string, string>;
        horizonYears: number;
        liquidityNeed: string;
      };
      server.riskPuts.push(body);
      const derived = derive(body.answers);
      const profile = {
        id: '00000000-0000-4000-8000-0000000000a1',
        tolerance: derived.tolerance,
        compositeScore: derived.credited,
        unpenalisedScore: derived.unpenalised,
        consistencyPenalty: derived.penalty,
        horizonYears: body.horizonYears,
        taxBracketBand: null,
        liquidityNeed: body.liquidityNeed,
        answeredAt: '2026-10-06T12:00:00.000Z',
      };
      server.riskCurrent = profile;
      return route.fulfill(
        json({
          profile,
          derivation: {
            instrument: 'risk-v1',
            tolerance: derived.tolerance,
            compositeScore: derived.credited,
            unpenalisedScore: derived.unpenalised,
            consistencyPenalty: derived.penalty,
            toleranceIfAveraged: derived.averaged,
            dispositions: [],
            explanation:
              derived.penalty > 0
                ? [
                    'What you said and what you did disagree, so the score follows the more cautious of the two.',
                  ]
                : [],
          },
        }),
      );
    }
    return route.fallback();
  });

  await page.route('**/api/plan/scenarios', async (route: Route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill(json({ scenarios: server.scenarios }));
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as { kind: string; name: string; levers: unknown };
      server.forkPosts.push(body);
      const fork = {
        kind: 'fork',
        id: `scenario-fork-${String(server.scenarios.length)}`,
        baselineId: 'scenario-baseline',
        name: body.name,
        levers: body.levers,
        createdAt: '2026-10-06T00:00:00.000Z',
        updatedAt: '2026-10-06T00:00:00.000Z',
      };
      server.scenarios.push(fork);
      return route.fulfill(json(fork, 201));
    }
    return route.fallback();
  });

  await page.route('**/api/plan/scenarios/*/projections', async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const id = /scenarios\/([^/]+)\/projections/.exec(route.request().url())?.[1] ?? '';
    return route.fulfill(json(projection(id, id === 'scenario-baseline' ? '0.82' : '0.74')));
  });

  await page.route('**/api/plan/compare**', async (route: Route) => {
    const url = new URL(route.request().url());
    const a = url.searchParams.get('a') ?? '';
    const b = url.searchParams.get('b') ?? '';
    return route.fulfill(
      json({
        a: projection(a, a === 'scenario-baseline' ? '0.82' : '0.74'),
        b: projection(b, b === 'scenario-baseline' ? '0.82' : '0.74'),
        seed: 'seed-baseline-1',
        successProbabilityDelta: '-0.08',
        retirementDate: { a: '2050-04-12', b: '2047-04-12' },
        retirementDeltaMonths: -36,
      }),
    );
  });

  return server;
}
