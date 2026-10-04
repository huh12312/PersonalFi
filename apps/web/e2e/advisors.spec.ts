// SPDX-License-Identifier: MIT
import { expect, test as base } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

import { injectAxe } from './support/axe.ts';
import type { AxeViolation } from './support/axe.ts';
import { installFakeWebAuthnAssertion } from './support/fake-webauthn.ts';
import { installApiMocks } from './support/mock-api.ts';
import { screenshotDir } from './support/screenshot-dir.ts';

/**
 * WP 5.12 exit tests (`docs/plan/05-phase-5-dispatch.md` §3). `mock-api.ts`
 * (shared, read-only to this package) carries no `/advisors*` handler at
 * all — this file registers its own `page.route` on top of it, the same
 * technique `inbox.spec.ts` uses for its own one-off fixture: Playwright
 * runs route handlers in reverse registration order, so a handler added
 * here after `installApiMocks` runs first and `route.fallback()`s anything
 * it does not recognise back to the shared mock (session, step-up, login).
 *
 * The in-memory store below is this file's own, not a shared support
 * module — no other package reads or writes it.
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
    path: `${screenshotDir(currentEvidenceDir)}wp5.12-${name}.png`,
    fullPage: true,
  });
}

async function expectAxeCleanExceptSharedSidebar(page: Page, screenName: string): Promise<void> {
  await injectAxe(page);
  const violations: AxeViolation[] = await page.evaluate(async () => {
    const result = await window.axe.run({
      include: [['#app-content']],
      exclude: [['a[aria-current="page"]']],
    });
    return result.violations;
  });
  if (violations.length > 0) {
    const details = violations
      .map(
        (v) =>
          `- [${v.impact}] ${v.id}: ${v.description}\n  ${v.nodes
            .map((n) => `${n.target.join(' ')} :: ${n.html}\n  ${n.failureSummary ?? ''}`)
            .join('\n  ')}`,
      )
      .join('\n');
    throw new Error(
      `axe found ${String(violations.length)} violation(s) on ${screenName}:\n${details}`,
    );
  }
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((value) => {
    window.localStorage.setItem('personalfi:theme', value);
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // `--dur-fast` (160ms) animates colour on a theme flip; outlasting it is a
  // synchronisation fix for the axe scan, not a loosened assertion (same
  // comment as `market-data.spec.ts`'s own copy).
  await page.waitForTimeout(250);
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Use an authenticator code instead' }).click();
  await page.getByLabel('6-digit authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Verify code' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

async function openAdvisorManagement(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Settings' })
    .click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole('link', { name: 'Advisor management' }).click();
  await expect(page).toHaveURL(/\/settings\/advisors$/);
  await expect(page.getByRole('heading', { name: 'Advisor management' })).toBeVisible();
}

const ADVISOR_ID = 'local.narrator';

/**
 * The exact prompt bytes a run of `local.narrator` would send — the same
 * object reused for the preview's `prompt.text` and the retained payload's
 * `payload` field below, so the two are byte-identical by construction (the
 * mock's honest version of "the run that followed retained what the preview
 * showed"), which the evidence file compares directly.
 */
const PROMPT_MESSAGES = [
  {
    role: 'system',
    content: 'Narrate only from the grounded findings below. Never invent a figure.',
  },
  {
    role: 'user',
    content:
      'Findings:\n<untrusted_data>{"finding_key":"cash.low_balance","summary":"Checking balance is low this week."}</untrusted_data>',
  },
];
const PROMPT_TEXT = JSON.stringify({ messages: PROMPT_MESSAGES });
const PROMPT_HASH = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const QUERY_SHAPE = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const INPUT_DIGEST = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

interface Store {
  grantedScopes: Set<string>;
  approved: boolean;
  liveStatus: string;
  liveCancelReason: string | null;
}

