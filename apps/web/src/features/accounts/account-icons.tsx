// SPDX-License-Identifier: MIT
import { Bitcoin, CreditCard, Landmark, PencilLine, TrendingUp, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { Account } from '../../api/generated/types.gen.ts';

/** One glyph per account type, distinct from the sidebar's own "Accounts" icon so a card doesn't repeat the nav chrome. */
export const ACCOUNT_TYPE_ICON: Record<Account['type'], LucideIcon> = {
  depository: Wallet,
  credit: CreditCard,
  loan: Landmark,
  investment: TrendingUp,
  crypto: Bitcoin,
  manual: PencilLine,
};
