# Runbook: construtor de fluxo em canvas (add-flow-builder-canvas)

[← STATUS](STATUS.md) · [Histórico das ondas](CHANGELOG_ONDAS.md)

Entrega 1 de 5. Mudança OpenSpec: `openspec/changes/add-flow-builder-canvas/`.

## Antes do deploy
- `bun run check:ci` verde na `maquina`.
- Nenhuma automação ou workflow da Zernio ativo na conta (eles respondem antes do manypost).
- Conferir a conferência no navegador (seção abaixo). Ela não foi feita pelo autor: o login local
  é via Clerk (serviço externo) e não deu para automatizar.

## Deploy (Easypanel, manual)
1. Clicar em Deploy. No boot entram as migrations `0012_flow-builder` (tabela de gatilhos e cursor
   nas execuções) e `0013_flow-builder-backfill` (um gatilho por automação existente).
2. Conferir no console: `bun run scripts/diag-automation.ts <channelId>` mostra o gatilho da
   automação ativa e as execuções com `nodeId`.
3. A automação ativa continua no formato antigo no banco e roda pelo motor novo.

## Teste em produção
1. Criar uma automação nova no canvas, em **Teste**, com o @ de teste.
2. Usar uma palavra-chave e/ou post **diferentes** dos da automação ativa. Quando os gatilhos se
   sobrepõem, a automação mais antiga vence e a de teste nunca dispara.
3. Comentar a palavra-chave com o @ de teste e percorrer o fluxo (botões, condição, pedir para
   seguir, fim). Conferir o lead em /leads e o `lead.captured` no n8n.

## Migrar a automação ativa
1. Antes de abrir no canvas, conferir os textos da abertura e das perguntas da automação ativa:
   não pode haver `{...}` literal. O motor novo renderiza `{campo}` e `{username}` em todas as
   mensagens (a v1 só fazia isso na mensagem final), então um `{x}` literal sumiria ou seria
   trocado.
2. Abrir a automação ativa no canvas. Ela aparece convertida, com o aviso de abertura em botão.
3. Trocar a abertura para "Pedir para responder" (quem não segue a conta passa a receber).
4. Salvar. A partir daqui ela é v2.

## Voltar atrás
- Antes do passo "Migrar a automação ativa": voltar o deploy anterior no Easypanel é seguro.
  Conversas que começaram no código novo e estavam no meio podem repetir uma pergunta.
- Depois: não voltar o deploy (o código antigo não lê v2). Pausar a automação, corrigir e
  publicar de novo.

## Regenerar o cliente OpenAPI
O snapshot precisa incluir as rotas de billing, então a API sobe com as duas variáveis abaixo:

```bash
IS_SELF_HOSTED=false HIDE_BILLING=false bun run dev   # API em :3100
API_URL=http://localhost:3100 bun run --cwd apps/web generate:api
```

`apps/web/openapi.json` e `apps/web/src/lib/api/schema.d.ts` são gerados: não se editam à mão.

## Conferência no navegador (roteiro do dono)
Com `bun run dev:all` e o banco local, abrir `http://localhost:3000/automacoes/nova`.

Fluxo e edição:
- [ ] O fluxo inicial (abertura, pergunta do nome, fim) aparece sem problemas.
- [ ] Puxar a saída "Respondeu" para o vazio abre o menu "Próximo passo". Soltar a ligação em cima
      de um balão não abre o menu.
- [ ] Mensagem: renomear os botões, adicionar um terceiro (o quarto fica bloqueado).
- [ ] No ⚙ da mensagem, "Guardar a escolha em" `tipo`. Trocar o formato (botões, respostas
      rápidas, texto) apaga as ligações que deixam de existir, e a saída "Digitou outra coisa"
      continua visível.
- [ ] Ligar um botão a uma Condição (`tipo` igual a `minha empresa`), outro a Link ou WhatsApp, e
      pôr "Pedir para seguir" depois do WhatsApp. O bloco aponta para o @ certo da conta.
- [ ] Apagar com Delete um balão que tem ligações e apertar Ctrl/Cmd+Z: o balão volta com as
      ligações.
- [ ] Arrastar um balão conta como um único passo de desfazer. Refazer funciona (botões e
      Ctrl/Cmd+Z fora de campo de texto).
- [ ] Organizar e Centralizar.

Gatilho e salvamento:
- [ ] No painel do gatilho, as palavras-chave continuam lá depois de Esc.
- [ ] Sair da tela com edição não salva pede confirmação (links internos e fechar a aba).
- [ ] Uma saída sem ligar mostra o selo de problemas. Clicar no selo abre a lista, e escolher um
      item foca o balão.
- [ ] Automação Ativa ou em Teste com erro não pode ser salva.
- [ ] Ativar abre o diálogo de confirmação. Teste exige um @ de teste.
- [ ] Salvar leva a `/automacoes/<id>`. Recarregar mantém fluxo, posições e gatilho.

Simulador:
- [ ] Tocar nos botões, digitar texto inválido (re-pergunta) e chegar ao fim. "Campos gravados"
      aparece.
- [ ] "Testar daqui" num balão do meio começa dali.
- [ ] Recomeçar zera a conversa.
- [ ] O botão do WhatsApp abre o link com o texto preenchido.

Outros:
- [ ] Abaixo de 768 px o editor é somente leitura, sem dock.
- [ ] Uma automação v1 abre convertida, com o aviso de abertura em botão.
- [ ] Em /leads, a conversa que acabou sem completar o lead aparece como "Encerrada sem lead".

Defeito achado: corrigir com teste quando houver lógica, um commit `fix(web): …` por correção.