function scopesFor(store: Store) {
  return [
    {
      scope: 'cash.summary',
      sensitivity: 2,
      key: 'cash.summary',
      yields: 'Account balances and cash totals, rounded.',
      drops: 'No transaction detail, no merchant names.',
      externalAllowed: true,
      requiresPerRunConsent: false,
      sourcedInPhase2: true,
      granted: store.grantedScopes.has('cash.summary'),
    },
    {
      scope: 'transactions.raw',
      sensitivity: 9,
      key: 'transactions.raw',
      yields: 'Every raw transaction row, including merchant free text.',
      drops: 'Nothing — this is the widest transaction scope.',
      externalAllowed: false,
      requiresPerRunConsent: true,
      sourcedInPhase2: false,
      granted: store.grantedScopes.has('transactions.raw'),
    },
  ] as const;
}

function requestFor(store: Store) {
  return {
    contract_version: 1,
    request_id: 'req_1',
    advisor_id: ADVISOR_ID,
    advisor_version: '1.0.0',
    kind: 'local_model',
    generated_at: '2026-06-01T00:00:00.000Z',
    base_currency: 'USD',
    time_zone: 'UTC',
    today: '2026-06-01',
    granted_scopes: [...store.grantedScopes],
    input_digest: INPUT_DIGEST,
    limits: { max_insights: 5, max_response_bytes: 65536, deadline: '2026-06-01T00:03:00.000Z' },
    snapshot: {},
  };
}

function liveRun(store: Store) {
  return {
    id: 'run_live',
    advisorId: ADVISOR_ID,
    advisorVersion: '1.0.0',
    trigger: 'manual',
    status: store.liveStatus,
    refusal: null,
    inputDigest: INPUT_DIGEST,
    grantedScopes: [...store.grantedScopes],
    emittedScopes: ['cash.summary'],
    proposedCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    errorCode: null,
    durationMs: null,
    startedAt: '2026-06-01T06:00:00.000Z',
    finishedAt: store.liveStatus === 'started' ? null : '2026-06-01T06:00:05.000Z',
    cancelRequestedAt: store.liveStatus === 'started' ? null : '2026-06-01T06:00:04.000Z',
    cancelReason: store.liveCancelReason,
    llmModel: store.liveStatus === 'started' ? null : 'qwen2.5:7b-instruct-q4_K_M',
    llmPromptHash: store.liveStatus === 'started' ? null : PROMPT_HASH,
  };
}

function doneRun() {
  return {
    id: 'run_done',
    advisorId: ADVISOR_ID,
    advisorVersion: '1.0.0',
    trigger: 'schedule',
    status: 'completed',
    refusal: null,
    inputDigest: INPUT_DIGEST,
    grantedScopes: ['cash.summary'],
    emittedScopes: ['cash.summary'],
    proposedCount: 1,
    acceptedCount: 1,
    rejectedCount: 1,
    errorCode: null,
    durationMs: 4800,
    startedAt: '2026-05-25T06:00:00.000Z',
    finishedAt: '2026-05-25T06:00:05.000Z',
    cancelRequestedAt: null,
    cancelReason: null,
    llmModel: 'qwen2.5:7b-instruct-q4_K_M',
    llmPromptHash: PROMPT_HASH,
  };
}

/**
 * Registers every `/advisors*` route this screen calls, over the shared
 * mock's session/step-up handling (`state.steppedUp`, flipped by
 * `/api/auth/step-up/verify` — the same flag `mock-api.ts`'s own
 * `/api/connections` POST reads).
 */
