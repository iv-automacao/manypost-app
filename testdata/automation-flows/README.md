# Fixtures de fluxo de automação

Lidas por `packages/core/src/domain/automation/flow-fixtures.test.ts` e por
`apps/web/src/features/automation/flow/logic.test.ts`. As duas implementações precisam produzir
exatamente os mesmos problemas e mensagens. Mensagens são normalizadas: só texto, títulos de botões,
títulos de respostas rápidas e URLs (nunca payloads). Textos são fictícios.
