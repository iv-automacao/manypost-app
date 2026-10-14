## 1. Contrato

- [x] 1.1 Testes em `packages/contracts`: `delaySec` 0..60 em message/question/link/end (61 e negativo recusados; abertura sem o campo), `reminder` (5..1380, texto 1..300, ausente aceito)
- [x] 1.2 `AUTOMATION_LIMITS.maxDelaySec`/`reminderText`, `delaySec` nos nós, `reminder` no `FlowV2Schema`, `DirectTransport.typing?`

## 2. Banco

- [x] 2.1 Migration `0014_flow-delay-reminder.sql` (`resume_at`, `last_inbound_at`, `reminder_sent_at`, nulos) + schema Drizzle + metadata pelo gerador
- [x] 2.2 Repositório e porta: campos em `AutomationRunRecord`/`AutomationRunPatch`; teste do repositório com banco de teste

## 3. Motor (test-first)

- [x] 3.1 Atraso: agenda `resume` com `startAfter`, typing best-effort, não envia antes da hora, envia na hora com a mesma chave, job velho não faz nada, automação pausada não segue
- [x] 3.2 `last_inbound_at` em todo `onMessage`; mensagem durante o atraso não antecipa
- [x] 3.3 Lembrete: arma só depois de resposta e fora da abertura, teto de 23 h, dispara uma vez com texto + nó + opções e chave `rem`, não dispara com cursor mudado, sem segundo lembrete, retentativa não duplica
- [x] 3.4 `process` aceita `{ timer, runId, cursor, accountRef }`; handler da fila na API repassa o payload

## 4. Ponte

- [x] 4.1 `typing` na Zernio (`POST /inbox/conversations/{id}/typing`, `{ accountId }`), com teste de golden

## 5. Web

- [x] 5.1 `logic.ts`: normalização/validação de `delaySec` e `reminder` (paridade com o contrato), simulador com linha de typing e "Simular silêncio"
- [x] 5.2 ⚙ "Esperar antes de enviar" + selo no balão; botão "Lembrete" na barra de cima; textos pt-BR
- [x] 5.3 Regenerar o snapshot OpenAPI

## 6. Fechamento

- [x] 6.1 E2E local (`scripts/e2e-automation.ts`): fluxo com atraso e lembrete em banco de teste isolado
- [x] 6.2 `bun run check`, `db:check`, `spec:validate`; `CHANGELOG.md`, `STATUS.md`, `CHANGELOG_ONDAS.md`
