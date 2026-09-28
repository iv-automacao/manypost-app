import type { Metadata } from 'next';
import { SpendView } from '@/features/content-machine/spend-view';

export const metadata: Metadata = { title: 'Gastos · Máquina' };

export default function MaquinaGastosPage() {
  return <SpendView />;
}
