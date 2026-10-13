## Context

Em produção, a Graph do Instagram Login devolve `data: []` para `/{media}/comments` com
`comments_count > 0`, inclusive para comentário da própria conta e sem `fields`, em v21, v25 e sem
versão (`scripts/diag-ig-comments.ts`, 12/10/2026). O cursor vem presente, ou seja, a Meta acha os
itens e os filtra. Isso é o acesso padrão do app: o conteúdo só sai com Advanced Access em
`instagram_business_manage_comments`. A Zernio (app aprovado) já tem a @invistaseguros.br conectada
e expõe, com `Authorization: Bearer <chave>`:

- `GET /v1/accounts?platform=instagram` → `accounts[]` com `_id`, `platformUserId`, `username`.
- `GET /v1/inbox/comments/{postId}?accountId=&limit=&cursor=` → `comments[]` (`id`, `message`,
  `createdTime`, `from{username,isOwner}`, `likeCount`, `isHidden`, `replies[]`) e
  `pagination{hasMore,cursor}`. Aceita o id da mídia na rede como `postId`. Resposta em cache de
  até 10 min, e escritas próprias renovam o cache.
- `POST /v1/inbox/comments/{postId}` `{accountId, message, commentId}` → `data.commentId`.
- `POST /v1/inbox/comments/{postId}/{commentId}/hide` `{accountId}`, e `DELETE` com
  `?accountId=` para reexibir.
- Erros no formato `{ error: string, code, type }`. As operações de inbox exigem o add-on Inbox
  (403).

## Goals / Non-Goals

**Goals:** comentários reais pela Zernio, trocável e desligável por env; contrato HTTP e telas
iguais.

**Non-Goals:** automação, resposta privada, webhooks (próxima mudança); posts e métricas pela
Zernio; configuração por organização na interface.

## Decisions

### 1. `CommentTransport` no contrato, ao lado dos métodos do provider
`packages/contracts` ganha a interface `CommentTransport { listComments(mediaId, page),
replyToComment(mediaId, commentId, message), setCommentHidden(mediaId, commentId, hidden) }`. Ela
devolve os mesmos tipos `EngagementPage<EngagementComment>`, e as falhas são `ProviderFailure`. A
interface não recebe `ctx`/token: quem a constrói já fechou sobre a chave e a conta. A alternativa
descartada foi um provider `zernio` novo: ele exigiria um canal novo e reconexão, e misturaria
publicação com engajamento.

### 2. O caso de uso decide, a composição resolve
`makeEngagement` recebe `commentTransportFor?: (row: ChannelRecord) => Promise<CommentTransport | null>`.
Nas três operações de comentário, depois de resolver canal, provider e status `ACTIVE` (a mesma
ordem de hoje), o caso de uso consulta a ponte. Se houver ponte, pula a checagem de escopo do token
próprio (o acesso é o da conexão da ponte) e não decifra o token. Sem ponte, segue o caminho
direto. `packages/core` continua sem conhecer a Zernio (regra de fronteira).

### 3. Adaptador em `packages/providers/src/zernio/`
`makeZernioBridge({ apiKey, fetch, log, now, baseUrl? })` expõe
`forAccount({ platformUserId, username }) → Promise<CommentTransport | null>`. A lista de contas
Instagram fica em cache de 10 minutos em memória (uma chamada por processo e janela). A
correspondência é por `platformUserId` igual a `settings.userId` ou ao `externalId` do canal, e por
`username` sem diferenciar caixa como reserva. Conta inativa ou não encontrada → `null`. Falha ao
listar contas também volta `null` com log `warn`: a tela cai no caminho direto em vez de quebrar.

### 4. Allowlist por organização na composição
A chave é da instalação e pertence à conta Zernio da Invista. O container só monta a ponte com
`ZERNIO_API_KEY` **e** `ZERNIO_ORG_IDS` definidos, e `commentTransportFor` devolve `null` para
`orgId` fora da lista e para provider que não seja `instagram-standalone`/`instagram`. A conta
ainda precisa estar visível para a chave, o que é a segunda trava.

### 5. Classificação própria da ponte
O adaptador lança `ProviderFailure` já classificado (`errorClass`). 401/403 → `permanent`, que vira
`provider_rejected` e nunca `refresh-token`, porque o problema é a chave da instalação e não o
token do canal. 408/429/5xx → `transient`, e o resto → `permanent`. O corpo é reescrito para
`{"error":{"message":…}}`, para que o `sanitizedMessage` existente extraia o texto da Zernio sem
URL. Erro de rede continua como transporte, e na escrita vira `uncertain: true`.

### 6. `mediaId` opcional no corpo das escritas
As rotas `POST …/comments/{commentId}/replies` e `…/visibility` aceitam `mediaId` (mesmo padrão
numérico). O caso de uso o exige só quando a operação vai pela ponte, devolvendo 400
`validation.invalid_request` sem rede. A web já tem o `mediaId` do post aberto e passa a enviá-lo
sempre.

### 7. Mapeamento de comentário
`id`, `message`→`text`, `from.username`, `createdTime`→`timestamp`, `likeCount`,
`isHidden`→`hidden`, `from.isOwner`→`fromOwner`, e `replies[]` mapeadas com `replies: []`.
Cursor: `pagination.cursor` só quando `hasMore`. `limit` limitado a 50, no máximo.

## Risks / Trade-offs

- **Cache de 10 min na leitura da Zernio.** Comentário novo pode demorar a aparecer, mas as
  escritas próprias renovam o cache. A tela já orienta a atualizar.
- **Dependência de terceiro** (plano, add-on Inbox, disponibilidade). Mitigação: a ponte desliga
  por env e o App Review segue em paralelo.
- **Chave única por instalação.** Aceitável enquanto só a Invista usa, e a allowlist evita que
  outra organização a use. Se outras organizações precisarem, a chave por organização entra numa
  mudança própria.

## Migration Plan

Sem migration. Deploy → definir `ZERNIO_API_KEY` e `ZERNIO_ORG_IDS` no serviço da API no
Easypanel → redeploy. Rollback: apagar a variável.

## Observability

Logs `engagement.<op>` ganham `via: 'bridge' | 'provider'`. O adaptador loga `zernio.accounts.failed`
com o status, nunca a chave nem o corpo.

## Generated files

`apps/web/openapi.json` e `apps/web/src/lib/api/schema.d.ts`, regenerados com a API local e
`API_URL=http://localhost:3100 bun run --cwd apps/web generate:api`.
