## Context

O motor (`makeAutomationEngine`, em `packages/core/src/application/use-cases/comment-automation.ts`)
roda na fila serial `automation-event`. Em `drive(run)`, cada nó que ainda não saiu
(`sentCursor < cursor`) passa pelo atraso, depois pelo envio (`messageFor` → `sendInConversation`) e
grava `sentCursor = cursor`. Os nós que não esperam resposta seguem pelo `autoNext` no mesmo job, até
`MAX_AUTO_STEPS` (20). Ao concluir, o motor emite `lead.captured` uma vez (`leadEmittedAt`).

Já existem:
- **Webhooks de saída** (`makeEmitEvent`, `webhooks.ts`): eco no SSE, linha em `webhook_deliveries`,
  entrega assinada (`x-manypost-signature`, HMAC-SHA256), 5 tentativas, SSRF bloqueado, filtro por
  evento e por canal.
- **Notificações** (`notifications`, `NotificationRepository.create`), lidas na tela /notificacoes e
  no sino. Hoje só aprovações e a Máquina usam.

Não existe tabela de contatos nem conceito de "passar para humano", e a Zernio não tem chamada de
atribuição. Por isso esta mudança fica só em enviar dados e avisar a equipe.

## Goals / Non-Goals

**Goals:**
- balão de ação que dispara um evento de webhook ou uma notificação em qualquer ponto do fluxo;
- o CRM recebe o lead assim que o dado existe, sem n8n obrigatório;
- tudo visível no simulador sem disparar nada.

**Non-Goals:**
- contatos, tags, campos e condição por tag;
- passar para humano / pausar a automação para uma pessoa;
- escolher o webhook ou colar URL dentro do balão;
- e-mail ou push para a equipe;
- mudar o formato do `lead.captured`.

## Decisions

### 1. Contrato

- **Nó:** `ActionNode` no `FlowNodeSchema`, `type: 'action'`, sem `delaySec`:

  ```ts
  data: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('send_data'), label: field }),          // /^[a-z][a-z0-9_]{0,31}$/
    z.object({ kind: z.literal('notify'), text: text(L.notifyText) }), // 1..280, aceita {campo}
  ])
  ```

  - `field` é o mesmo formato dos nomes de campo: o rótulo vira chave no CRM.
  - `AUTOMATION_LIMITS.notifyText = 280`.
- **Saídas:** `handlesOf(action) = ['next']`, obrigatória.
- **Evento:** `WebhookEvents.LeadUpdated = 'lead.updated'`, junto do `LeadCaptured`. O enum da API de
  webhooks e o snapshot OpenAPI acompanham.
- **Sem código de problema novo:** formato inválido é 400 na API e `shapeIssues` no editor, como texto
  vazio nos outros balões. Saída solta é `missing_edge`.
- **Por que um tipo só com `kind`, e não dois tipos de nó:** o dock já tem um item "Ação"; os próximos
  tipos (tag, humano) entram como novos `kind` sem mexer no grafo.
- **Por que evento, e não URL no balão:** o segredo continua cifrado em `webhooks`, com log de
  entregas e tentativas; o grafo não guarda segredo. Decidido pelo Iago em 19/10/2026.

### 2. Grafo e passo

- `waits(action) = false`; `delayOf(action) = 0`; `messageFor(action) = null`.
- `autoNext(action)` segue por `next` (saída solta = `dead_end`, como hoje).
- `fieldsWritten` não muda: a ação não grava campo.
- `no_finish` não muda: a ação não conclui o fluxo.
- **Laço:** uma ação só entra em laço junto de outros nós que não esperam, e esse laço já é barrado
  por `wait_free_cycle`.
- **Função pura nova** em `flow-step.ts`: `actionFor(node, ctx)` devolve o efeito já resolvido:

  ```ts
  | { kind: 'send_data'; label: string }
  | { kind: 'notify'; text: string }   // texto com {campo} preenchido por renderTemplate
  | null                                // nó que não é ação
  ```

  O motor e o simulador usam a mesma função (a web tem a cópia em `logic.ts`, com paridade testada).

### 3. Motor

Dentro do bloco `if (run.sentCursor < run.cursor)` de `drive`, onde o nó "sai":

