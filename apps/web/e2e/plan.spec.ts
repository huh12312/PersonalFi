// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { expect, test as base } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { expectNoAxeViolations } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installPlanMocks } from './support/mock-plan.ts';
import { screenshotDir } from './support/screenshot-dir.ts';

/**
 * WP 4.10's five named exit tests, verbatim from
 * `docs/plan/04-phase-4-dispatch.md` §3 "WP 4.10", plus axe clean on both
 * themes and the evidence screenshots. Against `support/mock-plan.ts` (this
 * work package's own mock module — `mock-api.ts` and
 * `app-walkthrough.spec.ts` are off-limits per the dispatch).
 *
 * WP 5.14 / C-14's G4-3 (`docs/evidence/phase-4/gate-security-review.md`):
 * this file hardcoded `SCREENSHOT_DIR` straight at the committed evidence
 * directory, so an ordinary `just verify`/Playwright run rewrote eight
 * committed `wp4.10-*.png` files in place — reproduced red first (a plain
 * `pnpm exec playwright test e2e/plan.spec.ts --project chromium` with no
 * `PLAYWRIGHT_EVIDENCE_DIR` left `git status` showing all eight modified).
 * Same mechanism `market-data.spec.ts` already uses: the `evidenceDir` test
 * option from `playwright.config.ts`, a gitignored output directory by
 * default, `PLAYWRIGHT_EVIDENCE_DIR` for a deliberate regeneration.
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

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: `${screenshotDir(currentEvidenceDir)}wp4.10-${name}.png`,
    fullPage: true,
  });
}

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

/**
 * WP 9.7's own screenshots carry the `wp9.7-` prefix, so a deliberate regeneration into
 * `docs/evidence/phase-9/` (`PLAYWRIGHT_EVIDENCE_DIR`) never rewrites the committed `wp4.10-*.png` set.
 */
async function shoot97(page: Page, name: string): Promise<void> {
  // Both themes, dark first, leaving the page light (the default every later assertion expects).
  for (const theme of ['dark', 'light'] as const) {
    await setTheme(page, theme);
    await shootMain(page, `${screenshotDir(currentEvidenceDir)}wp9.7-${name}-${theme}.png`);
  }
}

async function loginAndReachPlan(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Plan' })
    .click();
  await expect(page).toHaveURL(/\/plan/);
  await expect(page.getByRole('heading', { name: 'Plan', exact: true })).toBeVisible();
}

/** `src/lib/theme.ts`'s own two effects: the stored preference and `data-theme` on `<html>` — the same helper `investments.spec.ts`/`networth.spec.ts` use. */
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('personalfi:theme', value);
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function fillGoal(
  page: Page,
  target: string,
  date: string,
  maxMonthly: string,
): Promise<void> {
  const targetInput = page.getByLabel('Target amount');
  await targetInput.fill(target);
  await page.getByLabel('By date').fill(date);
  const maxMonthlyInput = page.getByLabel('Max extra monthly saving to consider');
  await maxMonthlyInput.fill(maxMonthly);
  await page.getByRole('button', { name: 'Set goal' }).click();
}

