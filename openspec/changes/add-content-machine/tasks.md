## 1. Contracts and domain (test-first)

- [x] 1.1 Add statuses, formats, foundation keys and error codes to `packages/contracts`
- [x] 1.2 Write `content-piece-state.test.ts`, then the pure transition table in `core/domain/content-machine`
- [x] 1.3 `bun test packages/core/src/domain/content-machine`

## 2. AI adapter settings

- [x] 2.1 Test that the chat-completions adapter honors `AI_TOKEN_LIMIT_PARAM` and `AI_SEND_TEMPERATURE`
- [x] 2.2 Implement in the config mapping and adapter; `bun test packages/core/src/infra/ai`

## 3. Persistence

- [x] 3.1 Schema `packages/db/src/schema/content-machine.ts`; `bun run --cwd packages/db generate -- --name content-machine`
- [x] 3.2 Repository `content-machine.repo.ts` with conditional status updates and org filters
- [x] 3.3 `bun run db:check`

## 4. Use cases and ports

- [x] 4.1 Ports: repository, renderer, video provider
- [x] 4.2 Tests with inline fakes for setup idempotency, plan creation, each stage, human decisions and spend
- [x] 4.3 Implement `content-machine.ts` and `content-machine-stages.ts`; `bun test packages/core/src/application/use-cases/content-machine`

## 5. Adapters, queue and API

- [x] 5.1 Renderer and video HTTP adapters (vendor name only under `infra/ai`)
- [x] 5.2 Queue `content-machine` + sweeper in `packages/queue`; wire API and worker containers
- [x] 5.3 Routes `/v1/content-machine/*` with route tests (401, org scoping, 404, 409)
- [x] 5.4 Regenerate the web client: `API_URL=http://localhost:3100 bun run --cwd apps/web generate:api`

## 6. Web

- [ ] 6.1 Routes `app/(app)/maquina`, sidebar, topbar and command-palette entries, `pt-BR.json` namespace
- [ ] 6.2 Board + piece detail sheet; brand identity; foundation and prompts; spend
- [ ] 6.3 `bun test apps/web/src/features/content-machine`

## 7. Validation and docs

- [ ] 7.1 `bun install --frozen-lockfile && bun run check && bun run db:check && bun run build:web`
- [ ] 7.2 `bun run spec:validate`
- [ ] 7.3 CHANGELOG, `docs/principal/STATUS.md`, `docs/principal/CHANGELOG_ONDAS.md`, repository map
