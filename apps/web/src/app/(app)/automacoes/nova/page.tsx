import type { Metadata } from 'next';
import { AutomationBuilder } from '@/features/automation/builder-view';

export const metadata: Metadata = { title: 'Nova automação' };

export default function NovaAutomacaoPage() {
  return <AutomationBuilder />;
}
