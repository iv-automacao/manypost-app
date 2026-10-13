## Context

`add-comment-automation` entregou o seguinte:

- **Webhook da Zernio:** grava e enfileira na fila `automation-event` (pg-boss, `workers: 1`).
- **Motor:** `packages/core/src/application/use-cases/comment-automation.ts`.
  - `onComment` cria uma execução por comentário. `ensureProgress` faz, só uma vez cada, a
    resposta pública, a resposta privada (abertura), o prompt do passo e o fim.
  - `onMessage` avança `step` de -1 até n.
- **Lógica pura:** `domain/automation/automation-logic.ts` com normalização, payload `mp1:`,
  validação de resposta e montagem de mensagens.
- **Web:** um formulário com pré-visualização em `apps/web/src/features/automation/`.

A configuração v1 é linear (`opening`, `questions[0..5]`, `finish`), e o gatilho fica dentro dela
(`config.trigger`).

Fatos da Zernio usados aqui:

- **Resposta privada:** uma por comentário, e não abre a janela de 24 h. Só a ação da pessoa
  (tocar no botão, responder) abre.
- **Envio na conversa:** aceita `Idempotency-Key`, guardada por 24 h. Até 3 `buttons` ou até 13
  `quickReplies`, com título de até 20 caracteres.

## Goals / Non-Goals

**Goals:**

- Fluxo em grafo editável num canvas, com ramificação por botão e condição.
- Motor retomável e idempotente sobre o grafo.
- Compatibilidade total com as automações e execuções v1.

**Non-Goals:** ver a proposta (gatilhos de DM e story, espera, mídia, ações, versão publicada
separada, edição no celular).

## Decisions

### 1. O fluxo v2 fica em `comment_automations.config`, validado em `packages/contracts`

O schema zod fica em `packages/contracts/src/automation-flow.ts`, ao lado de `automation.ts`:

```
FlowV2 = { version: 2, nodes: FlowNode[] (1..40), edges: FlowEdge[] (0..120) }
FlowNode = { id: /^[a-z0-9_-]{1,24}$/, type, position: { x, y } (finitos, |v| ≤ 100000), data }
FlowEdge = { id, source: nodeId, sourceHandle: string, target: nodeId }
```

| `type` | `data` | saídas (`sourceHandle`) | espera resposta? |
|---|---|---|---|
| `opening` | `text` (≤600), `mode: text\|button` (padrão `text`), `buttonTitle` (≤20), `disclosure: bool` | `next` | sim |
| `message` | `text` (≤600), `format: none\|buttons\|quick`, `options: [{id, title ≤20}]` (none: 0; buttons: 1..3; quick: 1..13), `saveTo?: field`, `onTyped: reask\|branch` | id de cada opção, `typed`; ou `next` se `none` | sim, exceto `none` |
| `question` | `text` (≤600), `field`, `validate: name\|phone\|email\|free` | `next` | sim |
| `condition` | `field`, `op: equals\|contains\|filled\|empty`, `value?` (≤60) | `yes`, `no` | não |
| `link` | `text` (≤600), `buttonTitle` (≤20), `target: whatsapp {phone, message} \| url {https}` | `next` (opcional) | não |
| `end` | `text?` (≤600) | — | não |

Regras de formato (sempre aplicadas, inclusive em rascunho):

- ids únicos;
- ids de opção únicos dentro do nó;
- `field` no padrão `^[a-z][a-z0-9_]{0,31}$`;
- no máximo uma ligação por (`source`, `sourceHandle`);
- ligação só para nó existente;
- nenhuma ligação entrando na `opening`;
- `url` só `https:`;
- exatamente um nó `opening`.

Os limites vão para `AUTOMATION_LIMITS` (`maxNodes: 40`, `maxEdges: 120`). O texto continua em 600
caracteres: a Meta aceita 640 com botões, e a sobra cobre o aviso de mensagem automática e a dica
do modo texto.

**Abertura em texto por padrão.** O Instagram recusa botão, cartão e anexo na resposta privada para
quem não segue a conta, e a recusa gasta a única resposta privada do comentário (documentação da
Zernio, "Send private reply"). Por isso uma `opening` nova nasce com `mode: text`: a mensagem pede
para a pessoa responder, e a resposta abre a conversa para os botões seguintes. O modo `button`
continua disponível, com um aviso fixo no balão ("quem não segue a conta não recebe") e um
problema de nível aviso que não bloqueia.

**Pedir para seguir não é um tipo de nó.** É um atalho do dock que cria um `link` com alvo `url`
apontando para o perfil da conta do canal (`https://instagram.com/<username>`), botão "Seguir" e um
texto sugerido. Não trava o fluxo, não consulta a Zernio e pode ficar em qualquer lugar. O uso
pensado é depois dos dados capturados, por exemplo depois do link do WhatsApp. Decisão do Iago em
13/10/2026: seguir não é condição para receber a cotação nem para deixar os dados.

