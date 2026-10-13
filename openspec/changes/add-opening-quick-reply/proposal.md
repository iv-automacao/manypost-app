## Why

A abertura da automação comentário → direct é a resposta privada ao comentário: uma só por
comentário. Hoje ela tem dois modos. O modo `text` pede para a pessoa responder e chega a todos, mas
não oferece nada para tocar. O modo `button` oferece um botão, mas o Instagram pode recusar botão a
quem não segue a conta, e a recusa gasta a resposta privada.

No teste de 13/10/2026 na @invistaseguros.br, as respostas rápidas das mensagens seguintes
funcionaram para quem não segue a conta. O Iago pediu o mesmo na abertura, como no ManyChat (texto
com uma resposta rápida embaixo).

A documentação da Zernio ("Send private reply") lista a recusa a não seguidores só para botões,
cartões e anexos. Respostas rápidas não estão nessa lista. Elas não aparecem na pasta de
Solicitações do Instagram, mas o texto chega do mesmo jeito.

## What Changes

- **Novo modo `quick` na abertura.** A resposta privada leva o texto, a dica "Responda esta mensagem
  para continuar." e uma resposta rápida com o título configurado. Quem vê a sugestão toca nela;
  quem está em Solicitações responde digitando. As duas coisas seguem pela saída `next`.
- **Editor:** o ⚙ da abertura ganha a opção "Resposta rápida", com o campo do texto da sugestão. O
  balão mostra a sugestão e a dica. O simulador mostra a sugestão e aceita o toque.
- **Sem aviso de problema** para o modo `quick` (o aviso `opening_button` continua só no modo
  `button`).
- **Padrão inalterado:** uma abertura nova continua nascendo em `text` até o modo `quick` ser
  conferido em produção com conta que não segue.

## Capabilities

### New Capabilities

### Modified Capabilities

- `automation-flow-builder`: a abertura aceita o modo `quick`.

## Impact

- `packages/contracts/src/automation-flow.ts` (enum `FlowOpeningModes`).
- `packages/core/src/domain/automation/flow-step.ts` (mensagem da abertura).
- `apps/web/src/features/automation/flow/*` (lógica espelhada, ⚙, balão, simulador) e
  `apps/web/src/messages/pt-BR.json`.
- Snapshot OpenAPI do web (`apps/web/openapi.json` + `schema.d.ts`) regenerado.
- Sem migration, sem variável nova. Fluxos salvos continuam válidos.