test.describe('plan screen (WP 4.10)', () => {
  test('the median band is labelled "median" in words and not only by position', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await loginAndReachPlan(page);

    await expect(page.getByTestId('plan-headline-probability')).toBeVisible();
    // Both the on-chart label and the legend swatch say "median" in words.
    const medianLabels = page.getByText('median', { exact: true });
    await expect(medianLabels.first()).toBeVisible();
    expect(await medianLabels.count()).toBeGreaterThanOrEqual(2);

    await shoot(page, 'fan-chart-median');
  });

  test('clicking the dotted gap line renders a required monthly saving, and an unreachable gap names its constraint instead', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await loginAndReachPlan(page);

    // A reachable goal: $1,000,000 by 2046, a $2,000/mo ceiling.
    await fillGoal(page, '1000000', '2046-01-01', '2000');
    const gap = page.getByTestId('fan-chart-gap-line');
    await expect(gap).toBeVisible();
    await gap.click();

    const result = page.getByTestId('required-savings-result');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Save an additional');
    await expect(result).not.toContainText('unreachable');
    await shoot(page, 'required-savings-required');

    // Now an unreachable goal: $10,000,000 by next year, same ceiling.
    await fillGoal(page, '10000000', '2027-01-01', '2000');
    await page.getByTestId('fan-chart-gap-line').click();

    const unreachable = page.getByTestId('required-savings-unreachable');
    await expect(unreachable).toBeVisible();
    await expect(unreachable).toContainText('unreachable');
    await expect(unreachable).toContainText('ceiling falls short');
    // Never a number that implies a solved monthly figure — the literal
    // "required" phrasing, and (sabotage-resistant to a rewording) no real
    // `Money` component render at all inside the unreachable block
    // (`Money.tsx` marks every one with `.money-sensitive`; the
    // constraint's own server-authored `detail` prose, which legitimately
    // quotes the ceiling in words, is plain text and carries no such class).
    await expect(page.getByText('Save an additional')).not.toBeVisible();
    expect(await unreachable.locator('.money-sensitive').count()).toBe(0);
    await shoot(page, 'required-savings-unreachable');
  });

  test('a life event can be moved with the keyboard alone', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await loginAndReachPlan(page);

    const slider = page.getByRole('slider', { name: 'Signing bonus date' });
    await expect(slider).toBeVisible();
    const before = await slider.getAttribute('aria-valuetext');

    await slider.focus();
    const patchResponse = page.waitForResponse(
      (response) =>
        /\/api\/plan\/life-events\/[^/]+$/.test(new URL(response.url()).pathname) &&
        response.request().method() === 'PATCH',
    );
    // A real browser translates repeated ArrowRight presses on a focused
    // native `<input type="range">` into value changes with no pointer
    // event anywhere in this test — the WCAG 2.5.7 property under test.
    for (let i = 0; i < 10; i += 1) await page.keyboard.press('ArrowRight');
    await slider.blur();
    await patchResponse;

    const after = await slider.getAttribute('aria-valuetext');
    expect(after).not.toBe(before);
    await shoot(page, 'life-event-keyboard-move');
  });

  test('every assumption shows its source and its as-of date without a click', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await loginAndReachPlan(page);

    // No click anywhere before these assertions — visible on first paint.
    await expect(page.getByText(/Source: 07 Appendix A §5\.5/)).toBeVisible();
    await expect(page.getByText(/As of 2026-01-01/)).toBeVisible();
    await expect(page.getByText(/Source: SSA 2026 COLA notice/)).toBeVisible();
    await expect(page.getByText(/As of 2025-10-15/)).toBeVisible();
    // No collapsed disclosure anywhere *inside the assumptions panel itself*
    // — scoped there rather than to the whole page because `FanChart`'s own
    // "View as table" toggle is a real `aria-expanded="false"` disclosure
    // for the chart's data table, an unrelated feature this assertion must
    // not flag.
    const panel = page.getByTestId('assumptions-panel');
    expect(await panel.locator('details').count()).toBe(0);
    expect(await panel.getByRole('button', { expanded: false }).count()).toBe(0);

    await shoot(page, 'assumptions-panel');
  });

  test('two scenarios render side by side with the success-probability delta', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await loginAndReachPlan(page);

    await page.getByLabel('Scenario A').selectOption('scenario-baseline');
    await page.getByLabel('Scenario B').selectOption('scenario-fork-retire-early');

    const compareA = page.getByTestId('compare-a');
    const compareB = page.getByTestId('compare-b');
    await expect(compareA).toContainText('Baseline');
    await expect(compareA).toContainText('82%');
    await expect(compareB).toContainText('Retire at 62');
    await expect(compareB).toContainText('74%');

    const delta = page.getByTestId('compare-delta');
    await expect(delta).toContainText('Δ success probability');
    await expect(delta).toContainText('36 months earlier');

    await shoot(page, 'scenario-compare');
  });

  test('axe reports no violations on the plan screen, in light and in dark', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await loginAndReachPlan(page);
    // Set a goal and choose both compare scenarios first, so the axe pass
    // covers the gap-line button, the required-savings panel and the
    // scenario-compare grid, not just the screen's resting state.
    await fillGoal(page, '1000000', '2046-01-01', '2000');
    await page.getByTestId('fan-chart-gap-line').click();
    await expect(page.getByTestId('required-savings-result')).toBeVisible();
    await page.getByLabel('Scenario A').selectOption('scenario-baseline');
    await page.getByLabel('Scenario B').selectOption('scenario-fork-retire-early');
    await expect(page.getByTestId('compare-delta')).toBeVisible();

    await setTheme(page, 'light');
    await expectNoAxeViolations(page, 'plan screen (light)');
    await shoot(page, 'plan-light');

    await setTheme(page, 'dark');
    await expectNoAxeViolations(page, 'plan screen (dark)');
    await shoot(page, 'plan-dark');
  });
});