1. `const effect = actionFor(node, ctx())`.
2. **`send_data`:** `deps.events?.emit({ orgId, event: LeadUpdated, channelId, data })`, com:

   ```ts
   {
     label, nodeId: node.id, runId, automationId, automationName, channelId, mediaId, commentId,
     commentText, participantId, participantUsername, answers,
     whatsappUrl: leadWhatsappUrl(flow, ctx()),   // null se o fluxo ainda não tem link do WhatsApp
     status: 'OPEN', test: automation.status === 'TEST', sentAt: now().toISOString(),
   }
   ```

3. **`notify`:** `deps.notifications?.create({ orgId, userId: null, kind: 'automation.notify',
   title: automation.name, body: effect.text, link: '/leads' })`.
4. Grava `sentCursor = cursor`, como depois de uma mensagem. Retomar o run não repete a ação.

- **Garantia:** pelo menos uma vez. Se o processo cair entre o efeito e a gravação de `sentCursor`, o
  job é refeito e a ação sai de novo. Quem recebe deduplica por `runId` + `nodeId`; a notificação
  repetida é aceitável.
- **Falha do webhook não trava o fluxo:** `emit` só grava a entrega e enfileira. A entrega tenta de
  novo sozinha e fica no log.
- **Falha do `emit` ou da notificação** (erro de banco): lança e o job da fila tenta de novo, como uma
  falha transitória de envio. Nada foi gravado em `sentCursor`, então a ação é refeita.
- **Sem webhook cadastrado ou sem `deps.notifications`:** a ação vira no-op e o fluxo segue.
- **Dependência nova:** `AutomationEngineDeps.notifications?: Pick<NotificationRepository, 'create'>`,
  ligada em `apps/api/src/automation.container.ts` com o repositório que já existe.

### 4. Editor e simulador

- `SOON` perde `action`; `BLOCKS` ganha `action` (ícone `Zap`), no dock e no menu "Próximo passo".
- **Balão:** seletor "Enviar dados / Avisar a equipe" e o campo do tipo, editados no próprio balão. Sem
  opção avançada no ⚙ e sem selo de atraso.
- **Novo balão:** nasce como `send_data` com rótulo vazio. O Salvar fica travado até preencher
  (`shapeIssues`: `labelInvalid` / `textRequired`).
- **Simulador:** linha cinza, sem bolha: "⚡ Enviaria dados: `<rótulo>`" ou "⚡ Avisaria a equipe:
  `<texto preenchido>`". Não dispara nada.
- **Configurações → Webhooks:** `lead.updated` entra em `ALL_EVENTS`, com descrição.

### 5. Testes

- **Fixtures** (`testdata/automation-flows/`), rodando no core e na web:
  - ação `send_data` entre duas perguntas;
  - duas ações seguidas;
  - `notify` com `{nome}`;
  - ação sem saída (`missing_edge`).
- **Contrato:** rótulo inválido e texto vazio ou longo recusados; `delaySec` recusado na ação.
- **Motor** (`comment-automation.test.ts`, fakes em memória):
  - `lead.updated` uma vez por passagem, com `test` conforme o modo;
  - retomar não repete;
  - falha do `emit` faz o job lançar;
  - `notify` cria a notificação;
  - sem webhook o fluxo segue até o Fim e o `lead.captured` sai igual.
- **E2E** (`scripts/e2e-automation.ts`): a Triagem com a ação depois do WhatsApp recebe um
  `lead.updated` assinado antes do `lead.captured`.

## Risks / Trade-offs

- **Evento repetido** em queda no meio do passo → o receptor deduplica por `runId` + `nodeId`
  (documentado no payload e no INTEGRATIONS_SETUP).
- **Muitos avisos** se a ação ficar num caminho muito usado → é escolha de quem desenha o fluxo; o
  aviso vai só para o sino, sem e-mail.
- **Teste também dispara** → o campo `test` deixa o receptor ignorar; o `lead.captured` não tem o
  campo (fica igual), e isso já acontece hoje.

## Migration Plan

Sem migration. Deploy normal da API e da web. Fluxos salvos continuam válidos (o tipo novo só aparece
quando alguém usa). Rollback: antes de voltar a imagem, tirar o balão de
ação dos fluxos (ou pausá-los). O código antigo não conhece o tipo `action` e não deve ler um fluxo
salvo com ele.

## Open Questions

Nenhuma bloqueante. A função `instagram-lead` do CRM fica fora deste repositório.
