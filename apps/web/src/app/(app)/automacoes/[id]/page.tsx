import type { Metadata } from 'next';
import { AutomationBuilder } from '@/features/automation/builder-view';

export const metadata: Metadata = { title: 'Automação' };

export default async function AutomacaoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AutomationBuilder id={id} />;
}
