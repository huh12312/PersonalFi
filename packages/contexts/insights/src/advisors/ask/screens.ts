// SPDX-License-Identifier: MIT
/**
 * The screens an Ask PersonalFi answer may point at (WP 11.5c; 12 §4: "I
 * can't compute that yet — here is the nearest screen"), and the words the
 * app uses for each catalogue function in the "I looked at: …" line.
 *
 * A closed list of real routes of the web app (`apps/web/src/routes/`): the
 * compiler names one by path, the validator refuses any other, and the screen
 * links it. `ask-screens.test.ts` in the web package holds the list to the
 * route tree.
 */
import type { CatalogueFunctionName } from '../../catalogue/catalogue.ts';

export const ASK_NEAREST_SCREENS = Object.freeze({
  '/': 'Dashboard',
  '/reports': 'Reports',
  '/cash-flow': 'Cash flow',
  '/budget': 'Budget',
  '/transactions': 'Transactions',
  '/recurring': 'Recurring',
  '/accounts': 'Accounts',
  '/investments': 'Investments',
  '/plan': 'Plan',
  '/goals': 'Goals',
  '/health': 'Financial health',
  '/brief': 'Brief',
  '/insights': 'Insights',
} as const);
export type AskNearestScreen = keyof typeof ASK_NEAREST_SCREENS;
export const ASK_NEAREST_SCREEN_PATHS = Object.freeze(
  Object.keys(ASK_NEAREST_SCREENS) as AskNearestScreen[],
);

export function isAskNearestScreen(value: unknown): value is AskNearestScreen {
  return typeof value === 'string' && Object.hasOwn(ASK_NEAREST_SCREENS, value);
}

/** Each function's own screen: where a not-available or refused call points the holder. */
export const ASK_FUNCTION_SCREENS: Readonly<Record<CatalogueFunctionName, AskNearestScreen>> =
  Object.freeze({
    'situation.snapshot': '/',
    'cash.emergency_fund': '/health',
    'debt.payoff_plan': '/accounts',
    'goal.required_savings': '/goals',
    'plan.project': '/plan',
    'plan.compare': '/plan',
    'plan.levers': '/plan',
    'retirement.claiming': '/plan',
    'retirement.guardrail': '/plan',
    'retirement.rmd_window': '/plan',
    'investing.allocation': '/investments',
    'investing.drift': '/investments',
    'investing.concentration': '/investments',
    'investing.costs': '/investments',
    'investing.tax_location': '/investments',
    'limits.contribution_room': '/investments',
    'recurring.waste': '/recurring',
    'insights.current': '/brief',
    'insights.explain': '/insights',
  });

/** The words for each function in "I looked at: …". The app's, never a model's. */
export const ASK_FUNCTION_LABELS: Readonly<Record<CatalogueFunctionName, string>> = Object.freeze({
  'situation.snapshot': 'your financial snapshot',
  'cash.emergency_fund': 'emergency-fund cover',
  'debt.payoff_plan': 'debt payoff plan',
  'goal.required_savings': 'required savings for a goal',
  'plan.project': 'plan projection',
  'plan.compare': 'plan comparison',
  'plan.levers': 'plan levers',
  'retirement.claiming': 'Social Security claiming ages',
  'retirement.guardrail': 'withdrawal guardrail',
  'retirement.rmd_window': 'required minimum distribution window',
  'investing.allocation': 'portfolio allocation',
  'investing.drift': 'allocation drift',
  'investing.concentration': 'position concentration',
  'investing.costs': 'fund costs',
  'investing.tax_location': 'asset location',
  'limits.contribution_room': 'contribution room',
  'recurring.waste': 'subscription findings',
  'insights.current': 'this week’s Brief',
  'insights.explain': 'a stored explanation',
});

/**
 * The playbook page each function's answer would rest on (12 §2.2: retrieval
 * is keyed, never semantic). Read through the knowledge base's review gate; a
 * draft is never sent (`knowledge/playbook.ts` refuses it), and the session
 * records which pages were withheld.
 */
export const ASK_FUNCTION_PAGES: Readonly<Partial<Record<CatalogueFunctionName, string>>> =
  Object.freeze({
    'cash.emergency_fund': 'emergency-fund',
    'debt.payoff_plan': 'debt-order',
    'retirement.claiming': 'claiming-age',
    'retirement.guardrail': 'guardrail-withdrawal',
    'investing.drift': 'rebalancing-with-new-money',
    'investing.tax_location': 'tax-location',
    'limits.contribution_room': 'tax-advantaged-order',
    'recurring.waste': 'subscription-audit',
  });
