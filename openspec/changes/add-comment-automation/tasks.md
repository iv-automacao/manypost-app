## 1. Contrato e configuração

- [ ] 1.1 `packages/contracts`: schema zod `CommentAutomationConfigSchema` v1, tipos de status, `DirectTransport`, `WebhookEvents.LeadCaptured`; testes do schema (limites de botão, opções, campos únicos)
- [ ] 1.2 `ZERNIO_WEBHOOK_SECRET` opcional em `packages/config/src/env.ts` + `.env.example`

## 2. Banco

- [ ] 2.1 `packages/db/src/schema/automation.ts` (3 tabelas) + export
- [ ] 2.2 Gerar migration `0011_comment-automation` e `bun run --cwd packages/db check`
- [ ] 2.3 Port `ports/automation.ts` em core + `automation.repo.ts` em db

## 3. Zernio

- [ ] 3.1 Testes: `accountById`, `privateReply` (buttons/quickReplies, consumida → permanent, 502 unknown → uncertain), `sendMessage` com `Idempotency-Key`
- [ ] 3.2 Implementar na ponte (`DirectTransport`)

## 4. Motor (test-first)

- [ ] 4.1 Lógica pura: normalização e casamento de palavra-chave, payload `mp1:`, validação de resposta de texto, montagem de prompt (buttons vs quickReplies), link do WhatsApp com `{campo}`
- [ ] 4.2 Testes do motor: comentário casa → execução + resposta pública + privada; modo teste; própria conta/resposta ignoradas; reentrega sem duplicar; botão avança; texto inválido re-pergunta uma vez; fim emite `lead.captured` uma vez; standby/saída ignorados; retomada após falha transitória; privada consumida/incerta não retenta
- [ ] 4.3 Implementar `use-cases/comment-automation.ts` (CRUD + motor) e exportar

## 5. API

- [ ] 5.1 Rota pública do webhook: assinatura inválida → 401 sem gravar; reentrega → 200 sem reenfileirar; sem segredo → 404 (testes)
- [ ] 5.2 Rotas `/v1/automations` (CRUD, status) e `/v1/automations/leads` com testes de org e validação
- [ ] 5.3 `automation.container.ts` com `registerQueue('automation-event', …, { workers: 1 })`; montagem em `main.ts`
- [ ] 5.4 Regenerar OpenAPI

## 6. Web

- [ ] 6.1 Lógica pura testada (`features/automation/logic.ts`): rascunho padrão, prévia da conversa, validação local
- [ ] 6.2 Telas: lista, construtor com pré-visualização, Leads; nav, mobile, paleta, i18n, testes de PageHeader
- [ ] 6.3 `lead.captured` nas listas de eventos de webhook da web
- [ ] 6.4 `bun run check`, `bun run build:web` (cópia no scratchpad)

## 7. Operação e fechamento

- [ ] 7.1 `scripts/register-zernio-webhook.ts` (cria/atualiza o webhook filtrado pela conta, sem imprimir segredo)
- [ ] 7.2 CHANGELOG, CHANGELOG_ONDAS, STATUS, SPEC_INTEGRATIONS, INTEGRATIONS_SETUP
- [ ] 7.3 Verificação em produção em modo Teste com a conta de teste do Iago; ativação só com autorização explícita