// ---------------------------------------------------------------------------
// WP 9.7 / C-8 (CF-15; G4-10, G4-13, G4-16, O-5) — the plan screen's honesty.
//
// The mocks stay `support/mock-plan.ts`'s (orchestrator-owned, read-only for
// this work package): every test below registers its own `page.route` handler
// *after* `installPlanMocks`, which wins over the shared one, and hands
// everything it does not answer back with `route.fallback()` — the
// `accounts-overrides.spec.ts` pattern.
//
// What each test takes from the contract rather than from a list written here
// (C5-11 — a new code, method or staleness arm must fail a test, not slip
// past a hand-kept list):
//   * the problem codes: the typed unions and status tables the API maps
//     verbatim (`projection-store.ts`, `engine/boundary.ts`,
//     `engine/worker-host.ts`, `routes/domain-errors.ts`). The OpenAPI document
//     itself does not enumerate codes (`Problem.code` is a free `string`),
//     which `wp9.7-plan-screens.md` §6 records as a finding;
//   * the projection methods and the staleness arms: `openapi.json`.
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL('../../../', import.meta.url);

function readRepoFile(relative: string): string {
  return readFileSync(new URL(relative, REPO_ROOT), 'utf8');
}

/** Every `'planning.…'` literal inside one `export type <name> = … ;` union. */
function unionCodes(text: string, name: string): string[] {
  const body = new RegExp(`export type ${name} =([^;]+);`).exec(text)?.[1];
  if (body === undefined) throw new Error(`type ${name} not found — the extractor is stale`);
  return [...body.matchAll(/'(planning\.[a-z_]+)'/g)].map((m) => m[1] as string);
}

interface ProblemCode {
  readonly code: string;
  readonly status: number;
}

/**
 * Every code a projection, compare, scenario or required-savings request can
 * answer with — the API's own typed tables, not a list kept here.
 */
