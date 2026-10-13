import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LeadsView } from '@/features/automation/leads-view';

export const metadata: Metadata = { title: 'Leads' };

export default function LeadsPage() {
  // useSearchParams exige um limite de Suspense no build estático
  return (
    <Suspense>
      <LeadsView />
    </Suspense>
  );
}
