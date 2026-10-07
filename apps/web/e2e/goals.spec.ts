// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';

import { expectNoAxeViolations, injectAxe } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installPlanMocks } from './support/mock-plan.ts';
import { screenshotDir } from './support/screenshot-dir.ts';

/**
 * WP 9.7 / C-10 (`docs/plan/09-phase-9-dispatch.md` §3 "WP 9.7", §6 Q5 default build): goals, the risk
 * questionnaire and scenario forking, on screen. Three exit tests, verbatim:
 *
 *   * `'a goal can be created, edited, funded and deleted by keyboard alone'`
 *   * `'the questionnaire produces a risk profile the plan reads'`
 *   * `'a scenario can be forked and compared'`
 *
 * plus axe clean in both themes and the walk of 04 §5 item 3's on-screen steps (the evidence).
 *
 * ## The mocks are this file's own
 *
 * `support/mock-plan.ts` answers the session and the plan routes; this file layers `/goals`,
 * `/risk-profile` and a forkable `/plan/scenarios` on top of it (`page.route` handlers registered later
 * win; `route.fallback()` hands everything else down) — the `accounts-overrides.spec.ts` pattern.
 * `support/**` is the orchestrator's, so no shared mock changes: `wp9.7-plan-screens.md` §7 gives the
 * handlers' shapes for the shared mock.
 *
 * Every body below is a field-for-field instance of the contract's own schema (the generated client's
 * types), and the instrument is the real `risk-v1`'s six questions.
 */
interface EvidenceDirOptions {
  readonly evidenceDir?: string;
}

const test = base.extend<EvidenceDirOptions>({
  evidenceDir: [undefined, { option: true }],
});

let currentEvidenceDir: string | undefined;
test.beforeEach(({ evidenceDir }) => {
  currentEvidenceDir = evidenceDir;
});

/**
 * The app shell scrolls inside `<main>`, so a full-page capture clips it to one viewport (and photographs the
 * dev-only devtools panels). Grow the viewport until `<main>` shows all of its content, shoot `<main>`, restore.
 */
async function shootMain(page: Page, path: string): Promise<void> {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 2600 });
  await page.locator('main').screenshot({ path });
  if (original !== null) await page.setViewportSize(original);
}

async function shoot(page: Page, name: string): Promise<void> {
  await shootMain(page, `${screenshotDir(currentEvidenceDir)}wp9.7-${name}.png`);
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('personalfi:theme', value);
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // Colours transition on a theme change; measure (and photograph) them settled.
  await settled(page);
}

/** One screenshot per theme, light first, leaving the page in light. */
async function shootBothThemes(page: Page, name: string): Promise<void> {
  await setTheme(page, 'dark');
  await shoot(page, `${name}-dark`);
  await setTheme(page, 'light');
  await shoot(page, `${name}-light`);
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

// ---------------------------------------------------------------------------
// The server's side, as this file's mock
// ---------------------------------------------------------------------------

const usd = (minor: string) => ({ minor, currency: 'USD' });

interface GoalRow {
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

interface ContributionRow {
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

interface Server {
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

async function installServer(page: Page): Promise<Server> {
  const server: Server = {
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

  await installPlanMocks(page);

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

// ---------------------------------------------------------------------------
// Keyboard helpers — and a record of every pointer event, so "by keyboard alone" is measured, not claimed
// ---------------------------------------------------------------------------

async function countPointerEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __pointerEvents: number }).__pointerEvents = 0;
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
      window.addEventListener(
        type,
        () => {
          (window as unknown as { __pointerEvents: number }).__pointerEvents += 1;
        },
        true,
      );
    }
  });
}

async function resetPointerEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __pointerEvents: number }).__pointerEvents = 0;
  });
}

async function pointerEvents(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __pointerEvents: number }).__pointerEvents);
}

