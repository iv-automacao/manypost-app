import type { Metadata } from 'next';
import { PromptsView } from '@/features/content-machine/prompts-view';

export const metadata: Metadata = { title: 'Prompts · Máquina' };

export default function MaquinaPromptsPage() {
  return <PromptsView />;
}
