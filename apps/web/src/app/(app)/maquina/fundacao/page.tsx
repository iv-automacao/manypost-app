import type { Metadata } from 'next';
import { FoundationView } from '@/features/content-machine/foundation-view';

export const metadata: Metadata = { title: 'Fundação · Máquina' };

export default function MaquinaFundacaoPage() {
  return <FoundationView />;
}
