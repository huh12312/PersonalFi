// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * WP 2.9's own mock module, entirely separate from `mock-api.ts` (owned by
 * WP 2.11/the transactions-and-inbox suites — this work package's rules
 * forbid editing it, to avoid a two-agent collision on one shared fixture
 * file). Same technique as `mock-api.ts`'s own header explains: a single
 * `page.route('**\/*')` handler backed by an in-memory store, entirely
 * client-side — no live `apps/api`, no database.
 *
 * Covers exactly what `e2e/budget.spec.ts` drives: login, the budget screen
 * (`GET /budgets/current`, `GET /budgets/periods`, `POST /budgets/lines`,
 * `PATCH /budgets/lines/{id}`, `POST /budgets/periods/roll`), the reports
 * screen (`GET /reports/{spending,income,sankey,budget-vs-actual}`,
 * `GET /export` behind step-up), the dashboard's own `GET /insights` (the
 * landing screen after login, per every other e2e suite's own login-then-
 * navigate shape), and the `/transactions` drill-through target
 * (`GET /transactions`, `GET /accounts`, `GET /categories`).
 */

const SESSION = {
  userId: 'user_1',
  displayName: 'Chris',
  displayTimezone: 'UTC',
  authMethod: 'totp',
  trustedDevice: true,
  fresh: true,
  idleExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  credentialCount: 1,
  totpEnrolled: true,
  recoveryCodesRemaining: 10,
};

const ACCOUNT = {
  id: 'acct_1',
  connectionId: 'conn_1',
  provider: 'manual',
  name: 'Everyday Checking',
  officialName: null,
  type: 'depository',
  subtype: null,
  classification: 'asset',
  currency: 'USD',
  mask: '4321',
  closedAt: null,
  includeInNetWorth: true,
  balance: {
    current: { minor: '250000', currency: 'USD' },
    available: null,
    limit: null,
    asOf: new Date().toISOString(),
    source: 'provider',
  },
};

const CREDIT_ACCOUNT = {
  id: 'acct_card',
  connectionId: 'conn_1',
  provider: 'manual',
  name: 'Rewards Card',
  officialName: null,
  type: 'credit',
  subtype: null,
  classification: 'liability',
  currency: 'USD',
  mask: '9999',
  closedAt: null,
  includeInNetWorth: true,
  balance: {
    current: { minor: '-15000', currency: 'USD' },
    available: null,
    limit: { minor: '500000', currency: 'USD' },
    asOf: new Date().toISOString(),
    source: 'provider',
  },
};

const CATEGORIES = [
  {
    id: 'cat_groceries',
    key: 'groceries',
    parentId: null,
    label: 'Groceries',
    description: 'Food at home.',
    kind: 'expense',
    icon: 'shopping-cart',
    sort: 100,
    isSystem: true,
    archivedAt: null,
    assignable: true,
  },
  {
    id: 'cat_dining',
    key: 'dining',
    parentId: null,
    label: 'Dining',
    description: 'Eating out.',
    kind: 'expense',
    icon: 'utensils',
    sort: 200,
    isSystem: true,
    archivedAt: null,
    assignable: true,
  },
];

function usd(minor: string): { minor: string; currency: string } {
  return { minor, currency: 'USD' };
}

interface BudgetLineState {
  id: string;
  kind: 'category' | 'credit_card_payment';
  categoryId: string | null;
  creditAccountId: string | null;
  name: string | null;
  assigned: string;
  activity: string;
  cashOverspend: string;
  creditOverspend: string;
  rolloverPolicy: 'ROLLOVER' | 'RESET' | 'ROLLOVER_ALLOW_NEGATIVE';
  goalType:
    | 'NONE'
    | 'MONTHLY_TARGET'
    | 'TARGET_BY_DATE'
    | 'MINIMUM_BALANCE'
    | 'PCT_OF_INCOME'
    | 'REFILL_UP_TO';
  priority: number;
  class: 'NEED' | 'WANT' | 'SAVINGS' | null;
}

