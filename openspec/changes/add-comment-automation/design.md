## Context

Comentários já passam pela ponte Zernio (`add-zernio-comment-bridge`, `packages/providers/src/zernio/`).
A Zernio entrega por webhook (até 50 por conta, filtráveis por `accountIds`):

- **`comment.received`:** `comment.{id, platformPostId, text, author{id, username, isOwnAccount},
  isReply}` e `account.accountId`.
- **`message.received`:** `message.{conversationId, direction, text, sender{id, username}}`,
  `conversation.{id, participantId, participantUsername}` e
  `metadata.{postbackPayload, quickReplyPayload, standby}`.

Formato das entregas:

- **Assinatura:** HMAC-SHA256 em hex do corpo cru, no cabeçalho `X-Zernio-Signature`.
- **Deduplicação:** `X-Zernio-Event-Id`, estável entre retentativas.
- **Prazo:** 2xx em até 5 s; senão a Zernio retenta até 7 vezes.

Envios:

- **Resposta privada:** `POST /v1/inbox/comments/{postId}/{commentId}/private-reply`
  `{accountId, message, buttons? (1–3) | quickReplies? (≤13)}`. É uma por comentário, em até 7 dias.
  - **400** com `details.privateReplyConsumed` significa resposta gasta.
  - **502** com `privateReplyOutcome: "unknown"` significa desfecho incerto.
- **Mensagem na conversa:** `POST /v1/inbox/conversations/{id}/messages`
  `{accountId, message, buttons? | quickReplies?}`. Aceita `Idempotency-Key`, guardada por 24 h. Com
  botões, o texto tem no máximo 640 caracteres.
- **Botões:** título de até 20 caracteres. Os `buttons` aparecem também na caixa de solicitações; as
  `quickReplies` não.

Infraestrutura do manypost que é reaproveitada:

- **Fila:** pg-boss com `runtime.registerQueue` (o padrão da máquina de conteúdo, com container
  próprio no processo da API em `MODE=all`).
- **Webhooks de saída:** `EventPublisher.emit` com o catálogo `WebhookEvents`.
- **Auditoria:** `audit_log`.
- **Migrations:** aplicadas no boot (`DB_MIGRATE=auto`); a próxima é `0011`.

## Goals / Non-Goals

**Goals:** fluxo linear configurável (gatilho → resposta pública → abertura no direct → perguntas →
WhatsApp), modo teste, retomável após falha, sem envio duplicado, lead persistido e emitido.

**Non-Goals:** ramificação, atrasos, follow-up, outros gatilhos, caixa de DM, transporte Meta
direto (ver proposal).

## Decisions

### 1. Três tabelas novas, status em `text`
`packages/db/src/schema/automation.ts`:

- **`comment_automations`:** `id`, `org_id`, `channel_id`, `name`, `status`
  (`DRAFT|TEST|ACTIVE|PAUSED`), `config` jsonb (versão 1, validada em contracts),
  `test_usernames text[]`, `created_by`, timestamps e `deleted_at`.
  - **Índice:** `(org_id, channel_id)`.
- **`automation_runs`:** `id`, `org_id`, `automation_id`, `channel_id`, `media_id`, `comment_id`,
  `comment_text`, `participant_id`, `participant_username`, `conversation_id`, `status`
  (`OPEN|COMPLETED|FAILED|UNCERTAIN|SKIPPED`), `step` int, `prompt_sent_step` int, `reasks` int,
  `answers` jsonb, `public_reply` (`PENDING|SENT|FAILED|NONE`), `private_reply`
  (`PENDING|SENT|FAILED|UNCERTAIN`), `last_error`, `last_interaction_at`, `completed_at`,
  `lead_emitted_at` e timestamps.
  - **Índices:** unique `(automation_id, comment_id)` e `(channel_id, participant_id, status)`.
- **`inbound_events`:** `id`, `source`, `event_id`, `event_type`, `payload` jsonb, `received_at`,
  `processed_at`, `attempts`, `last_error`.
  - **Índice:** unique `(source, event_id)`.

`text` em vez de `pgEnum` segue o precedente da máquina de conteúdo: um status novo não exige
migration destrutiva. A migration só cria tabelas, então é segura no rollout e no rollback (o código
antigo ignora as tabelas).

### 2. Configuração validada por um schema zod em `packages/contracts`

`CommentAutomationConfig` v1:

