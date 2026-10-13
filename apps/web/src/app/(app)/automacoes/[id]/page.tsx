import type { Metadata } from 'next';
import { AutomationEditorPage } from '@/features/automation/flow/editor-page';

export const metadata: Metadata = { title: 'Automação' };

export default async function AutomacaoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AutomationEditorPage id={id} />;
}