O schema aceita `version: 1 | 2` por união discriminada. A escrita pela API exige 2.

Por que em `config` e não em tabelas de nós: o grafo é sempre lido e gravado inteiro, é pequeno
(40 nós), e jsonb mantém a gravação atômica. `packages/contracts` continua só com schema e tipos.

### 2. Validação de fluxo (`validateFlow`) é lógica pura em `core`

`packages/core/src/domain/automation/flow-validate.ts` devolve `FlowProblem[]`
(`{ code, severity: error|warning, nodeId?, edgeId?, handle? }`). Os textos são da web, por i18n do
`code`. Só `error` bloqueia; `warning` aparece no selo e no balão.

| `code` | regra |
|---|---|
| `unreachable` | nó não alcançável a partir da `opening` |
| `missing_edge` | saída obrigatória sem ligação |
| `wait_free_cycle` | ciclo sem nenhum nó que espera resposta (detectado por DFS no subgrafo dos nós que não esperam) |
| `unknown_field` | `condition.field` que nenhum nó grava (`question.field` / `message.saveTo`) |
| `no_finish` | nenhum `end` nem `link` alcançável |
| `opening_button` (warning) | `opening` em modo `button`: quem não segue a conta não recebe |

As saídas obrigatórias são:

- `opening.next`;
- cada opção de `message` com botões ou respostas rápidas;
- `message(none).next`;
- `question.next`;
- `condition.yes` e `condition.no`.

As saídas opcionais e o que acontece quando ficam sem ligação:

- **`message.typed`:** segue pela primeira opção.
- **`link.next`:** encerra como fim.

Na API, os problemas de nível `error` não impedem salvar em `DRAFT`/`PAUSED`. Impedem salvar ou mudar o status para
`TEST`/`ACTIVE`, e nesse caso a resposta é 400 `automation.flow_invalid` com a lista. A web repete a
validação para mostrar ao vivo (ver a decisão 8).

### 3. Gatilhos em `automation_triggers`

Colunas: `id`, `org_id`, `automation_id` (fk, cascade), `channel_id`, `kind` (`text`, hoje só
`comment`), `config` jsonb, `position` jsonb (onde o ⚡ fica no canvas), `created_at` e
`updated_at`. Índice em `(channel_id, kind)`.

- **`config` do gatilho de comentário:**
  - `mediaIds` (vazio = qualquer post);
  - `keywords` (vazio = qualquer comentário);
  - `publicReplies` (0..10, ≤300).

  É o mesmo vocabulário da v1, agora fora do fluxo. Um gatilho de story ou DM é só outro `kind`.
- **Casamento:** igual ao da v1 (`normalizeText` + palavra ou frase inteira). Vence o gatilho mais
  antigo entre as automações `ACTIVE`, mais as `TEST` cujo username de teste bate.
- **Na interface:** a entrega 1 mostra um gatilho de comentário por fluxo. A API aceita uma lista e
  valida no máximo 1 por enquanto.
- **Leitura de automação v1:** o motor e a API preferem a tabela. Se não houver linha (automação
  criada antes da migration por algum caminho não coberto), caem para `config.trigger` da v1.

### 4. Conversão v1 → v2 determinística

`packages/core/src/domain/automation/flow-from-v1.ts` monta o grafo assim:

- `opening` → nó `opening`, levando `mode`, `buttonTitle` e `disclosure` da v1 (a conversão preserva
  o modo; o editor mostra o aviso do modo botão).
- Pergunta `i`:
  - **`choice`:** nó `message` `q{i}`, com `format = buttons` até 3 opções e `quick` acima disso,
    `options[j].id = o{j}`, `saveTo = field` e `onTyped = reask`. Todas as opções ligam ao próximo.
  - **`text`:** nó `question` `q{i}`.
- `finish`:
  - **com WhatsApp:** nó `link` `finish` (texto da v1, botão e alvo WhatsApp) → `end` `end` sem
    texto;
  - **sem WhatsApp:** `end` `finish` com o texto.
- Posições em coluna (x fixo, y = 160·i). O Organizar arruma depois.
- Gatilho e `publicReplies` → linha de `automation_triggers` (feito pela migration; ver a
  Migration Plan).

**Prova de equivalência:** para as mesmas entradas, o motor v2 sobre o grafo convertido envia a
mesma sequência de mensagens (texto, botões, respostas rápidas, URL) que o motor v1. O teste usa a
configuração da automação de produção com os textos trocados por marcadores, e cobre toque, texto
que bate o título, texto inválido e fim.

### 5. Execução com cursor de nó

Colunas novas em `automation_runs`:

- `node_id text null`: nó atual;
- `cursor int not null default 0`: conta as entradas em nó;
- `sent_cursor int not null default -1`: último cursor cuja mensagem foi confirmada.

O status ganha `ABANDONED` (coluna `text`, sem DDL). O significado é: a conversa terminou sem
lead porque o nó em que ela estava foi apagado.

**Execução v1** (`node_id` nulo) é mapeada no primeiro toque e gravada:

- `step = -1` → `opening`;
- `0 ≤ i < n` → `q{i}`;
- `step ≥ n` → `finish`.

`sent_cursor` vem de `promptSentStep ≥ step`.

**Idempotency-Key** de cada envio na conversa: `<runId>:c<cursor>:<reasks>`.

### 6. Percurso: `drive(run)` substitui `ensureProgress`

Cada efeito é gravado logo depois de confirmado, como hoje:

1. Resposta pública, se `PENDING` (não crítica).
2. Resposta privada com a mensagem da `opening`, se `PENDING`. Nunca retentada às cegas. Ao
   confirmar, grava `node_id = opening` e `sent_cursor = cursor`.
3. Laço, com no máximo 20 iterações por evento:
   - Nó atual inexistente no grafo salvo → `ABANDONED` e para.
   - Se `sent_cursor < cursor` e o nó tem mensagem, envia e grava `sent_cursor = cursor`. A
     `condition` não envia nada.
   - Se o nó espera resposta, para.
   - Senão, escolhe a saída:
     - `condition` → `yes`/`no`, pela comparação normalizada (`normalizeText`) do campo;
     - `message(none)` → `next`;
     - `link` → `next`, ou fim se não tiver ligação;
     - `end` → fim.
   - Grava `node_id = alvo`, `cursor + 1` e `reasks = 0`.
   - Bater o limite de 20 → `FAILED` com motivo (é defesa, porque a validação já impede).
4. **Fim:** `COMPLETED` e `completed_at`, depois emite `lead.captured` uma vez (`lead_emitted_at`).

**Falha no envio**, mesma classificação de hoje:

- **Transitória:** o job é retentado, e a retomada pula o que já foi gravado.
- **Permanente:** a execução fica `FAILED` com motivo. Inclui 409 `not_thread_owner`.
- **Incerta:** a execução fica `UNCERTAIN`, sem reenvio.

### 7. Entrada no direct (`onMessage`) sobre o grafo

A execução é localizada:

1. pelo payload (`mp2:<runId>:<nodeId>:<handle>` ou `mp1:` v1 convertido);
2. senão, por `findOpenRun` (participante, depois username, janela de 7 dias), como hoje.

Payload de um nó diferente do atual = toque antigo: só chama `drive` e ignora.

No nó atual:

- **`opening`:** qualquer toque ou texto segue por `next`.
- **`message` com opções:**
  - Toque, ou texto igual ao título de uma opção → grava o título em `saveTo` e segue a saída da
    opção.
  - Outro texto, com `onTyped = branch` → grava o texto e segue por `typed`.
  - Outro texto, com `onTyped = reask`:
    - na 1ª vez, pergunta de novo (`sent_cursor = cursor − 1`, `reasks + 1`);
    - na 2ª vez, grava o texto cru e segue por `typed`, ou pela primeira opção se `typed` não
      tiver ligação.

  Esse é o comportamento da v1 hoje.
- **`question`:**
  - válida → grava e segue;
  - inválida → pergunta de novo uma vez e depois aceita o texto cru, como na v1.

### 8. Editor e simulador na web

- **Rotas:** `/automacoes/nova` e `/automacoes/[id]` passam a abrir o editor canvas em tela cheia,
  com `apps/web/src/features/automation/flow/`. A lista e `/leads` não mudam. O formulário v1 sai
  do código (`builder-view.tsx` e `conversation-preview.tsx`); o simulador desenha as próprias bolhas, tocáveis.
- **Dependências:** `@xyflow/react` 12 e `@dagrejs/dagre` (os dois MIT), com versão exata no
  `package.json`.
- **Balões:** nós customizados, com edição de texto e opções no próprio balão.
  - Cada opção tem um handle à direita.
  - O ⚙ abre um popover com formato (botões ou respostas rápidas), guardar em campo e "se
    digitar".
  - O balão ⚡ do gatilho é virtual (vem de `automation_triggers`). Ele liga só à `opening` e abre
    o editor de posts, palavras-chave, respostas públicas e @s de teste.
- **Criação:**
  - soltar uma ligação no vazio abre o menu "Próximo passo", que cria o nó já ligado;
  - o dock à esquerda arrasta ou clica para inserir; "Pedir para seguir" entra como `link` para o
    perfil (decisão 1);
  - espera, imagem e ação aparecem desabilitadas com "em breve".