```
trigger:  { mediaIds: string[] (vazio = qualquer post), keywords: string[] (vazio = qualquer comentário) }
publicReplies: string[] (0..10, ≤300 cada)
opening:  { text (1..600), mode: 'button' | 'text', buttonTitle (≤20) }
questions: Array<
  { kind: 'choice', field, prompt (1..600), options: [{ title ≤20 }] (1..13) } |
  { kind: 'text',   field, prompt (1..600), validate: 'name'|'phone'|'email'|'free' }
> (0..5)
finish:   { text (1..600), whatsapp?: { phone (10..15 dígitos), message (≤500, com {campo}), buttonTitle (≤20) } }
disclosure: boolean (padrão true → acrescenta "Mensagem automática." à abertura)
```

A API valida com este schema. A web não carrega `@manypost/contracts` no bundle: repete os limites em `features/automation/logic.ts` e a paridade é assertada no teste dela. `field` usa o padrão `^[a-z][a-z0-9_]{0,31}$` e é único entre
as perguntas.

### 3. Abertura com um botão (ou texto) e perguntas depois
A resposta privada leva só a abertura. No modo `button` vai com um botão postback; no modo `text`
pede "responda qualquer coisa para continuar". Motivos:

- **Janela de mensagem:** a resposta privada não abre a janela de 24 h; só a ação da pessoa abre.
- **Caixa de solicitações:** quem não segue a conta recebe na caixa de solicitações, onde só
  `buttons` aparecem.
- **Recusa da Meta:** algumas contas têm botões recusados para não seguidores, e a recusa gasta a
  resposta. Por isso o modo `text` existe como saída. A tela explica a escolha.

As perguntas seguem pela conversa: até 3 opções vão como `buttons` (postback) e de 4 a 13 como
`quickReplies`.

### 4. Payload autodescritivo
O payload de cada botão é `mp1:<runId>:<step>:<option>`, com `step` = `o` para a abertura. Uma
mensagem com payload localiza a execução direto pelo id, conferindo canal e org. Sem payload (texto
livre), a execução é localizada pela execução aberta mais recente do canal com
`participant_id = sender.id` (IGSID), e o username serve de reserva. Payload de passo anterior ao
atual é tratado como repetição e ignorado. A execução aberta vale por 7 dias desde a última
interação (a janela da resposta privada); a mensagem da própria pessoa reabre a janela de 24 h da
Meta para os envios seguintes.

### 5. Motor retomável
`step = -1` aguarda a abertura; `0..n-1` aguarda a pergunta i; `n` encerra.
`prompt_sent_step` guarda até onde o prompt já foi entregue. O processamento de qualquer evento
termina em `ensureProgress(run)`:

1. Responde em público se `public_reply = PENDING`.
2. Faz a resposta privada se `private_reply = PENDING`.
3. Se `prompt_sent_step < step`, envia o prompt do passo atual com `Idempotency-Key =
   <runId>:<step>:<reasks>`.
4. Se `step = n` e o fim ainda não foi enviado, envia o fim.
5. Se o lead ainda não foi emitido, emite.

Cada efeito é gravado logo depois de confirmado.

- **Falha transitória** em envio idempotente (429/5xx/rede): o job falha e o pg-boss retenta (3
  vezes). A retomada pula o que já foi gravado.
- **Resposta privada:** não tem chave de idempotência, então não é retentada. Rede ou 502 →
  `private_reply = UNCERTAIN` e execução `UNCERTAIN`. 400 → `FAILED`.

### 6. Fila serial
A fila é `automation-event`, com `workers: 1`. A rota grava o evento
(`ON CONFLICT (source, event_id) DO NOTHING`) e, só se inseriu, enfileira `{ inboundEventId }`.
Processar em série evita que duas mensagens da mesma pessoa avancem a mesma execução ao mesmo
tempo. O volume esperado (dezenas a centenas por dia) cabe com folga. O unique
`(automation_id, comment_id)` garante uma execução por comentário mesmo com reentrega.

### 7. Rota pública do webhook
`POST /v1/integrations/zernio/webhook`, montada só com `ZERNIO_WEBHOOK_SECRET`; sem ela, 404.

- **Validação:** corpo lido como texto com limite de 256 KB. HMAC comparado com `timingSafeEqual`.
- **Rejeição:** assinatura ausente ou inválida responde 401 e nada é gravado.
- **Eventos que não são de comentário nem mensagem:** respondem 200 e são ignorados (inclusive
  `webhook.test`).
- **Fora do OpenAPI público:** a rota é chamada pela Zernio, não pelo cliente.

