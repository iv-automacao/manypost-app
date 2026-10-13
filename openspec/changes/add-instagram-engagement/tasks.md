## 1. Contrato

- [x] 1.1 Tipos de engajamento e métodos opcionais em `packages/contracts/src/channel-provider.ts`; códigos `channel.provider_rejected`/`channel.provider_failed` em `error-codes.ts`
- [x] 1.2 `bun run typecheck`

## 2. Provider (test-first)

- [x] 2.1 Testes de `shared/instagram-engagement.ts` com fetch falso: mídia paginada, comentários com respostas/`hidden`/autor próprio, resposta e ocultação no corpo, insights da conta com degradação por métrica, insights por post com falha isolada
- [x] 2.2 Implementar `makeInstagramEngagement(apiBase)`
- [x] 2.3 Testes do `instagram-standalone` cobrindo os seis métodos e `engagementScopes`; implementar a ligação
- [x] 2.4 `bun test packages/providers`

## 3. Caso de uso (test-first)

- [x] 3.1 Testes de `makeEngagement`: canal de outra org → not_found sem decifrar; canal não ativo e escopo ausente sem rede; provider sem método → `capability.disabled`; classificação refresh/permanent/transient; transporte na escrita → `uncertain`; período > 30 dias e mensagem vazia/longa recusados; auditoria em resposta e ocultação
- [x] 3.2 Implementar `packages/core/src/application/use-cases/engagement.ts` e exportar
- [x] 3.3 `bun test packages/core`

## 4. API

- [x] 4.1 Testes de rota: id não numérico → 400 sem rede; idempotência na resposta; status dos códigos novos
- [x] 4.2 `engagement.routes.ts`, montagem em `main.ts`, container, mapa de status em `error.ts`
- [x] 4.3 API local + `API_URL=http://localhost:3100 bun run --cwd apps/web generate:api`; revisar `openapi.json` e `schema.d.ts`

## 5. Web

- [x] 5.1 Lógica pura testada (`features/engagement/logic.ts`): períodos, formatação de métricas, canais elegíveis
- [x] 5.2 Hooks, telas Comentários e Insights, páginas `app/(app)/comentarios` e `app/(app)/insights`
- [x] 5.3 Menu lateral, nav mobile/topbar, paleta de comandos, mensagens `pt-BR.json`, testes de propriedade do `PageHeader`
- [x] 5.4 `bun run check:brand`, `bun run typecheck:web`, `bun run build:web`

## 6. Fechamento

- [x] 6.1 `bun install --frozen-lockfile`, `bun run check`, `bun run spec:validate`, `git diff --check`
- [x] 6.2 `CHANGELOG.md`, `docs/principal/STATUS.md`, entrada no `docs/principal/CHANGELOG_ONDAS.md`, `docs/specs/SPEC_INTEGRATIONS.md` (engajamento)
- [ ] 6.3 Verificação em produção com a conta da Invista (leitura; resposta só com autorização explícita) antes de arquivar
