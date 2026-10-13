## 0. Preparação

- [x] 0.1 `bun install --frozen-lockfile` e `bun run check` verdes antes de começar (linha de base)

## 1. Contrato

- [x] 1.1 Testes de `packages/contracts/src/automation-flow.test.ts`: limites por tipo de nó, ids únicos, uma ligação por saída, ligação para a `opening` recusada, `url` só https, exatamente uma `opening`, gatilho `comment`
- [x] 1.2 `automation-flow.ts`: `FlowV2Schema`, `FlowNode`, `FlowEdge`, `CommentTriggerConfigSchema`, `FlowProblem`, `AUTOMATION_LIMITS.maxNodes/maxEdges`, `ABANDONED` em `AutomationRunStatuses`; exportar no índice

## 2. Fixtures compartilhadas

- [x] 2.1 `testdata/automation-flows/*.json`: cada uma com grafo, entradas, mensagens esperadas e problemas esperados. Cobrir: linear convertido da v1 (forma da automação de produção, textos marcadores), ramificação por botão, mensagens encadeadas, pedir para seguir depois do WhatsApp (link para o perfil, sem esperar resposta), condição, laço sem espera, nó solto, saída obrigatória sem ligação

## 3. Domínio puro em core (test-first)

- [x] 3.1 Testes e implementação de `domain/automation/flow-validate.ts` (todas as fixtures de problema)
- [x] 3.2 Testes e implementação de `domain/automation/flow-from-v1.ts` (ids determinísticos, posições, `link` + `end` no WhatsApp)
- [x] 3.3 Testes e implementação de `domain/automation/flow-step.ts`: mensagem de cada nó (botões, respostas rápidas, aviso, dica do modo texto, payload `mp2`), avaliação de condição, decisão da entrada (toque, texto = título, `typed`, re-pergunta), mapeamento passo v1 → nó; rodar as fixtures de mensagens
- [x] 3.4 Teste de equivalência: motor v1 × grafo convertido, mesma sequência de mensagens

## 4. Banco

- [x] 4.1 Schema `automation_triggers` e colunas `node_id`, `cursor`, `sent_cursor` em `automation_runs`
- [x] 4.2 Gerar `0012_flow-builder` com drizzle-kit e `0013_flow-builder-backfill` com `--custom` (`INSERT ... SELECT ... WHERE NOT EXISTS`); rodar `bun run db:check`
- [x] 4.3 Port e repo: CRUD de gatilhos por automação (substituir na mesma transação do update), `listTriggerable` por gatilho; testes de integração (org, backfill rodado duas vezes, cascade)

## 5. Motor (test-first)

- [x] 5.1 Testes do motor sobre o grafo, com o harness em memória atual:
  - comentário → abertura;
  - toque → ramo certo;
  - encadeamento;
  - retry sem duplicar;
  - toque antigo ignorado;
  - nó apagado → `ABANDONED`;
  - limite de 20 passos;
  - permanente / incerto / `not_thread_owner`;
  - fim → `lead.captured` uma vez;
  - link sem saída encerra e emite o lead;
  - execução v1 em andamento com payload `mp1`;
  - automação v1 sem linha de gatilho cai para `config.trigger`.
- [x] 5.2 Reescrever `use-cases/comment-automation.ts` com `drive` e `onMessage` sobre o grafo; manter `ingest`/`process`; os testes v1 existentes continuam passando

## 6. API

- [x] 6.1 Testes de rota:
  - GET devolve `flow` + `triggers` + `problems`, com v1 convertida;
  - salvar rascunho com problema → 200 com a lista;
  - Teste/Ativa com problema → 400 `automation.flow_invalid`;
  - formato inválido → 400;
  - org alheia → 404;
  - admin para status.
- [x] 6.2 Implementar rotas e regenerar o cliente com `bun run --cwd apps/web generate:api`

## 7. Web

- [x] 7.1 Adicionar `@xyflow/react` e `@dagrejs/dagre` com versão exata (`bun add --exact`); conferir licença MIT
- [x] 7.2 `features/automation/flow/logic.ts` (schema, limites, `validateFlow`, passo do simulador, Organizar), com teste de paridade contra `testdata/automation-flows/` e contra `AUTOMATION_LIMITS`
- [x] 7.3 Canvas:
  - balões por tipo com edição inline e ⚙;
  - balão ⚡ do gatilho;
  - menu "Próximo passo";
  - dock (blocos da entrega 3 desabilitados; "Pedir para seguir" cria um link para o perfil do canal);
  - barra do selecionado;
  - zoom, Centralizar e Organizar;
  - desfazer e refazer;
  - aviso de saída sem salvar;
  - selo de problemas com foco.
- [x] 7.4 Simulador (painel, "Testar daqui") e barra superior (Salvar, Ativar com confirmação, aviso ao salvar automação Ativa)
- [x] 7.5 Somente leitura abaixo de 768 px; i18n; import dinâmico do editor; CSS do React Flow sem sombra; `bun run check:brand`
- [x] 7.6 Remover o formulário v1 (`builder-view.tsx`, `conversation-preview.tsx`) e os testes dele que não valem mais
- [x] 7.7 `bun run check` e `bun run build:web` (a montagem no navegador virou o roteiro "Conferência no navegador" do runbook, a cargo do Iago: o login local é via Clerk)

## 8. E2E e operação

- [x] 8.1 `scripts/e2e-automation.ts`: cenário v2 (ramificação + condição + pedir para seguir no fim) com a Zernio falsa; o cenário v1 continua passando
- [x] 8.2 `scripts/diag-automation.ts`: mostrar gatilhos da tabela, `node_id`/`cursor` das execuções e o motivo de casamento pelo gatilho

## 9. Documentação e fechamento

- [x] 9.1 `CHANGELOG.md` (raiz), `docs/principal/STATUS.md`, entrada no topo de `docs/principal/CHANGELOG_ONDAS.md`, runbook do rollout (passos do Migration Plan do design; rollback só antes de salvar a automação ativa no canvas)
- [x] 9.2 `bun run spec:validate` e `bun run check:ci`
- [ ] 9.3 Produção: deploy pelo Iago; automação nova em Teste com o @ de teste; só depois salvar a automação ativa no canvas (com autorização explícita)
