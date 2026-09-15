// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { ConnectionsScreen } from '../features/connections/ConnectionsScreen.tsx';

export const Route = createFileRoute('/_app/accounts/connections')({
  component: ConnectionsScreen,
});
