// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { Lightbulb } from 'lucide-react';

import { PlaceholderRoute } from '../components/patterns/PlaceholderRoute.tsx';

export const Route = createFileRoute('/_app/insights')({
  component: () => (
    <PlaceholderRoute
      icon={Lightbulb}
      headline="You're all caught up"
      description="Insights about spending, price increases, and budgets will appear here as they're found."
    />
  ),
});
