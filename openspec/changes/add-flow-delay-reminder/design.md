## Context

O motor (`makeAutomationEngine`, em `packages/core`) roda na fila serial `automation-event` (pg-boss,
um job por vez). Hoje cada evento recebido chama `drive(run)`, que manda as mensagens dos nós que não
esperam resposta até o próximo que espera, tudo no mesmo job. A execução guarda `cursor` e
`sentCursor`. A chave de idempotência de cada envio é `<runId>:c<cursor>:<reasks>`.

A fila já agenda tarefas para mais tarde (`enqueue(..., { startAfter })`). A Zernio expõe
`POST /v1/inbox/conversations/{conversationId}/typing` (corpo `{ accountId }`), best-effort.

Regras do Instagram que limitam o desenho:
- uma resposta privada por comentário (a abertura);
- mensagem automática só até 24 h depois da última mensagem da pessoa.

## Goals / Non-Goals

**Goals:** atraso de 0 a 60 s por balão com "digitando…"; um lembrete por conversa para quem parou
no meio; tudo configurado no editor do fluxo e visível no simulador.

**Non-Goals:**
- bloco "Esperar X horas" livre;
- mais de um lembrete;
- lembrete antes da pessoa responder a abertura;
- follow-up depois do fim (é a ponte do CRM);
- métricas de lembrete (entrega 5).

## Decisions

### 1. Contrato

- **Atraso:** `delaySec: z.number().int().min(0).max(60).default(0)` nos dados de `message`,
  `question`, `link` e `end`.
- **Limites:** `AUTOMATION_LIMITS.maxDelaySec = 60` e `AUTOMATION_LIMITS.reminderText = 300`.
- **Lembrete:** `FlowV2Schema` ganha
  `reminder: z.object({ afterMinutes: z.number().int().min(5).max(1380), text }).optional()`.
  Ausente quer dizer desligado. 1380 min = 23 h.
- **Por que no fluxo:** o lembrete é uma configuração do fluxo (não de um balão) e fica junto do
  grafo para seguir o mesmo ciclo de salvar, validar e Teste/Ativa. Um lembrete por balão foi
  descartado: complica o editor e o pedido é "um lembrete".
- **Texto do lembrete:** até 300 caracteres, enviado numa mensagem própria, antes da pergunta. Junto
  do texto do balão estouraria o teto de 640 caracteres das mensagens com botões (revisão final).
- **Typing:** `DirectTransport` ganha `typing?(conversationId: string): Promise<void>`, opcional,
  para transportes sem suporte.

### 2. Execução

Migration `0014_flow-delay-reminder.sql`, só acrescenta colunas que aceitam nulo em
`automation_runs`:
- `resume_at`: hora marcada do envio atrasado do nó atual; `null` = nenhum atraso pendente;
- `last_inbound_at`: hora da última mensagem da pessoa, gravada em todo `onMessage`;
- `reminder_sent_at`: o lembrete desta conversa já saiu.

### 3. Jobs de tempo na mesma fila serial

- **Payload:** `{ timer: 'resume' | 'reminder', runId, cursor, accountRef }`, na fila
  `automation-event`, com `startAfter`. Ficar na mesma fila mantém tudo serial, então um job de
  tempo nunca corre em paralelo com um evento da mesma conversa.
- **Deduplicação:** não há. Na política padrão do pg-boss v10, a `singletonKey` sozinha não
  deduplica. Jobs repetidos são inofensivos: cada um confere `cursor`, `sentCursor` e
  `reminder_sent_at` na fila serial.
- **Transporte:** `accountRef` vai no payload porque o `gateway.resolve(accountRef)` é quem monta o
  transporte. Guardar na execução exigiria outra coluna sem ganho.
- **Despacho:** `process` passa a aceitar os dois formatos. O handler da fila na API repassa o
  payload inteiro.

### 4. Atraso dentro de `drive`

Antes de enviar um nó ainda não enviado (`sentCursor < cursor`) com `delaySec > 0`:
- **`resume_at` nulo:** grava `resume_at = agora + delaySec`, tenta o typing (falha só vira log),
  agenda `resume` para `resume_at` e para.
- **Antes da hora** (`agora < resume_at - 1 s`): para sem enviar. É o caso da mensagem da pessoa
  durante a espera ou de um job adiantado.
- **Na hora:** envia, grava `sentCursor = cursor` e `resume_at = null` juntos, e segue.

O job `resume` carrega a execução e só segue se ela está `OPEN`, com o mesmo `cursor`, e a automação
não está pausada nem em rascunho. Depois chama `drive`. Uma retentativa após falha transitória acha
`resume_at` no passado e envia com a mesma chave de idempotência, sem duplicar.

