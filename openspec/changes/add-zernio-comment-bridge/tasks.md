## 1. Contrato e configuração

- [x] 1.1 `CommentTransport` em `packages/contracts/src/channel-provider.ts`
- [x] 1.2 `ZERNIO_API_KEY` e `ZERNIO_ORG_IDS` opcionais em `packages/config/src/env.ts` + `.env.example`

## 2. Adaptador Zernio (test-first)

- [x] 2.1 Testes com fetch falso: resolução por `platformUserId`, reserva por username, conta ausente → null, cache de contas, mapeamento de comentário e cursor, corpo de resposta/ocultação/reexibição, classificação 401/403/429/5xx/400, chave fora de log
- [x] 2.2 Implementar `packages/providers/src/zernio/zernio-bridge.ts` e exportar

## 3. Caso de uso (test-first)

- [x] 3.1 Testes de `makeEngagement`: ponte usada no lugar do provider; sem ponte = caminho direto; canal de outra org não consulta a ponte; escrita pela ponte sem `mediaId` → 400 sem rede; auditoria pela ponte; falha classificada da ponte
- [x] 3.2 Implementar `commentTransportFor` em `engagement.ts`

## 4. API e web

- [x] 4.1 `mediaId` opcional nos corpos de resposta e visibilidade (teste de rota: não numérico → 400)
- [x] 4.2 Container: ponte só com chave + allowlist; `commentTransportFor` por org e provider
- [x] 4.3 Regenerar `openapi.json`/`schema.d.ts`; web envia `mediaId`
- [x] 4.4 `bun run typecheck`, testes de providers/core/api/web, `bun run check:brand`

## 5. Fechamento

- [x] 5.1 CHANGELOG, CHANGELOG_ONDAS, STATUS, SPEC_INTEGRATIONS, `docs/principal/INTEGRATIONS_SETUP.md` (variáveis)
- [ ] 5.2 Verificação em produção com a Invista: leitura ✓ em 12/10/2026 (`check-zernio-bridge.ts`: Meta conta 5, ponte devolveu 5); responder/ocultar pela tela pendente (feito pelo Iago)
