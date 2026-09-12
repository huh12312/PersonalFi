// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { Landmark } from 'lucide-react';

import { PlaceholderRoute } from '../components/patterns/PlaceholderRoute.tsx';

export const Route = createFileRoute('/_app/accounts')({
  component: () => (
    <PlaceholderRoute
      icon={Landmark}
      headline="Connect your first account"
      description="Link a bank via Plaid, connect Coinbase, or add a manual account."
    />
  ),
});
