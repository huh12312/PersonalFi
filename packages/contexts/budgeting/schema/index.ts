// SPDX-License-Identifier: MIT
/**
 * Drizzle table definitions owned by `@ctx/budgeting`.
 *
 * Tables declared here must appear in this package's OWNERSHIP.md, and nowhere
 * else's. Hand-written SQL for them still lives in `packages/db/migrations/` so
 * there is one ordered, forward-only history for the whole database.
 *
 * `accounts`, `transactions` and `categories` are deliberately absent.
 * `@ctx/ledger` and `@ctx/categorization` own them, and this context reaches
 * their data through the injected `LedgerPort` (`src/ledger-port.ts`) and
 * through events — never through a table definition and never through a JOIN.
 * `budget_lines.category_id` and `budget_lines.credit_account_id` are opaque
 * UUIDs with no foreign key for exactly that reason (decision D8).
 */
export {
  BUDGET_MODES,
  PERIOD_KINDS,
  PERIOD_STATUSES,
  budgetPeriods,
  budgets,
  type BudgetMode,
  type BudgetPeriodRow,
  type BudgetRow,
  type NewBudgetPeriodRow,
  type NewBudgetRow,
  type PeriodKind,
  type PeriodStatus,
} from './budgets.ts';
export {
  ASSIGNED_SOURCES,
  BUDGET_CLASSES,
  GOAL_TYPES,
  LINE_KINDS,
  ROLLOVER_POLICIES,
  budgetLineActuals,
  budgetLines,
  type AssignedSource,
  type BudgetClass,
  type BudgetLineActualsRow,
  type BudgetLineRow,
  type GoalType,
  type LineKind,
  type NewBudgetLineActualsRow,
  type NewBudgetLineRow,
  type RolloverPolicy,
} from './lines.ts';
export {
  ALERT_THRESHOLDS,
  budgetAlertsState,
  rollovers,
  type AlertThreshold,
  type BudgetAlertStateRow,
  type NewBudgetAlertStateRow,
  type NewRolloverRow,
  type RolloverRow,
} from './rollovers.ts';
