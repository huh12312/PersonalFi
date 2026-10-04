// SPDX-License-Identifier: MIT
import {
  CalendarClock,
  Inbox,
  Landmark,
  LayoutDashboard,
  Lightbulb,
  LineChart,
  PiggyBank,
  Receipt,
  Repeat,
  Settings,
  Target,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * The nine authenticated-shell routes, as a literal union rather than
 * `string` — `<Link to>` is type-checked against the registered route tree
 * (src/app/router.tsx), and a widened `string` would defeat that. Keeping the
 * union here means adding a route is a compiler error at every nav surface
 * (sidebar, bottom tabs, "More" sheet, command palette) until it's added.
 */
export type NavPath =
  | '/'
  | '/inbox'
  | '/transactions'
  | '/budget'
  | '/recurring'
  | '/accounts'
  | '/investments'
  | '/plan'
  | '/insights'
  | '/brief'
  | '/settings';

export interface NavItem {
  to: NavPath;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Sidebar grouping (05-frontend-architecture.md §4.2). */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/insights', label: 'Insights', icon: Lightbulb },
      { to: '/brief', label: 'Brief', icon: CalendarClock },
    ],
  },
  {
    label: 'Money',
    items: [
      { to: '/inbox', label: 'Inbox', icon: Inbox },
      { to: '/transactions', label: 'Transactions', icon: Receipt },
      { to: '/budget', label: 'Budget', icon: PiggyBank },
      { to: '/recurring', label: 'Recurring', icon: Repeat },
    ],
  },
  {
    label: 'Wealth',
    items: [
      { to: '/accounts', label: 'Accounts', icon: Landmark },
      { to: '/investments', label: 'Investments', icon: LineChart },
      { to: '/plan', label: 'Plan', icon: Target },
    ],
  },
  { label: 'System', items: [{ to: '/settings', label: 'Settings', icon: Settings }] },
];

/** Flat list, in the order used by the command palette and the "More" sheet. */
export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** Mobile bottom tab bar — 5 items max (§4.2): the four highest-frequency destinations, plus More. */
export const BOTTOM_TABS: NavItem[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard },
  { to: '/transactions', label: 'Transactions', icon: Receipt },
  { to: '/budget', label: 'Budget', icon: PiggyBank },
  { to: '/insights', label: 'Insights', icon: Lightbulb },
];

/** Everything not on the bottom bar, surfaced from the "More" sheet. */
export const MORE_NAV_ITEMS: NavItem[] = [
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/accounts', label: 'Accounts', icon: Landmark },
  { to: '/investments', label: 'Investments', icon: LineChart },
  { to: '/plan', label: 'Plan', icon: Target },
  { to: '/recurring', label: 'Recurring', icon: Repeat },
  { to: '/brief', label: 'Brief', icon: CalendarClock },
  { to: '/settings', label: 'Settings', icon: Settings },
];