### 5. Lembrete

- **Armar** (`armReminder`), depois de cada `drive` chamado por `onMessage` ou por `resume`. Só arma
  se tudo isto vale:
  - o fluxo tem `reminder`;
  - a execução está `OPEN` e sem `reminder_sent_at`;
  - `last_inbound_at` existe;
  - o nó atual espera resposta, não é a abertura e já foi enviado (`sentCursor === cursor`).
- **Horário:** `min(last_inbound_at + afterMinutes, last_inbound_at + 23 h)`. Se já passou, não arma.
- **Disparo** (`reminder`): só envia se, no momento do job, tudo isto vale:
  - a execução continua `OPEN`, com o mesmo `cursor`, `sentCursor === cursor` e sem
    `reminder_sent_at`;
  - a automação não está pausada nem em rascunho e o fluxo ainda tem `reminder`;
  - o nó existe, espera resposta e não é a abertura;
  - `agora <= last_inbound_at + 23 h 30 min`.
- **Mensagens:** duas. Primeiro `renderTemplate(reminder.text)` sozinho (chave `<runId>:rem<cursor>`),
  depois `messageFor(nó)` com as opções (chave `<runId>:rem<cursor>:q`). Depois de confirmar as
  duas, grava `reminder_sent_at`. Uma retentativa repete as mesmas chaves e a Zernio deduplica.
- **Job antes da hora:** é o caso de uma resposta mais nova, um toque antigo, o tempo editado ou o
  relógio adiantado. O job reagenda para a hora certa em vez de sumir.
- **Ponte fora do ar:** se `gateway.resolve` falhar, o job lança e a fila tenta de novo.
- **Resposta depois do lembrete:** é tratada como qualquer resposta ao nó atual. `reasks` não muda.
- **Cancelamento:** não existe cancelamento explícito. Se a pessoa responde, o `cursor` avança ou o
  `sentCursor` volta por re-pergunta, e o job encontra o estado mudado e não faz nada.

### 6. Editor e simulador (web)

- **Atraso:**
  - `logic.ts` normaliza e valida `delaySec` e `reminder`, espelhando o contrato;
  - `shapeIssues` aponta valor fora do limite;
  - o ⚙ de message, question, link e end tem o select "Esperar antes de enviar" (0, 2, 5, 10, 30 ou
    60 s), e o balão mostra o selo "⏱ N s" quando é maior que 0.
- **Lembrete:**
  - a barra de cima do editor ganha o botão "Lembrete", com um popover: liga/desliga, tempo (5, 15
    e 30 min; 1, 2, 4, 8, 12 e 23 h) e texto (300, com contador);
  - o texto sugerido ao ligar é "{nome}, ficou faltando pouco pra eu te mandar a opção certa.". Se o
    fluxo não grava `nome`, a renderização deixa o campo vazio, como já acontece hoje.
- **Simulador:**
  - antes de um balão com atraso, a conversa mostra uma linha de sistema "⏱ N s · digitando…";
  - quando a conversa espera num balão depois da abertura, há lembrete e ele ainda não saiu, aparece
    o botão "Simular silêncio", que acrescenta a mensagem do lembrete.

### 7. Privacidade e logs

Os logs do motor continuam só com ids, status e cursor. O texto do lembrete e as respostas da pessoa
não vão para o log.

## Risks / Trade-offs

- **Job de tempo perdido** (fila apagada, por exemplo): o atraso não avança sozinho.
  - Mitigação: a próxima mensagem da pessoa chama `drive`, que vê `resume_at` no passado e envia.
  - Para quem não responde, a conversa fica parada, igual a hoje.
- **Fila serial:** um atraso longo não segura a fila, porque o job termina na hora; só a continuação
  espera, na fila.
- **Typing que não aparece:** o "digitando…" depende da Meta (best-effort). Se falhar, só a mensagem
  atrasa.
- **Lembrete percebido como spam:** é limitado a um por conversa, configurável e desligado por
  padrão.
- **Pausar a automação:** jobs de tempo pendentes não fazem nada; ao reativar, a conversa retoma na
  próxima mensagem da pessoa.

## Migration Plan

- **Migration `0014`:** é só aditiva e roda no boot. Código antigo ignora as colunas.
- **Deploy manual no Easypanel.** Sem variável nova.
- **Rollback:** código anterior. Jobs `timer` pendentes viram erro de payload no código antigo e são
  descartados pelo `retryLimit`, sem envio. Execuções com `resume_at` pendente retomam na próxima
  mensagem da pessoa.
