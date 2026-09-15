// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { AccountsScreen } from '../features/accounts/AccountsScreen.tsx';

export const Route = createFileRoute('/_app/accounts/')({
  component: AccountsScreen,
});
