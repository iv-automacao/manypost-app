import type { Metadata } from 'next';
import { IdentityView } from '@/features/content-machine/identity-view';

export const metadata: Metadata = { title: 'Identidade · Máquina' };

export default function MaquinaIdentidadePage() {
  return <IdentityView />;
}