/** Presses Tab until `target` has focus; fails (rather than hangs) if it never does. */
async function tabTo(page: Page, target: Locator, limit = 150): Promise<void> {
  const handle = await target.elementHandle({ timeout: 5_000 });
  if (handle === null) throw new Error('tabTo: the target is not in the page');
  for (let i = 0; i < limit; i += 1) {
    if (await handle.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`tabTo: focus never reached the target in ${String(limit)} Tab presses`);
}

/** Types into a field the keyboard has already focused, replacing what is there. */
async function typeInto(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text);
}

/** Waits out every running transition and animation under `scope`, so axe measures settled colours, not a fade's midpoint. */
async function settled(page: Page, scope = 'body'): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        (selector) =>
          document.querySelector(selector)?.getAnimations({ subtree: true }).length ?? 0,
        scope,
      ),
    )
    .toBe(0);
}

/** axe over one portalled element (a dialog), in the page's current theme — the helper's `#app-content` scope does not see portals. */
async function expectNoAxeViolationsIn(page: Page, selector: string, name: string): Promise<void> {
  await settled(page);
  const violations = await page.evaluate(async (scope) => {
    const result = await window.axe.run(scope);
    return result.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    );
  }, selector);
  expect(violations, `axe on ${name}`).toEqual([]);
}

