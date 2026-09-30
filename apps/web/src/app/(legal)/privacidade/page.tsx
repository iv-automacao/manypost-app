import type { Metadata } from 'next';
import { CONTATO, Ext, Lista, Secao, Titulo } from '@/features/legal/secao';

export const metadata: Metadata = { title: 'Política de Privacidade' };

// texto pensado para a verificação do Google (inclui a declaração de Uso Limitado e os links
// exigidos pelos Serviços de API do YouTube) e para a revisão de app da Meta (#exclusao-de-dados)
export default function PrivacidadePage() {
  return (
    <>
      <Titulo atualizado="30 de setembro de 2026">Política de Privacidade</Titulo>

      <p>
        O Invista Postagem é a ferramenta que o Grupo Invista usa para criar, agendar e publicar o próprio
        conteúdo nas suas contas de redes sociais. A ferramenta é operada pela VANTAGE (
        <Ext href="https://vantagemanaus.com.br">vantagemanaus.com.br</Ext>), em Manaus/AM, e fica em
        post.vantagemanaus.com.br. Esta política explica quais dados acessamos quando uma conta é conectada,
        para que usamos e como você pode pedir a exclusão.
      </p>

      <Secao titulo="1. Dados que acessamos">
        <p>Quando uma pessoa autorizada conecta uma conta de rede social, recebemos da própria rede:</p>
        <Lista
          itens={[
            'identificador, nome e foto do perfil, canal ou página conectada;',
            'os tokens de acesso que a rede concede à ferramenta (nunca a senha da conta);',
            'o resultado de cada publicação feita pela ferramenta (status, link e, quando a rede fornece, métricas básicas).',
          ]}
        />
        <p>
          Também guardamos o que a equipe cria dentro da ferramenta: textos, imagens, vídeos e agendamentos, além do
          e-mail e nome de quem tem acesso ao painel.
        </p>
      </Secao>

      <Secao titulo="2. Para que usamos">
        <p>
          Usamos esses dados só para publicar, a pedido da equipe, o conteúdo agendado nas contas conectadas e mostrar
          o andamento das publicações no painel. Não vendemos dados, não usamos para publicidade e não enviamos dados
          recebidos das redes a provedores de inteligência artificial.
        </p>
      </Secao>

      <Secao titulo="3. YouTube e dados do Google">
        <p>
          O Invista Postagem usa os Serviços de API do YouTube. Ao conectar um canal, você concorda com os{' '}
          <Ext href="https://www.youtube.com/t/terms">Termos de Serviço do YouTube</Ext>, e o tratamento dos seus dados
          pelo Google segue a <Ext href="https://policies.google.com/privacy">Política de Privacidade do Google</Ext>.
        </p>
        <Lista
          itens={[
            <>
              <strong className="font-semibold">youtube.upload</strong>: enviar ao canal os vídeos que a equipe agendou;
            </>,
            <>
              <strong className="font-semibold">youtube.readonly</strong>: ler o nome e o identificador do canal para
              mostrar qual canal está conectado.
            </>,
          ]}
        />
        <p>
          O uso e a transferência, para qualquer outro app, de informações recebidas das APIs do Google seguem a{' '}
          <Ext href="https://developers.google.com/terms/api-services-user-data-policy">
            Política de Dados do Usuário dos Serviços de API do Google
          </Ext>
          , incluindo os requisitos de Uso Limitado.
        </p>
        <p>
          Você pode revogar o acesso a qualquer momento em{' '}
          <Ext href="https://security.google.com/settings/security/permissions">
            security.google.com/settings/security/permissions
          </Ext>
          .
        </p>
      </Secao>

      <Secao titulo="4. Instagram, Facebook e Threads">
        <p>
          Nas contas da Meta usamos só as permissões de publicar e ler as informações básicas da conta, da página e das
          publicações feitas pela ferramenta. O acesso pode ser removido em Configurações › Apps e sites, no Facebook
          ou no Instagram.
        </p>
      </Secao>

      <Secao titulo="5. Armazenamento e segurança">
        <p>
          Os tokens de acesso ficam cifrados no banco de dados e só são decifrados no momento de publicar. O painel
          exige login e o acesso é restrito à equipe autorizada.
        </p>
      </Secao>

      <Secao titulo="6. Compartilhamento">
        <p>
          Os dados só saem da ferramenta para a própria rede social, no ato da publicação, e para os provedores de
          infraestrutura necessários para operar o serviço (hospedagem e armazenamento de mídia). Não compartilhamos
          dados com terceiros para nenhuma outra finalidade.
        </p>
      </Secao>

      <Secao id="exclusao-de-dados" titulo="7. Retenção e exclusão de dados">
        <p>
          Ao desconectar uma conta no painel, a ferramenta deixa de usar aquele acesso. Para apagar de vez os tokens e os
          dados ligados à conta, envie um pedido para <Ext href={`mailto:${CONTATO}`}>{CONTATO}</Ext> informando a rede
          e o perfil. A exclusão é concluída em até 30 dias e confirmada por e-mail. Recomendamos também revogar o
          acesso diretamente na rede (links acima).
        </p>
      </Secao>

      <Secao titulo="8. Seus direitos">
        <p>
          Nos termos da Lei Geral de Proteção de Dados (Lei 13.709/2018), você pode pedir acesso, correção ou exclusão
          dos seus dados pelo e-mail <Ext href={`mailto:${CONTATO}`}>{CONTATO}</Ext>.
        </p>
      </Secao>

      <Secao titulo="9. Alterações">
        <p>
          Se esta política mudar, a nova versão fica nesta página com a data de atualização no topo.
        </p>
      </Secao>
    </>
  );
}
