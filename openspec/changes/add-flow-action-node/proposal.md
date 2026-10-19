## Why

A Triagem Invista (PLANO) só entrega o lead para fora do manypost no balão Fim, pelo evento
`lead.captured`. Quem dá o WhatsApp e para antes do Fim nunca chega ao CRM. Também não há como avisar
a equipe no meio do fluxo, por exemplo quando alguém escolhe "empresa".

O balão "Ação" aparece desabilitado ("em breve") no editor desde a entrega 1. A entrega 3 do roteiro
do construtor previa contatos com tags, condição por tag, webhook, avisar a equipe e passar para
humano. O Iago escolheu fatiar (19/10/2026): esta mudança entrega só **Enviar dados** e **Avisar a
equipe**, o suficiente para a ponte do CRM no ponto certo do fluxo.

O destino é o webhook de saída que já existe (Configurações → Webhooks), por um evento novo. O
manypost não conhece o CRM nem o n8n: só uma URL e um segredo. O CRM pode receber direto, numa função
própria, sem n8n no meio.

## What Changes

- **Balão `action`** no grafo do fluxo, com uma saída obrigatória `next`. Não envia nada para a
  pessoa, não espera resposta e não tem atraso: executa a ação e segue no mesmo passo do motor.
  Dois tipos:
  - **Enviar dados** (`send_data`, com `label`): dispara o evento `lead.updated` com as respostas
    até ali;
  - **Avisar a equipe** (`notify`, com `text` que aceita `{campo}`): cria uma notificação para a
    organização inteira, com link para /leads.
- **Evento novo `lead.updated`** no catálogo de webhooks de saída. Mesmo envelope, assinatura,
  tentativas e log de entregas dos outros eventos. Leva os campos do `lead.captured` (menos
  `completedAt`) mais `label`, `nodeId`, `status: "OPEN"`, `test` e `sentAt`.
- **`lead.captured` não muda.** Continua saindo uma vez, ao concluir.
- **Validação:** segue o padrão dos outros balões. Rótulo fora do formato ou texto vazio é erro de
  formato: a API recusa com 400 e o editor trava o Salvar apontando o balão (`shapeIssues`). Saída
  `next` sem ligação é o `missing_edge` que já existe. Nenhum código de problema novo.
- **Editor:** "Ação" sai do "em breve" no dock e no menu "Próximo passo"; balão com seletor de tipo e
  edição no próprio balão; o simulador mostra uma linha "⚡ Enviaria dados…" / "⚡ Avisaria a
  equipe…" sem disparar nada. Espera e Imagem ou vídeo continuam "em breve".
- **Configurações → Webhooks:** `lead.updated` aparece na lista de eventos.

Fora desta mudança (cada uma terá a sua): contatos com tags e campos, condição por tag, passar para
humano, espera longa, mídia.

## Capabilities

### New Capabilities

### Modified Capabilities

- `automation-flow-builder`: balão de ação (enviar dados e avisar a equipe) e o evento `lead.updated`.

## Impact

- **Contrato:** `packages/contracts` (`action` no `FlowNodeSchema` e em `handlesOf`, limite do
  texto do aviso, `WebhookEvents.LeadUpdated`).
- **Core:** `packages/core` (`flow-step`, `flow-graph`, `flow-validate`, `flow-simulate`; motor em
  `comment-automation.ts` com a dependência de notificações).
- **API:** `apps/api/src/automation.container.ts` (passa o repositório de notificações ao motor);
  enum de eventos e snapshot OpenAPI.
- **Web:** `apps/web/src/features/automation/flow/*` (dock, menu, balão, simulador, paridade),
  `apps/web/src/features/settings/*` (lista de eventos) e textos pt-BR.
- **Banco:** nenhuma migration. A execução reaproveita `sentCursor`; a notificação usa a tabela
  `notifications` que já existe.
- **Testes:** fixtures em `testdata/automation-flows/`, testes do motor e o E2E
  `scripts/e2e-automation.ts`.
- **Quem recebe:** o CRM (ou qualquer sistema) assina `lead.updated` e deduplica por
  `runId` + `nodeId`.
