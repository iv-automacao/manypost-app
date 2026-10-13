import type { Metadata } from 'next';
import { AutomationEditorPage } from '@/features/automation/flow/editor-page';

export const metadata: Metadata = { title: 'Nova automação' };

export default function NovaAutomacaoPage() {
  return <AutomationEditorPage />;
}
