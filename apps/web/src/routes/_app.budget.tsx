// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { PiggyBank } from 'lucide-react';

import { PlaceholderRoute } from '../components/patterns/PlaceholderRoute.tsx';

export const Route = createFileRoute('/_app/budget')({
  component: () => (
    <PlaceholderRoute
      icon={PiggyBank}
      headline="No budget yet"
      description="Start with last month's spending, or build categories from scratch."
    />
  ),
});
