// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { AccountDetailScreen } from '../features/accounts/AccountDetailScreen.tsx';

export const Route = createFileRoute('/_app/accounts/$accountId')({
  component: RouteComponent,
});

function RouteComponent() {
  const { accountId } = Route.useParams();
  return <AccountDetailScreen accountId={accountId} />;
}