test.describe('goals, questionnaire and forking (WP 9.7, C-10)', () => {
  test('a goal can be created, edited, funded and deleted by keyboard alone', async ({ page }) => {
    test.setTimeout(90_000);
    await installFakeWebAuthnAssertion(page);
    await countPointerEvents(page);
    const server = await installServer(page);
    await login(page);
    await page.goto('/goals');
    await expect(
      page.getByRole('main').getByRole('heading', { name: 'Goals', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('No goals yet')).toBeVisible();
    await resetPointerEvents(page);

    // --- create -----------------------------------------------------------------------------
    await tabTo(page, page.getByRole('button', { name: 'Add goal' }));
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // Focus is inside the dialog the moment it opens (a keyboard user is not left behind it).
    await expect(dialog.getByLabel('Name')).toBeFocused();
    await page.keyboard.type('Car');
    await tabTo(page, dialog.getByLabel('Target amount'));
    await page.keyboard.type('18000');
    await tabTo(page, dialog.getByLabel('Target date'));
    await page.keyboard.type('06012029');
    await tabTo(page, dialog.getByLabel('Priority'));
    await page.keyboard.press('ArrowDown');
    await tabTo(page, dialog.getByRole('button', { name: 'Add goal' }));
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();

    const card = page.getByTestId('goal').filter({ hasText: 'Car' });
    await expect(card).toContainText('$18,000.00');
    await expect(card).toContainText('2029-06-01');
    expect(server.goalPosts).toEqual([
      {
        kind: 'custom',
        name: 'Car',
        target: usd('1800000'),
        targetDate: '2029-06-01',
        priority: 4,
      },
    ]);
    // Closing the dialog returned focus to somewhere a keyboard user can continue from.
    await shoot(page, 'goal-created');

    // --- edit -------------------------------------------------------------------------------
    await tabTo(page, card.getByRole('button', { name: 'Edit Car' }));
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Name')).toBeFocused();
    await typeInto(page, 'Car fund');
    await tabTo(page, dialog.getByLabel('Status'));
    await page.keyboard.press('ArrowDown');
    await tabTo(page, dialog.getByRole('button', { name: 'Save goal' }));
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    const edited = page.getByTestId('goal').filter({ hasText: 'Car fund' });
    await expect(edited).toBeVisible();
    await expect(edited).toContainText('Paused');
    expect(server.goalPatches).toHaveLength(1);
    expect(server.goalPatches[0]).toMatchObject({ name: 'Car fund', status: 'paused' });

    // --- fund -------------------------------------------------------------------------------
    await tabTo(page, edited.getByRole('button', { name: /^Contributions for Car fund/ }));
    await page.keyboard.press('Enter');
    const panel = page.getByRole('region', { name: 'Contributions to Car fund' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Nothing is set aside');
    await tabTo(page, panel.getByLabel('Amount each time'));
    await page.keyboard.type('300');
    await page.keyboard.press('Enter'); // Enter in a field submits the form
    const row = panel.getByTestId('contribution');
    await expect(row).toContainText('$300.00');
    await expect(row).toContainText('every month');
    await expect(row).toContainText('entered by you');
    expect(server.contributionPosts).toHaveLength(1);
    expect(server.contributionPosts[0]).toMatchObject({
      cadence: 'monthly',
      amount: usd('30000'),
      source: 'USER',
    });
    await shoot(page, 'goal-funded');

    // --- delete (the contribution, then the goal) --------------------------------------------
    await tabTo(page, row.getByRole('button', { name: /^Remove the every month/i }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toContainText('Remove this contribution?');
    await tabTo(page, page.getByRole('button', { name: 'Remove contribution' }));
    await page.keyboard.press('Enter');
    await expect(panel).toContainText('Nothing is set aside');

    await tabTo(page, edited.getByRole('button', { name: 'Delete Car fund' }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toContainText('Delete Car fund?');
    await page.keyboard.press('Escape'); // backing out leaves it alone
    await expect(edited).toBeVisible();
    await tabTo(page, edited.getByRole('button', { name: 'Delete Car fund' }));
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByRole('button', { name: 'Delete goal' }));
    await page.keyboard.press('Enter');
    await expect(page.getByText('No goals yet')).toBeVisible();
    expect(server.goals).toHaveLength(0);

    // The whole flow, create to delete, without one pointer event.
    expect(await pointerEvents(page)).toBe(0);
  });

  test('the questionnaire produces a risk profile the plan reads', async ({ page }) => {
    test.setTimeout(90_000);
    await installFakeWebAuthnAssertion(page);
    const server = await installServer(page);
    await login(page);
    await page.goto('/goals');

    // Before: the plan has nothing to read.
    await page.getByRole('link', { name: 'plan', exact: true }).click();
    await expect(page.getByTestId('plan-risk-profile')).toContainText(
      'not answered the risk questionnaire',
    );
    await page.getByRole('link', { name: 'Take the questionnaire' }).click();
    await expect(page.getByRole('heading', { name: 'Risk profile' })).toBeVisible();

    await page.getByRole('button', { name: 'Take the questionnaire' }).click();
    // Answered inconsistently, on purpose: bold when asked what they would do, cautious about what they did.
    const choose = async (itemId: string, label: string) =>
      page.getByTestId(`risk-item-${itemId}`).getByRole('radio', { name: label }).check();
    await choose('drawdown.stated', 'Invest extra while prices are lower');
    await choose('drawdown.revealed', 'I sold all or most of it');
    await choose('volatility.stated', '$6,500 to $13,000');
    await choose('volatility.revealed', 'Less than a fifth');
    await choose('risk_identity.stated', 'I look for it; higher risk is how returns are earned');
    await choose('risk_identity.revealed', 'A savings account or cash');
    await page.getByLabel('Years until you start using this money').fill('25');
    await page.getByRole('button', { name: 'See my risk profile' }).click();

    const result = page.getByTestId('risk-result');
    await expect(result).toBeVisible();
    // What the screen sent is exactly what was chosen.
    expect(server.riskPuts).toHaveLength(1);
    expect(server.riskPuts[0]).toEqual({
      answers: {
        'drawdown.stated': 'buy_more',
        'drawdown.revealed': 'sold_all',
        'volatility.stated': 'range_widest',
        'volatility.revealed': 'stocks_under_20',
        'risk_identity.stated': 'seek',
        'risk_identity.revealed': 'cash',
      },
      horizonYears: 25,
      liquidityNeed: 'medium',
    });
    // The score moved conservative, not to the mean: averaging would have said otherwise, and the screen shows both.
    await expect(page.getByTestId('risk-result-tolerance')).toHaveText('Conservative');
    await expect(result).toContainText('consistency penalty of');
    await expect(result).toContainText('Averaging your answers would have said moderate');
    await expect(page.getByTestId('risk-explanation')).toContainText(
      'the score follows the more cautious of the two',
    );
    await shootBothThemes(page, 'risk-result');

    // And the plan reads it: the same tolerance, from the same server read, on the plan screen.
    await page.goto('/plan');
    const summary = page.getByTestId('plan-risk-profile-text');
    await expect(summary).toContainText('Conservative risk tolerance');
    await expect(summary).toContainText('answered 2026-10-06');
    await expect(page.getByTestId('plan-risk-profile')).toContainText(
      'The projection does not use this',
    );
    await shootBothThemes(page, 'plan-risk-profile');
  });

  test('a scenario can be forked and compared', async ({ page }) => {
    test.setTimeout(90_000);
    await installFakeWebAuthnAssertion(page);
    const server = await installServer(page);
    await login(page);
    await page.goto('/plan');
    await expect(page.getByTestId('plan-headline-probability')).toBeVisible();

    // Scoped to the form: the sliders panel has fields of the same names.
    const fork = page.getByRole('form', { name: 'Fork the baseline' });
    await fork.getByLabel('Fork name').fill('Retire at 60');
    await fork.getByLabel('Retirement age').fill('60');
    await fork.getByLabel('Annual spending').fill('55000');
    await fork.getByRole('button', { name: 'Fork and compare' }).click();

    // The fork the screen sent carries only the levers filled in.
    await expect.poll(() => server.forkPosts.length).toBe(1);
    expect(server.forkPosts[0]).toEqual({
      kind: 'fork',
      name: 'Retire at 60',
      levers: { retireAge: 60, annualSpending: usd('5500000') },
    });
    // ...and is put straight into the compare against the baseline.
    await expect(page.getByLabel('Scenario A')).toHaveValue('scenario-baseline');
    await expect(page.getByLabel('Scenario B')).toHaveValue('scenario-fork-1');
    await expect(page.getByTestId('compare-a')).toContainText('Baseline');
    await expect(page.getByTestId('compare-a')).toContainText('82%');
    await expect(page.getByTestId('compare-b')).toContainText('Retire at 60');
    await expect(page.getByTestId('compare-b')).toContainText('74%');
    await expect(page.getByTestId('compare-delta')).toContainText('36 months earlier');
    await shootBothThemes(page, 'fork-and-compare');

    // The fork is one the viewing selector offers, too.
    await expect(page.getByLabel('Viewing scenario').locator('option')).toHaveText([
      'Baseline',
      'Retire at 60',
    ]);
  });

  test('axe reports no violations on the goals screen or its dialogs, in light and in dark', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await installFakeWebAuthnAssertion(page);
    const server = await installServer(page);
    server.goals.push({
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'emergency_fund',
      name: 'Emergency fund',
      target: usd('2500000'),
      targetDate: '2028-01-01',
      priority: 2,
      fundedFromAccountIds: [],
      status: 'active',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    server.contributions.push({
      id: '00000000-0000-4000-8000-0000000000c1',
      goalId: '00000000-0000-4000-8000-000000000001',
      cadence: 'monthly',
      amount: usd('50000'),
      escalationPct: '3',
      startsOn: '2026-11-01',
      endsOn: null,
      source: 'DERIVED',
      derivedAsOf: '2026-09-30',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    await login(page);
    await page.goto('/goals');
    await page.getByRole('button', { name: /^Contributions for/ }).click();
    await expect(page.getByTestId('contribution')).toBeVisible();
    await page.getByRole('button', { name: 'Take the questionnaire' }).click();
    await expect(page.getByTestId('risk-item-drawdown.stated')).toBeVisible();

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await injectAxe(page);
      await expectNoAxeViolations(page, `goals screen (${theme})`);
      await shoot(page, `goals-${theme}`);
    }

    // The dialogs are portalled out of `#app-content`, so the helper's scope never sees them (CF-7): scan each directly.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Add goal' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await injectAxe(page);
      await expectNoAxeViolationsIn(page, '[role="dialog"]', `goal dialog (${theme})`);
    }
    await shoot(page, 'goal-dialog-dark');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Delete Emergency fund/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await injectAxe(page);
      await expectNoAxeViolations(page, `goals screen behind the confirmation (${theme})`);
    }
    // The confirmation itself, in light. Its dark scan is the known-defect test below.
    await setTheme(page, 'light');
    await injectAxe(page);
    await expectNoAxeViolationsIn(page, '[role="dialog"]', 'delete confirmation (light)');
  });

  test('the delete confirmation is axe clean in dark', async ({ page }) => {
    // CF-9 (docs/plan/09-phase-9-dispatch.md §2b), owned by WP 9.8: the shared destructive button is
    // `bg-money-neg text-white`, which fails AA at rest in the dark theme. Not a goals-screen defect and
    // not mine to fix (`components/ui/button.tsx`), so this is `test.fail`: it passes while the defect
    // stands and goes red the day 9.8 fixes the token, at which point the annotation is deleted.
    test.fail(true, 'CF-9: the destructive button fails AA in dark; WP 9.8 owns the token');
    test.setTimeout(60_000);
    await installFakeWebAuthnAssertion(page);
    const server = await installServer(page);
    server.goals.push({
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'emergency_fund',
      name: 'Emergency fund',
      target: usd('2500000'),
      targetDate: '2028-01-01',
      priority: 2,
      fundedFromAccountIds: [],
      status: 'active',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    await login(page);
    await page.goto('/goals');
    await page.getByRole('button', { name: /^Delete Emergency fund/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await setTheme(page, 'dark');
    await injectAxe(page);
    await expectNoAxeViolationsIn(page, '[role="dialog"]', 'delete confirmation (dark)');
  });

  test('the plan screen with a fork form and the risk card is axe clean in both themes', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await installFakeWebAuthnAssertion(page);
    const server = await installServer(page);
    server.riskCurrent = {
      id: '00000000-0000-4000-8000-0000000000a1',
      tolerance: 'moderate',
      compositeScore: 9,
      unpenalisedScore: 9,
      consistencyPenalty: 0,
      horizonYears: 25,
      taxBracketBand: null,
      liquidityNeed: 'medium',
      answeredAt: '2026-10-05T12:00:00.000Z',
    };
    await login(page);
    await page.goto('/plan');
    await expect(page.getByTestId('plan-risk-profile-text')).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      await injectAxe(page);
      await expectNoAxeViolations(page, `plan screen with fork form and risk card (${theme})`);
    }
  });

  /**
   * The evidence walk (`docs/plan/04-phase-4-dispatch.md` §5 item 3's on-screen steps), against this
   * file's mocks, with a screenshot of each step in both themes. It asserts as it goes — a step that
   * does not happen fails here, not in a caption. Step 8's byte-identity is the API's property (the
   * `projection_runs` cache hit, `projection-service.test.ts`); on screen it can only be shown that a
   * re-opened screen reads the same stored run, which is what the last assertion does.
   */
  test('the Phase 4 on-screen steps walk end to end, in both themes', async ({ page }) => {
    test.setTimeout(150_000);
    await installFakeWebAuthnAssertion(page);
    const server = await installServer(page);
    await login(page);

    // 1. A goal is created.
    await page.goto('/goals');
    await page.getByRole('button', { name: 'Add goal' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Retire at 65');
    await dialog.getByLabel('Kind').selectOption('retirement');
    await dialog.getByLabel('Target amount').fill('2000000');
    await dialog.getByLabel('Target date').fill('2050-04-12');
    await dialog.getByRole('button', { name: 'Add goal' }).click();
    await expect(page.getByTestId('goal').filter({ hasText: 'Retire at 65' })).toContainText(
      '$2,000,000.00',
    );
    expect(server.goals).toHaveLength(1);
    await shootBothThemes(page, 'step1-goal-created');

    // 2. The questionnaire is answered inconsistently and the score moves conservative on screen.
    await page.getByRole('button', { name: 'Take the questionnaire' }).click();
    for (const [item, label] of [
      ['drawdown.stated', 'Invest extra while prices are lower'],
      ['drawdown.revealed', 'I sold all or most of it'],
      ['volatility.stated', '$6,500 to $13,000'],
      ['volatility.revealed', 'Less than a fifth'],
      ['risk_identity.stated', 'I look for it; higher risk is how returns are earned'],
      ['risk_identity.revealed', 'A savings account or cash'],
    ] as const) {
      await page.getByTestId(`risk-item-${item}`).getByRole('radio', { name: label }).check();
    }
    await page.getByLabel('Years until you start using this money').fill('25');
    await page.getByRole('button', { name: 'See my risk profile' }).click();
    await expect(page.getByTestId('risk-result-tolerance')).toHaveText('Conservative');
    await expect(page.getByTestId('risk-result')).toContainText(
      'Averaging your answers would have said moderate',
    );
    await shootBothThemes(page, 'step2-risk-conservative');

    // 3. The fan chart draws with a labelled median.
    await page.goto('/plan');
    await expect(page.getByTestId('plan-headline-probability')).toBeVisible();
    await expect(page.getByTestId('plan-projection').getByText('median').first()).toBeVisible();
    await expect(page.getByTestId('plan-run-source')).toContainText('Monte Carlo simulation');
    await shootBothThemes(page, 'step3-fan-chart-median');

    // 4. The dotted gap line is clicked and returns a required monthly saving.
    await page.getByLabel('Target amount').fill('1000000');
    await page.getByLabel('By date').fill('2046-01-01');
    await page.getByLabel('Max extra monthly saving to consider').fill('2000');
    await page.getByRole('button', { name: 'Set goal' }).click();
    await page.getByTestId('fan-chart-gap-line').click();
    await expect(page.getByTestId('required-savings-result')).toContainText('Save an additional');
    await shootBothThemes(page, 'step4-required-saving');

    // 5. A life event is moved with the keyboard.
    const slider = page.getByRole('slider', { name: 'Signing bonus date' });
    await slider.focus();
    const before = await slider.getAttribute('aria-valuetext');
    for (let i = 0; i < 10; i += 1) await page.keyboard.press('ArrowRight');
    await slider.blur();
    await expect.poll(() => slider.getAttribute('aria-valuetext')).not.toBe(before);
    await shootBothThemes(page, 'step5-life-event-moved');

    // 6. Two scenarios compare.
    const fork = page.getByRole('form', { name: 'Fork the baseline' });
    await fork.getByLabel('Fork name').fill('Retire at 60');
    await fork.getByLabel('Retirement age').fill('60');
    await fork.getByRole('button', { name: 'Fork and compare' }).click();
    await expect(page.getByTestId('compare-delta')).toContainText('36 months earlier');
    await shootBothThemes(page, 'step6-two-scenarios-compare');

    // 7. Every assumption shows its source and date, and only the ones the engine reads offer an edit.
    await expect(page.getByText(/Source: 07 Appendix A §5\.5/)).toBeVisible();
    await expect(page.getByText(/As of 2026-01-01/)).toBeVisible();
    await shootBothThemes(page, 'step7-assumptions-cited');

    // 8. A saved projection is re-opened: a reload reads the same stored run.
    const headline = await page.getByTestId('plan-headline').innerText();
    const source = await page.getByTestId('plan-run-source').innerText();
    await page.reload();
    await expect(page.getByTestId('plan-headline-probability')).toBeVisible();
    expect(await page.getByTestId('plan-headline').innerText()).toBe(headline);
    expect(await page.getByTestId('plan-run-source').innerText()).toBe(source);
    await shootBothThemes(page, 'step8-reopened');
  });
});
