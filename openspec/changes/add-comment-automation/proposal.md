## Why

A Invista quer transformar comentário em conversa sem ManyChat. Exemplo: alguém comenta "quero" num
post, recebe uma resposta pública e uma mensagem no direct, responde a duas ou três perguntas com
botões e termina com um botão que abre o WhatsApp do atendimento. O lead fica registrado e segue
para o CRM. Os comentários já chegam ao manypost pela ponte Zernio (`add-zernio-comment-bridge`), e
a mesma conta da Zernio entrega eventos de comentário e de mensagem por webhook assinado e faz a
resposta privada com botões.

Decisões do Iago (12/10/2026):
- **Quem conduz o direct:** o fluxo do manypost. A IA do CRM fica com `active_instagram=false` e o
  CRM continua só registrando o histórico via Zernio.
- **Para onde vão os leads:** ficam no manypost e saem no evento assinado `lead.captured` para um
  workflow n8n que grava no CRM Invista.
- **Transporte:** Zernio agora, com App Review do app próprio em paralelo.

## What Changes

- **Automações de comentário por canal:**
  - **Gatilho:** posts específicos ou qualquer post, mais palavras-chave (ou qualquer comentário).
  - **Resposta pública:** variações sorteadas.
  - **Primeira mensagem privada:** texto, aviso de mensagem automática e botões.
  - **Perguntas:** de escolha (botões) ou de texto (nome, WhatsApp, e-mail ou campo livre).
  - **Mensagem final:** botão que abre o WhatsApp com texto pré-preenchido.
  - **Estados:** rascunho, teste (só reage a usernames listados), ativa e pausada.
- **Entrada de eventos:**
  - **Rota pública** `POST /v1/integrations/zernio/webhook`, com HMAC (`X-Zernio-Signature`).
  - **Gravação:** cada evento é gravado uma vez por `X-Zernio-Event-Id` e respondido em menos de
    5 s.
  - **Processamento:** fica na fila (pg-boss).
- **Motor do fluxo:**
  - **Disparo:** comentário que casa com uma automação cria uma execução (uma por comentário),
    responde em público e envia a resposta privada.
  - **Avanço:** cada mensagem recebida no direct avança a execução, grava a resposta e envia a
    próxima pergunta. No fim, envia o botão do WhatsApp e marca o lead como completo.
- **Lead:**
  - **Evento novo** `lead.captured` nos webhooks de saída.
  - **Tela Leads** com as respostas.
- **Telas:** construtor de automação com pré-visualização em forma de conversa, lista de
  automações e tela de Leads.
- **Variáveis:** `ZERNIO_WEBHOOK_SECRET`, mais um script que registra o webhook na Zernio filtrado
  pela conta.

## Capabilities

### New Capabilities

- `comment-automation`: automação comentário → resposta pública → direct com perguntas →
  WhatsApp, com registro de leads e evento `lead.captured`.

### Modified Capabilities

(nenhuma. A ponte de comentários e os webhooks de saída não mudam de requisito. O catálogo de
eventos de saída só ganha `lead.captured`.)

## Goals

- O fluxo completo funcionando na @invistaseguros.br, configurável pela interface, com modo teste
  antes de ativar.
- Nada de resposta dupla:
  - **Eventos:** idempotência por evento e por comentário.
  - **Mensagens:** chave de idempotência em cada envio à Zernio.
  - **Falha incerta:** nunca reenviada às cegas.
- Lead no CRM pelo n8n, sem acoplar o manypost ao Supabase do CRM.

## Non-goals

- Gatilho por story, live, menção ou DM espontânea.
- Lógica condicional (ramificar por resposta), atraso programado, sequência de follow-up e
  segmentação por seguidor.
- Caixa de entrada de DM no manypost. O direct é visto no app do Instagram e no CRM.
- Transporte pela Meta direto (entra quando o App Review sair, pela mesma porta).
- O workflow n8n que grava no CRM: é configurado fora do código; a mudança só garante o evento.

## Compatibility

A mudança só acrescenta: tabelas novas, rota pública nova, evento de saída novo e telas novas. Sem
`ZERNIO_WEBHOOK_SECRET`, a rota responde 404 e nenhuma automação recebe eventos. Nenhuma conta
precisa reconectar.

## Rollback

- **Desligar na hora:** pausar as automações pela interface.
- **Desligar a entrada:** remover `ZERNIO_WEBHOOK_SECRET` ou o webhook na Zernio; os eventos param
  de entrar.
- **Reverter o código:** reverter o commit. As tabelas novas ficam vazias e inofensivas, e a
  migration de remoção só sai se for pedida.

## Impact

- **Pacotes e apps:**
  - `packages/contracts`: tipos de automação e o evento `lead.captured`.
  - `packages/db`: 3 tabelas e migration.
  - `packages/core`: casos de uso do motor e do CRUD.
  - `packages/providers`: na Zernio, resposta privada, envio de mensagem e consulta da conta por id.
  - `packages/queue`: fila `automation-event`.
  - `apps/api`: rota pública do webhook, CRUD e leads.
  - `apps/web`: construtor, lista e Leads.
- **Segurança:**
  - **Assinatura:** HMAC comparado em tempo constante; corpo limitado; evento de conta fora de
    `ZERNIO_ORG_IDS` é descartado.
  - **Dados do comentarista** (username, respostas): dado pessoal guardado por organização e
    filtrado por `org_id`. Nunca vai para log; sai só no webhook de saída da própria organização.
  - **Automação ao vivo:** fica atrás do modo teste, e a resposta privada respeita o limite da Meta
    (7 dias, uma por comentário).
- **Dados:** `comment_automations`, `automation_runs`, `inbound_events`.
- **Easypanel:** uma variável nova e o registro do webhook (script).
- **Identidade:** nenhum nome Postiz alterado.
