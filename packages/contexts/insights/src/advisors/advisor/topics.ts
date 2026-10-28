// SPDX-License-Identifier: MIT
/**
 * The advisor's three closed tables (WP 11.5d), in code so a test holds each:
 *
 *   * **topic → playbook page** (12 §2.2: retrieval is keyed, never semantic) —
 *     the gather step picks pages by keyword over the clarified question, and
 *     the knowledge base's review gate decides whether one may be sent (every
 *     page is a draft today, so none is; the session records each withheld);
 *   * **the action screens** a plan step may link to: 11.5c's nearest-screen
 *     list, extended with the goal, rule, connection and plan screens — real
 *     routes of the web app, never an execution, never an external address;
 *   * **the rubric per page** the judge scores against (12 §5, decision 3): did
 *     the wording surface the cost; did it say when the approach does not
 *     apply (in that page's own terms); did it stay in scope.
 */
import { ASK_NEAREST_SCREENS } from '../ask/screens.ts';

export interface AdvisorTopic {
  readonly topic: string;
  readonly pattern: RegExp;
  readonly page: string;
}

/** Deterministic, in this order; a question may match several. */
export const ADVISOR_TOPIC_PAGES: readonly AdvisorTopic[] = Object.freeze([
  {
    topic: 'emergency_fund',
    pattern:
      /\b(?:emergency(?: fund)?|cushion|rainy[- ]day|cash (?:reserve|buffer)|sitting in (?:checking|savings)|months? of (?:spending|expenses))\b/iu,
    page: 'emergency-fund',
  },
  {
    topic: 'debt_order',
    pattern:
      /\b(?:debts?|loans?|credit cards?|cards?|pay ?(?:it )?(?:off|down)|payoff|interest|apr|avalanche|snowball|mortgage)\b/iu,
    page: 'debt-order',
  },
  {
    topic: 'tax_advantaged_order',
    pattern:
      /\b(?:401\s*\(?k\)?|403\s*\(?b\)?|ira|roth|hsa|contribut\w*|employer match|match|tax[- ]advantaged|retirement accounts?)\b/iu,
    page: 'tax-advantaged-order',
  },
  {
    topic: 'claiming_age',
    pattern: /\b(?:social security|claim(?:ing)?(?: age)?)\b/iu,
    page: 'claiming-age',
  },
  {
    topic: 'guardrail_withdrawal',
    pattern:
      /\b(?:withdraw\w*|guardrails?|drawdown|retire(?: at| early)?|retirement spending|can i retire)\b/iu,
    page: 'guardrail-withdrawal',
  },
  {
    topic: 'rebalancing',
    pattern: /\b(?:rebalanc\w*|drift\w*|allocation|new money)\b/iu,
    page: 'rebalancing-with-new-money',
  },
  {
    topic: 'tax_location',
    pattern: /\b(?:tax[- ]location|asset location|which account|taxable account)\b/iu,
    page: 'tax-location',
  },
  {
    topic: 'subscriptions',
    pattern: /\b(?:subscriptions?|streaming|recurring charges?|memberships?)\b/iu,
    page: 'subscription-audit',
  },
]);

/** The page keys a question touches, in table order, without repeats. Pure. */
export function advisorPagesFor(text: string): readonly string[] {
  const folded = text.normalize('NFKC');
  const pages: string[] = [];
  for (const entry of ADVISOR_TOPIC_PAGES) {
    if (entry.pattern.test(folded) && !pages.includes(entry.page)) pages.push(entry.page);
  }
  return pages;
}

// ---------------------------------------------------------------------------
// The action screens
// ---------------------------------------------------------------------------

export const ADVISOR_ACTION_SCREENS = Object.freeze({
  ...ASK_NEAREST_SCREENS,
  '/accounts/connections': 'Connections',
  '/settings': 'Settings (rules)',
  '/inbox': 'Inbox',
} as const);
export type AdvisorActionScreen = keyof typeof ADVISOR_ACTION_SCREENS;
export const ADVISOR_ACTION_SCREEN_PATHS = Object.freeze(
  Object.keys(ADVISOR_ACTION_SCREENS) as AdvisorActionScreen[],
);

export function isAdvisorActionScreen(value: unknown): value is AdvisorActionScreen {
  return typeof value === 'string' && Object.hasOwn(ADVISOR_ACTION_SCREENS, value);
}

// ---------------------------------------------------------------------------
// The rubric
// ---------------------------------------------------------------------------

export interface RubricCriterion {
  readonly id: 'cost_surfaced' | 'non_applicability' | 'scope_kept';
  readonly question: string;
}

export interface AdvisorRubric {
  /** The page it is for, or `general` when the question touched none. */
  readonly page: string;
  readonly criteria: readonly RubricCriterion[];
}

/** Each page's "When it does not apply", in a phrase — what the second criterion asks after. */
const NOT_APPLICABLE: Readonly<Record<string, string>> = Object.freeze({
  'emergency-fund':
    'high-interest debt competing for the same money, cash already spoken for, other liquid resources, or retirement',
  'debt-order':
    'a promotional rate ending, no cushion at all, low-rate debt weighed against investing, or loans with special terms',
  'tax-advantaged-order':
    'no employer match or a costly plan, no high-deductible health plan, income above the Roth phase-out, money needed soon, or self-employment',
  'claiming-age':
    'health and family history, no savings to bridge the wait, other benefit types, or the separate question of when to stop working',
  'guardrail-withdrawal':
    'before retirement, spending that cannot fall, income that already covers spending, required distributions, or the final years of a plan',
  'rebalancing-with-new-money':
    'a large drift, no new money, a deliberate change of target, a small drift inside the band, or a concentrated position',
  'tax-location':
    'only one kind of account, tax-exempt bonds, moves that would realise gains, or money needed before retirement withdrawals',
  'subscription-audit':
    'bills that vary, annual plans, shared or bundled services, or contracts with a minimum term',
});

const COST: RubricCriterion = Object.freeze({
  id: 'cost_surfaced',
  question: 'Does every option the wording names say what it costs, next to what it gains?',
});
const SCOPE: RubricCriterion = Object.freeze({
  id: 'scope_kept',
  question:
    'Does the wording stay inside scope: no security, fund or coin named, no market timing, no tax filing, insurance or estate advice, and nothing saying the app will move money?',
});

export function advisorRubricFor(pages: readonly string[]): AdvisorRubric {
  const page = pages.find((key) => Object.hasOwn(NOT_APPLICABLE, key)) ?? null;
  if (page === null) {
    return {
      page: 'general',
      criteria: [
        COST,
        {
          id: 'non_applicability',
          question:
            'Does the wording say, at least once, when one of the options would not suit the situation?',
        },
        SCOPE,
      ],
    };
  }
  return {
    page,
    criteria: [
      COST,
      {
        id: 'non_applicability',
        question: `Does the wording mention when the approach does not apply — for example ${NOT_APPLICABLE[page] ?? ''}?`,
      },
      SCOPE,
    ],
  };
}

/** Every page with a rubric: the eight playbook pages. */
export const ADVISOR_RUBRIC_PAGES: readonly string[] = Object.freeze(Object.keys(NOT_APPLICABLE));
