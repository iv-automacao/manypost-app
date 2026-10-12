## Why

O manypost publica no Instagram, mas depois do post a operação sai do produto: comentários são
lidos e respondidos no app do Instagram e as métricas não existem em lugar nenhum
(`capabilities.analytics: false`, `channel_metrics` vazia). As contas conectadas pelo Instagram
Login já concedem `instagram_business_manage_comments` e `instagram_business_manage_insights`, ou
seja, o acesso existe e não é usado. Esta mudança traz para o produto, em TypeScript e pela API
oficial, a parte de comentários e de métricas que o servidor MCP `instagram-mcp` (MIT) expõe — sem
rodar o servidor Python — e prepara a base da automação comentário → direct, que vem numa mudança
seguinte.

## What Changes

- Contrato de provider ganha capacidades **opcionais** de engajamento: listar mídia recente da
  conta, listar comentários (com respostas) de uma mídia, responder um comentário, ocultar/reexibir
  um comentário, métricas da conta num período e métricas por mídia.
- O provider `instagram-standalone` (Instagram Login, `graph.instagram.com`) implementa todas.
- Casos de uso em `core` resolvem o canal **pela organização**, decifram o token, exigem o escopo
  certo antes de chamar a rede e classificam a falha (reconectar / rede recusou / rede indisponível).
- Rotas novas sob `/v1/channels/{id}/…` (OpenAPI): mídia, comentários, resposta, visibilidade,
  insights da conta e insights por post. Escrita aceita `Idempotency-Key` e fica na trilha de
  auditoria.
- Duas telas novas no app: **Comentários** e **Insights**, com entrada no menu lateral.
- Nada é persistido: leitura direta da rede a cada consulta (cache só no cliente).

## Capabilities

### New Capabilities

- `instagram-engagement`: leitura e moderação de comentários e leitura de métricas de contas do
  Instagram conectadas, expostas por API e por duas telas do app.

### Modified Capabilities

(nenhuma — `instagram-business-publishing` não muda requisitos; o provider por Facebook Login
segue sem engajamento)

## Goals

- Responder e ocultar comentários dos posts da conta sem sair do manypost.
- Ver alcance, visualizações e interações da conta num período e de cada post recente.
- Reaproveitável pela automação comentário → direct (próxima mudança).

## Non-goals

- Direct (conversas e envio). A caixa de entrada do direct fica com o CRM da operação; a permissão
  de mensagens entra na mudança da automação.
- Automação por palavra-chave, construtor de fluxos e resposta privada.
- Webhooks, ingestão e histórico persistido de métricas (`channel_metrics` continua vazia).
- Engajamento no provider `instagram` (Facebook Login), busca de hashtag e mídia marcada — exigem
  o login pelo Facebook.
- Excluir comentário, ferramentas MCP e gate de plano para analytics (não há `PlanFeature` para
  isso hoje; a decisão comercial fica registrada no design).

## Compatibility

Aditivo. Métodos opcionais no contrato: providers que não os implementam continuam iguais e a rota
responde `capability.disabled`. Nenhum escopo novo é pedido, então nenhuma conta precisa reconectar.
Os stubs `fetchAnalytics`/`fetchPostAnalytics` existentes não mudam.

## Rollback

Reverter o commit. Não há migration, dado gravado ou estado externo criado pelo produto (respostas
publicadas na rede continuam na rede, como qualquer comentário).

## Impact

- `packages/contracts` (tipos + métodos opcionais + 2 error codes), `packages/providers`
  (`shared/instagram-graph.ts`, `instagram-standalone`), `packages/core` (use cases de engajamento),
  `apps/api` (rotas, container, mapa de status), `apps/web` (2 páginas, menu, cliente OpenAPI
  regenerado).
- **Segurança:** ids de mídia/comentário validados como numéricos antes de entrar na URL da Graph;
  token nunca sai do servidor nem vai a log; escopo por organização em toda rota.
- **Dados:** nenhum schema novo. **Railway/Easypanel:** nenhuma env nova.
- **Identidade:** nenhum nome Postiz alterado; trechos derivados mantêm o comentário de derivação.
