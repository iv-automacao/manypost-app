## Why

A Triagem Invista (comentário → direct) funcionou de ponta a ponta em 14/10/2026, mas as mensagens
que vão em sequência saem coladas umas nas outras. Por exemplo, o "Seguir" chega no mesmo segundo do
link do WhatsApp, e isso tem cara de robô.

Também falta um jeito de recuperar quem **parou no meio**: a pessoa respondeu algumas perguntas e
sumiu. Hoje a conversa fica parada até expirar.

O Iago pediu as duas coisas, configuráveis no próprio editor do fluxo. Elas são um recorte da
entrega 4 (tempo e conteúdo) do roteiro do construtor.

O follow-up "depois do fim" (completou, mas não chamou no WhatsApp) **não** entra aqui. Ele é a
ponte do CRM: template no WhatsApp 5 minutos depois, só para quem respondeu "Pode chamar" no
`whatsapp_optin`.

## What Changes

- **Atraso por balão.** Mensagem, pergunta, link e fim ganham `delaySec` (0 a 60 s). O motor manda
  o "digitando…", agenda a continuação na fila e envia na hora marcada. A abertura não tem atraso.
  - O motor não fica parado esperando.
  - Um deploy no meio do atraso não perde nada.
  - Uma resposta da pessoa durante a espera não antecipa o envio.
- **Lembrete "parou no meio".** O fluxo ganha `reminder` opcional, com tempo (5 min a 23 h) e texto
  (até 300 caracteres, com `{campo}`).
  - **Quando sai:** se a conversa ficar parada esperando resposta num balão depois da abertura, sai
    uma vez por conversa. A mensagem leva o texto do lembrete e repete a pergunta com as opções.
  - **Se a pessoa responder:** o fluxo continua dali.
  - **Nunca sai:** para quem não respondeu a abertura (o Instagram só permite uma resposta
    privada por comentário) nem passadas 23 h da última mensagem da pessoa (janela de 24 h da Meta).
- **"Digitando…" na ponte.** O transporte do direct ganha `typing(conversationId)`, best-effort,
  via `POST /v1/inbox/conversations/{id}/typing` da Zernio.
- **Execução:** três colunas novas em `automation_runs`, só acrescentadas:
  - `resume_at`: envio atrasado pendente;
  - `last_inbound_at`: última mensagem da pessoa;
  - `reminder_sent_at`: o lembrete já saiu.
- **Editor:**
  - "Esperar antes de enviar" no ⚙ de cada balão (0, 2, 5, 10, 30 ou 60 s), com o selo "⏱ 5 s" no
    balão;
  - botão **"Lembrete"** na barra de cima do editor (ligar, tempo e texto);
  - o simulador mostra o atraso e tem "Simular silêncio" para ver o lembrete.

## Capabilities

### New Capabilities

### Modified Capabilities

- `automation-flow-builder`: atraso por balão e lembrete único dentro da janela de 24 h.

## Impact

- **Contrato:** `packages/contracts` (`delaySec`, `reminder`, limites, `DirectTransport.typing`).
- **Core:** `packages/core` (motor: atraso, lembrete, jobs de tempo na fila `automation-event`;
  porta da execução).
- **Banco:** `packages/db` (migration `0014`, repositório).
- **Ponte:** `packages/providers/src/zernio` (typing).
- **API:** `apps/api/src/automation.container.ts` (handler da fila com os jobs de tempo).
- **Web:** `apps/web/src/features/automation/flow/*` (⚙, selo, botão Lembrete, simulador), textos
  pt-BR e o snapshot OpenAPI.
- **Compatibilidade:** sem variável nova. Fluxos e execuções existentes seguem iguais (atraso 0,
  sem lembrete).
