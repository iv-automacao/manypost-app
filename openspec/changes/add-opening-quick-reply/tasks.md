## 1. Contrato e motor

- [x] 1.1 Teste em `packages/core/src/domain/automation/flow-step.test.ts`: abertura `quick` manda texto + dica + uma resposta rápida com payload `mp2` de `next`, sem botões; texto digitado avança por `next`
- [x] 1.2 Teste em `flow-validate.test.ts`: modo `quick` não gera `opening_button`
- [x] 1.3 `FlowOpeningModes` com `quick`; `messageFor` da abertura no core

## 2. Web

- [x] 2.1 Teste em `apps/web/src/features/automation/flow/logic.test.ts`: simulador mostra a sugestão e o toque avança
- [x] 2.2 `logic.ts` (normalização, `messageFor`, `tapForTitle`), ⚙ da abertura com três modos, balão com a sugestão, textos pt-BR
- [x] 2.3 Regenerar o snapshot OpenAPI (`bun run --cwd apps/web generate:api`)

## 3. Fechamento

- [x] 3.1 `bun run check`, `bun run spec:validate`
- [x] 3.2 `CHANGELOG.md`, `docs/principal/STATUS.md` e `docs/principal/CHANGELOG_ONDAS.md`