### 8. Do evento ao canal
A ponte ganha `accountById(zernioAccountId)`, com o mesmo cache de contas, que devolve
`platformUserId` e `username`. O motor procura, entre as organizações de `ZERNIO_ORG_IDS`, o canal
`instagram-standalone`/`instagram` com `settings.userId`, ou `externalId`, igual ao
`platformUserId`. Conta sem canal: o evento é marcado como processado e ignorado.

### 9. Casamento de palavra-chave
O texto passa por NFD sem acentos, minúsculas e pontuação trocada por espaço. Cada palavra-chave
normalizada casa como palavra ou frase inteira (`(^| )kw( |$)`). Vence a automação mais antiga do
canal entre as `ACTIVE`, mais as `TEST` cujo username de teste bate. Não reage a resposta de
comentário (`isReply`) nem à própria conta (`isOwnAccount`).

### 10. Transporte de mensagens no contrato
O contrato ganha `DirectTransport { privateReply(mediaId, commentId, msg), sendMessage(conversationId,
msg, idempotencyKey) }`, com `msg = { text, buttons?, quickReplies? }`. A ponte Zernio o
implementa. O motor em `core` não conhece a Zernio. Quando o App Review sair, um transporte Meta
implementa a mesma interface.

### 11. `lead.captured`
O evento entra em `WebhookEvents` e nas listas da web. `data`: `runId`, `automationId`,
`automationName`, `channelId`, `mediaId`, `commentId`, `commentText`, `participantUsername`,
`participantId`, `answers`, `whatsappUrl` e `completedAt`. A emissão é pelo menos uma vez, e
`runId` é a chave de deduplicação do lado do n8n.

### 12. Interface
- **Telas:** `/automacoes` (lista), `/automacoes/nova` e `/automacoes/[id]`, com o construtor à
  esquerda e a pré-visualização em bolhas de conversa à direita; e `/leads` (tabela com respostas e
  filtro por automação e status).
- **Construtor:** os posts vêm de `GET /v1/channels/{id}/media`. O status é um seletor
  Rascunho/Teste/Ativa/Pausada; para ativar, a tela pede confirmação lembrando de desligar a IA do
  CRM e as automações da Zernio.

### 13. Auditoria e privacidade
Criação, edição e mudança de status ficam na auditoria (`automation.*`). Os logs do motor levam só
ids e status, nunca texto, username nem respostas.

## Risks / Trade-offs

- **IGSID diferente entre comentário e mensagem.** Mitigado pelo payload com `runId` e pela reserva
  por username.
- **Recusa de botões para não seguidores.** Mitigado pelo modo `text` da abertura. A falha fica
  visível na execução.
- **Resposta dupla com outra ferramenta** (IA do CRM, automação da Zernio). É operacional: o aviso
  aparece na ativação e está no checklist.
- **Fila serial** é um gargalo teórico; pode passar a uma fila por participante se o volume crescer.

## Migration Plan

1. Deploy (a migration 0011 é aplicada no boot).
2. Gerar o segredo no Easypanel: `ZERNIO_WEBHOOK_SECRET`, 64 caracteres hex.
3. Rodar `bun run scripts/register-zernio-webhook.ts <channelId>` no console. Ele cria o webhook na
   Zernio com o mesmo segredo, filtrado pela conta.
4. Criar a automação em Teste, comentar com a conta de teste e conferir em Leads.
5. Desligar a IA do CRM para o Instagram e conferir que não há automação ativa na Zernio.
6. Ativar.

**Rollback:** pausar as automações; apagar o webhook na Zernio ou a variável.

## Observability

- **Logs:** `automation.event` (tipo, ação, ms), `automation.run` (id, status, passo) e
  `automation.send.failed` (id, status, classe).
- **`inbound_events`:** `attempts` e `last_error` permitem auditar a ingestão.

## Testes de ponta a ponta

`scripts/e2e-automation.ts` sobe uma Zernio falsa, prepara o banco e inicia a API real
(`ZERNIO_API_URL` aponta para a falsa). O fluxo completo vai do comentário ao `lead.captured`
assinado, inclusive com reentrega e assinatura inválida.

## Generated files

- **Migration:** `packages/db/migrations/0011_comment-automation.sql` e `meta/*`, gerados com
  `bun run --cwd packages/db generate -- --name comment-automation`.
- **Cliente OpenAPI:** `apps/web/openapi.json` e `src/lib/api/schema.d.ts`, gerados com
  `generate:api`.
