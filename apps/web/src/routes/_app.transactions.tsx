// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { TransactionsScreen } from '../features/transactions/TransactionsScreen.tsx';
import { transactionsSearchSchema } from '../features/transactions/filters.ts';

export const Route = createFileRoute('/_app/transactions')({
  validateSearch: transactionsSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <TransactionsScreen
      search={search}
      onSearchChange={(next) => void navigate({ search: next, replace: true })}
    />
  );
}
