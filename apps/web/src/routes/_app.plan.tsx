// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { Target } from 'lucide-react';

import { PlaceholderRoute } from '../components/patterns/PlaceholderRoute.tsx';

export const Route = createFileRoute('/_app/plan')({
  component: () => (
    <PlaceholderRoute
      icon={Target}
      headline="No goals yet"
      description="Start an emergency fund, a house down payment, or a retirement projection."
    />
  ),
});
