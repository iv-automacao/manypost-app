import Link from 'next/link';

// páginas públicas exigidas pelas redes (Google/YouTube e Meta) para publicar o app OAuth:
// abrem sem sessão (ver PUBLIC_PREFIXES no proxy) e não dependem de nada do produto
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-paper text-ink">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
        <nav className="flex flex-wrap items-center gap-4 text-compact text-muted-foreground">
          <span className="font-semibold text-ink">Invista Postagem</span>
          <Link href="/privacidade" className="hover:text-ink">Política de Privacidade</Link>
          <Link href="/termos" className="hover:text-ink">Termos de Serviço</Link>
        </nav>
        <article className="flex flex-col gap-6 text-panel leading-relaxed">{children}</article>
      </div>
    </main>
  );
}
