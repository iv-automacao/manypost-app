## Why

A automação comentário → direct (`add-comment-automation`) está no ar na @invistaseguros.br, mas o
construtor é um formulário linear: abertura, até 5 perguntas em sequência e o fim. O Iago quer o
modelo do ManyChat:

- **Canvas de balões conectados:** cada botão leva a um caminho diferente.
- **Montagem amigável:** adicionar opções e blocos dentro do próprio balão.
- **Opt-in:** botão de abertura, e um "pedir para seguir" que não trava nada e fica depois dos
  dados capturados.

O formulário não comporta ramificação, e o motor só conhece "passo i de n".

Esta é a **entrega 1 de 3**, aprovada no brainstorming de 12–13/10/2026:

1. **Esta mudança:** canvas, motor em grafo, blocos básicos, condição, pedir para seguir (atalho)
   e gatilho de comentário. O gatilho fica separado do fluxo.
2. **Gatilhos novos:** palavra-chave no direct, resposta a story e fluxo reutilizável.
3. **Blocos novos:** espera (janela de 24 h), imagem/vídeo e ações internas (etiqueta, avisar a
   equipe, CRM no meio do fluxo).

As entregas 2 e 3 têm mudanças próprias.

## What Changes

- **Fluxo em grafo.** A automação passa a guardar `config.version = 2`: nós com posição e conteúdo,
  e ligações de uma saída (botão, "sim/não", "seguir") para outro nó.
  - **Tipos de nó:** Abertura (opt-in), Mensagem (texto, até 3 botões ou até 13 respostas rápidas,
    guardar escolha em campo), Pergunta (texto validado), Condição, Link/WhatsApp e Fim.
  - **Pedir para seguir:** atalho do dock que cria um Link para o perfil da conta. Não trava o
    fluxo nem consulta se a pessoa segue. Decisão do Iago (13/10/2026): seguir não é condição para
    receber a cotação nem para deixar os dados; o pedido vem depois.
- **Gatilhos separados do fluxo.** Nova tabela `automation_triggers` (um fluxo, N gatilhos). A
  entrega 1 só tem o tipo `comment`, com posts, palavras-chave e respostas públicas. A migration
  copia o gatilho das automações existentes.
- **Motor em grafo.**
  - A execução guarda o nó atual.
  - O motor anda sozinho pelos nós que não esperam resposta, até o próximo que espera.
  - Novo payload `mp2:<runId>:<nodeId>:<saída>`.
  - **Condição:** avalia os campos respondidos.
  - Mantém a idempotência, a falha incerta sem reenvio e a fila serial atuais.
- **Compatibilidade v1.** Automações e execuções no formato atual são convertidas para grafo na
  leitura, com ids determinísticos. O payload `mp1:` continua aceito. Nada é reescrito no banco até
  alguém salvar pelo canvas.
- **Editor canvas** em `/automacoes/[id]` e `/automacoes/nova`, com React Flow (`@xyflow/react`,
  MIT):
  - edição no balão e ⚙ de opções avançadas;
  - menu "Próximo passo" ao soltar uma ligação no vazio;
  - dock de blocos;
  - barra do balão selecionado (Duplicar / Testar daqui / Excluir);
  - Organizar (layout automático com `@dagrejs/dagre`, MIT);
  - lista de problemas;
  - simulador de conversa;
  - somente leitura no celular.
- **Validação em dois níveis.** O formato e os limites valem sempre. Os problemas de fluxo (nó
  solto, saída obrigatória sem ligação, laço sem espera) bloqueiam só Teste e Ativa.

## Capabilities

### New Capabilities

- `automation-flow-builder`: fluxo de automação em grafo, gatilhos separados, motor que percorre
  o grafo, condição, compatibilidade v1 e editor canvas com simulador.

### Modified Capabilities

