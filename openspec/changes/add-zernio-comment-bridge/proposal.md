## Why

A tela de Comentários (`add-instagram-engagement`) está no ar, mas a Meta não entrega o conteúdo dos
comentários ao app próprio: `GET /{media}/comments` responde 200 com `data` vazio e cursor presente,
em qualquer versão e com qualquer conjunto de campos, mesmo com `comments_count > 0` e com o
comentário escrito pela própria conta. O diagnóstico em produção (`scripts/diag-ig-comments.ts`)
mostra filtragem por nível de acesso: o escopo `instagram_business_manage_comments` está concedido,
mas o app só tem acesso padrão. Para destravar pela Meta direto é preciso pôr o app em modo Live e
passar pelo App Review (Advanced Access) com a empresa verificada, o que leva de dias a semanas.

A mesma conta já está conectada na Zernio, um app aprovado pela Meta que a operação usa para
mandar o direct ao CRM. A API da Zernio lista, responde e oculta comentários e, mais adiante, faz a
resposta privada. Esta mudança põe a Zernio como **ponte de comentários** atrás de uma interface
trocável. O App Review segue em paralelo. Quando sair, desligamos a ponte e o caminho direto volta
sem mexer nas telas.

## What Changes

- Contrato ganha `CommentTransport`, uma interface opcional (listar, responder, ocultar e reexibir
  comentários de uma mídia) usada **no lugar** dos métodos de comentário do provider quando existir
  ponte para o canal.
- Novo adaptador `packages/providers/src/zernio/` que fala com `zernio.com/api/v1`
  (`/inbox/comments/...`). Ele resolve a conta da Zernio pelo id da conta na rede
  (`platformUserId`), com o nome de usuário como reserva.
- `makeEngagement` passa a consultar `commentTransportFor(canal)` antes do provider nas operações
  de comentário. A listagem de posts e as métricas continuam na Graph do próprio app.
- As rotas de resposta e de visibilidade aceitam `mediaId` (opcional) no corpo. A ponte o exige
  porque a API da Zernio endereça o comentário pelo post.
- A web passa a enviar o `mediaId` que já conhece.
- Variáveis novas, opcionais: `ZERNIO_API_KEY` e `ZERNIO_ORG_IDS`, a lista de organizações
  autorizadas a usar a ponte.

## Capabilities

### New Capabilities

- `engagement-comment-bridge`: leitura e moderação de comentários por uma ponte externa autorizada
  por organização, com o mesmo contrato HTTP da leitura direta.

### Modified Capabilities

(nenhuma. Os requisitos de `instagram-engagement` continuam valendo. A ponte só troca quem fala com
a rede.)

## Goals

- Comentários reais na tela de Comentários da Invista agora, sem esperar o App Review.
- Ponte trocável: sem a ponte configurada, o comportamento atual se mantém intacto.
- Base para a resposta privada da automação comentário → direct (próxima mudança).

## Non-goals

- Automação, resposta privada, direct e webhooks da Zernio: ficam na mudança da automação.
- Listar posts e métricas pela Zernio (a Graph do próprio app já entrega).
- Configuração da ponte pela interface ou chave da Zernio por organização (por enquanto é env da
  instalação, restrita por `ZERNIO_ORG_IDS`).
- Excluir comentário.

## Compatibility

A mudança só acrescenta. Sem `ZERNIO_API_KEY`, nada muda. O campo `mediaId` é opcional nas rotas e
clientes antigos continuam válidos: só a ponte o exige e, sem ele, ela responde 400 sem chamar a
rede. Nenhum escopo novo é pedido e nenhuma conta precisa reconectar.

## Rollback

Remover `ZERNIO_API_KEY` do ambiente (desliga a ponte na hora) ou reverter o commit. Não há
migration nem estado gravado. Respostas publicadas ficam na rede como qualquer comentário.

## Impact

- `packages/contracts` (interface `CommentTransport`), `packages/config` (2 env opcionais),
  `packages/providers` (adaptador Zernio), `packages/core` (`makeEngagement`), `apps/api`
  (container e corpo de 2 rotas), `apps/web` (envia `mediaId`; cliente OpenAPI regenerado).
- **Segurança:** a chave da Zernio é segredo da instalação e nunca vai a log nem a resposta. A
  ponte só atende organizações listadas e contas que a própria chave da Zernio enxerga. Ids
  continuam validados como numéricos antes de entrar em URL.
- **Dados:** nenhum schema novo.
- **Easypanel:** duas variáveis novas no serviço da API.
- **Identidade:** nenhum nome Postiz alterado.