async function installAdvisorMocks(page: Page, state: { steppedUp: boolean }): Promise<Store> {
  const store: Store = {
    grantedScopes: new Set(['cash.summary']),
    approved: false,
    liveStatus: 'started',
    liveCancelReason: null,
  };

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const stepUpRequired = () =>
      json(
        {
          type: 'about:blank',
          title: 'Step-up required',
          status: 403,
          code: 'step_up_required',
          correlationId: 'corr_su',
        },
        403,
      );

    if (path === '/api/advisors' && method === 'GET') {
      return json({
        advisors: [
          {
            advisorId: ADVISOR_ID,
            displayName: 'Local narrator',
            kind: 'local_model',
            version: '1.0.0',
            enabled: true,
            quarantinedAt: null,
            quarantineReason: null,
            consecutiveFailures: 0,
            lastRunAt: '2026-06-01T06:00:00.000Z',
            grantedScopes: [...store.grantedScopes],
            lastRunStatus: store.liveStatus,
            lastRunRejected: 1,
          },
        ],
      });
    }

    if (path === `/api/advisors/${ADVISOR_ID}/scopes` && method === 'GET') {
      return json({ advisorId: ADVISOR_ID, kind: 'local_model', scopes: scopesFor(store) });
    }

    if (path === `/api/advisors/${ADVISOR_ID}/grants` && method === 'PUT') {
      if (!state.steppedUp) return stepUpRequired();
      const body = request.postDataJSON() as { scopes: string[] };
      const before = new Set(store.grantedScopes);
      store.grantedScopes = new Set(body.scopes);
      const granted = body.scopes.filter((s) => !before.has(s));
      const revoked = [...before].filter((s) => !store.grantedScopes.has(s));
      return json({ advisorId: ADVISOR_ID, granted, revoked });
    }

    if (path === `/api/advisors/${ADVISOR_ID}/payload-preview` && method === 'GET') {
      return json({
        advisorId: ADVISOR_ID,
        kind: 'local_model',
        queryShape: QUERY_SHAPE,
        scopes: [...store.grantedScopes],
        promptTemplateHash: PROMPT_HASH,
        request: requestFor(store),
        prompt: { text: PROMPT_TEXT, hash: PROMPT_HASH },
        approvalRequired: true,
        approved: store.approved,
      });
    }

    if (path === `/api/advisors/${ADVISOR_ID}/payload-approvals` && method === 'POST') {
      if (!state.steppedUp) return stepUpRequired();
      store.approved = true;
      return json({ approvalId: 'appr_1', queryShape: QUERY_SHAPE });
    }

    if (path === `/api/advisors/${ADVISOR_ID}/runs` && method === 'GET') {
      return json({ runs: [liveRun(store), doneRun()] });
    }

    if (path === '/api/advisors/runs/run_live' && method === 'GET') {
      return json({ run: liveRun(store), rejections: [], payload: null });
    }

    if (path === '/api/advisors/runs/run_done' && method === 'GET') {
      return json({
        run: doneRun(),
        rejections: [
          { step: 'numerals', code: 'figure_not_traceable', findingKey: 'cash.low_balance' },
        ],
        payload: {
          queryShape: QUERY_SHAPE,
          recordedDigest: INPUT_DIGEST,
          recomputedDigest: INPUT_DIGEST,
          digestVerified: true,
          payload: { messages: PROMPT_MESSAGES },
          expiresAt: '2026-06-25T06:00:00.000Z',
        },
      });
    }

    if (path === '/api/advisors/runs/run_live/cancel' && method === 'POST') {
      if (!state.steppedUp) return stepUpRequired();
      if (store.liveStatus !== 'started') {
        return json(
          {
            type: 'about:blank',
            title: 'Run not in flight',
            status: 409,
            code: 'insights.run_not_in_flight',
            correlationId: 'corr_c',
          },
          409,
        );
      }
      store.liveStatus = 'cancelled';
      store.liveCancelReason = 'run_cancelled';
      return json({ runId: 'run_live', outcome: 'requested' });
    }

    if (path === '/api/advisors/kinds/local_model/enabled' && method === 'PUT') {
      if (!state.steppedUp) return stepUpRequired();
      const body = request.postDataJSON() as { enabled: boolean };
      return json({ kind: 'local_model', enabled: body.enabled });
    }

    return route.fallback();
  });

  return store;
}

async function openAdvisorDetail(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Show detail' }).click();
  await expect(page.getByRole('region', { name: 'Local narrator detail' })).toBeVisible();
}

