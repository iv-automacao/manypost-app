import type { Metadata } from 'next';
import { AutomationsView } from '@/features/automation/automations-view';

export const metadata: Metadata = { title: 'Automações' };

export default function AutomacoesPage() {
  return <AutomationsView />;
}
