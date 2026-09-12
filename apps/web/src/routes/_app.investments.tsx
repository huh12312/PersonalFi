// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { LineChart } from 'lucide-react';

import { PlaceholderRoute } from '../components/patterns/PlaceholderRoute.tsx';

export const Route = createFileRoute('/_app/investments')({
  component: () => (
    <PlaceholderRoute
      icon={LineChart}
      headline="No investment accounts yet"
      description="Connect a brokerage or crypto exchange to see performance, allocation, and holdings."
    />
  ),
});