function projectionProblemCodes(): ProblemCode[] {
  const store = readRepoFile('packages/contexts/planning/src/projection-store.ts');
  const boundary = readRepoFile('packages/contexts/planning/src/engine/boundary.ts');
  const host = readRepoFile('packages/contexts/planning/src/engine/worker-host.ts');
  const domainErrors = readRepoFile('apps/api/src/routes/domain-errors.ts');

  const statusOf = new Map<string, number>();
  for (const m of store.matchAll(/'(planning\.[a-z_]+)': \{ status: (\d+)/g)) {
    statusOf.set(m[1] as string, Number(m[2]));
  }
  for (const m of domainErrors.matchAll(/'(planning\.assumptions_[a-z_]+)': \{ status: (\d+)/g)) {
    statusOf.set(m[1] as string, Number(m[2]));
  }

  const codes = [
    ...unionCodes(store, 'ProjectionRefusalCodeWp46'),
    ...unionCodes(boundary, 'ProjectionRefusalCode'),
    ...unionCodes(host, 'MonteCarloRefusalCode'),
    ...[...host.matchAll(/readonly code = '(planning\.[a-z_]+)'/g)].map((m) => m[1] as string),
    ...[...domainErrors.matchAll(/'(planning\.assumptions_[a-z_]+)': \{ status/g)].map(
      (m) => m[1] as string,
    ),
  ];
  const unique = [...new Set(codes)];
  return unique.map((code) => ({
    code,
    status:
      statusOf.get(code) ?? (code.endsWith('_timeout') || code.endsWith('_failed') ? 503 : 422),
  }));
}

interface OpenApiDocument {
  components: { schemas: Record<string, Record<string, unknown>> };
}

function openApi(): OpenApiDocument {
  return JSON.parse(readRepoFile('packages/contracts/openapi/openapi.json')) as OpenApiDocument;
}

function projectionMethods(): string[] {
  const run = openApi().components.schemas['ProjectionRun'] as {
    properties: { method: { enum: string[] } };
  };
  return run.properties.method.enum;
}

function stalenessReasons(): string[] {
  const staleness = openApi().components.schemas['ProjectionStaleness'] as {
    oneOf: { properties: { reason: { const: string } } }[];
  };
  return staleness.oneOf.map((arm) => arm.properties.reason.const);
}

const money = (minor: string) => ({ minor, currency: 'USD' });

/** The checkpoints of a run. A deterministic run carries only the median; the outer bands are `null` (the contract's own shape). */
function checkpoints(method: string) {
  return [
    { index: 0, age: 41, calendarYear: 2026, p50: 40_000_00 },
    { index: 1, age: 53, calendarYear: 2038, p50: 110_000_00 },
    { index: 2, age: 65, calendarYear: 2050, p50: 180_000_00 },
  ].map((row) => {
    const band = (factor: number) =>
      method === 'monte_carlo' ? money(String(Math.round(row.p50 * factor))) : null;
    return {
      index: row.index,
      age: row.age,
      calendarYear: row.calendarYear,
      p5: band(0.6),
      p10: band(0.7),
      p25: band(0.85),
      p50: money(String(row.p50)),
      p75: band(1.15),
      p90: band(1.3),
      p95: band(1.45),
    };
  });
}

function runFixture(scenarioId: string, method: string, successProbability: string) {
  return {
    id: `run-${scenarioId}-${method}`,
    scenarioId,
    scenarioKind: scenarioId === 'scenario-baseline' ? 'baseline' : 'fork',
    method,
    seed: 'seed-baseline-1',
    paths: method === 'monte_carlo' ? 10_000 : 1,
    engineVersion: 'engine-1',
    assumptionsVersion: 'assumptions-1',
    asOfDate: '2026-09-23',
    balancesSealed: true,
    currency: 'USD',
    successProbability,
    durationMs: 412,
    createdAt: '2026-09-23T00:00:00.000Z',
  };
}

/** A deterministic run's `successProbability` can only be 0 or 1 (G4-13); a Monte Carlo run's is a share of paths. */
function outcomeOf(method: string, scenarioId: string): string {
  if (method === 'monte_carlo') return scenarioId === 'scenario-baseline' ? '0.82' : '0.74';
  return '1';
}

function projectionBody(scenarioId: string, method: string, staleness: unknown = null) {
  return {
    status: staleness === null ? 'computed' : 'stale',
    run: runFixture(scenarioId, method, outcomeOf(method, scenarioId)),
    percentiles: checkpoints(method),
    staleness,
  };
}

function problemBody(code: string, status: number) {
  return {
    type: 'about:blank',
    title: status === 409 ? 'Conflict' : 'Unprocessable Content',
    status,
    code,
    detail: `mock server detail for ${code}`,
    correlationId: 'corr-9-7',
  };
}

function fulfillJson(body: unknown, status = 200) {
  return {
    status,
    contentType: status >= 400 ? 'application/problem+json' : 'application/json',
    body: JSON.stringify(body),
  };
}

const SCENARIO_ID = /^\/api\/plan\/scenarios\/([^/]+)\/projections$/;

interface ProjectionBehaviour {
  /** Answer the projection POST; `null` falls through to the shared mock. */
  (scenarioId: string, requestBody: unknown): ReturnType<typeof fulfillJson> | null;
}

/** Layers a projection answer over the shared plan mock and counts the POSTs the screen makes. */
async function answerProjection(page: Page, behaviour: ProjectionBehaviour) {
  const seen: unknown[] = [];
  await page.route('**/api/plan/scenarios/*/projections', async (route: Route) => {
    const request = route.request();
    const match = SCENARIO_ID.exec(new URL(request.url()).pathname);
    if (match === null || request.method() !== 'POST') return route.fallback();
    seen.push(request.postDataJSON());
    const answer = behaviour(match[1] ?? '', request.postDataJSON());
    return answer === null ? route.fallback() : route.fulfill(answer);
  });
  return seen;
}

async function answerAccounts(page: Page) {
  await page.route('**/api/accounts', (route) => route.fulfill(fulfillJson({ accounts: [] })));
}

/** Anything that reads as a probability, a share or a chance — in numbers or in words. */
const PROBABILITY_PHRASING = /%|percent|probab|chance|likel|of (simulated )?(plans|paths)/i;

test.describe('plan screen honesty (WP 9.7, C-8)', () => {
  test('every projection problem code reads as words', async ({ page }) => {
    test.setTimeout(240_000);
    const codes = projectionProblemCodes();
    // The extractor must see the whole class, or this test would pass over an empty list.
    expect(codes.length).toBeGreaterThanOrEqual(40);
    for (const anchor of [
      'planning.projection_no_balances',
      'planning.projection_balances_unsealed',
      'planning.projection_spending_unknown',
      'planning.monte_carlo_unavailable',
      'planning.assumptions_version_unknown',
      'planning.montecarlo_timeout',
    ]) {
      expect(codes.map((c) => c.code)).toContain(anchor);
    }

    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    let current: ProblemCode = codes[0] as ProblemCode;
    await answerProjection(page, () =>
      fulfillJson(problemBody(current.code, current.status), current.status),
    );
    await loginAndReachPlan(page);

    for (const next of codes) {
      current = next;
      await page.reload();
      const problem = page.getByTestId('plan-projection').getByTestId('plan-problem');
      await expect(problem, next.code).toBeVisible();
      // In words: a sentence from the screen's own table, never the fallback, never a bare code.
      await expect(problem, next.code).toHaveAttribute('data-problem-words', 'table');
      expect(
        ((await problem.textContent()) ?? '').trim().split(/\s+/).length,
        next.code,
      ).toBeGreaterThan(12);
      // And never the spinner sentence an error used to hide behind (G4-10).
      await expect(page.getByTestId('plan-headline'), next.code).not.toContainText(
        'Projecting your plan',
      );
      await expect(page.getByTestId('plan-headline'), next.code).not.toContainText('on track');
    }
    await shoot97(page, 'problem-last-code');
  });

  test('a deterministic run is never phrased as a probability', async ({ page }) => {
    test.setTimeout(120_000);
    // What each method must be called on screen. A method the contract gains has no entry here, and the
    // loop below fails on it rather than skipping it.
    const NAMED_AS: Record<string, RegExp> = {
      deterministic: /deterministic/i,
      monte_carlo: /monte carlo/i,
    };
    const methods = projectionMethods();
    expect(methods).toContain('deterministic');

    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    let method = 'deterministic';
    await answerProjection(page, (scenarioId) => fulfillJson(projectionBody(scenarioId, method)));
    await page.route('**/api/plan/compare**', (route) =>
      route.fulfill(
        fulfillJson({
          a: projectionBody('scenario-baseline', method),
          b: projectionBody('scenario-fork-retire-early', method),
          seed: 'seed-baseline-1',
          successProbabilityDelta: method === 'monte_carlo' ? '-0.08' : '0',
          retirementDate: { a: '2050-04-12', b: '2047-04-12' },
          retirementDeltaMonths: -36,
        }),
      ),
    );
    await loginAndReachPlan(page);

    for (const next of methods) {
      method = next;
      expect(NAMED_AS[next], `${next} has no expected on-screen name — add one`).toBeDefined();
      await page.reload();
      await expect(
        page.getByRole('main').getByRole('heading', { name: 'Plan', exact: true }),
      ).toBeVisible();
      await page.getByLabel('Scenario A').selectOption('scenario-baseline');
      await page.getByLabel('Scenario B').selectOption('scenario-fork-retire-early');
      await expect(page.getByTestId('compare-delta')).toBeVisible();

      const headline = page.getByTestId('plan-headline');
      const section = page.getByTestId('plan-projection');
      const compare = page.getByTestId('scenario-compare');
      await expect(headline).toContainText(/\d/); // the median is on screen: the run rendered
      const probabilistic = next === 'monte_carlo';
      for (const [where, locator] of [
        ['the headline', headline],
        ['the projection section', section],
        ['the compare panel', compare],
      ] as const) {
        const text = (await locator.innerText()).replace(/\s+/g, ' ');
        if (probabilistic) {
          // The section carries the chart, not the figure; the headline and the compare panel do.
          if (locator !== section) expect(text, `${next}: ${where}`).toMatch(/82%|74%/);
        } else {
          expect(text, `${next}: ${where} phrased a ${next} run as a probability`).not.toMatch(
            PROBABILITY_PHRASING,
          );
        }
      }
      // The engine is named on the section, whatever it is.
      await expect(section, next).toHaveAttribute('data-engine', next);
      await expect(section.getByRole('heading').first(), next).toHaveText(NAMED_AS[next] as RegExp);

      await shoot97(page, `engine-${next}`);
    }
  });

  test('a stale run says so and names its version', async ({ page }) => {
    test.setTimeout(120_000);
    const reasons = stalenessReasons();
    // The contract's arms, with the version each one must put on screen. An arm without a fixture fails here.
    const FIXTURES: Record<string, { staleness: unknown; mustName: string[] }> = {
      assumptions_version_retired: {
        staleness: {
          reason: 'assumptions_version_retired',
          assumptionsVersion: 'assumptions-0',
          known: ['assumptions-1'],
        },
        mustName: ['assumptions-0'],
      },
      assumptions_changed: {
        staleness: {
          reason: 'assumptions_changed',
          assumptionsVersion: 'assumptions-0',
          currentVersion: 'assumptions-2',
        },
        mustName: ['assumptions-0', 'assumptions-2'],
      },
      account_overrides_changed: {
        staleness: {
          reason: 'account_overrides_changed',
          changes: [
            {
              accountId: '00000000-0000-4000-8000-0000000000a1',
              field: 'taxTreatment',
              from: null,
              to: 'ROTH',
            },
          ],
        },
        // The run's own assumptions version: the 9.2 notice lists the changes, this one dates the run.
        mustName: ['assumptions-0'],
      },
    };

    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await answerAccounts(page);
    let reason = reasons[0] as string;
    await answerProjection(page, (scenarioId) => {
      const fixture = FIXTURES[reason];
      if (fixture === undefined) throw new Error(`staleness arm ${reason} has no fixture`);
      const body = projectionBody(scenarioId, 'monte_carlo', fixture.staleness);
      return fulfillJson({ ...body, run: { ...body.run, assumptionsVersion: 'assumptions-0' } });
    });
    await loginAndReachPlan(page);

    for (const next of reasons) {
      reason = next;
      const fixture = FIXTURES[next];
      expect(fixture, `staleness arm ${next} has no fixture — add one`).toBeDefined();
      await page.reload();
      const stale = page.getByTestId('plan-run-stale');
      await expect(stale, next).toBeVisible();
      await expect(stale, next).toHaveAttribute('data-staleness', next);
      await expect(stale, next).toContainText(/out of date|stale/i);
      for (const version of fixture?.mustName ?? [])
        await expect(stale, next).toContainText(version);
      // A stale run is not served as the current answer.
      await expect(page.getByTestId('plan-headline'), next).toContainText(/out of date|stale/i);
      // 9.2's notice is the one place the account changes are listed and recomputed; not duplicated here.
      await expect(page.getByTestId('projection-stale-notice')).toHaveCount(
        next === 'account_overrides_changed' ? 1 : 0,
      );
      await shoot97(page, `stale-${next}`);
    }
  });

  test('a stale answer with no stored run says so instead of projecting forever', async ({
    page,
  }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await answerProjection(page, () =>
      fulfillJson({
        status: 'stale',
        run: null,
        percentiles: [],
        staleness: {
          reason: 'assumptions_version_retired',
          assumptionsVersion: 'assumptions-0',
          known: ['assumptions-1'],
        },
      }),
    );
    await loginAndReachPlan(page);
    const stale = page.getByTestId('plan-run-stale');
    await expect(stale).toContainText('assumptions-0');
    await expect(stale).toContainText(/no (stored )?(run|result)/i);
    await expect(page.getByTestId('plan-headline')).not.toContainText('Projecting your plan');
  });

  test('saving an assumption override re-reads the projection', async ({ page }) => {
    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    const posts = await answerProjection(page, () => null);
    await loginAndReachPlan(page);
    await expect(page.getByTestId('plan-headline-probability')).toBeVisible();
    const before = posts.length;

    await page.getByRole('button', { name: 'Edit' }).first().click();
    await page.getByLabel(/^Override /).fill('0.05');
    await page.getByRole('button', { name: 'Save' }).click();

    // G4-16: the PUT used to invalidate only `GET /assumptions`, so the headline kept quoting the old
    // run for up to its 15-second stale time. The projection is asked again.
    await expect.poll(() => posts.length, { timeout: 10_000 }).toBeGreaterThan(before);
  });

  test('only paths the engine reads are offered as overrides', async ({ page }) => {
    // The eight the engine never reads (G4 O-5), spelled from the assumptions file's own list of overridable paths.
    const UNREAD = [
      'capitalMarket.intlDevelopedEquity.expectedReturn',
      'capitalMarket.intlDevelopedEquity.volatility',
      'capitalMarket.emergingEquity.expectedReturn',
      'capitalMarket.emergingEquity.volatility',
      'capitalMarket.tips.expectedReturn',
      'capitalMarket.tips.volatility',
      'capitalMarket.cash.expectedReturn',
      'capitalMarket.cash.volatility',
    ];
    const assumptionsSource = readRepoFile('packages/contexts/planning/src/assumptions.ts');
    const block = /OVERRIDABLE_PATHS[^=]*=\s*\[([^\]]+)\]/.exec(assumptionsSource)?.[1] ?? '';
    const overridable = [...block.matchAll(/'(capitalMarket\.[A-Za-z.]+)'/g)].map(
      (m) => m[1] as string,
    );
    expect(overridable.length).toBe(17);

    const cited = (value: string) => ({
      value,
      kind: 'nominal',
      basis: null,
      source: 'test source',
      asOf: '2026-01-01',
      note: null,
    });
    const file: Record<string, Record<string, Record<string, unknown>>> = { capitalMarket: {} };
    for (const path of overridable) {
      const [, group, leaf] = path.split('.') as [string, string, string];
      (file['capitalMarket'] as Record<string, Record<string, unknown>>)[group] ??= {};
      (
        (file['capitalMarket'] as Record<string, Record<string, unknown>>)[group] as Record<
          string,
          unknown
        >
      )[leaf] = cited('0.05');
    }

    await installFakeWebAuthnAssertion(page);
    await installPlanMocks(page);
    await page.route('**/api/assumptions', (route) =>
      route.request().method() !== 'GET'
        ? route.fallback()
        : route.fulfill(
            fulfillJson({
              version: 'assumptions-1',
              file,
              overrides: [],
              overridablePaths: overridable,
            }),
          ),
    );
    await loginAndReachPlan(page);
    const panel = page.getByTestId('assumptions-panel');
    await expect(panel).toBeVisible();

    const offered = await panel.getByRole('button', { name: 'Edit' }).count();
    expect(offered).toBe(overridable.length - UNREAD.length);
    // Every path the engine ignores says so, in place of the control.
    await expect(panel.getByText('Not used by the current engine')).toHaveCount(UNREAD.length);
    await shoot97(page, 'assumptions-engine-read-only');
  });
});
