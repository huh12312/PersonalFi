// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { Receipt } from 'lucide-react';

import { PlaceholderRoute } from '../components/patterns/PlaceholderRoute.tsx';

export const Route = createFileRoute('/_app/transactions')({
  component: () => (
    <PlaceholderRoute
      icon={Receipt}
      headline="No transactions yet"
      description="Connect an account to start seeing transactions here, or import a CSV."
    />
  ),
});