- **Barra do selecionado:** Duplicar (ids novos, sem ligações de entrada), Testar daqui (abre o
  simulador naquele nó) e Excluir (remove o nó e as ligações; a `opening` não pode ser excluída).
- **Controles:** zoom, Centralizar e Organizar (dagre da esquerda para a direita, grava as
  posições). Desfazer e refazer guardam um histórico de 50 estados do grafo. Ao sair com
  alterações não salvas, aparece um aviso.
- **Barra superior:** nome, chip de status, selo "N problemas" (clicar foca o nó, que fica com borda
  de erro), Simular conversa, Salvar e Ativar. Ativar pede confirmação, com o mesmo aviso de
  hoje sobre IA do CRM e automações da Zernio.
- **Paridade sem carregar `core` no bundle:**
  - A web não importa `@manypost/core`. Ela repete o schema, os limites, `validateFlow` e o passo
    do percurso em `features/automation/flow/logic.ts`, como já faz com os limites da v1.
  - A paridade é assertada por fixtures JSON compartilhadas em `testdata/automation-flows/`. Cada
    fixture traz grafo, sequência de entradas, mensagens esperadas e problemas esperados, e é
    executada pelos testes de `core` e da web.
- **Simulador:** painel com bolhas no estilo do direct. Executa o passo puro da web (decisão 6,
  sem I/O). Toques e texto livre funcionam. Mostra os campos gravados.
- **Celular** (largura menor que 768 px): o canvas abre somente leitura, sem dock nem edição, com o
  aviso "edite no computador".
- **Marca:**
  - tokens CSS: ligações em `--line-strong`, selecionado em `--accent`, superfícies `--surface`;
  - raios de 8 a 12 px e nenhuma sombra (o CSS padrão do React Flow é sobrescrito);
  - `cursor: pointer` em todo controle e nenhum hover com transform;
  - i18n nos catálogos existentes.

### 9. API

- **`GET /v1/automations/{id}`:** devolve `{ ..., flow: FlowV2, triggers: Trigger[], problems: FlowProblem[] }`.
  Se a automação ainda é v1, o fluxo vem convertido.
- **`POST /v1/automations` e `PATCH /v1/automations/{id}`:** aceitam `name`, `status`,
  `testUsernames`, `flow` (v2) e `triggers`. Os gatilhos são gravados na mesma transação: os da
  automação são substituídos pela lista enviada.
- **Status:** a mudança para `TEST`/`ACTIVE` é rejeitada com `problems` quando houver algum. A regra
  de admin para mudar status continua.
- **OpenAPI:** é regenerado com `bun run --cwd apps/web generate:api`, que gera
  `apps/web/openapi.json` e `apps/web/src/lib/api/schema.d.ts`. Esses arquivos são gerados e não se
  editam à mão.

### 10. Auditoria e privacidade

Continuam como estão: `automation.*` na auditoria (o diff do fluxo não vai para lá, só o fato da
edição), e logs só com ids, status e nó.

## Risks / Trade-offs

- **Editar com conversas em andamento.** Sem versão publicada, quem está num nó apagado vira
  `ABANDONED`. Quem está num nó editado recebe o texto novo nas próximas mensagens. É uma escolha
  consciente, registrada na tela (aviso ao salvar quando a automação está Ativa).
- **Lógica duplicada na web.** É o padrão do repositório. As fixtures compartilhadas reduzem a
  divergência a uma falha de teste.
- **O bundle cresce** com React Flow e dagre, mas só na rota do editor. O import é dinâmico e
  `/automacoes` fica fora dele.

## Migration Plan

1. **Migrations:**
   - `0012_flow-builder` (gerada pelo drizzle-kit): cria `automation_triggers` e acrescenta
     `node_id`, `cursor` e `sent_cursor` em `automation_runs`.
   - `0013_flow-builder-backfill` (`drizzle-kit generate --custom`): `INSERT ... SELECT` de um
     gatilho `comment` por automação v1 não apagada, a partir de `config->'trigger'` e
     `config->'publicReplies'`. É idempotente por `NOT EXISTS`.

   As duas são aplicadas no boot (`DB_MIGRATE=auto`) e conferidas com
   `bun run --cwd packages/db check`.
2. Deploy pelo Iago no Easypanel. A automação ativa continua v1 no banco e roda pelo motor novo,
   convertida na leitura.
3. Criar uma automação nova em Teste no canvas, testar com o @ de teste do Iago (ramificação,
   condição, pedir para seguir e fim) e conferir em Leads.
4. Abrir a automação ativa no canvas e salvar. A partir daqui ela é v2.
5. **Rollback:** ver a proposta. Antes do passo 4, voltar o deploy é seguro. Depois do passo 4, o
   caminho é corrigir para a frente: pausar a automação, corrigir e publicar de novo.