test('granting a scope shows what it yields and what it drops before the step-up', async ({
  page,
}) => {
  await installFakeWebAuthnAssertion(page);
  const state = await installApiMocks(page);
  await installAdvisorMocks(page, state);

  await login(page);
  await openAdvisorManagement(page);
  await openAdvisorDetail(page);

  const scopeRows = page.getByTestId('scope-row');
  await expect(scopeRows).toHaveCount(2);

  // Rendered on mount, before any grant action — no checkbox has been
  // clicked and no step-up has happened yet (the sabotage this proves
  // against: "yields/drops hidden before step-up").
  const perRunRow = page.getByTestId('scope-row').filter({ hasText: 'transactions.raw' });
  await expect(perRunRow).toContainText('Every raw transaction row, including merchant free text.');
  await expect(perRunRow).toContainText('Nothing — this is the widest transaction scope.');
  await expect(perRunRow).toContainText('Consented per run only');

  // Now grant it, which does cross the step-up ceremony.
  await perRunRow.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Save grants' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Granted:' })).toBeVisible();
});

test('the payload preview shows the exact bytes the model would receive, and approval comes before the first run', async ({
  page,
}) => {
  await installFakeWebAuthnAssertion(page);
  const state = await installApiMocks(page);
  await installAdvisorMocks(page, state);

  await login(page);
  await openAdvisorManagement(page);
  await openAdvisorDetail(page);

  const untrustedBlock = page.getByTestId('untrusted-block');
  await expect(untrustedBlock).toContainText('cash.low_balance');
  await expect(untrustedBlock).toContainText('Checking balance is low this week');

  // Approval is offered, and is not yet granted — "before the first run".
  await expect(page.getByRole('button', { name: 'Approve this payload' })).toBeVisible();
  await expect(page.getByText('Approved for this exact payload shape')).toHaveCount(0);

  await page.getByRole('button', { name: 'Approve this payload' }).click();
  await expect(page.getByText('Approved for this exact payload shape')).toBeVisible();
});

test('the run inspector shows the input digest and marks a verified payload', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  const state = await installApiMocks(page);
  await installAdvisorMocks(page, state);

  await login(page);
  await openAdvisorManagement(page);
  await openAdvisorDetail(page);

  await page.getByTestId('run-row').filter({ hasText: 'run_done' }).click();
  await expect(page.getByTestId('input-digest')).toHaveText(INPUT_DIGEST);
  const mark = page.getByTestId('verified-mark');
  await expect(mark).toContainText('Verified');
  await expect(mark).not.toContainText('Not verified');
});

test('an in-flight local-model run can be cancelled from the inspector', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  const state = await installApiMocks(page);
  await installAdvisorMocks(page, state);

  await login(page);
  await openAdvisorManagement(page);
  await openAdvisorDetail(page);

  // The live run is selected by default (most recent).
  await expect(page.getByTestId('run-detail')).toContainText('started');
  const cancelButton = page.getByTestId('cancel-run-button');
  await expect(cancelButton).toBeVisible();

  await cancelButton.click();

  await expect(page.getByTestId('run-detail')).toContainText('cancelled');
  await expect(page.getByTestId('cancellation-level')).toContainText('Level 4 (this run)');
  await expect(page.getByTestId('cancel-run-button')).toHaveCount(0);
});

test('the advisor management screen is axe clean in both themes', async ({ page }) => {
  await installFakeWebAuthnAssertion(page);
  const state = await installApiMocks(page);
  await installAdvisorMocks(page, state);

  await login(page);
  await openAdvisorManagement(page);
  await openAdvisorDetail(page);

  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await expectAxeCleanExceptSharedSidebar(page, `advisor management (${theme})`);
    await shoot(page, `advisor-management-${theme}`);

    await page.getByTestId('run-row').filter({ hasText: 'run_done' }).click();
    await expectAxeCleanExceptSharedSidebar(page, `advisor management, run detail (${theme})`);
    await shoot(page, `run-inspector-${theme}`);
  }
});
