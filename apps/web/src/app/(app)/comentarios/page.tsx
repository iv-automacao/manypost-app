import type { Metadata } from 'next';
import { CommentsView } from '@/features/engagement/comments-view';

export const metadata: Metadata = { title: 'Comentários' };

export default function ComentariosPage() {
  return <CommentsView />;
}
