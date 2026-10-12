## Context

O `instagram-standalone` (Instagram Login, `graph.instagram.com/v21.0`) só publica. O contrato de
provider já tem stubs `fetchAnalytics`/`fetchPostAnalytics` que ninguém implementa nem chama, e o
formato deles (`MetricSeries[]` por dia) não descreve totais de período nem métricas vitalícias de
post — que é o que a API do Instagram devolve hoje (`metric_type=total_value`). A referência
funcional é o `instagram-mcp` (MIT, Python): `list_comments`, `reply_to_comment`, `hide_comment`,
`get_account_insights`, `get_media_insights`, que por padrão falam com `graph.facebook.com`; aqui a
conta usa o host do Instagram Login. Nenhum código Python é portado; só os endpoints públicos da
Graph, que são documentação da Meta.

## Goals / Non-Goals

**Goals:** comentários (ler, responder, ocultar) e métricas (conta e post) de canais
`instagram-standalone`, por API e por duas telas; base reaproveitável pela automação
comentário → direct.

**Non-Goals:** direct, automação, webhooks, persistência de métricas, provider `instagram` via
Facebook Login, exclusão de comentário, MCP e gate de plano (ver Decisão 9).

## Decisions

### 1. Métodos opcionais novos no contrato, sem reaproveitar os stubs de analytics
`packages/contracts` (folha, só tipos) ganha `EngagementMedia`, `EngagementComment`,
`EngagementPage<T>`, `AccountInsights`, `MediaInsights` e seis métodos opcionais em
`ChannelProvider`: `listRecentMedia`, `listComments`, `replyToComment`, `setCommentHidden`,
`fetchAccountInsights`, `fetchMediaInsights`, todos recebendo `(ctx, token, settings, …)` porque o
id da conta vive em `channelSettings.userId`. Métodos opcionais seguem o padrão de
`listSubAccounts`/`publishReply`. Os stubs antigos ficam intocados (compatibilidade).
Alternativa descartada: um objeto `engagement` aninhado — mudaria o estilo do contrato sem ganho.

### 2. Chamadas à Graph num módulo compartilhado do Instagram
`packages/providers/src/shared/instagram-engagement.ts` exporta `makeInstagramEngagement(apiBase)`,
parametrizado pelo host como o `makeInstagramGraph` existente. O `instagram-standalone` o liga ao
`graph.instagram.com`; o provider via Facebook Login poderá ligá-lo ao `graph.facebook.com` depois,
resolvendo a conta pela Página. Toda chamada usa `metaFetch` (ctx.fetch injetado, erro como
`{ status, body }`). Parâmetros de escrita vão no corpo form-urlencoded (`igForm`), nunca em query.

### 3. Regra de negócio em `core`
`packages/core/src/application/use-cases/engagement.ts` (`makeEngagement`) concentra:
resolução do canal por `findMany(orgId, [id])` (escopo por organização); `status !== 'ACTIVE'` →
`channel.refresh_required` sem rede; checagem de escopo por operação a partir de um mapa declarado
no provider (`engagementScopes: { comments, insights }`); decifra o token com o AAD do canal; chama
o provider; traduz falhas com `provider.classifyError(status, body)`:
`refresh-token` → `channel.refresh_required`; `permanent` → `channel.provider_rejected` com a
mensagem da Meta saneada (só `error.message`, cortada, sem URL/token); `transient` ou erro de
transporte → `channel.provider_failed`. Em escrita, erro de transporte leva `uncertain: true` — sem
retentativa automática (mesma regra do `NEEDS_REVIEW` da publicação). O caminho de leitura não muda
status de canal: renovação continua com o worker.
Validação de período (≤ 30 dias, `until` ≤ agora) e de mensagem (1..2200 após trim) também ficam
aqui, testáveis sem HTTP.

