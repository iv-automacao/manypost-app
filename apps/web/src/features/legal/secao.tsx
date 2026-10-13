// blocos de texto das páginas legais (/privacidade e /termos)
export function Titulo({ children, atualizado }: { children: React.ReactNode; atualizado: string }) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="font-display text-3xl font-semibold">{children}</h1>
      <p className="text-compact text-muted-foreground">Última atualização: {atualizado}</p>
    </header>
  );
}

export function Secao({ id, titulo, children }: { id?: string; titulo: string; children: React.ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-3">
      <h2 className="text-title font-semibold">{titulo}</h2>
      {children}
    </section>
  );
}

export function Lista({ itens }: { itens: React.ReactNode[] }) {
  return (
    <ul className="flex list-disc flex-col gap-2 pl-6">
      {itens.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

export function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
      {children}
    </a>
  );
}

export const CONTATO = 'suporteinvistaseguros@gmail.com';
