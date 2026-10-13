import { MaquinaShell } from '@/features/content-machine/maquina-shell';

/** Cabeçalho, seções e avisos de capacidade são da área inteira; cada seção é uma rota. */
export default function MaquinaLayout({ children }: { children: React.ReactNode }) {
  return <MaquinaShell>{children}</MaquinaShell>;
}