### 4. Rotas finas sob `/v1/channels/{id}`
`apps/api/src/http/routes/engagement.routes.ts`, montado em `/v1/channels` ao lado do router atual:
`GET media`, `GET media/{mediaId}/comments`, `POST comments/{commentId}/replies`,
`POST comments/{commentId}/visibility`, `GET insights`, `GET insights/media`. Ids de mídia e
comentário passam por `z.string().regex(/^\d{1,32}$/)` — o id entra no path da Graph, então
`../me` precisa morrer na borda. `requireAuth` como nas rotas de post: qualquer membro que agenda
post também responde comentário. A rota fica fora da API pública/MCP nesta mudança.

### 5. Idempotência e auditoria nas escritas
As duas rotas `POST` usam o middleware `idempotency(ctn.runtime.idempotency)` já existente (Redis,
TTL 24h, por credencial; sem Redis ele falha aberto — a UI também trava o botão). Resposta e
ocultação gravam `audit_log` (`comment.replied`, `comment.hidden`, `comment.unhidden`) com
canal, id do comentário e id da resposta; o texto da resposta fica fora do detalhe da auditoria
para não duplicar conteúdo de terceiros.

### 6. Métricas que degradam por métrica
A API do Instagram troca nomes de métrica com frequência (`impressions` e `plays` saíram na v22).
A conta pede `reach,views,accounts_engaged,total_interactions,likes,comments,shares,saves` com
`metric_type=total_value&period=day&since&until`. Se a Meta recusar o conjunto com erro de
parâmetro (código 100), o provider repete **uma métrica por chamada** e devolve `null` nas
recusadas. Série diária só de `reach` (`period=day`, sem `metric_type`). Seguidores vêm de
`GET /me?fields=followers_count,media_count`.

### 7. Métricas por post com falha isolada e concorrência limitada
`GET insights/media` lista a página de mídia (até 12) e busca
`/{media-id}/insights?metric=reach,views,likes,comments,shares,saved,total_interactions` com
concorrência 4. Post recusado volta com métricas `null` e `reason`. Story não aparece em
`/me/media`, então o conjunto vale para feed e reels.

### 8. Sem persistência, cache no cliente
Nada vai ao banco. React Query: comentários `staleTime` 30 s; insights 5 min, raiz de chave
`['channel-insights', …]` para não colidir com `['insights', 'summary']` da home (invalidado por
SSE). Histórico de métricas é outra mudança.

### 9. Gate de plano adiado (decisão humana registrada)
`PLANS.md` lista Analytics como Pro+, mas não existe `PlanFeature` para isso e o fork interno roda
sem barreira. Criar a feature agora mudaria o catálogo comercial sem decisão. Fica sem gate; a
decisão volta quando o SaaS ligar billing.

### 10. Códigos de erro
Novos: `channel.provider_rejected` (422) e `channel.provider_failed` (502). Mapeados agora (antes
sem status, caíam em 400 e nunca eram lançados como `DomainError`): `channel.refresh_required`
(409) e `channel.missing_scopes` (403). Mensagens no dicionário `errors.*` do web.

## Arquivos gerados

`apps/web/openapi.json` e `apps/web/src/lib/api/schema.d.ts` — regenerar com a API local:
`API_URL=http://localhost:3100 bun run --cwd apps/web generate:api`.

## Risks / Trade-offs

- **Nomes de métrica mudam** → Decisão 6 degrada por métrica; a tela mostra "indisponível".
- **Limite de chamadas da Meta** (por conta/hora) → página de 12 posts, concorrência 4, cache de 5
  min no cliente. Se apertar, o próximo passo é cache curto no servidor.
- **Duas ferramentas na mesma conta** (o CRM via Zernio também recebe eventos) → esta mudança só
  responde quando um membro clica; não há automação.
- **Resposta incerta** (timeout depois do envio) → reportada como incerta, sem retry; a lista de
  comentários mostra se a resposta existiu.
- **URLs de mídia do CDN da Meta expiram** → a tela usa a URL do momento; nada é guardado.

## Observability

Log estruturado por operação (`engagement.<op>` com canal, provider, duração, classe do erro) sem
token e sem corpo de comentário. Requisições levam o correlation id existente.
