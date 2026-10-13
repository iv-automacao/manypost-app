import type { Metadata } from 'next';
import Link from 'next/link';
import { CONTATO, Ext, Lista, Secao, Titulo } from '@/features/legal/secao';

export const metadata: Metadata = { title: 'Termos de Serviço' };

export default function TermosPage() {
  return (
    <>
      <Titulo atualizado="30 de setembro de 2026">Termos de Serviço</Titulo>

      <p>
        O Invista Postagem é uma ferramenta de uso interno do Grupo Invista, operada pela VANTAGE, para criar, agendar
        e publicar conteúdo nas contas de redes sociais do próprio grupo. Ao usar a ferramenta, você concorda com estes
        termos.
      </p>

      <Secao titulo="1. Quem pode usar">
        <p>
          O acesso é restrito às pessoas autorizadas pelo Grupo Invista e pela VANTAGE. Cada pessoa é responsável por
          manter o próprio login em segurança.
        </p>
      </Secao>

      <Secao titulo="2. Conteúdo publicado">
        <Lista
          itens={[
            'o conteúdo publicado é de responsabilidade do Grupo Invista;',
            'a ferramenta só publica nas contas que a própria equipe conectou e autorizou;',
            'todo conteúdo deve respeitar as regras de cada rede e a legislação aplicável.',
          ]}
        />
      </Secao>

      <Secao titulo="3. Redes sociais conectadas">
        <p>
          Ao conectar um canal do YouTube, você também concorda com os{' '}
          <Ext href="https://www.youtube.com/t/terms">Termos de Serviço do YouTube</Ext>. Contas da Meta (Instagram,
          Facebook e Threads) seguem os termos da Meta, e contas do TikTok seguem os{' '}
          <Ext href="https://www.tiktok.com/legal/terms-of-service">Termos de Serviço do TikTok</Ext>. O acesso pode ser revogado a qualquer momento na própria rede.
        </p>
      </Secao>

      <Secao titulo="4. Privacidade">
        <p>
          O tratamento de dados está descrito na <Link href="/privacidade" className="text-accent underline underline-offset-2">Política de Privacidade</Link>.
        </p>
      </Secao>

      <Secao titulo="5. Disponibilidade">
        <p>
          Trabalhamos para manter a ferramenta estável, mas as publicações dependem das APIs de cada rede, que podem
          mudar ou ficar fora do ar sem aviso.
        </p>
      </Secao>

      <Secao titulo="6. Contato">
        <p>
          Dúvidas sobre estes termos: <Ext href={`mailto:${CONTATO}`}>{CONTATO}</Ext>.
        </p>
      </Secao>
    </>
  );
}
