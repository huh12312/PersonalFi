// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { Repeat } from 'lucide-react';

import { PlaceholderRoute } from '../components/patterns/PlaceholderRoute.tsx';

export const Route = createFileRoute('/_app/recurring')({
  component: () => (
    <PlaceholderRoute
      icon={Repeat}
      headline="No subscriptions detected yet"
      description="Once transactions are syncing, recurring charges and price increases show up here."
    />
  ),
});