(nenhuma formalmente. `comment-automation` ainda não foi arquivada em `openspec/specs/`.

- **O que esta mudança substitui:** o fluxo linear da v1, os requisitos de configuração e de avanço
  do direct.
- **O que continua valendo como está:** entrada de eventos, uma execução por comentário, respostas
  pública e privada únicas, `lead.captured` e Leads.)

## Goals

- Montar no canvas o fluxo da Invista com ramificação por botão e pedido para seguir no fim, e
  testá-lo no simulador e em modo Teste antes de ativar.
- A automação ativa hoje continua funcionando sem intervenção no deploy.
- Nenhuma mensagem duplicada, nenhum laço de envio e nenhum fluxo inválido rodando em Teste ou
  Ativa.

## Non-goals

- Gatilhos de DM, story e fluxo reutilizável (entrega 2).
- Espera/atraso, mídia e ações internas (entrega 3). Os blocos aparecem acinzentados no dock.
- Rascunho separado de versão publicada: salvar vale na hora.
- Mais de um gatilho por fluxo na interface. A tabela já aceita N.
- Editar no celular.
- Canvas colaborativo em tempo real.
- Conferir se a pessoa segue a conta, ou condicionar o fluxo a isso.
- Converter de volta para v1 um fluxo salvo no canvas.

## Compatibility

- **Banco:** a migration é aditiva.
  - Cria a tabela nova e copia os gatilhos.
  - Acrescenta colunas anuláveis ou com padrão em `automation_runs`.
  - Não altera nem apaga dado existente.
- **Automações v1:** continuam funcionando. O motor converte na leitura e o editor abre a versão
  convertida.
- **Execuções em andamento:** seguem do passo onde estão (passo → nó).
- **API:** `GET /v1/automations/{id}` passa a devolver o fluxo v2 e os gatilhos. A escrita aceita
  v2. Os únicos clientes são a web deste repositório e scripts próprios.
- **Webhooks:** `lead.captured` mantém o formato.
- **Rede de conta:** nenhuma reconexão.

## Rollback

- **Antes de salvar qualquer automação no canvas:** reverter o deploy é seguro. Os configs
  continuam v1, as colunas e a tabela nova são ignoradas pelo código antigo, e o gatilho v1 continua
  em `config.trigger`. Uma conversa que começou no código novo e ainda está no meio pode repetir uma
  pergunta depois da volta (o código antigo lê `step`, o novo grava o nó).
- **Depois de salvar em v2:** o código antigo não lê `version: 2`, e aquela automação pararia de
  disparar. Por isso, a partir daí não se volta o deploy: corrige-se para a frente (pausar,
  corrigir, publicar de novo). O rollout testa tudo numa automação nova em Teste antes de salvar a
  ativa.
- **Desligar na hora:** pausar a automação, como hoje.

## Impact

- **Pacotes e apps:**
  - `packages/contracts`: schema do fluxo v2, gatilho, limites, status `ABANDONED` e payload.
  - `packages/db`: tabela `automation_triggers`, colunas de cursor em `automation_runs` e migration
    `0012`.
  - `packages/core`: validação de fluxo, conversão v1→v2, percurso do grafo e o motor reescrito
    sobre o grafo.
  - `packages/providers`: sem mudança.
  - `apps/api`: rotas de automação com fluxo, gatilhos e validação por status; OpenAPI regenerado.
  - `apps/web`: editor canvas, simulador, dependências `@xyflow/react` e `@dagrejs/dagre`.
- **Segurança e privacidade:**
  - Nada muda na entrada de eventos.
  - Os logs continuam só com ids e status.
- **Dados:** `comment_automations.config` passa a ter v2 quando salva pelo canvas; tabela
  `automation_triggers`; colunas novas em `automation_runs`.
- **Easypanel:** nenhuma variável nova. O deploy é manual, como sempre.
- **Identidade:** nenhum nome Postiz alterado. React Flow e dagre são MIT; não há derivação do
  Postiz.