function lineResponse(line: BudgetLineState) {
  const assigned = BigInt(line.assigned);
  const activity = BigInt(line.activity);
  const cashOver = BigInt(line.cashOverspend);
  const creditOver = BigInt(line.creditOverspend);
  const available = assigned + activity;
  return {
    id: line.id,
    kind: line.kind,
    categoryId: line.categoryId,
    creditAccountId: line.creditAccountId,
    name: line.name,
    carryover: usd('0'),
    assigned: usd(line.assigned),
    activity: usd(line.activity),
    available: usd(available.toString()),
    cashOverspend: usd(cashOver.toString()),
    creditOverspend: usd(creditOver.toString()),
    rolloverPolicy: line.rolloverPolicy,
    goalType: line.goalType,
    neededThisPeriod: usd('0'),
    underfunded: usd('0'),
    priority: line.priority,
    class: line.class,
    transferExcludedCount: 0,
    refundNettedCount: 0,
  };
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

export interface MockBudgetState {
  lastAssignBody: unknown;
  lastRollBody: unknown;
  lastExportDownloaded: boolean;
}

export async function installBudgetMocks(page: Page): Promise<MockBudgetState> {
  const state: MockBudgetState = {
    lastAssignBody: null,
    lastRollBody: null,
    lastExportDownloaded: false,
  };
  let authenticated = false;
  let steppedUp = false;

  const budgetId = 'budget_1';
  let periodId = 'period_1';
  let periodSequence = 1;
  let periodStart = '2026-09-01';
  let periodEnd = '2026-10-01';
  let readyToAssignMinor = 100000n; // $1,000.00

  const lines = new Map<string, BudgetLineState>([
    [
      'line_groceries',
      {
        id: 'line_groceries',
        kind: 'category',
        categoryId: 'cat_groceries',
        creditAccountId: null,
        name: null,
        assigned: '0',
        activity: '0',
        cashOverspend: '0',
        creditOverspend: '0',
        rolloverPolicy: 'ROLLOVER',
        goalType: 'NONE',
        priority: 0,
        class: null,
      },
    ],
    [
      'line_dining_overspent',
      {
        id: 'line_dining_overspent',
        kind: 'category',
        categoryId: 'cat_dining',
        creditAccountId: null,
        name: null,
        assigned: '5000',
        activity: '-7500',
        cashOverspend: '2500',
        creditOverspend: '0',
        rolloverPolicy: 'ROLLOVER',
        goalType: 'NONE',
        priority: 0,
        class: null,
      },
    ],
    [
      'line_ccp',
      {
        id: 'line_ccp',
        kind: 'credit_card_payment',
        categoryId: null,
        creditAccountId: 'acct_card',
        name: 'Rewards Card payment',
        assigned: '0',
        activity: '0',
        cashOverspend: '0',
        creditOverspend: '3000',
        rolloverPolicy: 'ROLLOVER_ALLOW_NEGATIVE',
        goalType: 'NONE',
        priority: 0,
        class: null,
      },
    ],
  ]);

  const periodHistory = [
    { id: periodId, sequence: periodSequence, startDate: periodStart, endDate: periodEnd },
  ];

  function currentPeriodResponse() {
    return {
      budgetId,
      currency: 'USD',
      period: {
        id: periodId,
        budgetId,
        kind: 'CALENDAR_MONTH',
        startDate: periodStart,
        endDate: periodEnd,
        sequence: periodSequence,
        status: 'open',
        readyToAssign: usd(readyToAssignMinor.toString()),
        income: usd('0'),
        dirty: false,
        toStayOnTrack: usd('0'),
        totalCategoryAvailable: usd('0'),
        totalCreditCardPaymentAvailable: usd('0'),
        lines: [...lines.values()].map(lineResponse),
      },
    };
  }

  const drillThrough = {
    categoryIds: ['cat_groceries'],
    from: '2026-08-01',
    to: '2026-09-01',
  };

  const transaction = {
    id: 'txn_groceries_1',
    accountId: ACCOUNT.id,
    factId: 'fact_txn_groceries_1',
    date: '2026-08-15',
    amount: usd('-6000'),
    name: 'Farmers Market',
    merchantId: 'merch_1',
    merchantName: 'Farmers Market',
    pending: false,
    excluded: false,
    categoryId: 'cat_groceries',
    note: null,
    isTransfer: false,
    transferLinkId: null,
    refundOfId: null,
    refundConfidence: null,
    supersededById: null,
    supersededReason: null,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  };

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/auth/session') {
      if (!authenticated) {
        return route.fulfill(
          json({ code: 'unauthenticated', title: 'Unauthenticated', status: 401 }, 401),
        );
      }
      return route.fulfill(json(SESSION));
    }

    if (path === '/api/auth/login/options' && method === 'POST') {
      return route.fulfill(json({ options: {} }));
    }

    if (path === '/api/auth/totp/verify' && method === 'POST') {
      authenticated = true;
      return route.fulfill(json({ ok: true }));
    }

    if (path === '/api/auth/step-up/options' && method === 'POST') {
      return route.fulfill(
        json({
          options: {
            challenge: 'dGVzdC1jaGFsbGVuZ2U',
            rpId: 'localhost',
            timeout: 60_000,
            userVerification: 'preferred',
          },
        }),
      );
    }

    if (path === '/api/auth/step-up/verify' && method === 'POST') {
      steppedUp = true;
      return route.fulfill(json({ freshUntil: new Date(Date.now() + 300_000).toISOString() }));
    }

    if (path === '/api/categories' && method === 'GET') {
      return route.fulfill(json({ categories: CATEGORIES }));
    }

    if (path === '/api/accounts' && method === 'GET') {
      return route.fulfill(json({ accounts: [ACCOUNT, CREDIT_ACCOUNT] }));
    }

    if (path === '/api/insights' && method === 'GET') {
      return route.fulfill(json({ items: [] }));
    }

    if (path === '/api/budgets/current' && method === 'GET') {
      return route.fulfill(json(currentPeriodResponse()));
    }

    if (path === '/api/budgets/periods' && method === 'GET') {
      return route.fulfill(
        json({
          periods: periodHistory.map((p) => ({
            id: p.id,
            kind: 'CALENDAR_MONTH',
            startDate: p.startDate,
            endDate: p.endDate,
            sequence: p.sequence,
            status: p.id === periodId ? 'open' : 'closed',
            readyToAssign: usd(p.id === periodId ? readyToAssignMinor.toString() : '0'),
            dirty: false,
          })),
        }),
      );
    }

    if (path === '/api/budgets/lines' && method === 'POST') {
      const body = request.postDataJSON() as { periodId: string; categoryId: string };
      const id = `line_${String(lines.size + 1)}`;
      const created: BudgetLineState = {
        id,
        kind: 'category',
        categoryId: body.categoryId,
        creditAccountId: null,
        name: null,
        assigned: '0',
        activity: '0',
        cashOverspend: '0',
        creditOverspend: '0',
        rolloverPolicy: 'ROLLOVER',
        goalType: 'NONE',
        priority: 0,
        class: null,
      };
      lines.set(id, created);
      return route.fulfill(json({ line: lineResponse(created) }, 201));
    }

    const lineMatch = /^\/api\/budgets\/lines\/([^/]+)$/.exec(path);
    if (lineMatch && method === 'PATCH') {
      const line = lines.get(lineMatch[1] ?? '');
      if (line === undefined) return route.fulfill(json({ code: 'not_found' }, 404));
      const body = request.postDataJSON() as { assigned?: { minor: string; currency: string } };
      state.lastAssignBody = body;
      if (body.assigned !== undefined) {
        const delta = BigInt(body.assigned.minor) - BigInt(line.assigned);
        readyToAssignMinor -= delta;
        line.assigned = body.assigned.minor;
      }
      return route.fulfill(json({ line: lineResponse(line) }));
    }

    if (path === '/api/budgets/periods/roll' && method === 'POST') {
      state.lastRollBody = request.postDataJSON();
      periodSequence += 1;
      periodId = `period_${String(periodSequence)}`;
      const nextStart = new Date(periodStart);
      nextStart.setUTCMonth(nextStart.getUTCMonth() + 1);
      const nextEnd = new Date(periodEnd);
      nextEnd.setUTCMonth(nextEnd.getUTCMonth() + 1);
      periodStart = nextStart.toISOString().slice(0, 10);
      periodEnd = nextEnd.toISOString().slice(0, 10);
      periodHistory.push({
        id: periodId,
        sequence: periodSequence,
        startDate: periodStart,
        endDate: periodEnd,
      });
      return route.fulfill(
        json({
          fromPeriodId: periodHistory[periodHistory.length - 2]?.id,
          toPeriodId: periodId,
          lineCount: lines.size,
          rolledOut: usd('0'),
          absorbedByRta: usd('0'),
          autoAssigned: usd('0'),
        }),
      );
    }

    if (path === '/api/reports/spending' && method === 'GET') {
      return route.fulfill(
        json({
          cells: [
            {
              month: '2026-08',
              categoryId: 'cat_groceries',
              amount: usd('-6000'),
              transactionCount: 1,
              transferExcludedCount: 0,
              refundNettedCount: 0,
              drillThrough,
            },
            {
              month: '2026-08',
              categoryId: 'cat_dining',
              amount: usd('-7500'),
              transactionCount: 1,
              transferExcludedCount: 0,
              refundNettedCount: 0,
              drillThrough: { categoryIds: ['cat_dining'], from: '2026-08-01', to: '2026-09-01' },
            },
          ],
        }),
      );
    }

    if (path === '/api/reports/income' && method === 'GET') {
      return route.fulfill(json({ cells: [] }));
    }

    if (path === '/api/reports/sankey' && method === 'GET') {
      return route.fulfill(
        json({
          currency: 'USD',
          nodes: [
            { id: 'income', kind: 'income', refId: null },
            { id: 'groceries', kind: 'category', refId: 'cat_groceries' },
          ],
          links: [
            {
              source: 'income',
              target: 'groceries',
              amount: usd('-6000'),
              drillThrough,
            },
          ],
        }),
      );
    }

    if (path === '/api/reports/budget-vs-actual' && method === 'GET') {
      return route.fulfill(
        json({
          lines: [...lines.values()]
            .filter((l) => l.kind === 'category')
            .map((l) => ({
              id: l.id,
              categoryId: l.categoryId,
              name: l.categoryId === 'cat_groceries' ? 'Groceries' : 'Dining',
              assigned: usd(l.assigned),
              activity: usd(l.activity),
              available: usd((BigInt(l.assigned) + BigInt(l.activity)).toString()),
              cashOverspend: usd(l.cashOverspend),
              creditOverspend: usd(l.creditOverspend),
              drillThrough:
                l.categoryId === 'cat_groceries'
                  ? drillThrough
                  : { categoryIds: ['cat_dining'], from: '2026-08-01', to: '2026-09-01' },
            })),
        }),
      );
    }

    if (path === '/api/export' && method === 'GET') {
      if (!steppedUp) {
        return route.fulfill(
          json(
            {
              type: 'about:blank',
              title: 'Step-up required',
              status: 403,
              code: 'step_up_required',
              correlationId: 'corr_export',
            },
            403,
          ),
        );
      }
      state.lastExportDownloaded = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson; charset=utf-8',
        body: '{"version":1,"createdAt":"2026-09-20T00:00:00.000Z","streams":[]}\n',
      });
    }

    if (path === '/api/transactions' && method === 'GET') {
      const categoryIds = url.searchParams.getAll('categoryIds');
      const items =
        categoryIds.length === 0 || categoryIds.includes('cat_groceries') ? [transaction] : [];
      return route.fulfill(
        json({ items, nextCursor: null, summary: { count: items.length, totals: [] } }),
      );
    }

    if (path === '/api/sync/stream' || path.endsWith('/events')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    }

    return route.continue();
  });

  return state;
}
