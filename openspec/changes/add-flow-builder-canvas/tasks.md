## 0. Preparação

- [ ] 0.1 `bun install --frozen-lockfile` e `bun run check` verdes antes de começar (linha de base)

## 1. Contrato

- [ ] 1.1 Testes de `packages/contracts/src/automation-flow.test.ts`: limites por tipo de nó, ids únicos, uma ligação por saída, ligação para a `opening` recusada, `url` só https, exatamente uma `opening`, gatilho `comment`
- [ ] 1.2 `automation-flow.ts`: `FlowV2Schema`, `FlowNode`, `FlowEdge`, `CommentTriggerConfigSchema`, `FlowProblem`, `AUTOMATION_LIMITS.maxNodes/maxEdges`, `ABANDONED` em `AutomationRunStatuses`, `DirectTransport.followStatus?` opcional; exportar no índice

## 2. Fixtures compartilhadas

- [ ] 2.1 `testdata/automation-flows/*.json`: cada uma com grafo, entradas, mensagens esperadas e problemas esperados. Cobrir: linear convertido da v1 (forma da automação de produção, textos marcadores), ramificação por botão, mensagens encadeadas, pedir para seguir (segue / não segue com e sem `no` / não sabe), condição, laço sem espera, nó solto, saída obrigatória sem ligação

## 3. Domínio puro em core (test-first)

- [ ] 3.1 Testes e implementação de `domain/automation/flow-validate.ts` (todas as fixtures de problema)
- [ ] 3.2 Testes e implementação de `domain/automation/flow-from-v1.ts` (ids determinísticos, posições, `link` + `end` no WhatsApp)
- [ ] 3.3 Testes e implementação de `domain/automation/flow-step.ts`: mensagem de cada nó (botões, respostas rápidas, aviso, dica do modo texto, payload `mp2`), avaliação de condição, decisão da entrada (toque, texto = título, `typed`, re-pergunta, follow), mapeamento passo v1 → nó; rodar as fixtures de mensagens
- [ ] 3.4 Teste de equivalência: motor v1 × grafo convertido, mesma sequência de mensagens

## 4. Banco

- [ ] 4.1 Schema `automation_triggers` e colunas `node_id`, `cursor`, `sent_cursor` em `automation_runs`
- [ ] 4.2 Gerar `0012_flow-builder` com drizzle-kit, acrescentar o backfill idempotente (`INSERT ... SELECT ... WHERE NOT EXISTS`) e rodar `bun run db:check`
- [ ] 4.3 Port e repo: CRUD de gatilhos por automação (substituir na mesma transação do update), `listTriggerable` por gatilho; testes de integração (org, backfill rodado duas vezes, cascade)

## 5. Zernio

- [ ] 5.1 Testes de `followStatus`: `true`, `false`, `null` com `unavailableReason`, HTTP 5xx e rede → `null`/`error`, `refresh=true` na URL
- [ ] 5.2 Implementar na ponte

## 6. Motor (test-first)

- [ ] 6.1 Testes do motor sobre o grafo, com o harness em memória atual:
  - comentário → abertura;
  - toque → ramo certo;
  - encadeamento;
  - retry sem duplicar;
  - toque antigo ignorado;
  - nó apagado → `ABANDONED`;
  - limite de 20 passos;
  - permanente / incerto / `not_thread_owner`;
  - fim → `lead.captured` uma vez;
  - pedir para seguir nos quatro resultados;
  - execução v1 em andamento com payload `mp1`;
  - automação v1 sem linha de gatilho cai para `config.trigger`.
- [ ] 6.2 Reescrever `use-cases/comment-automation.ts` com `drive` e `onMessage` sobre o grafo; manter `ingest`/`process`; os testes v1 existentes continuam passando

## 7. API

- [ ] 7.1 Testes de rota:
  - GET devolve `flow` + `triggers` + `problems`, com v1 convertida;
  - salvar rascunho com problema → 200 com a lista;
  - Teste/Ativa com problema → 400 `automation.flow_invalid`;
  - formato inválido → 400;
  - org alheia → 404;
  - admin para status.
- [ ] 7.2 Implementar rotas e regenerar o cliente com `bun run --cwd apps/web generate:api`

## 8. Web

- [ ] 8.1 Adicionar `@xyflow/react` e `@dagrejs/dagre` com versão exata (`bun add --exact`); conferir licença MIT
- [ ] 8.2 `features/automation/flow/logic.ts` (schema, limites, `validateFlow`, passo do simulador, Organizar), com teste de paridade contra `testdata/automation-flows/` e contra `AUTOMATION_LIMITS`
- [ ] 8.3 Canvas:
  - balões por tipo com edição inline e ⚙;
  - balão ⚡ do gatilho;
  - menu "Próximo passo";
  - dock (blocos da entrega 3 desabilitados);
  - barra do selecionado;
  - zoom, Centralizar e Organizar;
  - desfazer e refazer;
  - aviso de saída sem salvar;
  - selo de problemas com foco.
- [ ] 8.4 Simulador (painel, "Testar daqui", simular segue / não segue / não sabe) e barra superior (Salvar, Ativar com confirmação, aviso ao salvar automação Ativa)
- [ ] 8.5 Somente leitura abaixo de 768 px; i18n; import dinâmico do editor; CSS do React Flow sem sombra; `bun run check:brand`
- [ ] 8.6 Remover o formulário v1 (`builder-view.tsx`) e os testes dele que não valem mais; `conversation-preview.tsx` é reaproveitada nas bolhas do simulador
- [ ] 8.7 `bun run check` e `bun run build:web`; montar no navegador um fluxo com ramificação, pedir para seguir e condição, e simular

## 9. E2E e operação

- [ ] 9.1 `scripts/e2e-automation.ts`: cenário v2 (ramificação + pedir para seguir + condição) com a Zernio falsa respondendo `follow-status`; o cenário v1 continua passando
- [ ] 9.2 `scripts/flow-to-v1.ts <automationId>`: converte de volta um grafo linear e recusa os demais (teste com fixture linear e com ramificada)
- [ ] 9.3 `scripts/diag-automation.ts`: mostrar gatilhos da tabela, `node_id`/`cursor` das execuções e o motivo de casamento pelo gatilho

## 10. Documentação e fechamento

- [ ] 10.1 `CHANGELOG.md` (raiz), `docs/principal/STATUS.md`, entrada no topo de `docs/principal/CHANGELOG_ONDAS.md`, runbook do rollout (passos do Migration Plan do design e rollback com `flow-to-v1`)
- [ ] 10.2 `bun run spec:validate` e `bun run check:ci`
- [ ] 10.3 Produção: deploy pelo Iago; automação nova em Teste com o @ de teste; só depois salvar a automação ativa no canvas (com autorização explícita)
