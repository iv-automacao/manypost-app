import type { Metadata } from 'next';
import { BoardView } from '@/features/content-machine/board-view';

export const metadata: Metadata = { title: 'Máquina' };

export default function MaquinaPage() {
  return <BoardView />;
}
