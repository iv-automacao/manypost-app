## 1. Contrato

- [x] 1.1 Testes em `packages/contracts`: nó `action` com `send_data` (rótulo válido; `WhatsApp coletado`, vazio e 33 caracteres recusados) e `notify` (texto 1..280; vazio e 281 recusados); `delaySec` descartado na ação (como na abertura); `handlesOf(action) = ['next']`
- [x] 1.2 `ActionNode` no `FlowNodeSchema`, `FlowNodeTypes` com `action`, `AUTOMATION_LIMITS.notifyText = 280`, `WebhookEvents.LeadUpdated`, enum de eventos da API

## 2. Grafo e passo (test-first)

- [x] 2.1 Fixtures em `testdata/automation-flows/`: ação entre perguntas, duas ações seguidas, `notify` com `{nome}`, ação sem saída
- [x] 2.2 `flow-step`: `actionFor` (efeito resolvido, `{campo}` preenchido), `messageFor`/`delayOf`/`autoNext` para `action`; `flow-graph`: `outputsOf`, `waits`
- [x] 2.3 `flow-simulate`: linha de sistema para a ação; `flow-validate` cobre a ação pelas regras que já existem

## 3. Motor (test-first)

- [x] 3.1 `send_data`: `lead.updated` com o payload da spec, uma vez por cursor, `test` conforme o modo, retomar não repete, falha do `emit` faz o job lançar, sem webhook o fluxo segue e o `lead.captured` sai com os mesmos campos
- [x] 3.2 `notify`: notificação da organização (`automation.notify`, título = nome da automação, corpo preenchido, link /leads); falha faz o job lançar
- [x] 3.3 `AutomationEngineDeps.notifications` e ligação em `apps/api/src/automation.container.ts`

## 4. Web

- [x] 4.1 `logic.ts`: tipo `action` (normalização, `handlesOf`, `outputsOf`, `waits`, `actionFor`, simulador, `shapeIssues` `labelInvalid`/`textRequired`), paridade com o core e fixtures rodando
- [x] 4.2 Balão "Ação" (seletor de tipo e campo), dock e menu "Próximo passo" sem o "em breve" da Ação, linha ⚡ no simulador, textos pt-BR
- [x] 4.3 Configurações → Webhooks com `lead.updated`; regenerar o snapshot OpenAPI

## 5. Fechamento

- [x] 5.1 E2E local (`scripts/e2e-automation.ts`): Triagem com ação depois do WhatsApp recebe `lead.updated` assinado antes do `lead.captured`
- [x] 5.2 `docs/specs/SPEC_INTEGRATIONS.md` (guia dos eventos de lead): payload do `lead.updated` e deduplicação por `runId` + `nodeId`
- [x] 5.3 `bun run check`, `spec:validate`; `CHANGELOG.md`, `STATUS.md`, `CHANGELOG_ONDAS.md`

## 6. Depois do merge

- [x] 6.1 `test` no `lead.captured` (acréscimo compatível) para o CRM ignorar as contas de teste, com teste do motor nos dois modos
