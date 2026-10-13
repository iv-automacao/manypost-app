# Construtor de fluxo em canvas (entrega 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o formulário linear da automação comentário → direct por um fluxo em grafo, editado num canvas de balões estilo ManyChat, com um motor que percorre o grafo e continua rodando as automações v1 que já estão no ar.

**Architecture:**

- O fluxo v2 (nós + ligações) fica em `comment_automations.config` e é validado por zod em `packages/contracts`.
- O gatilho sai para a tabela `automation_triggers`.
- A lógica pura do grafo fica em `packages/core/src/domain/automation/`: validação, conversão v1→v2, mensagem de cada nó, decisão da entrada e simulação.
- O motor (`use-cases/comment-automation.ts`) é reescrito sobre ela, mantendo:
  - a ingestão;
  - a fila serial;
  - a idempotência por envio, agora com cursor de nó.
- A web repete a lógica pura (padrão do repositório) e prova a paridade com fixtures JSON compartilhadas em `testdata/automation-flows/`.
- O editor usa React Flow.

**Tech Stack:** Bun 1.3, TypeScript, zod, Drizzle + PostgreSQL, Hono + zod-openapi, pg-boss, Next 16 + React 19 + React Query + next-intl, `@xyflow/react` 12, `@dagrejs/dagre`.

**Spec:** `openspec/changes/add-flow-builder-canvas/`. Ler antes `proposal.md`, `design.md` e `specs/automation-flow-builder/spec.md`; a lista `tasks.md` é a de alto nível.

## Global Constraints

- Comentários de código em **português**.
- `packages/core` não importa de `apps/*` nem de `packages/{db,providers}` (`bun run check:boundaries`).
- `packages/contracts` só tem tipos, schemas e constantes.
- Toda leitura e escrita é filtrada por `org_id`.
- Nunca logar texto de mensagem, username nem respostas. Logs levam só ids, status, nó e código.
- **Limites do fluxo:**
  - nós 40 e ligações 120;
  - título de botão ≤ 20;
  - até 3 botões, até 13 respostas rápidas;
  - texto ≤ 600;
  - valor de condição ≤ 60;
  - id de nó e de opção casa com `^[a-z0-9_-]{1,24}$`;
  - campo casa com `^[a-z][a-z0-9_]{0,31}$`.
- Payload v2: `mp2:<runId>:<nodeId>:<handle>`. O payload `mp1:` continua aceito.
- `Idempotency-Key` de envio na conversa: `<runId>:c<cursor>:<reasks>`.
- Abertura nova nasce com `mode: 'text'`. O modo `button` gera o aviso `opening_button` (não bloqueia).
- O status de execução ganha `ABANDONED`.
- Código de erro novo: `automation.flow_invalid` (HTTP 400), com `extra.problems`.
- **Marca:**
  - cores só por tokens CSS;
  - sem sombra e sem hex fora de `globals.css`;
  - hover sem transform;
  - `cursor-pointer` em todo `<button>`;
  - `rounded-full` proibido;
  - gaps 4/8/12/16/20/24/28/32;
  - tipografia `text-meta`/`text-compact`/`text-panel`;
  - sentence case.
- **Dependências web:** `@xyflow/react` e `@dagrejs/dagre`, versão exata (`bun add --exact`), licença MIT.
- Docs públicas: nunca segredo, token ou dado pessoal.
- Migrations existentes e arquivos gerados (`apps/web/openapi.json`, `apps/web/src/lib/api/schema.d.ts`, `packages/db/migrations/meta/*`) não se editam à mão.

## Review Focus

1. **Botão `mp1` antigo tocado depois do deploy** (a automação ativa hoje está em v1): a conversa continua no nó equivalente e não recomeça. Teste no Task 7 (`execução v1 em andamento continua com payload mp1`).
2. **Membro apaga, com a automação ativa, o balão em que alguém está esperando:** a próxima mensagem da pessoa encerra a execução como `ABANDONED`, sem enviar nada e sem erro na fila. Teste no Task 7 (`nó apagado → ABANDONED`).
3. **Texto com `{campo}` que ainda não foi respondido:** a mensagem sai com vazio no lugar, nunca com as chaves cruas. Teste no Task 4 (`campo ausente vira vazio`).
4. **Toque duplo ou toque em botão de uma mensagem que já passou:** não avança duas vezes nem regrava a resposta. Teste no Task 7 (`toque antigo é ignorado`).
5. **Condição com caixa e acento diferentes** ("Minha Empresa" × "minha empresa"; "Saúde" × "saude"): casa. Teste no Task 4 (`condição normaliza caixa e acento`).

Também coberto: mensagem sem texto (figurinha) não avança pergunta nem re-pergunta (Task 4, `entrada vazia é ignorada`).

---

## File Structure

**Contracts:**

| Arquivo | Ação | Conteúdo |
|---|---|---|
| `packages/contracts/src/automation-flow.ts` | criar | schema `FlowV2Schema`, nós, ligação, gatilho, problemas, `AnyAutomationConfigSchema` |
| `packages/contracts/src/automation-flow.test.ts` | criar | testes de formato |
| `packages/contracts/src/automation.ts` | modificar | `AUTOMATION_LIMITS` (+`maxNodes`, `maxEdges`, `conditionValue`), `ABANDONED` |
| `packages/contracts/src/error-codes.ts` | modificar | `AutomationFlowInvalid` |
| `packages/contracts/src/index.ts` | modificar | exporta `automation-flow` |

**Fixtures:** `testdata/automation-flows/*.json` (criar), com fluxo, entradas e o esperado. São lidas pelos testes de core e da web.

**Core:**

| Arquivo | Ação | Conteúdo |
|---|---|---|
| `domain/automation/automation-logic.ts` | modificar | exporta `OPENING_DISCLOSURE`, `OPENING_TEXT_HINT`, `matchesCommentTrigger` |
| `domain/automation/flow-graph.ts` | criar | `outputsOf`, `waits`, `nodeById`, `targetOf`, `fieldsWritten`, `openingOf` |
| `domain/automation/flow-validate.ts` | criar | `validateFlow`, `hasErrors` |
| `domain/automation/flow-from-v1.ts` | criar | `flowFromV1`, `triggerFromV1`, `nodeForV1Step`, `tapFromV1` |
| `domain/automation/flow-step.ts` | criar | payload v2, `messageFor`, `linkUrl`, `conditionHolds`, `autoNext`, `decideInput`, `leadWhatsappUrl` |
| `domain/automation/flow-simulate.ts` | criar | `simulateFlow` (percurso puro, usado pelas fixtures) |
| `domain/automation/flow-*.test.ts` | criar | testes de cada arquivo acima, mais `flow-fixtures.test.ts` |
| `application/ports/automation.ts` | modificar | gatilhos, colunas de cursor |
| `application/use-cases/comment-automation.ts` | modificar | CRUD com fluxo, gatilhos e problemas; motor sobre o grafo |
| `application/use-cases/comment-automation.test.ts` | modificar | harness com gatilhos; testes v2 |
| `application/use-cases/comment-automation.golden.test.ts` | criar | sequência de mensagens da v1 congelada |
| `src/index.ts` | modificar | exporta o que a API e a web de teste usam |

Todos os caminhos de core são relativos a `packages/core/src/`.

**DB:**

| Arquivo | Ação | Conteúdo |
|---|---|---|
| `packages/db/src/schema/automation.ts` | modificar | `automationTriggers` e as colunas novas |
| `packages/db/migrations/0012_flow-builder.sql` | gerar | tabela e colunas |
| `packages/db/migrations/0013_flow-builder-backfill.sql` | gerar (custom) | backfill dos gatilhos |
| `packages/db/src/repositories/automation.repo.ts` | modificar | gatilhos, cursor |
| `packages/db/src/repositories/automation.repo.integration.test.ts` | modificar | testes novos |

**API:**

| Arquivo | Ação | Conteúdo |
|---|---|---|
| `apps/api/src/http/routes/automations.routes.ts` | modificar | `flow`, `triggers`, `problems` |
| `apps/api/src/http/routes/automations.routes.test.ts` | modificar | testes novos |
| `apps/web/openapi.json`, `apps/web/src/lib/api/schema.d.ts` | regenerar | `bun run --cwd apps/web generate:api` |

**Web** (caminhos relativos a `apps/web/src/features/automation/`):

| Arquivo | Ação | Conteúdo |
|---|---|---|
| `flow/logic.ts` | criar | espelho da lógica pura, mais fábricas de nó, ids e helpers do editor |
| `flow/logic.test.ts` | criar | paridade com contracts e fixtures |
| `flow/layout.ts` | criar | `autoLayout` com dagre |
| `flow/history.ts` | criar | `useFlowHistory` (desfazer/refazer) |
| `flow/flow.css` | criar | ajustes do React Flow com tokens (sem sombra) |
| `flow/actions.tsx` | criar | contexto das ações que os balões usam |
| `flow/nodes.tsx` | criar | balões por tipo com edição inline |
| `flow/node-settings.tsx` | criar | popover ⚙ |
| `flow/next-step-menu.tsx` | criar | menu "Próximo passo" |
| `flow/dock.tsx` | criar | dock de blocos |
| `flow/trigger-panel.tsx` | criar | balão ⚡ e painel do gatilho (posts, palavras-chave, respostas públicas, @s de teste) |
| `flow/simulator.tsx` | criar | painel de simulação |
| `flow/top-bar.tsx` | criar | nome, status, problemas, simular, salvar, ativar |
| `flow/editor.tsx` | criar | `FlowEditor` (monta tudo) |
| `flow/editor-page.tsx` | criar | `AutomationEditorPage` (carrega, cria, salva) |
| `hooks.ts` | modificar | corpo com `flow` e `triggers` |
| `logic.ts` | modificar | remove o rascunho v1; mantém status, leads e `renderTemplate` |
| `logic.test.ts` | modificar | remove os testes do rascunho v1 |
| `automations-view.tsx` | modificar | resumo pelo gatilho e pelo número de blocos |
| `leads-view.tsx` | modificar | status `ABANDONED` |
| `builder-view.tsx` | apagar | |
| `conversation-preview.tsx` | apagar | o simulador desenha as próprias bolhas, tocáveis |

Fora da pasta da feature:

- `apps/web/src/app/(app)/automacoes/[id]/page.tsx` e `nova/page.tsx`: modificar, passam a renderizar `AutomationEditorPage`.
- `apps/web/src/messages/pt-BR.json`: modificar, novas chaves em `automation.flow`.

**Scripts e docs:**

| Arquivo | Ação |
|---|---|
| `scripts/e2e-automation.ts` | modificar: payloads e chaves v2; cenário v2 |
| `scripts/diag-automation.ts` | modificar: gatilhos e cursor |
| `CHANGELOG.md`, `docs/principal/STATUS.md`, `docs/principal/CHANGELOG_ONDAS.md`, `docs/principal/RUNBOOK_FLOW_BUILDER.md` | modificar ou criar |

---

### Task 0: Linha de base

**Files:** nenhum.

- [ ] **Step 1: Instalar e conferir a base**

Run: `bun install --frozen-lockfile && bun run check`
Expected: tudo verde. Se algo falhar **antes** de qualquer mudança, pare e reporte. Não corrija nada fora do escopo.

---

### Task 1: Contrato do fluxo v2

**Files:**
- Create: `packages/contracts/src/automation-flow.ts`
- Create: `packages/contracts/src/automation-flow.test.ts`
- Modify: `packages/contracts/src/automation.ts` (`AUTOMATION_LIMITS`, `AutomationRunStatuses`)
- Modify: `packages/contracts/src/error-codes.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/web/src/features/automation/logic.ts` (`LIMITS` e `RUN_STATUSES`, para a paridade da web continuar verde)

**Interfaces:**
- Produces:
  - `FlowV2Schema`, `FlowV2`, `FlowNode`, `FlowEdge`, `FlowNodeOf<T>`;
  - `FlowNodeTypes`, `FlowMessageFormats`, `FlowOnTypedModes`, `FlowConditionOps`, `FlowOpeningModes`, `FlowProblemCodes`;
  - `FlowProblem`;
  - `CommentTriggerConfigSchema`, `CommentTriggerConfig`, `FlowTriggerInputSchema`, `FlowTriggerInput`;
  - `AnyAutomationConfigSchema`, `FLOW_ID_RE`;
  - `ErrorCodes.AutomationFlowInvalid`.

- [ ] **Step 1: Escrever os testes do schema**

`packages/contracts/src/automation-flow.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { AnyAutomationConfigSchema, FlowV2Schema } from './automation-flow';

const opening = { id: 'opening', type: 'opening', position: { x: 0, y: 0 }, data: { text: 'Oi!' } };
const end = { id: 'fim', type: 'end', position: { x: 0, y: 200 }, data: {} };
const flow = (nodes: unknown[], edges: unknown[] = []) => ({ version: 2, nodes, edges });
const edge = (source: string, sourceHandle: string, target: string) => ({
  id: `e-${source}-${sourceHandle}`,
  source,
  sourceHandle,
  target,
});
const issues = (v: unknown) => {
  const r = FlowV2Schema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('FlowV2Schema', () => {
  test('aceita o fluxo mínimo e aplica os padrões', () => {
    const r = FlowV2Schema.parse(flow([opening, end], [edge('opening', 'next', 'fim')]));
    expect(r.nodes[0]).toMatchObject({ data: { mode: 'text', buttonTitle: 'Quero!', disclosure: true } });
    expect(r.nodes[1]).toMatchObject({ data: { text: '' } });
  });

  test('exige exatamente uma abertura', () => {
    expect(issues(flow([end]))).toContain('o fluxo precisa de exatamente uma abertura');
    expect(issues(flow([opening, { ...opening, id: 'outra' }]))).toContain('o fluxo precisa de exatamente uma abertura');
  });

  test('ids de nó repetidos e fora do padrão', () => {
    expect(issues(flow([opening, { ...end, id: 'opening' }]))).toContain('id de nó repetido');
    expect(FlowV2Schema.safeParse(flow([opening, { ...end, id: 'Fim!' }])).success).toBe(false);
  });

  test('mensagem: 4 botões, 14 respostas rápidas, título longo e id reservado são recusados', () => {
    const msg = (format: string, n: number, title = 'Opção') => ({
      id: 'm',
      type: 'message',
      position: { x: 0, y: 0 },
      data: { text: 'Qual?', format, options: Array.from({ length: n }, (_, i) => ({ id: `o${i}`, title })) },
    });
    expect(FlowV2Schema.safeParse(flow([opening, msg('buttons', 3)])).success).toBe(true);
    expect(FlowV2Schema.safeParse(flow([opening, msg('buttons', 4)])).success).toBe(false);
    expect(FlowV2Schema.safeParse(flow([opening, msg('quick', 13)])).success).toBe(true);
    expect(FlowV2Schema.safeParse(flow([opening, msg('quick', 14)])).success).toBe(false);
    expect(FlowV2Schema.safeParse(flow([opening, msg('none', 1)])).success).toBe(false);
    expect(FlowV2Schema.safeParse(flow([opening, msg('buttons', 1, 'x'.repeat(21))])).success).toBe(false);
    const reserved = msg('buttons', 1);
    (reserved.data.options[0] as { id: string }).id = 'typed';
    expect(FlowV2Schema.safeParse(flow([opening, reserved])).success).toBe(false);
  });

  test('ligações: nó inexistente, entrada na abertura, saída inválida e saída duplicada', () => {
    expect(issues(flow([opening, end], [edge('opening', 'next', 'nada')]))).toContain('ligação para nó inexistente');
    expect(issues(flow([opening, end], [edge('fim', 'next', 'opening')]))).toContain('nada pode ligar na abertura');
    expect(issues(flow([opening, end], [edge('opening', 'yes', 'fim')]))).toContain('saída inexistente no nó de origem');
    expect(
      issues(flow([opening, end, { ...end, id: 'fim2' }], [edge('opening', 'next', 'fim'), { ...edge('opening', 'next', 'fim2'), id: 'x' }])),
    ).toContain('esta saída já tem uma ligação');
  });

  test('link só aceita https e condição igual/contém exige valor', () => {
    const link = (url: string) => ({
      id: 'l',
      type: 'link',
      position: { x: 0, y: 0 },
      data: { text: 'Veja', buttonTitle: 'Abrir', target: { kind: 'url', url } },
    });
    expect(FlowV2Schema.safeParse(flow([opening, link('https://instagram.com/x')])).success).toBe(true);
    expect(FlowV2Schema.safeParse(flow([opening, link('http://instagram.com/x')])).success).toBe(false);
    const cond = (op: string, value?: string) => ({
      id: 'c',
      type: 'condition',
      position: { x: 0, y: 0 },
      data: { field: 'plano', op, ...(value === undefined ? {} : { value }) },
    });
    expect(FlowV2Schema.safeParse(flow([opening, cond('equals')])).success).toBe(false);
    expect(FlowV2Schema.safeParse(flow([opening, cond('equals', 'Vida')])).success).toBe(true);
    expect(FlowV2Schema.safeParse(flow([opening, cond('filled')])).success).toBe(true);
  });

  test('limite de 40 nós', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...end, id: `n${i}` }));
    expect(FlowV2Schema.safeParse(flow([opening, ...many])).success).toBe(false);
  });
});

describe('AnyAutomationConfigSchema', () => {
  test('lê v1 e v2', () => {
    const v1 = AnyAutomationConfigSchema.parse({ trigger: {}, opening: { text: 'Oi' }, finish: { text: 'Fim' } });
    expect(v1.version).toBe(1);
    const v2 = AnyAutomationConfigSchema.parse(flow([opening, end], [edge('opening', 'next', 'fim')]));
    expect(v2.version).toBe(2);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test packages/contracts/src/automation-flow.test.ts`
Expected: FAIL com `Cannot find module './automation-flow'`.

- [ ] **Step 3: Ampliar limites, status e código de erro**

Em `packages/contracts/src/automation.ts`, dentro de `AUTOMATION_LIMITS`, acrescentar ao fim (antes de `} as const`):

```ts
  maxNodes: 40,
  maxEdges: 120,
  conditionValue: 60,
```

e trocar a linha de `AutomationRunStatuses` por:

```ts
export const AutomationRunStatuses = ['OPEN', 'COMPLETED', 'FAILED', 'UNCERTAIN', 'SKIPPED', 'ABANDONED'] as const;
```

Em `packages/contracts/src/error-codes.ts`, logo antes de `// genéricos`:

```ts
  // automação
  /** o fluxo tem problemas que impedem Teste/Ativa — detail: { problems } */
  AutomationFlowInvalid: 'automation.flow_invalid',
```

Em `packages/contracts/src/index.ts`, depois de `export * from './automation';`:

```ts
export * from './automation-flow';
```

Em `apps/web/src/features/automation/logic.ts`:

- dentro de `LIMITS`, antes de `} as const`, acrescentar `maxNodes: 40,`, `maxEdges: 120,` e `conditionValue: 60,`;
- trocar `RUN_STATUSES` por `['OPEN', 'COMPLETED', 'FAILED', 'UNCERTAIN', 'SKIPPED', 'ABANDONED'] as const`;
- em `runStatusVariant`, mapear `ABANDONED` para `'neutral'`. Ler a função: se ela usa `switch`, acrescentar `case 'ABANDONED': return 'neutral';`; se usa um mapa, acrescentar a chave.

- [ ] **Step 4: Escrever `automation-flow.ts`**

```ts
import { z } from 'zod';
import { AUTOMATION_LIMITS, AutomationTextValidations } from './automation';
import { CommentAutomationConfigSchema } from './automation';

/**
 * Fluxo de automação v2 em grafo (openspec add-flow-builder-canvas, design D1). Só formato: as regras
 * de fluxo (alcance, saídas obrigatórias, laço sem espera) ficam em
 * `packages/core/src/domain/automation/flow-validate.ts`. A web repete os limites em
 * `apps/web/src/features/automation/flow/logic.ts` e a paridade é assertada nos testes de lá.
 */

const L = AUTOMATION_LIMITS;
const text = (max: number) => z.string().trim().min(1).max(max);
const buttonTitle = text(L.buttonTitle);
const field = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'campo: minúsculas, números e _');
export const FLOW_ID_RE = /^[a-z0-9_-]{1,24}$/;
const flowId = z.string().regex(FLOW_ID_RE, 'id: minúsculas, números, _ e -');
const coord = z.number().finite().min(-100_000).max(100_000);
const Position = z.object({ x: coord, y: coord });

export const FlowNodeTypes = ['opening', 'message', 'question', 'condition', 'link', 'end'] as const;
export type FlowNodeType = (typeof FlowNodeTypes)[number];
export const FlowOpeningModes = ['text', 'button'] as const;
export const FlowMessageFormats = ['none', 'buttons', 'quick'] as const;
export const FlowOnTypedModes = ['reask', 'branch'] as const;
export const FlowConditionOps = ['equals', 'contains', 'filled', 'empty'] as const;
export const FlowProblemCodes = [
  'unreachable',
  'missing_edge',
  'wait_free_cycle',
  'unknown_field',
  'no_finish',
  'opening_button',
] as const;
export type FlowProblemCode = (typeof FlowProblemCodes)[number];

/** saídas com nome fixo — uma opção de mensagem não pode usar estes ids */
const RESERVED_HANDLES = new Set(['next', 'typed', 'yes', 'no']);

const OpeningNode = z.object({
  id: flowId,
  type: z.literal('opening'),
  position: Position,
  data: z.object({
    text: text(L.messageText),
    /** `text` = pede para responder (chega a quem não segue); `button` = um botão (recusado a não seguidores) */
    mode: z.enum(FlowOpeningModes).default('text'),
    buttonTitle: buttonTitle.default('Quero!'),
    /** acrescenta "Mensagem automática." (transparência exigida pela política da Meta) */
    disclosure: z.boolean().default(true),
  }),
});

const MessageNode = z.object({
  id: flowId,
  type: z.literal('message'),
  position: Position,
  data: z
    .object({
      text: text(L.messageText),
      format: z.enum(FlowMessageFormats).default('buttons'),
      options: z.array(z.object({ id: flowId, title: buttonTitle })).max(L.maxOptions).default([]),
      /** campo onde a escolha (ou o texto digitado) é gravada */
      saveTo: field.optional(),
      /** texto que não bate com nenhuma opção: perguntar de novo (`reask`) ou sair por `typed` (`branch`) */
      onTyped: z.enum(FlowOnTypedModes).default('reask'),
    })
    .superRefine((d, ctx) => {
      const n = d.options.length;
      const [min, max] = d.format === 'none' ? [0, 0] : d.format === 'buttons' ? [1, L.maxButtons] : [1, L.maxOptions];
      if (n < min || n > max) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: `formato ${d.format}: de ${min} a ${max} opções` });
      }
      const seen = new Set<string>();
      d.options.forEach((o, i) => {
        if (seen.has(o.id) || RESERVED_HANDLES.has(o.id)) {
          ctx.addIssue({ code: 'custom', path: ['options', i, 'id'], message: 'id de opção repetido ou reservado' });
        }
        seen.add(o.id);
      });
    }),
});

const QuestionNode = z.object({
  id: flowId,
  type: z.literal('question'),
  position: Position,
  data: z.object({ text: text(L.messageText), field, validate: z.enum(AutomationTextValidations) }),
});

const ConditionNode = z.object({
  id: flowId,
  type: z.literal('condition'),
  position: Position,
  data: z
    .object({
      field,
      op: z.enum(FlowConditionOps),
      value: z.string().trim().max(L.conditionValue).default(''),
    })
    .superRefine((d, ctx) => {
      if ((d.op === 'equals' || d.op === 'contains') && !d.value) {
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'informe o valor da condição' });
      }
    }),
});

const LinkNode = z.object({
  id: flowId,
  type: z.literal('link'),
  position: Position,
  data: z.object({
    text: text(L.messageText),
    buttonTitle: buttonTitle.default('Abrir'),
    target: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('whatsapp'),
        phone: z.string().regex(/^\d{10,15}$/, 'WhatsApp: só dígitos com DDI, 10 a 15'),
        /** aceita {campo}, ex.: "Oi, sou {nome}" */
        message: z.string().trim().max(L.whatsappMessage).default(''),
      }),
      z.object({
        kind: z.literal('url'),
        url: z
          .string()
          .url()
          .max(2000)
          .refine((u) => u.startsWith('https://'), 'só links https'),
      }),
    ]),
  }),
});

const EndNode = z.object({
  id: flowId,
  type: z.literal('end'),
  position: Position,
  data: z.object({ text: z.string().trim().max(L.messageText).default('') }),
});

export const FlowNodeSchema = z.discriminatedUnion('type', [
  OpeningNode,
  MessageNode,
  QuestionNode,
  ConditionNode,
  LinkNode,
  EndNode,
]);
export type FlowNode = z.infer<typeof FlowNodeSchema>;
export type FlowNodeOf<T extends FlowNodeType> = Extract<FlowNode, { type: T }>;

export const FlowEdgeSchema = z.object({
  id: z.string().min(1).max(80),
  source: flowId,
  sourceHandle: flowId,
  target: flowId,
});
export type FlowEdge = z.infer<typeof FlowEdgeSchema>;

/** saídas que existem em cada nó (as obrigatórias são decididas no core) */
function handlesOf(n: FlowNode): string[] {
  switch (n.type) {
    case 'opening':
    case 'question':
    case 'link':
      return ['next'];
    case 'message':
      return n.data.format === 'none' ? ['next'] : [...n.data.options.map((o) => o.id), 'typed'];
    case 'condition':
      return ['yes', 'no'];
    case 'end':
      return [];
  }
}

export const FlowV2Schema = z
  .object({
    version: z.literal(2),
    nodes: z.array(FlowNodeSchema).min(1).max(L.maxNodes),
    edges: z.array(FlowEdgeSchema).max(L.maxEdges).default([]),
  })
  .superRefine((f, ctx) => {
    const byId = new Map<string, FlowNode>();
    f.nodes.forEach((n, i) => {
      if (byId.has(n.id)) ctx.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: 'id de nó repetido' });
      byId.set(n.id, n);
    });
    if (f.nodes.filter((n) => n.type === 'opening').length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'o fluxo precisa de exatamente uma abertura' });
    }
    const edgeIds = new Set<string>();
    const outs = new Set<string>();
    f.edges.forEach((e, i) => {
      const at = (message: string) => ctx.addIssue({ code: 'custom', path: ['edges', i], message });
      if (edgeIds.has(e.id)) at('id de ligação repetido');
      edgeIds.add(e.id);
      const src = byId.get(e.source);
      const dst = byId.get(e.target);
      if (!src || !dst) return at('ligação para nó inexistente');
      if (dst.type === 'opening') at('nada pode ligar na abertura');
      if (!handlesOf(src).includes(e.sourceHandle)) at('saída inexistente no nó de origem');
      const key = `${e.source}\u0000${e.sourceHandle}`;
      if (outs.has(key)) at('esta saída já tem uma ligação');
      outs.add(key);
    });
  });
export type FlowV2 = z.infer<typeof FlowV2Schema>;
export type FlowV2Input = z.input<typeof FlowV2Schema>;

/** v1 (formulário linear) ou v2 (grafo) — a leitura aceita as duas; a escrita pela API exige v2 */
export const AnyAutomationConfigSchema = z.union([FlowV2Schema, CommentAutomationConfigSchema]);
export type AnyAutomationConfig = z.infer<typeof AnyAutomationConfigSchema>;

// ---------- Gatilhos (tabela automation_triggers) ----------

export const CommentTriggerConfigSchema = z.object({
  /** vazio = qualquer post da conta */
  mediaIds: z.array(z.string().regex(/^\d{1,32}$/)).max(L.maxMedia).default([]),
  /** vazio = qualquer comentário */
  keywords: z.array(text(L.keyword)).max(L.maxKeywords).default([]),
  publicReplies: z.array(text(L.publicReply)).max(L.maxPublicReplies).default([]),
});
export type CommentTriggerConfig = z.infer<typeof CommentTriggerConfigSchema>;

export const FlowTriggerInputSchema = z.object({
  kind: z.literal('comment'),
  config: CommentTriggerConfigSchema,
  /** onde o balão ⚡ fica no canvas */
  position: Position.nullable().default(null),
});
export type FlowTriggerInput = z.infer<typeof FlowTriggerInputSchema>;

// ---------- Problemas de fluxo (calculados no core) ----------

export interface FlowProblem {
  code: FlowProblemCode;
  /** `error` bloqueia Teste/Ativa; `warning` só avisa */
  severity: 'error' | 'warning';
  nodeId?: string;
  handle?: string;
}
```

- [ ] **Step 5: Rodar os testes do pacote e a paridade da web**

Run: `bun test packages/contracts apps/web/src/features/automation/logic.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: sem erros. Se o `switch` de `handlesOf` reclamar de retorno faltando, a união está incompleta: confira os 6 tipos.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts apps/web/src/features/automation/logic.ts
git commit -m "feat(contracts): schema do fluxo v2 em grafo, gatilho e problemas"
```

---

### Task 2: Grafo e validação de fluxo (core)

**Files:**
- Create: `packages/core/src/domain/automation/flow-graph.ts`
- Create: `packages/core/src/domain/automation/flow-validate.ts`
- Create: `packages/core/src/domain/automation/flow-validate.test.ts`

**Interfaces:**
- Consumes: `FlowV2`, `FlowNode`, `FlowNodeOf`, `FlowProblem` (Task 1).
- Produces:
  - `outputsOf(node): Array<{ handle: string; required: boolean }>`
  - `waits(node): boolean`
  - `nodeById(flow, id: string | null): FlowNode | null`
  - `targetOf(flow, source: string, handle: string): string | null`
  - `fieldsWritten(flow): Set<string>`
  - `openingOf(flow): FlowNodeOf<'opening'>`
  - `validateFlow(flow): FlowProblem[]`
  - `hasErrors(problems): boolean`

- [ ] **Step 1: Escrever os testes**

`packages/core/src/domain/automation/flow-validate.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { FlowV2Schema, type FlowV2Input } from '@manypost/contracts';
import { outputsOf, waits } from './flow-graph';
import { hasErrors, validateFlow } from './flow-validate';

const P = { x: 0, y: 0 };
const parse = (f: Omit<FlowV2Input, 'version'>) => FlowV2Schema.parse({ version: 2, ...f });
const e = (source: string, sourceHandle: string, target: string) => ({
  id: `e-${source}-${sourceHandle}`,
  source,
  sourceHandle,
  target,
});
const opening = { id: 'opening', type: 'opening' as const, position: P, data: { text: 'Oi' } };
const end = { id: 'fim', type: 'end' as const, position: P, data: {} };
const codes = (f: Parameters<typeof validateFlow>[0]) =>
  validateFlow(f).map((p) => `${p.severity}:${p.code}:${p.nodeId ?? ''}:${p.handle ?? ''}`).sort();

describe('flow-graph', () => {
  test('saídas e espera por tipo', () => {
    const f = parse({
      nodes: [
        opening,
        { id: 'm', type: 'message', position: P, data: { text: 'Qual?', options: [{ id: 'a', title: 'A' }] } },
        { id: 'n', type: 'message', position: P, data: { text: 'Info', format: 'none' } },
        { id: 'b', type: 'message', position: P, data: { text: 'X', options: [{ id: 'a', title: 'A' }], onTyped: 'branch' } },
      ],
    });
    expect(outputsOf(f.nodes[1]!)).toEqual([
      { handle: 'a', required: true },
      { handle: 'typed', required: false },
    ]);
    expect(outputsOf(f.nodes[3]!).find((o) => o.handle === 'typed')?.required).toBe(true);
    expect(waits(f.nodes[0]!)).toBe(true);
    expect(waits(f.nodes[1]!)).toBe(true);
    expect(waits(f.nodes[2]!)).toBe(false);
  });
});

describe('validateFlow', () => {
  test('fluxo mínimo válido não tem problemas', () => {
    expect(validateFlow(parse({ nodes: [opening, end], edges: [e('opening', 'next', 'fim')] }))).toEqual([]);
  });

  test('nó solto, saída obrigatória sem ligação e sem fim', () => {
    const f = parse({
      nodes: [
        opening,
        { id: 'q', type: 'question', position: P, data: { text: 'Nome?', field: 'nome', validate: 'name' } },
        { ...end, id: 'solto' },
      ],
      edges: [e('opening', 'next', 'q')],
    });
    expect(codes(f)).toEqual([
      'error:missing_edge:q:next',
      'error:no_finish::',
      'error:unreachable:solto:',
    ]);
    expect(hasErrors(validateFlow(f))).toBe(true);
  });

  test('laço só com nós que não esperam é erro; laço passando por pergunta é permitido', () => {
    const info = { id: 'i', type: 'message' as const, position: P, data: { text: 'Info', format: 'none' as const } };
    const cond = { id: 'c', type: 'condition' as const, position: P, data: { field: 'nome', op: 'filled' as const } };
    const q = { id: 'q', type: 'question' as const, position: P, data: { text: 'Nome?', field: 'nome', validate: 'name' as const } };
    const ruim = parse({
      nodes: [opening, q, info, cond, end],
      edges: [e('opening', 'next', 'q'), e('q', 'next', 'i'), e('i', 'next', 'c'), e('c', 'yes', 'fim'), e('c', 'no', 'i')],
    });
    expect(codes(ruim)).toEqual(['error:wait_free_cycle:i:']);
    const bom = parse({
      nodes: [opening, q, cond, end],
      edges: [e('opening', 'next', 'q'), e('q', 'next', 'c'), e('c', 'yes', 'fim'), e('c', 'no', 'q')],
    });
    expect(validateFlow(bom)).toEqual([]);
  });

  test('condição sobre campo que ninguém grava', () => {
    const f = parse({
      nodes: [opening, { id: 'c', type: 'condition', position: P, data: { field: 'plano', op: 'filled' } }, end],
      edges: [e('opening', 'next', 'c'), e('c', 'yes', 'fim'), e('c', 'no', 'fim')],
    });
    expect(codes(f)).toEqual(['error:unknown_field:c:']);
  });

  test('abertura com botão é só aviso', () => {
    const f = parse({
      nodes: [{ ...opening, data: { text: 'Oi', mode: 'button' } }, end],
      edges: [e('opening', 'next', 'fim')],
    });
    expect(codes(f)).toEqual(['warning:opening_button:opening:']);
    expect(hasErrors(validateFlow(f))).toBe(false);
  });

  test('link sem saída conta como fim', () => {
    const f = parse({
      nodes: [
        opening,
        {
          id: 'l',
          type: 'link',
          position: P,
          data: { text: 'Fale', target: { kind: 'whatsapp', phone: '5592999990000' } },
        },
      ],
      edges: [e('opening', 'next', 'l')],
    });
    expect(validateFlow(f)).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test packages/core/src/domain/automation/flow-validate.test.ts`
Expected: FAIL com `Cannot find module './flow-graph'`.

- [ ] **Step 3: Escrever `flow-graph.ts`**

```ts
import type { FlowNode, FlowNodeOf, FlowV2 } from '@manypost/contracts';

/** Consultas puras sobre o grafo v2 (openspec add-flow-builder-canvas, design D1/D2). */

export interface FlowOutput {
  handle: string;
  /** sem ligação, vira problema `missing_edge` */
  required: boolean;
}

export function outputsOf(node: FlowNode): FlowOutput[] {
  switch (node.type) {
    case 'opening':
    case 'question':
      return [{ handle: 'next', required: true }];
    case 'message':
      if (node.data.format === 'none') return [{ handle: 'next', required: true }];
      return [
        ...node.data.options.map((o) => ({ handle: o.id, required: true })),
        { handle: 'typed', required: node.data.onTyped === 'branch' },
      ];
    case 'condition':
      return [
        { handle: 'yes', required: true },
        { handle: 'no', required: true },
      ];
    case 'link':
      return [{ handle: 'next', required: false }];
    case 'end':
      return [];
  }
}

/** nós que param e esperam a pessoa responder */
export function waits(node: FlowNode): boolean {
  return node.type === 'opening' || node.type === 'question' || (node.type === 'message' && node.data.format !== 'none');
}

export function nodeById(flow: FlowV2, id: string | null): FlowNode | null {
  return id ? (flow.nodes.find((n) => n.id === id) ?? null) : null;
}

export function targetOf(flow: FlowV2, source: string, handle: string): string | null {
  return flow.edges.find((e) => e.source === source && e.sourceHandle === handle)?.target ?? null;
}

/** campos que algum nó grava (pergunta ou mensagem com "guardar em") */
export function fieldsWritten(flow: FlowV2): Set<string> {
  const out = new Set<string>();
  for (const n of flow.nodes) {
    if (n.type === 'question') out.add(n.data.field);
    if (n.type === 'message' && n.data.saveTo) out.add(n.data.saveTo);
  }
  return out;
}

/** o schema garante exatamente uma abertura */
export function openingOf(flow: FlowV2): FlowNodeOf<'opening'> {
  const n = flow.nodes.find((x): x is FlowNodeOf<'opening'> => x.type === 'opening');
  if (!n) throw new Error('fluxo sem abertura');
  return n;
}
```

- [ ] **Step 4: Escrever `flow-validate.ts`**

```ts
import type { FlowProblem, FlowV2 } from '@manypost/contracts';
import { fieldsWritten, outputsOf, targetOf, waits } from './flow-graph';

/**
 * Problemas de fluxo (design D2). `error` bloqueia Teste/Ativa; `warning` só aparece no editor.
 * A ordem é estável para os testes e para a lista da tela.
 */
export function validateFlow(flow: FlowV2): FlowProblem[] {
  const out: FlowProblem[] = [];
  const opening = flow.nodes.find((n) => n.type === 'opening');
  if (!opening) return out;

  // alcance a partir da abertura
  const seen = new Set<string>([opening.id]);
  const queue = [opening.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of flow.edges) {
      if (e.source === id && !seen.has(e.target)) {
        seen.add(e.target);
        queue.push(e.target);
      }
    }
  }
  for (const n of flow.nodes) if (!seen.has(n.id)) out.push({ code: 'unreachable', severity: 'error', nodeId: n.id });

  // saídas obrigatórias (só dos alcançáveis: o nó solto já tem o próprio problema)
  for (const n of flow.nodes) {
    if (!seen.has(n.id)) continue;
    for (const o of outputsOf(n)) {
      if (o.required && !targetOf(flow, n.id, o.handle)) {
        out.push({ code: 'missing_edge', severity: 'error', nodeId: n.id, handle: o.handle });
      }
    }
  }

  for (const id of waitFreeCycleEntries(flow)) out.push({ code: 'wait_free_cycle', severity: 'error', nodeId: id });

  const fields = fieldsWritten(flow);
  for (const n of flow.nodes) {
    if (n.type === 'condition' && !fields.has(n.data.field)) {
      out.push({ code: 'unknown_field', severity: 'error', nodeId: n.id });
    }
  }

  if (!flow.nodes.some((n) => seen.has(n.id) && (n.type === 'end' || n.type === 'link'))) {
    out.push({ code: 'no_finish', severity: 'error' });
  }

  if (opening.type === 'opening' && opening.data.mode === 'button') {
    out.push({ code: 'opening_button', severity: 'warning', nodeId: opening.id });
  }
  return out;
}

export const hasErrors = (problems: FlowProblem[]) => problems.some((p) => p.severity === 'error');

/** ciclos no subgrafo dos nós que não esperam resposta: o motor entraria em laço mandando mensagem */
function waitFreeCycleEntries(flow: FlowV2): string[] {
  const free = new Set(flow.nodes.filter((n) => !waits(n)).map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const e of flow.edges) {
    if (free.has(e.source) && free.has(e.target)) adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  }
  const color = new Map<string, 1 | 2>();
  const found = new Set<string>();
  const visit = (u: string) => {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v);
      if (c === 1) found.add(v);
      else if (!c) visit(v);
    }
    color.set(u, 2);
  };
  for (const id of free) if (!color.has(id)) visit(id);
  return [...found];
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `bun test packages/core/src/domain/automation/flow-validate.test.ts`
Expected: PASS. Se `wait_free_cycle` reportar `c` em vez de `i`, a DFS começou por outro nó. A entrada reportada depende da ordem de `flow.nodes`, e a do teste segue a ordem declarada (`i` antes de `c`). Não mude o teste: confira se a iteração é `for (const id of free)` na ordem dos nós.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/domain/automation/flow-graph.ts packages/core/src/domain/automation/flow-validate.ts packages/core/src/domain/automation/flow-validate.test.ts
git commit -m "feat(core): grafo e validação do fluxo v2"
```

---

### Task 3: Conversão v1 → v2

**Files:**
- Create: `packages/core/src/domain/automation/flow-from-v1.ts`
- Create: `packages/core/src/domain/automation/flow-from-v1.test.ts`

**Interfaces:**
- Consumes: `CommentAutomationConfig` (v1), `FlowV2Schema`, `CommentTriggerConfig` (Task 1), `validateFlow` (Task 2).
- Produces:
  - `flowFromV1(cfg: CommentAutomationConfig): FlowV2`
  - `triggerFromV1(cfg): CommentTriggerConfig`
  - `nodeForV1Step(flow: FlowV2, step: number): string`: recebe o grafo, para servir também à automação v1 já salva como v2 no canvas, com os mesmos ids
  - `tapFromV1(step: number, option: number): { nodeId: string; handle: string }`

- [ ] **Step 1: Escrever os testes**

```ts
import { describe, expect, test } from 'bun:test';
import { CommentAutomationConfigSchema, FlowV2Schema } from '@manypost/contracts';
import { flowFromV1, nodeForV1Step, tapFromV1, triggerFromV1 } from './flow-from-v1';
import { validateFlow } from './flow-validate';

/** forma da automação de produção, com textos marcadores */
const V1 = CommentAutomationConfigSchema.parse({
  trigger: { mediaIds: ['1801'], keywords: ['plano'] },
  publicReplies: ['Resposta pública'],
  opening: { text: 'Abertura', mode: 'button', buttonTitle: 'Quero!' },
  questions: [
    { kind: 'choice', field: 'plano', prompt: 'Pergunta 1', options: [{ title: 'A' }, { title: 'B' }] },
    { kind: 'choice', field: 'vidas', prompt: 'Pergunta 2', options: [1, 2, 3, 4].map((n) => ({ title: `${n}` })) },
    { kind: 'text', field: 'whatsapp', prompt: 'Pergunta 3', validate: 'phone' },
  ],
  finish: { text: 'Fim {plano}', whatsapp: { phone: '5592999990000', message: 'Quero {plano}' } },
});

describe('flowFromV1', () => {
  test('gera um grafo válido com ids determinísticos', () => {
    const f = flowFromV1(V1);
    expect(FlowV2Schema.safeParse(f).success).toBe(true);
    expect(f.nodes.map((n) => `${n.id}:${n.type}`)).toEqual([
      'opening:opening',
      'q0:message',
      'q1:message',
      'q2:question',
      'finish:link',
      'end:end',
    ]);
    expect(f.nodes[1]).toMatchObject({ data: { format: 'buttons', saveTo: 'plano', onTyped: 'reask' } });
    expect(f.nodes[2]).toMatchObject({ data: { format: 'quick' } });
    expect(f.nodes[0]).toMatchObject({ data: { mode: 'button', buttonTitle: 'Quero!', disclosure: true } });
    expect(f.edges.map((e) => `${e.source}.${e.sourceHandle}>${e.target}`)).toEqual([
      'q0.o0>q1',
      'q0.o1>q1',
      'q1.o0>q2',
      'q1.o1>q2',
      'q1.o2>q2',
      'q1.o3>q2',
      'q2.next>finish',
      'opening.next>q0',
      'finish.next>end',
    ]);
    // só o aviso do modo botão
    expect(validateFlow(f).map((p) => p.code)).toEqual(['opening_button']);
  });

  test('sem WhatsApp o fim é um nó end com o texto; sem perguntas a abertura liga no fim', () => {
    const cfg = CommentAutomationConfigSchema.parse({ trigger: {}, opening: { text: 'Oi' }, finish: { text: 'Tchau' } });
    const f = flowFromV1(cfg);
    expect(f.nodes.map((n) => n.id)).toEqual(['opening', 'finish']);
    expect(f.nodes[1]).toMatchObject({ type: 'end', data: { text: 'Tchau' } });
    expect(f.edges).toEqual([{ id: 'e-opening-next', source: 'opening', sourceHandle: 'next', target: 'finish' }]);
  });

  test('gatilho, passo e toque', () => {
    expect(triggerFromV1(V1)).toEqual({ mediaIds: ['1801'], keywords: ['plano'], publicReplies: ['Resposta pública'] });
    const f = flowFromV1(V1);
    expect([-1, 0, 2, 3].map((s) => nodeForV1Step(f, s))).toEqual(['opening', 'q0', 'q2', 'finish']);
    expect(tapFromV1(-1, 0)).toEqual({ nodeId: 'opening', handle: 'next' });
    expect(tapFromV1(1, 3)).toEqual({ nodeId: 'q1', handle: 'o3' });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test packages/core/src/domain/automation/flow-from-v1.test.ts`
Expected: FAIL com `Cannot find module './flow-from-v1'`.

- [ ] **Step 3: Implementar**

```ts
import type {
  CommentAutomationConfig,
  CommentTriggerConfig,
  FlowEdge,
  FlowNode,
  FlowV2,
} from '@manypost/contracts';
import { AUTOMATION_LIMITS } from '@manypost/contracts';

/**
 * Conversão v1 (formulário linear) → v2 (grafo), feita na leitura e nunca gravada sozinha (design D4).
 * Os ids são determinísticos para que a execução v1 em andamento ache o nó equivalente:
 * `opening`, `q{i}`, opções `o{j}`, `finish` e, com WhatsApp, `end`.
 */

const STEP_Y = 160;

export function flowFromV1(cfg: CommentAutomationConfig): FlowV2 {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const link = (source: string, sourceHandle: string, target: string) =>
    edges.push({ id: `e-${source}-${sourceHandle}`, source, sourceHandle, target });

  nodes.push({
    id: 'opening',
    type: 'opening',
    position: { x: 0, y: 0 },
    data: {
      text: cfg.opening.text,
      mode: cfg.opening.mode,
      buttonTitle: cfg.opening.buttonTitle,
      disclosure: cfg.disclosure,
    },
  });

  const ids = cfg.questions.map((_, i) => `q${i}`);
  cfg.questions.forEach((q, i) => {
    const id = ids[i]!;
    const next = ids[i + 1] ?? 'finish';
    const position = { x: 0, y: STEP_Y * (i + 1) };
    if (q.kind === 'choice') {
      const options = q.options.map((o, j) => ({ id: `o${j}`, title: o.title }));
      nodes.push({
        id,
        type: 'message',
        position,
        data: {
          text: q.prompt,
          format: options.length <= AUTOMATION_LIMITS.maxButtons ? 'buttons' : 'quick',
          options,
          saveTo: q.field,
          onTyped: 'reask',
        },
      });
      for (const o of options) link(id, o.id, next);
    } else {
      nodes.push({ id, type: 'question', position, data: { text: q.prompt, field: q.field, validate: q.validate } });
      link(id, 'next', next);
    }
  });
  link('opening', 'next', ids[0] ?? 'finish');

  const finishY = STEP_Y * (cfg.questions.length + 1);
  const wa = cfg.finish.whatsapp;
  if (wa) {
    nodes.push({
      id: 'finish',
      type: 'link',
      position: { x: 0, y: finishY },
      data: {
        text: cfg.finish.text,
        buttonTitle: wa.buttonTitle,
        target: { kind: 'whatsapp', phone: wa.phone, message: wa.message },
      },
    });
    nodes.push({ id: 'end', type: 'end', position: { x: 0, y: finishY + STEP_Y }, data: { text: '' } });
    link('finish', 'next', 'end');
  } else {
    nodes.push({ id: 'finish', type: 'end', position: { x: 0, y: finishY }, data: { text: cfg.finish.text } });
  }
  return { version: 2, nodes, edges };
}

export function triggerFromV1(cfg: CommentAutomationConfig): CommentTriggerConfig {
  return { mediaIds: cfg.trigger.mediaIds, keywords: cfg.trigger.keywords, publicReplies: cfg.publicReplies };
}

/**
 * passo da execução v1 (-1 abertura, 0..n-1 pergunta, n fim) → nó equivalente. Recebe o grafo (e
 * não a v1) para funcionar também depois que a automação foi salva no canvas: os ids continuam.
 */
export function nodeForV1Step(flow: FlowV2, step: number): string {
  if (step < 0) return 'opening';
  const id = `q${step}`;
  return flow.nodes.some((n) => n.id === id) ? id : 'finish';
}

/** botão `mp1:<run>:<passo>:<opção>` → (nó, saída) do grafo convertido */
export function tapFromV1(step: number, option: number): { nodeId: string; handle: string } {
  return step < 0 ? { nodeId: 'opening', handle: 'next' } : { nodeId: `q${step}`, handle: `o${option}` };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test packages/core/src/domain/automation/flow-from-v1.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/domain/automation/flow-from-v1.ts packages/core/src/domain/automation/flow-from-v1.test.ts
git commit -m "feat(core): conversão determinística de automação v1 para grafo"
```

---

### Task 4: Passo do fluxo (mensagem, entrada, saída)

**Files:**
- Modify: `packages/core/src/domain/automation/automation-logic.ts`: exporta as constantes do aviso e da dica, e `matchesCommentTrigger`
- Create: `packages/core/src/domain/automation/flow-step.ts`
- Create: `packages/core/src/domain/automation/flow-step.test.ts`

**Interfaces:**
- Consumes: `flow-graph.ts` (Task 2); `normalizeText`, `renderTemplate`, `validateAnswer` (já existem).
- Produces:
  - `OPENING_DISCLOSURE`, `OPENING_TEXT_HINT` (constantes exportadas de `automation-logic.ts`)
  - `matchesCommentTrigger(t: { mediaIds: string[]; keywords: string[] }, c: { mediaId: string; text: string }): boolean`
  - `encodePayloadV2(runId, nodeId, handle): string`
  - `decodePayloadV2(p): { runId; nodeId; handle } | null`
  - `interface StepContext { runId: string; answers: Record<string, string>; username: string | null }`
  - `messageFor(node, ctx): DirectMessage | null`
  - `linkUrl(node: FlowNodeOf<'link'>, ctx): string`
  - `conditionHolds(node: FlowNodeOf<'condition'>, answers): boolean`
  - `type AutoNext = { kind: 'goto'; to: string } | { kind: 'finish' } | { kind: 'dead_end'; handle: string }`
  - `autoNext(flow, node, answers): AutoNext`
  - `type InputDecision = { kind: 'advance'; handle: string; save?: { field: string; value: string } } | { kind: 'reask' } | { kind: 'ignore' }`
  - `decideInput(flow, node, input: { handle: string | null; text: string }, reasks: number): InputDecision`
  - `MAX_REASKS = 1`, `MAX_AUTO_STEPS = 20`
  - `leadWhatsappUrl(flow, ctx): string | null`

- [ ] **Step 1: Escrever os testes**

`packages/core/src/domain/automation/flow-step.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { FlowV2Schema, type FlowNode, type FlowV2Input } from '@manypost/contracts';
import {
  autoNext,
  conditionHolds,
  decideInput,
  decodePayloadV2,
  encodePayloadV2,
  leadWhatsappUrl,
  messageFor,
} from './flow-step';

const P = { x: 0, y: 0 };
const parse = (f: Omit<FlowV2Input, 'version'>) => FlowV2Schema.parse({ version: 2, ...f });
const e = (source: string, sourceHandle: string, target: string) => ({ id: `e-${source}-${sourceHandle}`, source, sourceHandle, target });
const ctx = { runId: 'run-1', answers: { nome: 'Ana' }, username: 'ana.x' };

const FLOW = parse({
  nodes: [
    { id: 'opening', type: 'opening', position: P, data: { text: 'Oi {username}' } },
    {
      id: 'plano',
      type: 'message',
      position: P,
      data: { text: 'Qual plano, {nome}?', options: [{ id: 'pf', title: 'Pessoa física' }, { id: 'pj', title: 'Minha empresa' }], saveTo: 'plano' },
    },
    { id: 'zap', type: 'question', position: P, data: { text: 'WhatsApp?', field: 'zap', validate: 'phone' } },
    { id: 'cond', type: 'condition', position: P, data: { field: 'plano', op: 'equals', value: 'minha empresa' } },
    { id: 'wa', type: 'link', position: P, data: { text: 'Fale', buttonTitle: 'WhatsApp', target: { kind: 'whatsapp', phone: '5592999990000', message: 'Sou {nome} ({plano})' } } },
    { id: 'fim', type: 'end', position: P, data: { text: '' } },
  ],
  edges: [
    e('opening', 'next', 'plano'),
    e('plano', 'pf', 'zap'),
    e('plano', 'pj', 'zap'),
    e('zap', 'next', 'cond'),
    e('cond', 'yes', 'wa'),
    e('cond', 'no', 'fim'),
  ],
});
const node = (id: string) => FLOW.nodes.find((n) => n.id === id) as FlowNode;

describe('payload v2', () => {
  test('ida e volta; formatos inválidos e mp1 não decodificam', () => {
    const p = encodePayloadV2('0198a1b2-0000-7000-8000-000000000001', 'plano', 'pj');
    expect(decodePayloadV2(p)).toEqual({ runId: '0198a1b2-0000-7000-8000-000000000001', nodeId: 'plano', handle: 'pj' });
    expect(decodePayloadV2('mp1:abc:0:1')).toBeNull();
    expect(decodePayloadV2('mp2:abc:Plano!:x')).toBeNull();
    expect(decodePayloadV2(null)).toBeNull();
  });
});

describe('messageFor', () => {
  test('abertura em texto leva a dica e o aviso; em botão leva o payload', () => {
    expect(messageFor(node('opening'), ctx)).toEqual({
      text: 'Oi ana.x\n\nResponda esta mensagem para continuar.\n\nMensagem automática.',
    });
    const button = { ...node('opening'), data: { text: 'Oi', mode: 'button', buttonTitle: 'Quero!', disclosure: false } } as FlowNode;
    expect(messageFor(button, ctx)).toEqual({ text: 'Oi', buttons: [{ title: 'Quero!', payload: 'mp2:run-1:opening:next' }] });
  });

  test('mensagem com botões renderiza campos; quick vira quickReplies; none só texto', () => {
    expect(messageFor(node('plano'), ctx)).toEqual({
      text: 'Qual plano, Ana?',
      buttons: [
        { title: 'Pessoa física', payload: 'mp2:run-1:plano:pf' },
        { title: 'Minha empresa', payload: 'mp2:run-1:plano:pj' },
      ],
    });
    const quick = { ...node('plano'), data: { ...(node('plano') as { data: object }).data, format: 'quick' } } as FlowNode;
    expect(messageFor(quick, ctx)?.quickReplies?.[1]).toEqual({ title: 'Minha empresa', payload: 'mp2:run-1:plano:pj' });
  });

  test('campo ausente vira vazio, nunca chaves cruas', () => {
    expect(messageFor(node('plano'), { ...ctx, answers: {} })?.text).toBe('Qual plano, ?');
  });

  test('link de WhatsApp com mensagem preenchida; condição e fim vazio não enviam', () => {
    expect(messageFor(node('wa'), { ...ctx, answers: { nome: 'Ana', plano: 'Minha empresa' } })).toEqual({
      text: 'Fale',
      buttons: [{ title: 'WhatsApp', url: `https://wa.me/5592999990000?text=${encodeURIComponent('Sou Ana (Minha empresa)')}` }],
    });
    expect(messageFor(node('cond'), ctx)).toBeNull();
    expect(messageFor(node('fim'), ctx)).toBeNull();
  });
});

describe('condição e saída automática', () => {
  test('condição normaliza caixa e acento', () => {
    const c = node('cond') as Extract<FlowNode, { type: 'condition' }>;
    expect(conditionHolds(c, { plano: 'Minha Empresa' })).toBe(true);
    expect(conditionHolds(c, { plano: 'MINHA EMPRESA ' })).toBe(true);
    expect(conditionHolds(c, { plano: 'Pessoa física' })).toBe(false);
    const has = { ...c, data: { field: 'plano', op: 'contains', value: 'saude' } } as typeof c;
    expect(conditionHolds(has, { plano: 'Plano Saúde' })).toBe(true);
    expect(conditionHolds({ ...c, data: { field: 'x', op: 'filled', value: '' } } as typeof c, { x: '  ' })).toBe(false);
    expect(conditionHolds({ ...c, data: { field: 'x', op: 'empty', value: '' } } as typeof c, {})).toBe(true);
  });

  test('autoNext: condição, link com e sem saída, fim', () => {
    expect(autoNext(FLOW, node('cond'), { plano: 'Minha empresa' })).toEqual({ kind: 'goto', to: 'wa' });
    expect(autoNext(FLOW, node('cond'), { plano: 'Pessoa física' })).toEqual({ kind: 'goto', to: 'fim' });
    expect(autoNext(FLOW, node('wa'), {})).toEqual({ kind: 'finish' });
    expect(autoNext(FLOW, node('fim'), {})).toEqual({ kind: 'finish' });
  });

  test('leadWhatsappUrl usa o primeiro link de WhatsApp', () => {
    expect(leadWhatsappUrl(FLOW, ctx)).toBe(`https://wa.me/5592999990000?text=${encodeURIComponent('Sou Ana ()')}`);
  });
});

describe('decideInput', () => {
  const plano = node('plano');
  test('toque ou texto igual ao título avançam e gravam o título', () => {
    expect(decideInput(FLOW, plano, { handle: 'pj', text: '' }, 0)).toEqual({ kind: 'advance', handle: 'pj', save: { field: 'plano', value: 'Minha empresa' } });
    expect(decideInput(FLOW, plano, { handle: null, text: 'pessoa FISICA' }, 0)).toEqual({ kind: 'advance', handle: 'pf', save: { field: 'plano', value: 'Pessoa física' } });
  });

  test('texto fora das opções: re-pergunta uma vez e depois segue pela primeira opção com o texto cru', () => {
    expect(decideInput(FLOW, plano, { handle: null, text: 'sei lá' }, 0)).toEqual({ kind: 'reask' });
    expect(decideInput(FLOW, plano, { handle: null, text: 'sei lá' }, 1)).toEqual({ kind: 'advance', handle: 'pf', save: { field: 'plano', value: 'sei lá' } });
  });

  test('modo branch sai por typed', () => {
    const f = parse({
      nodes: [
        { id: 'opening', type: 'opening', position: P, data: { text: 'Oi' } },
        { id: 'm', type: 'message', position: P, data: { text: 'X', options: [{ id: 'a', title: 'A' }], onTyped: 'branch' } },
        { id: 'fim', type: 'end', position: P, data: {} },
      ],
      edges: [e('opening', 'next', 'm'), e('m', 'a', 'fim'), e('m', 'typed', 'fim')],
    });
    expect(decideInput(f, f.nodes[1]!, { handle: null, text: 'outra coisa' }, 0)).toEqual({ kind: 'advance', handle: 'typed' });
  });

  test('pergunta valida, re-pergunta uma vez e aceita o cru', () => {
    const zap = node('zap');
    expect(decideInput(FLOW, zap, { handle: null, text: '(92) 98888-7777' }, 0)).toEqual({ kind: 'advance', handle: 'next', save: { field: 'zap', value: '92988887777' } });
    expect(decideInput(FLOW, zap, { handle: null, text: 'não sei' }, 0)).toEqual({ kind: 'reask' });
    expect(decideInput(FLOW, zap, { handle: null, text: 'não sei' }, 1)).toEqual({ kind: 'advance', handle: 'next', save: { field: 'zap', value: 'não sei' } });
  });

  test('entrada vazia é ignorada em pergunta e em mensagem; a abertura segue com qualquer coisa', () => {
    expect(decideInput(FLOW, node('zap'), { handle: null, text: '  ' }, 0)).toEqual({ kind: 'ignore' });
    expect(decideInput(FLOW, plano, { handle: null, text: '' }, 0)).toEqual({ kind: 'ignore' });
    expect(decideInput(FLOW, node('opening'), { handle: null, text: '' }, 0)).toEqual({ kind: 'advance', handle: 'next' });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test packages/core/src/domain/automation/flow-step.test.ts`
Expected: FAIL com `Cannot find module './flow-step'`.

- [ ] **Step 3: Exportar as constantes e o casamento de gatilho em `automation-logic.ts`**

Trocar:

```ts
const DISCLOSURE = 'Mensagem automática.';
const TEXT_MODE_HINT = 'Responda esta mensagem para continuar.';
```

por:

```ts
export const OPENING_DISCLOSURE = 'Mensagem automática.';
export const OPENING_TEXT_HINT = 'Responda esta mensagem para continuar.';
const DISCLOSURE = OPENING_DISCLOSURE;
const TEXT_MODE_HINT = OPENING_TEXT_HINT;
```

Trocar o corpo de `matchesTrigger` para delegar a uma função nova:

```ts
/** post na lista (ou lista vazia) e palavra-chave como palavra/frase inteira (ou sem palavras) */
export function matchesTrigger(cfg: CommentAutomationConfig, c: { mediaId: string; text: string }): boolean {
  return matchesCommentTrigger(cfg.trigger, c);
}

/** mesmo casamento, sobre o gatilho da tabela `automation_triggers` (fluxo v2) */
export function matchesCommentTrigger(
  t: { mediaIds: string[]; keywords: string[] },
  c: { mediaId: string; text: string },
): boolean {
  if (t.mediaIds.length > 0 && !t.mediaIds.includes(c.mediaId)) return false;
  if (t.keywords.length === 0) return true;
  const hay = ` ${normalizeText(c.text)} `;
  return t.keywords.some((k) => {
    const n = normalizeText(k);
    return n.length > 0 && hay.includes(` ${n} `);
  });
}
```

- [ ] **Step 4: Escrever `flow-step.ts`**

```ts
import type { DirectMessage, FlowNode, FlowNodeOf, FlowV2 } from '@manypost/contracts';
import {
  OPENING_DISCLOSURE,
  OPENING_TEXT_HINT,
  normalizeText,
  renderTemplate,
  validateAnswer,
} from './automation-logic';
import { targetOf } from './flow-graph';

/**
 * Passo puro do fluxo v2 (design D6/D7): a mensagem de cada nó, a saída automática dos nós que não
 * esperam e a decisão sobre o que a pessoa mandou. O motor faz o I/O; o simulador e as fixtures usam
 * as mesmas funções.
 */

export const MAX_REASKS = 1;
/** defesa contra laço: nós automáticos seguidos num mesmo evento */
export const MAX_AUTO_STEPS = 20;
const PAYLOAD_RE = /^mp2:([A-Za-z0-9-]{1,64}):([a-z0-9_-]{1,24}):([a-z0-9_-]{1,24})$/;

export function encodePayloadV2(runId: string, nodeId: string, handle: string): string {
  return `mp2:${runId}:${nodeId}:${handle}`;
}

export function decodePayloadV2(p: string | null | undefined): { runId: string; nodeId: string; handle: string } | null {
  const m = p ? PAYLOAD_RE.exec(p) : null;
  return m ? { runId: m[1]!, nodeId: m[2]!, handle: m[3]! } : null;
}

export interface StepContext {
  runId: string;
  answers: Record<string, string>;
  username: string | null;
}

export function linkUrl(node: FlowNodeOf<'link'>, ctx: StepContext): string {
  const t = node.data.target;
  if (t.kind === 'url') return t.url;
  const msg = renderTemplate(t.message, ctx.answers, ctx.username).trim();
  return `https://wa.me/${t.phone}${msg ? `?text=${encodeURIComponent(msg)}` : ''}`;
}

/** o que o nó envia ao entrar nele; `null` = nada (condição, fim sem texto) */
export function messageFor(node: FlowNode, ctx: StepContext): DirectMessage | null {
  const r = (t: string) => renderTemplate(t, ctx.answers, ctx.username);
  switch (node.type) {
    case 'opening': {
      const parts = [r(node.data.text)];
      if (node.data.mode === 'text') parts.push(OPENING_TEXT_HINT);
      if (node.data.disclosure) parts.push(OPENING_DISCLOSURE);
      const text = parts.join('\n\n');
      return node.data.mode === 'button'
        ? { text, buttons: [{ title: node.data.buttonTitle, payload: encodePayloadV2(ctx.runId, node.id, 'next') }] }
        : { text };
    }
    case 'message': {
      const text = r(node.data.text);
      if (node.data.format === 'none') return { text };
      const opts = node.data.options.map((o) => ({ title: o.title, payload: encodePayloadV2(ctx.runId, node.id, o.id) }));
      return node.data.format === 'buttons' ? { text, buttons: opts } : { text, quickReplies: opts };
    }
    case 'question':
      return { text: r(node.data.text) };
    case 'condition':
      return null;
    case 'link':
      return { text: r(node.data.text), buttons: [{ title: node.data.buttonTitle, url: linkUrl(node, ctx) }] };
    case 'end':
      return node.data.text.trim() ? { text: r(node.data.text) } : null;
  }
}

export function conditionHolds(node: FlowNodeOf<'condition'>, answers: Record<string, string>): boolean {
  const v = normalizeText(answers[node.data.field] ?? '');
  const want = normalizeText(node.data.value);
  switch (node.data.op) {
    case 'equals':
      return v === want;
    case 'contains':
      return want.length > 0 && v.includes(want);
    case 'filled':
      return v.length > 0;
    case 'empty':
      return v.length === 0;
  }
}

export type AutoNext = { kind: 'goto'; to: string } | { kind: 'finish' } | { kind: 'dead_end'; handle: string };

/** saída dos nós que não esperam resposta */
export function autoNext(flow: FlowV2, node: FlowNode, answers: Record<string, string>): AutoNext {
  const go = (handle: string): AutoNext => {
    const to = targetOf(flow, node.id, handle);
    return to ? { kind: 'goto', to } : { kind: 'dead_end', handle };
  };
  switch (node.type) {
    case 'condition':
      return go(conditionHolds(node, answers) ? 'yes' : 'no');
    case 'link': {
      const to = targetOf(flow, node.id, 'next');
      return to ? { kind: 'goto', to } : { kind: 'finish' };
    }
    case 'end':
      return { kind: 'finish' };
    default:
      return go('next');
  }
}

export type InputDecision =
  | { kind: 'advance'; handle: string; save?: { field: string; value: string } }
  | { kind: 'reask' }
  | { kind: 'ignore' };

/** o que fazer com um toque (`handle`) ou texto no nó em que a execução espera */
export function decideInput(
  flow: FlowV2,
  node: FlowNode,
  input: { handle: string | null; text: string },
  reasks: number,
): InputDecision {
  const text = input.text.trim();
  switch (node.type) {
    case 'opening':
      // qualquer resposta abre a conversa (comportamento da v1)
      return { kind: 'advance', handle: 'next' };
    case 'message': {
      if (node.data.format === 'none') return { kind: 'ignore' };
      const saveTo = node.data.saveTo;
      const save = (value: string) => (saveTo ? { save: { field: saveTo, value } } : {});
      const byHandle = input.handle ? node.data.options.find((o) => o.id === input.handle) : undefined;
      const n = normalizeText(text);
      const opt = byHandle ?? (n ? node.data.options.find((o) => normalizeText(o.title) === n) : undefined);
      if (opt) return { kind: 'advance', handle: opt.id, ...save(opt.title) };
      if (!text) return { kind: 'ignore' };
      const typed = targetOf(flow, node.id, 'typed') ? 'typed' : null;
      if (node.data.onTyped === 'branch' && typed) return { kind: 'advance', handle: typed, ...save(text.slice(0, 200)) };
      if (reasks < MAX_REASKS) return { kind: 'reask' };
      return { kind: 'advance', handle: typed ?? node.data.options[0]!.id, ...save(text.slice(0, 200)) };
    }
    case 'question': {
      if (!text) return { kind: 'ignore' };
      const v = validateAnswer(node.data.validate, text);
      if (v.ok) return { kind: 'advance', handle: 'next', save: { field: node.data.field, value: v.value } };
      if (reasks < MAX_REASKS) return { kind: 'reask' };
      return { kind: 'advance', handle: 'next', save: { field: node.data.field, value: text.slice(0, 500) } };
    }
    default:
      return { kind: 'ignore' };
  }
}

/** `whatsappUrl` do `lead.captured`: o primeiro link de WhatsApp do fluxo, preenchido */
export function leadWhatsappUrl(flow: FlowV2, ctx: StepContext): string | null {
  const n = flow.nodes.find(
    (x): x is FlowNodeOf<'link'> => x.type === 'link' && x.data.target.kind === 'whatsapp',
  );
  return n ? linkUrl(n, ctx) : null;
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `bun test packages/core/src/domain/automation/`
Expected: PASS, incluindo os testes antigos de `automation-logic.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/domain/automation/
git commit -m "feat(core): passo puro do fluxo v2 (mensagens, condição, entrada, payload mp2)"
```

---

### Task 5: Simulação pura, fixtures compartilhadas e sequência dourada da v1

**Files:**
- Create: `packages/core/src/domain/automation/flow-simulate.ts`
- Create: `packages/core/src/domain/automation/flow-fixtures.test.ts`
- Create: `testdata/automation-flows/README.md` e os 9 arquivos `.json` abaixo
- Modify: `packages/core/src/application/use-cases/comment-automation.test.ts` (só acrescenta o `describe('sequência dourada da v1')`)

**Interfaces:**
- Consumes: Tasks 2 e 4.
- Produces:
  - `interface SimInput { tap?: string; text?: string }`
  - `interface SimMessage { text: string; buttons?: string[]; quick?: string[]; urls?: string[] }`
  - `interface SimResult { messages: SimMessage[]; answers: Record<string, string>; status: 'waiting' | 'completed' | 'abandoned' | 'failed'; nodeId: string | null }`
  - `toSimMessage(m: DirectMessage): SimMessage`
  - `simulateFlow(flow, inputs: SimInput[], opts?: { username?: string | null; startAt?: string; answers?: Record<string, string> }): SimResult`
  - Formato da fixture (lido também pela web no Task 10):

    ```
    { name: string, username?: string, flow: FlowV2Input, inputs?: SimInput[],
      expect: { problems?: FlowProblem[], messages?: SimMessage[], status?: string, answers?: Record<string,string> } }
    ```

A sequência dourada é escrita **antes** de reescrever o motor e precisa passar com o motor v1 de hoje. No Task 7 ela tem de continuar passando sem mudança. É a prova de equivalência pedida na spec.

- [ ] **Step 1: Escrever o teste das fixtures**

`packages/core/src/domain/automation/flow-fixtures.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { FlowV2Schema } from '@manypost/contracts';
import { simulateFlow, type SimInput } from './flow-simulate';
import { validateFlow } from './flow-validate';

/** fixtures compartilhadas com a web (apps/web/src/features/automation/flow/logic.test.ts) */
const DIR = new URL('../../../../../testdata/automation-flows/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

describe('fixtures de fluxo', () => {
  test('existem fixtures', () => expect(files.length).toBeGreaterThanOrEqual(9));
  for (const file of files) {
    const fx = JSON.parse(readFileSync(new URL(file, DIR), 'utf8')) as {
      name: string;
      username?: string;
      flow: unknown;
      inputs?: SimInput[];
      expect: { problems?: unknown[]; messages?: unknown[]; status?: string; answers?: Record<string, string> };
    };
    test(`${file}: ${fx.name}`, () => {
      const flow = FlowV2Schema.parse(fx.flow);
      expect(validateFlow(flow)).toEqual((fx.expect.problems ?? []) as ReturnType<typeof validateFlow>);
      if (fx.expect.messages) {
        const r = simulateFlow(flow, fx.inputs ?? [], { username: fx.username ?? null });
        expect(r.messages).toEqual(fx.expect.messages as typeof r.messages);
        expect(r.status).toBe(fx.expect.status as typeof r.status);
        if (fx.expect.answers) expect(r.answers).toEqual(fx.expect.answers);
      }
    });
  }
});
```

- [ ] **Step 2: Criar as fixtures**

`testdata/automation-flows/README.md`:

```md
# Fixtures de fluxo de automação

Lidas por `packages/core/src/domain/automation/flow-fixtures.test.ts` e por
`apps/web/src/features/automation/flow/logic.test.ts`. As duas implementações precisam produzir
exatamente os mesmos problemas e mensagens. Mensagens são normalizadas: só texto, títulos de botões,
títulos de respostas rápidas e URLs (nunca payloads). Textos são fictícios.
```

A abertura padrão de todas as fixtures é `{"id":"opening","type":"opening","position":{"x":0,"y":0},"data":{"text":"Olá!"}}`. A mensagem esperada dela é:

`{"text":"Olá!\n\nResponda esta mensagem para continuar.\n\nMensagem automática."}`.

`testdata/automation-flows/01-linear-v1.json`:

```json
{
  "name": "linear no formato da v1: abertura, escolha, telefone com re-pergunta, WhatsApp",
  "flow": {
    "version": 2,
    "nodes": [
      { "id": "opening", "type": "opening", "position": { "x": 0, "y": 0 }, "data": { "text": "Olá!" } },
      { "id": "q0", "type": "message", "position": { "x": 0, "y": 160 }, "data": { "text": "Qual plano?", "format": "buttons", "options": [{ "id": "o0", "title": "Saúde" }, { "id": "o1", "title": "Vida" }], "saveTo": "plano" } },
      { "id": "q1", "type": "question", "position": { "x": 0, "y": 320 }, "data": { "text": "Seu WhatsApp?", "field": "whatsapp", "validate": "phone" } },
      { "id": "finish", "type": "link", "position": { "x": 0, "y": 480 }, "data": { "text": "Valeu, {plano}!", "buttonTitle": "Falar no WhatsApp", "target": { "kind": "whatsapp", "phone": "5592999990000", "message": "Quero {plano}" } } },
      { "id": "end", "type": "end", "position": { "x": 0, "y": 640 }, "data": { "text": "" } }
    ],
    "edges": [
      { "id": "e1", "source": "opening", "sourceHandle": "next", "target": "q0" },
      { "id": "e2", "source": "q0", "sourceHandle": "o0", "target": "q1" },
      { "id": "e3", "source": "q0", "sourceHandle": "o1", "target": "q1" },
      { "id": "e4", "source": "q1", "sourceHandle": "next", "target": "finish" },
      { "id": "e5", "source": "finish", "sourceHandle": "next", "target": "end" }
    ]
  },
  "inputs": [{ "text": "oi" }, { "tap": "o1" }, { "text": "não sei" }, { "text": "(92) 98888-7777" }],
  "expect": {
    "messages": [
      { "text": "Olá!\n\nResponda esta mensagem para continuar.\n\nMensagem automática." },
      { "text": "Qual plano?", "buttons": ["Saúde", "Vida"] },
      { "text": "Seu WhatsApp?" },
      { "text": "Seu WhatsApp?" },
      { "text": "Valeu, Vida!", "buttons": ["Falar no WhatsApp"], "urls": ["https://wa.me/5592999990000?text=Quero%20Vida"] }
    ],
    "status": "completed",
    "answers": { "plano": "Vida", "whatsapp": "92988887777" }
  }
}
```

`testdata/automation-flows/02-branch-by-button.json`:

```json
{
  "name": "cada botão leva a um caminho",
  "flow": {
    "version": 2,
    "nodes": [
      { "id": "opening", "type": "opening", "position": { "x": 0, "y": 0 }, "data": { "text": "Olá!" } },
      { "id": "tipo", "type": "message", "position": { "x": 0, "y": 160 }, "data": { "text": "Para quem é o plano?", "options": [{ "id": "pf", "title": "Pessoa física" }, { "id": "pj", "title": "Minha empresa" }], "saveTo": "tipo" } },
      { "id": "fimpf", "type": "end", "position": { "x": -200, "y": 320 }, "data": { "text": "Plano individual" } },
      { "id": "vidas", "type": "question", "position": { "x": 200, "y": 320 }, "data": { "text": "Quantas vidas?", "field": "vidas", "validate": "free" } },
      { "id": "fimpj", "type": "end", "position": { "x": 200, "y": 480 }, "data": { "text": "Plano empresarial para {vidas} vidas" } }
    ],
    "edges": [
      { "id": "e1", "source": "opening", "sourceHandle": "next", "target": "tipo" },
      { "id": "e2", "source": "tipo", "sourceHandle": "pf", "target": "fimpf" },
      { "id": "e3", "source": "tipo", "sourceHandle": "pj", "target": "vidas" },
      { "id": "e4", "source": "vidas", "sourceHandle": "next", "target": "fimpj" }
    ]
  },
  "inputs": [{ "text": "oi" }, { "tap": "pj" }, { "text": "12" }],
  "expect": {
    "messages": [
      { "text": "Olá!\n\nResponda esta mensagem para continuar.\n\nMensagem automática." },
      { "text": "Para quem é o plano?", "buttons": ["Pessoa física", "Minha empresa"] },
      { "text": "Quantas vidas?" },
      { "text": "Plano empresarial para 12 vidas" }
    ],
    "status": "completed",
    "answers": { "tipo": "Minha empresa", "vidas": "12" }
  }
}
```

`testdata/automation-flows/03-chained-messages.json`:

```json
{
  "name": "mensagens sem botão saem em sequência até o próximo passo que espera",
  "flow": {
    "version": 2,
    "nodes": [
      { "id": "opening", "type": "opening", "position": { "x": 0, "y": 0 }, "data": { "text": "Olá!" } },
      { "id": "a1", "type": "message", "position": { "x": 0, "y": 160 }, "data": { "text": "Primeiro aviso.", "format": "none" } },
      { "id": "a2", "type": "message", "position": { "x": 0, "y": 320 }, "data": { "text": "Segundo aviso.", "format": "none" } },
      { "id": "nome", "type": "question", "position": { "x": 0, "y": 480 }, "data": { "text": "Qual é o seu nome?", "field": "nome", "validate": "name" } },
      { "id": "fim", "type": "end", "position": { "x": 0, "y": 640 }, "data": { "text": "Obrigado, {nome}!" } }
    ],
    "edges": [
      { "id": "e1", "source": "opening", "sourceHandle": "next", "target": "a1" },
      { "id": "e2", "source": "a1", "sourceHandle": "next", "target": "a2" },
      { "id": "e3", "source": "a2", "sourceHandle": "next", "target": "nome" },
      { "id": "e4", "source": "nome", "sourceHandle": "next", "target": "fim" }
    ]
  },
  "inputs": [{ "text": "oi" }, { "text": "Ana" }],
  "expect": {
    "messages": [
      { "text": "Olá!\n\nResponda esta mensagem para continuar.\n\nMensagem automática." },
      { "text": "Primeiro aviso." },
      { "text": "Segundo aviso." },
      { "text": "Qual é o seu nome?" },
      { "text": "Obrigado, Ana!" }
    ],
    "status": "completed",
    "answers": { "nome": "Ana" }
  }
}
```

`testdata/automation-flows/04-condition.json`:

```json
{
  "name": "condição compara sem caixa nem acento; texto igual ao título vale como toque",
  "flow": {
    "version": 2,
    "nodes": [
      { "id": "opening", "type": "opening", "position": { "x": 0, "y": 0 }, "data": { "text": "Olá!" } },
      { "id": "m", "type": "message", "position": { "x": 0, "y": 160 }, "data": { "text": "Para quem?", "options": [{ "id": "pf", "title": "Pessoa física" }, { "id": "pj", "title": "Minha Empresa" }], "saveTo": "plano" } },
      { "id": "c", "type": "condition", "position": { "x": 0, "y": 320 }, "data": { "field": "plano", "op": "equals", "value": "minha empresa" } },
      { "id": "a", "type": "end", "position": { "x": -200, "y": 480 }, "data": { "text": "Caminho empresa" } },
      { "id": "b", "type": "end", "position": { "x": 200, "y": 480 }, "data": { "text": "Caminho pessoa" } }
    ],
    "edges": [
      { "id": "e1", "source": "opening", "sourceHandle": "next", "target": "m" },
      { "id": "e2", "source": "m", "sourceHandle": "pf", "target": "c" },
      { "id": "e3", "source": "m", "sourceHandle": "pj", "target": "c" },
      { "id": "e4", "source": "c", "sourceHandle": "yes", "target": "a" },
      { "id": "e5", "source": "c", "sourceHandle": "no", "target": "b" }
    ]
  },
  "inputs": [{ "text": "oi" }, { "text": "MINHA EMPRESA" }],
  "expect": {
    "messages": [
      { "text": "Olá!\n\nResponda esta mensagem para continuar.\n\nMensagem automática." },
      { "text": "Para quem?", "buttons": ["Pessoa física", "Minha Empresa"] },
      { "text": "Caminho empresa" }
    ],
    "status": "completed",
    "answers": { "plano": "Minha Empresa" }
  }
}
```

`testdata/automation-flows/05-follow-after-whatsapp.json`:

```json
{
  "name": "pedir para seguir depois do WhatsApp não espera resposta e fecha o lead",
  "flow": {
    "version": 2,
    "nodes": [
      { "id": "opening", "type": "opening", "position": { "x": 0, "y": 0 }, "data": { "text": "Olá!" } },
      { "id": "nome", "type": "question", "position": { "x": 0, "y": 160 }, "data": { "text": "Qual é o seu nome?", "field": "nome", "validate": "name" } },
      { "id": "wa", "type": "link", "position": { "x": 0, "y": 320 }, "data": { "text": "Fale com a gente, {nome}", "buttonTitle": "WhatsApp", "target": { "kind": "whatsapp", "phone": "5592999990000", "message": "Sou {nome}" } } },
      { "id": "seguir", "type": "link", "position": { "x": 0, "y": 480 }, "data": { "text": "Segue a gente para mais dicas", "buttonTitle": "Seguir", "target": { "kind": "url", "url": "https://instagram.com/sua.conta" } } }
    ],
    "edges": [
      { "id": "e1", "source": "opening", "sourceHandle": "next", "target": "nome" },
      { "id": "e2", "source": "nome", "sourceHandle": "next", "target": "wa" },
      { "id": "e3", "source": "wa", "sourceHandle": "next", "target": "seguir" }
    ]
  },
  "inputs": [{ "text": "oi" }, { "text": "Ana" }],
  "expect": {
    "messages": [
      { "text": "Olá!\n\nResponda esta mensagem para continuar.\n\nMensagem automática." },
      { "text": "Qual é o seu nome?" },
      { "text": "Fale com a gente, Ana", "buttons": ["WhatsApp"], "urls": ["https://wa.me/5592999990000?text=Sou%20Ana"] },
      { "text": "Segue a gente para mais dicas", "buttons": ["Seguir"], "urls": ["https://instagram.com/sua.conta"] }
    ],
    "status": "completed",
    "answers": { "nome": "Ana" }
  }
}
```

`testdata/automation-flows/06-typed-branch.json`:

```json
{
  "name": "texto fora das opções sai por 'digitou outra coisa' no modo branch",
  "flow": {
    "version": 2,
    "nodes": [
      { "id": "opening", "type": "opening", "position": { "x": 0, "y": 0 }, "data": { "text": "Olá!" } },
      { "id": "m", "type": "message", "position": { "x": 0, "y": 160 }, "data": { "text": "Como posso ajudar?", "options": [{ "id": "cot", "title": "Cotação" }], "saveTo": "assunto", "onTyped": "branch" } },
      { "id": "x", "type": "end", "position": { "x": -200, "y": 320 }, "data": { "text": "Vamos cotar" } },
      { "id": "y", "type": "end", "position": { "x": 200, "y": 320 }, "data": { "text": "Recebi: {assunto}" } }
    ],
    "edges": [
      { "id": "e1", "source": "opening", "sourceHandle": "next", "target": "m" },
      { "id": "e2", "source": "m", "sourceHandle": "cot", "target": "x" },
      { "id": "e3", "source": "m", "sourceHandle": "typed", "target": "y" }
    ]
  },
  "inputs": [{ "text": "oi" }, { "text": "quero falar de sinistro" }],
  "expect": {
    "messages": [
      { "text": "Olá!\n\nResponda esta mensagem para continuar.\n\nMensagem automática." },
      { "text": "Como posso ajudar?", "buttons": ["Cotação"] },
      { "text": "Recebi: quero falar de sinistro" }
    ],
    "status": "completed",
    "answers": { "assunto": "quero falar de sinistro" }
  }
}
```

`testdata/automation-flows/07-problem-wait-free-cycle.json`:

```json
{
  "name": "laço que só passa por nós automáticos é erro",
  "flow": {
    "version": 2,
    "nodes": [
      { "id": "opening", "type": "opening", "position": { "x": 0, "y": 0 }, "data": { "text": "Olá!" } },
      { "id": "q", "type": "question", "position": { "x": 0, "y": 160 }, "data": { "text": "Nome?", "field": "nome", "validate": "name" } },
      { "id": "i", "type": "message", "position": { "x": 0, "y": 320 }, "data": { "text": "Info", "format": "none" } },
      { "id": "c", "type": "condition", "position": { "x": 0, "y": 480 }, "data": { "field": "nome", "op": "filled" } },
      { "id": "fim", "type": "end", "position": { "x": 0, "y": 640 }, "data": {} }
    ],
    "edges": [
      { "id": "e1", "source": "opening", "sourceHandle": "next", "target": "q" },
      { "id": "e2", "source": "q", "sourceHandle": "next", "target": "i" },
      { "id": "e3", "source": "i", "sourceHandle": "next", "target": "c" },
      { "id": "e4", "source": "c", "sourceHandle": "yes", "target": "fim" },
      { "id": "e5", "source": "c", "sourceHandle": "no", "target": "i" }
    ]
  },
  "expect": { "problems": [{ "code": "wait_free_cycle", "severity": "error", "nodeId": "i" }] }
}
```

`testdata/automation-flows/08-problem-structure.json`:

```json
{
  "name": "nó solto, botão sem ligação e abertura com botão",
  "flow": {
    "version": 2,
    "nodes": [
      { "id": "opening", "type": "opening", "position": { "x": 0, "y": 0 }, "data": { "text": "Olá!", "mode": "button" } },
      { "id": "m", "type": "message", "position": { "x": 0, "y": 160 }, "data": { "text": "Qual?", "options": [{ "id": "a", "title": "A" }, { "id": "b", "title": "B" }] } },
      { "id": "fim", "type": "end", "position": { "x": 0, "y": 320 }, "data": {} },
      { "id": "solto", "type": "end", "position": { "x": 300, "y": 320 }, "data": {} }
    ],
    "edges": [
      { "id": "e1", "source": "opening", "sourceHandle": "next", "target": "m" },
      { "id": "e2", "source": "m", "sourceHandle": "a", "target": "fim" }
    ]
  },
  "expect": {
    "problems": [
      { "code": "unreachable", "severity": "error", "nodeId": "solto" },
      { "code": "missing_edge", "severity": "error", "nodeId": "m", "handle": "b" },
      { "code": "opening_button", "severity": "warning", "nodeId": "opening" }
    ]
  }
}
```

`testdata/automation-flows/09-template-missing-field.json`:

```json
{
  "name": "campo ainda não respondido vira vazio, nunca chaves cruas",
  "flow": {
    "version": 2,
    "nodes": [
      { "id": "opening", "type": "opening", "position": { "x": 0, "y": 0 }, "data": { "text": "Olá!" } },
      { "id": "m", "type": "message", "position": { "x": 0, "y": 160 }, "data": { "text": "Oi {nome}, tudo bem?", "format": "none" } },
      { "id": "q", "type": "question", "position": { "x": 0, "y": 320 }, "data": { "text": "Nome?", "field": "nome", "validate": "name" } },
      { "id": "fim", "type": "end", "position": { "x": 0, "y": 480 }, "data": {} }
    ],
    "edges": [
      { "id": "e1", "source": "opening", "sourceHandle": "next", "target": "m" },
      { "id": "e2", "source": "m", "sourceHandle": "next", "target": "q" },
      { "id": "e3", "source": "q", "sourceHandle": "next", "target": "fim" }
    ]
  },
  "inputs": [{ "text": "oi" }],
  "expect": {
    "messages": [
      { "text": "Olá!\n\nResponda esta mensagem para continuar.\n\nMensagem automática." },
      { "text": "Oi , tudo bem?" },
      { "text": "Nome?" }
    ],
    "status": "waiting"
  }
}
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `bun test packages/core/src/domain/automation/flow-fixtures.test.ts`
Expected: FAIL com `Cannot find module './flow-simulate'`.

- [ ] **Step 4: Implementar `flow-simulate.ts`**

```ts
import type { DirectMessage, FlowV2 } from '@manypost/contracts';
import { nodeById, openingOf, targetOf, waits } from './flow-graph';
import { MAX_AUTO_STEPS, autoNext, decideInput, messageFor } from './flow-step';

/**
 * Percurso puro do fluxo, sem I/O (design D8/D9): é o mesmo caminho que o motor faz, com as mesmas
 * funções de passo. Serve às fixtures compartilhadas com a web e a testes de fluxo.
 */

export interface SimInput {
  /** saída tocada (id da opção ou `next`) */
  tap?: string;
  text?: string;
}

export interface SimMessage {
  text: string;
  buttons?: string[];
  quick?: string[];
  urls?: string[];
}

export interface SimResult {
  messages: SimMessage[];
  answers: Record<string, string>;
  status: 'waiting' | 'completed' | 'abandoned' | 'failed';
  nodeId: string | null;
}

/** mensagem sem payload, para comparar entre implementações */
export function toSimMessage(m: DirectMessage): SimMessage {
  const out: SimMessage = { text: m.text };
  if (m.buttons?.length) {
    out.buttons = m.buttons.map((b) => b.title);
    const urls = m.buttons.flatMap((b) => (b.url ? [b.url] : []));
    if (urls.length) out.urls = urls;
  }
  if (m.quickReplies?.length) out.quick = m.quickReplies.map((q) => q.title);
  return out;
}

export function simulateFlow(
  flow: FlowV2,
  inputs: SimInput[],
  opts: { username?: string | null; startAt?: string; answers?: Record<string, string> } = {},
): SimResult {
  let answers = { ...(opts.answers ?? {}) };
  let nodeId: string | null = opts.startAt ?? openingOf(flow).id;
  let reasks = 0;
  let pending = true;
  let status: SimResult['status'] = 'waiting';
  const messages: SimMessage[] = [];
  const ctx = () => ({ runId: 'sim', answers, username: opts.username ?? null });

  const drive = () => {
    for (let i = 0; i <= MAX_AUTO_STEPS; i++) {
      const node = nodeById(flow, nodeId);
      if (!node) {
        status = 'abandoned';
        return;
      }
      if (pending) {
        const m = messageFor(node, ctx());
        if (m) messages.push(toSimMessage(m));
        pending = false;
      }
      if (waits(node)) return;
      const nx = autoNext(flow, node, answers);
      if (nx.kind === 'finish') {
        status = 'completed';
        return;
      }
      if (nx.kind === 'dead_end') {
        status = 'abandoned';
        return;
      }
      nodeId = nx.to;
      reasks = 0;
      pending = true;
    }
    status = 'failed';
  };

  drive();
  for (const input of inputs) {
    if (status !== 'waiting') break;
    const node = nodeById(flow, nodeId)!;
    const d = decideInput(flow, node, { handle: input.tap ?? null, text: input.text ?? '' }, reasks);
    if (d.kind === 'ignore') continue;
    if (d.kind === 'reask') {
      reasks++;
      pending = true;
      drive();
      continue;
    }
    if (d.save) answers = { ...answers, [d.save.field]: d.save.value };
    const to = targetOf(flow, node.id, d.handle);
    if (!to) {
      status = 'abandoned';
      break;
    }
    nodeId = to;
    reasks = 0;
    pending = true;
    drive();
  }
  return { messages, answers, status, nodeId };
}
```

- [ ] **Step 5: Rodar as fixtures**

Run: `bun test packages/core/src/domain/automation/flow-fixtures.test.ts`
Expected: PASS nas 9 fixtures. Se uma fixture falhar, compare a diferença com a regra do design antes de mudar qualquer coisa. A fixture é a especificação; só corrija a fixture se ela contrariar o design. Nesse caso, anote no commit o motivo.

- [ ] **Step 6: Escrever a sequência dourada da v1 (contra o motor atual)**

Acrescentar ao fim de `packages/core/src/application/use-cases/comment-automation.test.ts`:

```ts
describe('sequência dourada da v1 (equivalência v1 × grafo convertido)', () => {
  /** mensagem sem payload/chave: o que a pessoa vê */
  const visto = (s: Sent) => ({
    op: s.op,
    text: s.msg?.text ?? s.text,
    buttons: s.msg?.buttons?.map((b) => b.title + (b.url ? ` → ${b.url}` : '')) ?? [],
    quick: s.msg?.quickReplies?.map((q) => q.title) ?? [],
  });
  /** toca o botão pelo título usando o payload que a própria mensagem levou (mp1 hoje, mp2 depois) */
  const tocar = (h: ReturnType<typeof harness>, title: string) => {
    for (const s of [...h.sent].reverse()) {
      const all = [...(s.msg?.buttons ?? []), ...(s.msg?.quickReplies ?? [])] as Array<{ title: string; payload?: string }>;
      const b = all.find((x) => x.title === title && x.payload);
      if (b) return h.message({ payload: b.payload!, text: title });
    }
    throw new Error(`botão ${title} não encontrado`);
  };

  test('toque, opção, telefone inválido, telefone e fim', async () => {
    const h = harness();
    await h.seedAutomation();
    await h.deliver(h.comment());
    await h.deliver(tocar(h, 'Quero!'));
    await h.deliver(tocar(h, 'Vida'));
    await h.deliver(h.message({ text: 'não sei' }));
    await h.deliver(h.message({ text: '(92) 98888-7777' }));
    expect(h.sent.map(visto)).toEqual([
      { op: 'public', text: 'Te chamei no direct!', buttons: [], quick: [] },
      { op: 'private', text: 'Oi! Toque abaixo.\n\nMensagem automática.', buttons: ['Quero!'], quick: [] },
      { op: 'send', text: 'Qual plano?', buttons: ['Saúde', 'Vida'], quick: [] },
      { op: 'send', text: 'Seu WhatsApp?', buttons: [], quick: [] },
      { op: 'send', text: 'Seu WhatsApp?', buttons: [], quick: [] },
      {
        op: 'send',
        text: 'Valeu!',
        buttons: [`Falar no WhatsApp → https://wa.me/5592999990000?text=${encodeURIComponent('Quero Vida')}`],
        quick: [],
      },
    ]);
    expect(h.runs[0]).toMatchObject({ status: 'COMPLETED', answers: { plano: 'Vida', whatsapp: '92988887777' } });
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]!.data.whatsappUrl).toBe(`https://wa.me/5592999990000?text=${encodeURIComponent('Quero Vida')}`);
  });

  test('opção digitada e texto inválido duas vezes na escolha', async () => {
    const h = harness();
    await h.seedAutomation();
    await h.deliver(h.comment());
    await h.deliver(tocar(h, 'Quero!'));
    await h.deliver(h.message({ text: 'sei lá' }));
    await h.deliver(h.message({ text: 'talvez' }));
    expect(h.sent.slice(2).map(visto)).toEqual([
      { op: 'send', text: 'Qual plano?', buttons: ['Saúde', 'Vida'], quick: [] },
      { op: 'send', text: 'Qual plano?', buttons: ['Saúde', 'Vida'], quick: [] },
      { op: 'send', text: 'Seu WhatsApp?', buttons: [], quick: [] },
    ]);
    expect(h.runs[0]!.answers).toEqual({ plano: 'talvez' });
  });
});
```

- [ ] **Step 7: Rodar a sequência dourada contra o motor v1 atual**

Run: `bun test packages/core/src/application/use-cases/comment-automation.test.ts`
Expected: PASS em todos os testes, inclusive os 2 dourados. Se algum dourado falhar agora, a expectativa está errada: ela descreve o comportamento **atual**. Ajuste a expectativa ao que a v1 faz hoje e registre no commit.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/domain/automation/flow-simulate.ts packages/core/src/domain/automation/flow-fixtures.test.ts testdata/automation-flows packages/core/src/application/use-cases/comment-automation.test.ts
git commit -m "test(core): fixtures de fluxo compartilhadas e sequência dourada da v1"
```

---

### Task 6: Banco: gatilhos e cursor de nó

**Files:**
- Modify: `packages/db/src/schema/automation.ts`
- Generate: `packages/db/migrations/0012_flow-builder.sql` (drizzle-kit)
- Generate: `packages/db/migrations/0013_flow-builder-backfill.sql` (`--custom`; o SQL é escrito por nós)
- Modify: `packages/core/src/application/ports/automation.ts`
- Modify: `packages/db/src/repositories/automation.repo.ts`
- Modify: `packages/db/src/repositories/automation.repo.integration.test.ts`
- Modify: `packages/core/src/application/use-cases/comment-automation.test.ts`: o `memRepo` passa a implementar as funções novas da porta, para o typecheck continuar verde

**Interfaces:**
- Produces (porta, `packages/core/src/application/ports/automation.ts`):

```ts
export interface AutomationTriggerInput {
  kind: 'comment';
  config: unknown;
  position: { x: number; y: number } | null;
}
export interface AutomationTriggerRecord extends AutomationTriggerInput {
  id: string;
  orgId: string;
  automationId: string;
  channelId: string;
  createdAt: Date;
}
// AutomationRunRecord ganha: nodeId: string | null; cursor: number; sentCursor: number;
// AutomationRunPatch passa a aceitar 'nodeId' | 'cursor' | 'sentCursor'
// AutomationRepository:
//   create(d: { ...; triggers?: AutomationTriggerInput[] }): Promise<AutomationRecord>
//   update(orgId, id, patch, triggers?: AutomationTriggerInput[]): Promise<AutomationRecord | null>
//   listTriggers(automationIds: string[]): Promise<AutomationTriggerRecord[]>
```

- [ ] **Step 1: Subir um Postgres de teste local** (se ainda não houver)

```bash
docker run -d --name mp-test-pg -e POSTGRES_USER=mp -e POSTGRES_PASSWORD=mp -e POSTGRES_DB=mp -p 5599:5432 postgres:16
export TEST_DATABASE_URL=postgresql://mp:mp@localhost:5599/mp
```

- [ ] **Step 2: Escrever os testes de integração novos**

Acrescentar dentro do `describe('automação com PostgreSQL real', ...)` de `automation.repo.integration.test.ts`:

```ts
  pgTest('gatilhos gravados com a automação e substituídos no update', async () => {
    const s = await seed(`${Date.now()}g`);
    const trig = { kind: 'comment' as const, config: { mediaIds: [], keywords: ['plano'], publicReplies: [] }, position: { x: -240, y: 0 } };
    const a = await repo().create({
      orgId: s.orgId,
      channelId: s.channelId,
      name: 'Com gatilho',
      status: 'DRAFT',
      config: { version: 2 },
      testUsernames: [],
      createdBy: null,
      triggers: [trig],
    });
    const t1 = await repo().listTriggers([a.id]);
    expect(t1).toHaveLength(1);
    expect(t1[0]).toMatchObject({ automationId: a.id, orgId: s.orgId, channelId: s.channelId, kind: 'comment', position: { x: -240, y: 0 } });
    await repo().update(s.orgId, a.id, { name: 'Renomeada' }, [{ ...trig, config: { mediaIds: [], keywords: ['cotação'], publicReplies: [] } }]);
    const t2 = await repo().listTriggers([a.id]);
    expect(t2).toHaveLength(1);
    expect((t2[0]!.config as { keywords: string[] }).keywords).toEqual(['cotação']);
    // update sem lista não mexe nos gatilhos; de outra org não grava nada
    await repo().update(s.orgId, a.id, { name: 'De novo' });
    expect(await repo().listTriggers([a.id])).toHaveLength(1);
    const outra = await seed(`${Date.now()}h`);
    expect(await repo().update(outra.orgId, a.id, { name: 'x' }, [])).toBeNull();
    expect(await repo().listTriggers([a.id])).toHaveLength(1);
  });

  pgTest('execução nasce sem nó, cursor 0 e enviado -1; o patch grava o cursor', async () => {
    const s = await seed(`${Date.now()}i`);
    const { run: r } = await repo().createRun(run(s, 'c-9'));
    expect(r).toMatchObject({ nodeId: null, cursor: 0, sentCursor: -1 });
    const u = await repo().updateRun(r.id, { nodeId: 'q0', cursor: 1, sentCursor: 1, status: 'ABANDONED' });
    expect(u).toMatchObject({ nodeId: 'q0', cursor: 1, sentCursor: 1, status: 'ABANDONED' });
  });

  pgTest('backfill cria um gatilho por automação v1 e é idempotente', async () => {
    const s = await seed(`${Date.now()}j`);
    await repo().update(s.orgId, s.automation.id, {
      config: { version: 1, trigger: { mediaIds: ['1801'], keywords: ['plano'] }, publicReplies: ['Oi'] },
    });
    const sql = await Bun.file(new URL('../../migrations/0013_flow-builder-backfill.sql', import.meta.url)).text();
    await client!.unsafe(sql);
    await client!.unsafe(sql);
    const t = await repo().listTriggers([s.automation.id]);
    expect(t).toHaveLength(1);
    expect(t[0]!.config).toEqual({ mediaIds: ['1801'], keywords: ['plano'], publicReplies: ['Oi'] });
  });
```

- [ ] **Step 3: Alterar a porta**

Em `packages/core/src/application/ports/automation.ts`:

1. Acrescentar as interfaces `AutomationTriggerInput` e `AutomationTriggerRecord` do bloco **Interfaces** acima, logo depois de `AutomationRecord`.
2. Em `AutomationRunRecord`, depois de `conversationId`:

   ```ts
     /** nó atual do fluxo v2; `null` = execução v1 ainda não adotada ou resposta privada pendente */
     nodeId: string | null;
     /** conta as entradas em nó (chave de idempotência do envio) */
     cursor: number;
     /** último cursor cuja mensagem foi confirmada */
     sentCursor: number;
   ```

3. Em `AutomationRunPatch`, acrescentar `| 'nodeId' | 'cursor' | 'sentCursor'` à lista do `Pick`.
4. Em `AutomationRepository`:
   - acrescentar `triggers?: AutomationTriggerInput[];` ao parâmetro de `create`;
   - mudar `update` para `update(orgId: string, id: string, patch: Partial<Pick<AutomationRecord, 'name' | 'status' | 'config' | 'testUsernames'>>, triggers?: AutomationTriggerInput[]): Promise<AutomationRecord | null>;`
   - acrescentar:

     ```ts
     /** gatilhos das automações, mais antigos primeiro */
     listTriggers(automationIds: string[]): Promise<AutomationTriggerRecord[]>;
     ```

- [ ] **Step 4: Alterar o schema**

Em `packages/db/src/schema/automation.ts`, em `automationRuns`, depois de `conversationId`:

```ts
    /** nó atual do fluxo v2 (openspec add-flow-builder-canvas, design D5) */
    nodeId: text('node_id'),
    /** entradas em nó: compõe a Idempotency-Key `<run>:c<cursor>:<reasks>` */
    cursor: integer('cursor').notNull().default(0),
    /** último cursor cuja mensagem a ponte confirmou */
    sentCursor: integer('sent_cursor').notNull().default(-1),
```

e atualizar o comentário do status: `/** OPEN | COMPLETED | FAILED | UNCERTAIN | SKIPPED | ABANDONED */`.

Depois de `automationRuns`, criar:

```ts
/** gatilhos de uma automação (fluxo 1 → N gatilhos); hoje só `comment` (design D3) */
export const automationTriggers = pgTable(
  'automation_triggers',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id),
    automationId: uuid('automation_id')
      .notNull()
      .references(() => commentAutomations.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    /** comment (entrega 1); dm_keyword, story_reply… nas próximas */
    kind: text('kind').notNull(),
    config: jsonb('config').notNull(),
    /** posição do balão ⚡ no canvas */
    position: jsonb('position'),
    ...timestamps,
  },
  (t) => [
    index('automation_triggers_channel_kind_ix').on(t.channelId, t.kind),
    index('automation_triggers_automation_ix').on(t.automationId),
  ],
);
```

- [ ] **Step 5: Gerar as migrations**

```bash
cd packages/db
bunx drizzle-kit generate --name flow-builder
bunx drizzle-kit generate --custom --name flow-builder-backfill
cd ../..
```

Conferir `0012_flow-builder.sql`: só `CREATE TABLE "automation_triggers"`, as FKs, os índices e três `ALTER TABLE "automation_runs" ADD COLUMN`. Se aparecer qualquer `DROP` ou `ALTER` em outra tabela, **pare**: o schema divergiu da migration 0011.

Escrever o conteúdo de `0013_flow-builder-backfill.sql` (o arquivo gerado vem vazio):

```sql
-- Um gatilho `comment` por automação v1 que ainda não tem gatilho (openspec add-flow-builder-canvas).
-- Idempotente: rodar de novo não duplica. Não altera `comment_automations`.
INSERT INTO "automation_triggers" ("id", "org_id", "automation_id", "channel_id", "kind", "config", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  a."org_id",
  a."id",
  a."channel_id",
  'comment',
  jsonb_build_object(
    'mediaIds', COALESCE(a."config"->'trigger'->'mediaIds', '[]'::jsonb),
    'keywords', COALESCE(a."config"->'trigger'->'keywords', '[]'::jsonb),
    'publicReplies', COALESCE(a."config"->'publicReplies', '[]'::jsonb)
  ),
  now(),
  now()
FROM "comment_automations" a
WHERE a."deleted_at" IS NULL
  AND COALESCE(a."config"->>'version', '1') = '1'
  AND NOT EXISTS (SELECT 1 FROM "automation_triggers" t WHERE t."automation_id" = a."id");
```

Run: `bun run db:check`
Expected: sem divergência.

- [ ] **Step 6: Implementar no repositório**

Em `packages/db/src/repositories/automation.repo.ts`:

- importar `automationTriggers` de `../schema` e os tipos `AutomationTriggerInput` e `AutomationTriggerRecord` de `@manypost/core`;
- em `toRun`, depois de `conversationId: row.conversationId,`, acrescentar:

  ```ts
    nodeId: row.nodeId,
    cursor: row.cursor,
    sentCursor: row.sentCursor,
  ```

- acrescentar, antes de `makeAutomationRepository`:

```ts
const toTrigger = (row: typeof automationTriggers.$inferSelect): AutomationTriggerRecord => ({
  id: row.id,
  orgId: row.orgId,
  automationId: row.automationId,
  channelId: row.channelId,
  kind: row.kind as 'comment',
  config: row.config,
  position: (row.position ?? null) as AutomationTriggerRecord['position'],
  createdAt: row.createdAt,
});
```

- trocar `create` e `update` por:

```ts
    async create({ triggers, ...d }) {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(commentAutomations).values(d).returning();
        const a = toAutomation(row!);
        if (triggers?.length) {
          await tx.insert(automationTriggers).values(
            triggers.map((t) => ({ orgId: a.orgId, automationId: a.id, channelId: a.channelId, kind: t.kind, config: t.config, position: t.position })),
          );
        }
        return a;
      });
    },
    async update(orgId, id, patch, triggers) {
      return db.transaction(async (tx) => {
        const [row] = Object.keys(patch).length
          ? await tx.update(commentAutomations).set(patch).where(alive(orgId, id)).returning()
          : await tx.select().from(commentAutomations).where(alive(orgId, id));
        if (!row) return null;
        if (triggers) {
          // a lista enviada substitui os gatilhos da automação, na mesma transação
          await tx.delete(automationTriggers).where(eq(automationTriggers.automationId, id));
          if (triggers.length) {
            await tx.insert(automationTriggers).values(
              triggers.map((t) => ({ orgId, automationId: id, channelId: row.channelId, kind: t.kind, config: t.config, position: t.position })),
            );
          }
        }
        return toAutomation(row);
      });
    },
```

- acrescentar depois de `listTriggerable`:

```ts
    async listTriggers(automationIds) {
      if (!automationIds.length) return [];
      const rows = await db
        .select()
        .from(automationTriggers)
        .where(inArray(automationTriggers.automationId, automationIds))
        .orderBy(asc(automationTriggers.createdAt));
      return rows.map(toTrigger);
    },
```

`AutomationTriggerInput` só é usado nos tipos dos parâmetros. Se o linter reclamar de import sem uso, importe só `AutomationTriggerRecord`.

- [ ] **Step 7: Exportar os tipos novos no core**

Conferir se `packages/core/src/index.ts` reexporta `./application/ports/automation` com `export *`. Se reexportar nomes um a um, acrescentar `AutomationTriggerInput` e `AutomationTriggerRecord`.

- [ ] **Step 8: Atualizar o `memRepo` dos testes do motor**

Em `comment-automation.test.ts`, dentro de `memRepo()`:

- declarar `const triggers: AutomationTriggerRecord[] = [];` ao lado de `runs` e importar o tipo de `../ports/automation`;
- trocar `create` e `update` por:

```ts
    async create({ triggers: ts, ...d }) {
      const a = { ...d, id: `auto-${++seq}`, createdAt: new Date(seq), updatedAt: new Date(seq) };
      automations.push(a);
      for (const t of ts ?? []) {
        triggers.push({ ...t, id: `trig-${++seq}`, orgId: a.orgId, automationId: a.id, channelId: a.channelId, createdAt: new Date(seq) });
      }
      return a;
    },
    async update(orgId, id, p, ts) {
      const a = automations.find((x) => x.orgId === orgId && x.id === id);
      if (!a) return null;
      Object.assign(a, p);
      if (ts) {
        for (let i = triggers.length - 1; i >= 0; i--) if (triggers[i]!.automationId === id) triggers.splice(i, 1);
        for (const t of ts) {
          triggers.push({ ...t, id: `trig-${++seq}`, orgId, automationId: id, channelId: a.channelId, createdAt: new Date(seq) });
        }
      }
      return { ...a };
    },
```

- acrescentar `async listTriggers(ids) { return triggers.filter((t) => ids.includes(t.automationId)); },`;
- em `createRun`, acrescentar `nodeId: null, cursor: 0, sentCursor: -1,` ao objeto da execução;
- devolver `triggers` no `return { repo, automations, runs, events, triggers };`.

- [ ] **Step 9: Migrar o banco de teste e rodar**

```bash
DATABASE_URL=$TEST_DATABASE_URL bun run --cwd packages/db migrate
TEST_DATABASE_URL=$TEST_DATABASE_URL bun test packages/db/src/repositories/automation.repo.integration.test.ts
bun test packages/core
bun run typecheck
```

Expected: integração PASS (8 testes), core PASS e typecheck sem erros.

- [ ] **Step 10: Commit**

```bash
git add packages/db packages/core/src/application/ports/automation.ts packages/core/src/index.ts packages/core/src/application/use-cases/comment-automation.test.ts
git commit -m "feat(db): automation_triggers, cursor de nó nas execuções e backfill dos gatilhos v1"
```

---

### Task 7: Motor sobre o grafo

**Files:**
- Modify: `packages/core/src/application/use-cases/comment-automation.ts`: a seção `// ---- motor` inteira
- Modify: `packages/core/src/application/use-cases/comment-automation.test.ts`

**Interfaces:**
- Consumes: Tasks 2 a 6.
- Produces:
  - `makeAutomationEngine` com a mesma assinatura (`AutomationEngineDeps`) e os mesmos retornos de `process`: `'run' | 'no_match' | 'ignored' | 'unknown_account' | 'no_run' | 'paused' | 'invalid_config' | 'duplicate' | 'advanced' | 'pending' | 'abandoned' | 'done'`;
  - função de módulo `loadFlow(raw: unknown): { flow: FlowV2; legacy: CommentAutomationConfig | null } | null`, exportada para o CRUD do Task 8;
  - `commentTriggerOf(automationId, triggers, loaded): CommentTriggerConfig | null`, também exportada.

- [ ] **Step 1: Atualizar os testes v1 para o motor novo e escrever os testes v2**

Em `comment-automation.test.ts`:

(a) Depois de `harness`, acrescentar o helper de toque (o mesmo da sequência dourada; mova o `tocar` do Task 5 para o escopo do módulo e reuse):

```ts
/** toca o botão pelo título usando o payload que a própria mensagem levou */
function tocar(h: ReturnType<typeof harness>, title: string) {
  for (const s of [...h.sent].reverse()) {
    const all = [...(s.msg?.buttons ?? []), ...(s.msg?.quickReplies ?? [])] as Array<{ title: string; payload?: string }>;
    const b = all.find((x) => x.title === title && x.payload);
    if (b) return h.message({ payload: b.payload!, text: title });
  }
  throw new Error(`botão ${title} não encontrado`);
}
```

Remova a cópia local de `tocar` dentro do `describe` dourado.

(b) Em `harness`, mudar `seedAutomation` para aceitar gatilhos:

```ts
  async function seedAutomation(
    config: unknown = CONFIG,
    testUsernames: string[] = ['iagovieira.ia'],
    triggers?: Array<{ kind: 'comment'; config: unknown; position: null }>,
  ) {
    return mem.repo.create({
      orgId: ORG,
      channelId: CH,
      name: 'Cotação',
      status: opts.status ?? 'ACTIVE',
      config,
      testUsernames,
      createdBy: null,
      ...(triggers ? { triggers } : {}),
    });
  }
```

(c) Substituir estes testes pelo novo conteúdo:

- `'casa a palavra-chave, responde em público e manda a abertura com botão'`:

```ts
  test('casa a palavra-chave, responde em público e manda a abertura com botão', async () => {
    const h = harness();
    await h.seedAutomation();
    expect(await h.deliver(h.comment())).toBe('run');
    expect(h.sent.map((s) => s.op)).toEqual(['public', 'private']);
    expect(h.sent[0]?.text).toBe('Te chamei no direct!');
    expect(h.sent[1]?.msg?.buttons?.[0]?.payload).toBe(`mp2:${h.runs[0]!.id}:opening:next`);
    expect(h.runs[0]).toMatchObject({ publicReply: 'SENT', privateReply: 'SENT', nodeId: 'opening', cursor: 0, sentCursor: 0 });
  });
```

- o `describe('direct → perguntas → lead', ...)` inteiro:

```ts
describe('direct → perguntas → lead', () => {
  async function aberto(h: ReturnType<typeof harness>) {
    await h.seedAutomation();
    await h.deliver(h.comment());
    return h.runs[0]!.id;
  }

  test('fluxo completo: botão da abertura, opção, telefone, fim com WhatsApp e lead uma vez', async () => {
    const h = harness();
    const runId = await aberto(h);

    await h.deliver(tocar(h, 'Quero!'));
    expect(h.sent.at(-1)).toMatchObject({ op: 'send', target: 'conv-1', key: `${runId}:c1:0` });
    expect(h.sent.at(-1)?.msg?.buttons?.map((b) => b.title)).toEqual(['Saúde', 'Vida']);

    await h.deliver(tocar(h, 'Saúde'));
    expect(h.runs[0]!.answers).toEqual({ plano: 'Saúde' });
    expect(h.sent.at(-1)?.msg?.text).toBe('Seu WhatsApp?');

    await h.deliver(h.message({ text: '(92) 98888-7777' }));
    const fim = h.sent.at(-1)!;
    expect(fim.key).toBe(`${runId}:c3:0`);
    expect(fim.msg?.buttons?.[0]?.url).toBe(`https://wa.me/5592999990000?text=${encodeURIComponent('Quero Saúde')}`);
    expect(h.runs[0]).toMatchObject({ status: 'COMPLETED', answers: { plano: 'Saúde', whatsapp: '92988887777' } });

    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({
      event: 'lead.captured',
      data: { runId, participantUsername: 'cliente', answers: { plano: 'Saúde', whatsapp: '92988887777' } },
    });

    // mensagem depois do fim não reabre nem reemite
    await h.deliver(h.message({ text: 'obrigado' }));
    expect(h.emitted).toHaveLength(1);
  });

  test('opção digitada em vez de tocada também vale', async () => {
    const h = harness();
    await aberto(h);
    await h.deliver(tocar(h, 'Quero!'));
    await h.deliver(h.message({ text: 'vida' }));
    expect(h.runs[0]!.answers).toEqual({ plano: 'Vida' });
  });

  test('telefone inválido re-pergunta uma vez com chave nova; na segunda aceita o texto', async () => {
    const h = harness();
    const runId = await aberto(h);
    await h.deliver(tocar(h, 'Quero!'));
    await h.deliver(tocar(h, 'Vida'));
    await h.deliver(h.message({ text: 'não sei' }));
    expect(h.sent.at(-1)).toMatchObject({ key: `${runId}:c2:1`, msg: { text: 'Seu WhatsApp?' } });
    expect(h.runs[0]).toMatchObject({ nodeId: 'q1', reasks: 1 });
    await h.deliver(h.message({ text: 'liga no fixo' }));
    expect(h.runs[0]).toMatchObject({ status: 'COMPLETED', answers: { plano: 'Vida', whatsapp: 'liga no fixo' } });
  });

  test('toque antigo é ignorado: não avança nem regrava a resposta', async () => {
    const h = harness();
    await aberto(h);
    await h.deliver(tocar(h, 'Quero!'));
    await h.deliver(tocar(h, 'Saúde'));
    const enviados = h.sent.length;
    expect(await h.deliver(tocar(h, 'Vida'))).toBe('duplicate');
    expect(h.runs[0]).toMatchObject({ nodeId: 'q1', answers: { plano: 'Saúde' } });
    expect(h.sent.length).toBe(enviados);
  });

  test('mensagens de saída, standby ou de quem não tem execução são ignoradas', async () => {
    const h = harness();
    await aberto(h);
    expect(await h.deliver(h.message({ outgoing: true, text: 'x' }))).toBe('ignored');
    expect(await h.deliver(h.message({ standby: true, text: 'x' }))).toBe('ignored');
    expect(await h.deliver(h.message({ senderId: 'outro', senderUsername: 'outro' }))).toBe('no_run');
    expect(h.runs[0]!.nodeId).toBe('opening');
  });

  test('remetente com id diferente é achado pelo username', async () => {
    const h = harness();
    await aberto(h);
    expect(await h.deliver(h.message({ senderId: 'igsid-outro', senderUsername: 'Cliente', text: 'oi' }))).toBe('advanced');
    expect(h.runs[0]!.nodeId).toBe('q0');
  });

  test('falha transitória ao mandar a pergunta: o job falha e a retentativa entrega uma vez', async () => {
    const h = harness({ sendErrors: [{ status: 503, body: '{}', errorClass: 'transient' }] });
    await aberto(h);
    const ev = await h.engine.ingest({ eventId: 'z-msg', eventType: 'message', payload: tocar(h, 'Quero!') });
    const id = (ev as { id: string }).id;
    await expect(h.engine.process(id)).rejects.toThrow();
    expect(h.runs[0]).toMatchObject({ nodeId: 'q0', cursor: 1, sentCursor: 0 });
    await h.engine.process(id);
    expect(h.sent.filter((s) => s.op === 'send')).toHaveLength(1);
    expect(h.runs[0]!.sentCursor).toBe(1);
  });

  test('automação pausada não conduz a conversa', async () => {
    const h = harness();
    await aberto(h);
    const tap = tocar(h, 'Quero!');
    await h.repo.update(ORG, h.automations[0]!.id, { status: 'PAUSED' });
    expect(await h.deliver(tap)).toBe('paused');
  });

  test('execução v1 em andamento continua com payload mp1', async () => {
    const h = harness();
    const runId = await aberto(h);
    // estado de uma execução criada pelo motor v1: esperando a pergunta 0, prompt já entregue
    Object.assign(h.runs[0]!, { nodeId: null, cursor: 0, sentCursor: -1, step: 0, promptSentStep: 0, conversationId: 'conv-1' });
    const antes = h.sent.length;
    expect(await h.deliver(h.message({ payload: `mp1:${runId}:0:1`, text: 'Vida' }))).toBe('advanced');
    expect(h.runs[0]).toMatchObject({ nodeId: 'q1', answers: { plano: 'Vida' } });
    expect(h.sent.slice(antes).map((s) => s.msg?.text)).toEqual(['Seu WhatsApp?']);
  });
});
```

(d) Acrescentar o `describe` do fluxo v2:

```ts
const P = { x: 0, y: 0 };
const ed = (source: string, sourceHandle: string, target: string) => ({ id: `e-${source}-${sourceHandle}`, source, sourceHandle, target });
const FLOW = {
  version: 2,
  nodes: [
    { id: 'opening', type: 'opening', position: P, data: { text: 'Oi!' } },
    { id: 'tipo', type: 'message', position: P, data: { text: 'Para quem?', options: [{ id: 'pf', title: 'Pessoa física' }, { id: 'pj', title: 'Minha empresa' }], saveTo: 'tipo' } },
    { id: 'info', type: 'message', position: P, data: { text: 'Empresarial tem condições especiais.', format: 'none' } },
    { id: 'nome', type: 'question', position: P, data: { text: 'Seu nome?', field: 'nome', validate: 'name' } },
    { id: 'c', type: 'condition', position: P, data: { field: 'tipo', op: 'equals', value: 'minha empresa' } },
    { id: 'wa', type: 'link', position: P, data: { text: 'Fale com a gente', buttonTitle: 'WhatsApp', target: { kind: 'whatsapp', phone: '5592999990000', message: 'Sou {nome}' } } },
    { id: 'fim', type: 'end', position: P, data: { text: 'Obrigado, {nome}!' } },
  ],
  edges: [
    ed('opening', 'next', 'tipo'),
    ed('tipo', 'pf', 'nome'),
    ed('tipo', 'pj', 'info'),
    ed('info', 'next', 'nome'),
    ed('nome', 'next', 'c'),
    ed('c', 'yes', 'wa'),
    ed('c', 'no', 'fim'),
  ],
};
const TRIGGER = [{ kind: 'comment' as const, config: { mediaIds: [], keywords: ['plano'], publicReplies: [] }, position: null }];

describe('fluxo v2', () => {
  async function aberto(h: ReturnType<typeof harness>, flow: unknown = FLOW) {
    await h.seedAutomation(flow, ['iagovieira.ia'], TRIGGER);
    expect(await h.deliver(h.comment({ text: 'quero o PLANO' }))).toBe('run');
    return h.runs[0]!.id;
  }

  test('gatilho da tabela dispara; abertura em texto chega sem botão e sem resposta pública', async () => {
    const h = harness();
    await aberto(h);
    expect(h.sent.map((s) => s.op)).toEqual(['private']);
    expect(h.sent[0]!.msg).toEqual({ text: 'Oi!\n\nResponda esta mensagem para continuar.\n\nMensagem automática.' });
    expect(h.runs[0]).toMatchObject({ publicReply: 'NONE', nodeId: 'opening' });
  });

  test('ramo empresa: mensagens encadeadas no mesmo evento, condição, link sem saída fecha o lead', async () => {
    const h = harness();
    const runId = await aberto(h);
    await h.deliver(h.message({ text: 'oi' }));
    expect(h.sent.at(-1)?.msg?.buttons?.map((b) => b.title)).toEqual(['Pessoa física', 'Minha empresa']);
    const antes = h.sent.length;
    await h.deliver(tocar(h, 'Minha empresa'));
    expect(h.sent.slice(antes).map((s) => [s.key, s.msg?.text])).toEqual([
      [`${runId}:c2:0`, 'Empresarial tem condições especiais.'],
      [`${runId}:c3:0`, 'Seu nome?'],
    ]);
    await h.deliver(h.message({ text: 'Ana' }));
    expect(h.sent.at(-1)).toMatchObject({ key: `${runId}:c5:0`, msg: { text: 'Fale com a gente' } });
    expect(h.runs[0]).toMatchObject({ status: 'COMPLETED', answers: { tipo: 'Minha empresa', nome: 'Ana' } });
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]!.data.whatsappUrl).toBe(`https://wa.me/5592999990000?text=${encodeURIComponent('Sou Ana')}`);
  });

  test('ramo pessoa física vai direto ao nome e termina no fim com texto', async () => {
    const h = harness();
    await aberto(h);
    await h.deliver(h.message({ text: 'oi' }));
    await h.deliver(tocar(h, 'Pessoa física'));
    expect(h.sent.at(-1)?.msg?.text).toBe('Seu nome?');
    await h.deliver(h.message({ text: 'Bia' }));
    expect(h.sent.at(-1)?.msg?.text).toBe('Obrigado, Bia!');
    expect(h.runs[0]!.status).toBe('COMPLETED');
  });

  test('retry no meio do encadeamento não reenvia a primeira mensagem', async () => {
    const h = harness({ sendErrors: [undefined, undefined, { status: 503, body: '{}', errorClass: 'transient' }] });
    await aberto(h);
    await h.deliver(h.message({ text: 'oi' }));
    const ev = await h.engine.ingest({ eventId: 'z-pj', eventType: 'message', payload: tocar(h, 'Minha empresa') });
    const id = (ev as { id: string }).id;
    await expect(h.engine.process(id)).rejects.toThrow();
    await h.engine.process(id);
    expect(h.sent.filter((s) => s.msg?.text === 'Empresarial tem condições especiais.')).toHaveLength(1);
    expect(h.sent.filter((s) => s.msg?.text === 'Seu nome?')).toHaveLength(1);
  });

  test('nó apagado → ABANDONED e nada é enviado', async () => {
    const h = harness();
    await aberto(h);
    await h.deliver(h.message({ text: 'oi' }));
    await h.deliver(tocar(h, 'Pessoa física'));
    expect(h.runs[0]!.nodeId).toBe('nome');
    const semNome = {
      ...FLOW,
      nodes: FLOW.nodes.filter((n) => n.id !== 'nome'),
      edges: FLOW.edges.filter((x) => x.source !== 'nome' && x.target !== 'nome'),
    };
    await h.repo.update(ORG, h.automations[0]!.id, { config: semNome });
    const antes = h.sent.length;
    expect(await h.deliver(h.message({ text: 'Bia' }))).toBe('abandoned');
    expect(h.runs[0]).toMatchObject({ status: 'ABANDONED' });
    expect(h.sent.length).toBe(antes);
    expect(h.emitted).toHaveLength(0);
  });

  test('dono da conversa é outra ferramenta (409) → execução falha sem retentar', async () => {
    const h = harness({
      sendErrors: [{ status: 409, body: '{"error":{"message":"not_thread_owner"}}', errorClass: 'permanent' }],
    });
    await aberto(h);
    await h.deliver(h.message({ text: 'oi' }));
    expect(h.runs[0]).toMatchObject({ status: 'FAILED' });
    expect(h.runs[0]!.lastError).toContain('not_thread_owner');
  });

  test('laço sem espera gravado à força para no limite de passos', async () => {
    const h = harness();
    const laco = {
      version: 2,
      nodes: [
        { id: 'opening', type: 'opening', position: P, data: { text: 'Oi!' } },
        { id: 'i', type: 'message', position: P, data: { text: 'Info', format: 'none' } },
        { id: 'c', type: 'condition', position: P, data: { field: 'x', op: 'filled' } },
        { id: 'fim', type: 'end', position: P, data: {} },
      ],
      edges: [ed('opening', 'next', 'i'), ed('i', 'next', 'c'), ed('c', 'yes', 'fim'), ed('c', 'no', 'i')],
    };
    await aberto(h, laco);
    await h.deliver(h.message({ text: 'oi' }));
    expect(h.runs[0]).toMatchObject({ status: 'FAILED' });
    expect(h.runs[0]!.lastError).toContain('limite');
    expect(h.sent.filter((s) => s.op === 'send').length).toBeLessThanOrEqual(21);
  });
});
```

(e) Nos testes de CRUD (`describe('CRUD')`), por enquanto **não mexa**. Eles mudam no Task 8.

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test packages/core/src/application/use-cases/comment-automation.test.ts`
Expected: FAIL nos testes v2 e nos v1 atualizados (payload `mp2`, `nodeId`). Os dourados e os de CRUD continuam passando.

- [ ] **Step 3: Reescrever o motor**

Em `comment-automation.ts`:

- ajustar os imports:
  - de `@manypost/contracts`: `AnyAutomationConfigSchema`, `CommentTriggerConfigSchema` e os tipos `CommentTriggerConfig` e `FlowV2`;
  - de `../../domain/automation/automation-logic`: `decodePayload` e `matchesCommentTrigger`. Saem `finishMessage`, `matchesTrigger`, `matchOption`, `openingMessage`, `pickPublicReply`, `promptMessage`, `validateAnswer` e `whatsappUrl`, que o CRUD não usa;
  - de `../../domain/automation/flow-graph`: `nodeById`, `openingOf`, `targetOf`, `waits`;
  - de `../../domain/automation/flow-step`: `MAX_AUTO_STEPS`, `autoNext`, `decideInput`, `decodePayloadV2`, `leadWhatsappUrl`, `messageFor`;
  - de `../../domain/automation/flow-from-v1`: `flowFromV1`, `nodeForV1Step`, `tapFromV1`, `triggerFromV1`;
  - de `../ports/automation`: o tipo `AutomationTriggerRecord`;
- remover a constante `MAX_REASKS` local (agora vem de `flow-step`; o motor não a usa direto);
- substituir **tudo** de `// ---------------------------------------------------------------- motor` até o fim do arquivo por:

```ts
// ---------------------------------------------------------------- fluxo carregado

export interface LoadedFlow {
  flow: FlowV2;
  /** configuração v1 original quando a automação ainda não foi salva pelo canvas */
  legacy: CommentAutomationConfig | null;
}

/** v2 como está; v1 convertida na leitura, sem gravar (design D4) */
export function loadFlow(raw: unknown): LoadedFlow | null {
  const r = AnyAutomationConfigSchema.safeParse(raw);
  if (!r.success) return null;
  return r.data.version === 2 ? { flow: r.data, legacy: null } : { flow: flowFromV1(r.data), legacy: r.data };
}

/** gatilho de comentário da automação: a linha da tabela; sem linha, o `config.trigger` da v1 */
export function commentTriggerOf(
  automationId: string,
  triggers: AutomationTriggerRecord[],
  loaded: LoadedFlow,
): CommentTriggerConfig | null {
  const row = triggers.find((t) => t.automationId === automationId && t.kind === 'comment');
  if (row) {
    const p = CommentTriggerConfigSchema.safeParse(row.config);
    return p.success ? p.data : null;
  }
  return loaded.legacy ? triggerFromV1(loaded.legacy) : null;
}

// ---------------------------------------------------------------- motor

export interface AutomationEngineDeps {
  repo: AutomationRepository;
  gateway: AutomationGateway;
  scheduler: Pick<JobScheduler, 'enqueue'>;
  events?: EventPublisher;
  log: (level: 'info' | 'warn' | 'error', msg: string, data?: object) => void;
  now?: () => Date;
  random?: () => number;
}

/** falha que o job deve retentar (o envio é idempotente ou nada saiu) */
class RetryableSendError extends Error {
  constructor(public readonly op: string) {
    super(`envio transitório falhou: ${op}`);
  }
}

const isFailure = (e: unknown): e is ProviderFailure & { consumed?: boolean; uncertain?: boolean } =>
  typeof e === 'object' && e !== null && typeof (e as ProviderFailure).status === 'number';

/** texto curto para `last_error` — só a mensagem saneada, nunca o corpo */
function errorText(e: unknown): string {
  if (isFailure(e)) {
    try {
      const msg = (JSON.parse(e.body) as { error?: { message?: unknown } }).error?.message;
      if (typeof msg === 'string') return `${e.status}: ${msg.slice(0, 200)}`;
    } catch {
      // corpo não-JSON
    }
    return `HTTP ${e.status}`;
  }
  return 'falha de rede';
}

interface Bound {
  channel: { id: string; orgId: string };
  comments: CommentTransport;
  direct: DirectTransport;
}

export const makeAutomationEngine = (deps: AutomationEngineDeps) => {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;

  async function patch(run: AutomationRunRecord, p: AutomationRunPatch) {
    return deps.repo.updateRun(run.id, p);
  }

  /** envio idempotente na conversa: transitório/rede = retentar o job; permanente = falha da execução */
  async function sendInConversation(bound: Bound, run: AutomationRunRecord, msg: DirectMessage, key: string, op: string) {
    if (!run.conversationId) throw new RetryableSendError(`${op}: conversa ainda desconhecida`);
    try {
      await bound.direct.sendMessage(run.conversationId, msg, key);
      return { ok: true as const };
    } catch (e) {
      if (!isFailure(e) || e.errorClass === 'transient') {
        deps.log('warn', 'automation.send.failed', { runId: run.id, op, status: isFailure(e) ? e.status : null, retry: true });
        throw new RetryableSendError(op);
      }
      deps.log('warn', 'automation.send.failed', { runId: run.id, op, status: e.status, retry: false });
      return { ok: false as const, error: errorText(e) };
    }
  }

  /** execução criada pelo motor v1 (sem nó) ganha o nó equivalente; o prompt entregue não sai de novo */
  async function adoptLegacyRun(run: AutomationRunRecord, flow: FlowV2) {
    if (run.nodeId !== null || run.privateReply !== 'SENT') return run;
    const delivered = run.step < 0 || run.promptSentStep >= run.step;
    return patch(run, { nodeId: nodeForV1Step(flow, run.step), cursor: 1, sentCursor: delivered ? 1 : 0 });
  }

  /**
   * Faz só o que falta, na ordem do fluxo, gravando cada efeito logo depois de confirmado (design D6):
   * resposta pública, resposta privada (abertura), mensagens dos nós até o próximo que espera, fim e
   * `lead.captured`. Reprocessar o mesmo evento nunca envia duas vezes.
   */
  async function drive(
    bound: Bound,
    automation: AutomationRecord,
    loaded: LoadedFlow,
    publicReplies: string[],
    start: AutomationRunRecord,
  ) {
    const { flow } = loaded;
    let run = start;
    const ctx = () => ({ runId: run.id, answers: run.answers, username: run.participantUsername });

    if (run.status === 'OPEN') {
      // 1. resposta pública (não crítica: falhou, segue)
      if (run.publicReply === 'PENDING') {
        const reply = publicReplies.length
          ? publicReplies[Math.min(publicReplies.length - 1, Math.floor(random() * publicReplies.length))]!
          : null;
        if (!reply) run = await patch(run, { publicReply: 'NONE' });
        else {
          try {
            await bound.comments.replyToComment(run.mediaId, run.commentId, reply);
            run = await patch(run, { publicReply: 'SENT' });
          } catch (e) {
            run = await patch(run, { publicReply: 'FAILED', lastError: `resposta pública: ${errorText(e)}` });
          }
        }
      }

      // 2. resposta privada = abertura; uma por comentário, sem chave de idempotência → nunca retentada às cegas
      if (run.privateReply === 'PENDING') {
        const opening = openingOf(flow);
        try {
          await bound.direct.privateReply(run.mediaId, run.commentId, messageFor(opening, ctx())!);
          run = await patch(run, { privateReply: 'SENT', promptSentStep: -1, nodeId: opening.id, sentCursor: run.cursor });
        } catch (e) {
          if (isFailure(e) && e.status === 429 && !e.uncertain) throw new RetryableSendError('private_reply');
          const uncertain = !isFailure(e) || e.uncertain === true || (e.status >= 500 && !e.consumed);
          run = await patch(run, {
            privateReply: uncertain ? 'UNCERTAIN' : 'FAILED',
            status: uncertain ? 'UNCERTAIN' : 'FAILED',
            lastError: `resposta privada: ${errorText(e)}`,
          });
          deps.log('warn', 'automation.run', { runId: run.id, status: run.status, node: run.nodeId });
          return run;
        }
      }

      // 3. anda pelos nós que não esperam até o próximo que espera
      let steps = 0;
      while (run.status === 'OPEN') {
        const node = nodeById(flow, run.nodeId);
        if (!node) {
          run = await patch(run, { status: 'ABANDONED', lastError: 'o passo desta conversa foi removido do fluxo' });
          break;
        }
        if (run.sentCursor < run.cursor) {
          const msg = messageFor(node, ctx());
          if (msg) {
            const sent = await sendInConversation(bound, run, msg, `${run.id}:c${run.cursor}:${run.reasks}`, node.type);
            if (!sent.ok) {
              run = await patch(run, { status: 'FAILED', lastError: `${node.type}: ${sent.error}` });
              break;
            }
          }
          run = await patch(run, { sentCursor: run.cursor });
        }
        if (waits(node)) break;
        if (++steps > MAX_AUTO_STEPS) {
          run = await patch(run, { status: 'FAILED', lastError: 'limite de passos automáticos seguidos' });
          break;
        }
        const nx = autoNext(flow, node, run.answers);
        if (nx.kind === 'finish') {
          const at = now();
          run = await patch(run, { status: 'COMPLETED', completedAt: at, finishSentAt: at });
          break;
        }
        if (nx.kind === 'dead_end') {
          run = await patch(run, { status: 'ABANDONED', lastError: `saída sem ligação: ${node.id}.${nx.handle}` });
          break;
        }
        run = await patch(run, { nodeId: nx.to, cursor: run.cursor + 1, reasks: 0 });
      }
    }

    // 4. lead completo emitido pelo menos uma vez (`runId` é a chave de deduplicação de quem recebe)
    if (run.status === 'COMPLETED' && !run.leadEmittedAt) {
      await deps.events?.emit({
        orgId: run.orgId,
        event: WebhookEvents.LeadCaptured,
        channelId: run.channelId,
        data: {
          runId: run.id,
          automationId: automation.id,
          automationName: automation.name,
          channelId: run.channelId,
          mediaId: run.mediaId,
          commentId: run.commentId,
          commentText: run.commentText,
          participantId: run.participantId,
          participantUsername: run.participantUsername,
          answers: run.answers,
          whatsappUrl: leadWhatsappUrl(flow, ctx()),
          completedAt: (run.completedAt ?? now()).toISOString(),
        },
      });
      run = await patch(run, { leadEmittedAt: now() });
    }
    deps.log('info', 'automation.run', { runId: run.id, status: run.status, node: run.nodeId, cursor: run.cursor });
    return run;
  }

  async function onComment(bound: Bound, c: InboundCommentEvent) {
    if (c.isReply || c.isOwn) return 'ignored';
    const author = c.authorUsername?.toLowerCase() ?? null;
    const automations = await deps.repo.listTriggerable(bound.channel.id);
    const triggers = automations.length ? await deps.repo.listTriggers(automations.map((a) => a.id)) : [];
    for (const automation of automations) {
      const loaded = loadFlow(automation.config);
      if (!loaded) continue;
      const trigger = commentTriggerOf(automation.id, triggers, loaded);
      if (!trigger) continue;
      if (automation.status === 'TEST' && !(author && automation.testUsernames.includes(author))) continue;
      if (!matchesCommentTrigger(trigger, { mediaId: c.mediaId, text: c.text })) continue;

      const { run } = await deps.repo.createRun({
        orgId: automation.orgId,
        automationId: automation.id,
        channelId: bound.channel.id,
        mediaId: c.mediaId,
        commentId: c.commentId,
        commentText: c.text.slice(0, 2200),
        participantId: c.authorId,
        participantUsername: c.authorUsername,
        publicReply: trigger.publicReplies.length ? 'PENDING' : 'NONE',
      });
      // reentrega ou retentativa: `drive` só faz o que ainda falta
      await drive(bound, automation, loaded, trigger.publicReplies, run);
      return 'run';
    }
    return 'no_match';
  }

  async function onMessage(bound: Bound, m: InboundMessageEvent) {
    if (m.outgoing || m.standby) return 'ignored';
    const since = new Date(now().getTime() - RUN_WINDOW_MS);
    const v2 = decodePayloadV2(m.payload);
    const v1 = v2 ? null : decodePayload(m.payload);
    const tapRunId = v2?.runId ?? v1?.runId ?? null;

    let run: AutomationRunRecord | null = null;
    if (tapRunId) {
      const r = await deps.repo.getRun(tapRunId);
      if (r && r.channelId === bound.channel.id && r.status === 'OPEN') run = r;
    }
    run ??= await deps.repo.findOpenRun(bound.channel.id, { participantId: m.senderId }, since);
    if (!run && m.senderUsername) run = await deps.repo.findOpenRun(bound.channel.id, { username: m.senderUsername }, since);
    if (!run) return 'no_run';

    const automation = await deps.repo.get(run.orgId, run.automationId);
    if (!automation || automation.status === 'PAUSED' || automation.status === 'DRAFT') return 'paused';
    const loaded = loadFlow(automation.config);
    if (!loaded) {
      await patch(run, { status: 'FAILED', lastError: 'configuração da automação inválida' });
      return 'invalid_config';
    }
    const triggers = await deps.repo.listTriggers([automation.id]);
    const publicReplies = commentTriggerOf(automation.id, triggers, loaded)?.publicReplies ?? [];

    const base: AutomationRunPatch = {
      lastInteractionAt: now(),
      ...(run.conversationId ? {} : { conversationId: m.conversationId }),
    };

    // resposta privada ainda pendente (429 em retentativa): só garante o progresso
    if (run.privateReply !== 'SENT') {
      run = await patch(run, base);
      await drive(bound, automation, loaded, publicReplies, run);
      return 'pending';
    }

    run = await adoptLegacyRun(run, loaded.flow);
    const node = nodeById(loaded.flow, run.nodeId);
    if (!node) {
      run = await patch(run, base);
      await drive(bound, automation, loaded, publicReplies, run);
      return 'abandoned';
    }

    const tap =
      v2 && v2.runId === run.id
        ? { nodeId: v2.nodeId, handle: v2.handle }
        : v1 && v1.runId === run.id
          ? tapFromV1(v1.step, v1.option)
          : null;
    // toque de outra execução ou de um passo que já passou (toque duplo, botão antigo): só garante o progresso
    if ((tapRunId && tapRunId !== run.id) || (tap && tap.nodeId !== run.nodeId)) {
      run = await patch(run, base);
      await drive(bound, automation, loaded, publicReplies, run);
      return 'duplicate';
    }

    const d = decideInput(loaded.flow, node, { handle: tap?.handle ?? null, text: m.text }, run.reasks);
    if (d.kind === 'ignore') {
      run = await patch(run, base);
    } else if (d.kind === 'reask') {
      // a chave nova (reasks+1) permite reenviar a mesma mensagem
      run = await patch(run, { ...base, reasks: run.reasks + 1, sentCursor: run.cursor - 1 });
    } else {
      const to = targetOf(loaded.flow, node.id, d.handle);
      const answers = d.save ? { ...run.answers, [d.save.field]: d.save.value } : run.answers;
      run = to
        ? await patch(run, { ...base, answers, nodeId: to, cursor: run.cursor + 1, reasks: 0 })
        : await patch(run, { ...base, answers, status: 'ABANDONED', lastError: `saída sem ligação: ${node.id}.${d.handle}` });
    }
    await drive(bound, automation, loaded, publicReplies, run);
    return 'advanced';
  }

  return {
    /** rota do webhook: grava uma vez e enfileira; `duplicate` = reentrega já gravada */
    async ingest(e: { eventId: string; eventType: string; payload: unknown }) {
      const id = await deps.repo.insertInboundEvent({ source: deps.gateway.source, ...e });
      if (!id) return { duplicate: true as const };
      await deps.scheduler.enqueue(AUTOMATION_EVENT_QUEUE, { inboundEventId: id }, { singletonKey: id, retryLimit: 3, retryBackoffSec: 20 });
      return { duplicate: false as const, id };
    },

    /** job da fila: lança só quando vale retentar (envio idempotente transitório) */
    async process(inboundEventId: string) {
      const started = Date.now();
      const ev = await deps.repo.getInboundEvent(inboundEventId);
      if (!ev || ev.processedAt) return 'done';
      const parsed = deps.gateway.parse(ev.eventType, ev.payload);
      if (!parsed) {
        await deps.repo.markInboundEvent(ev.id, { processed: true });
        return 'ignored';
      }
      const bound = await deps.gateway.resolve(parsed.accountRef);
      if (!bound) {
        await deps.repo.markInboundEvent(ev.id, { processed: true });
        return 'unknown_account';
      }
      try {
        const action = parsed.kind === 'comment' ? await onComment(bound, parsed) : await onMessage(bound, parsed);
        await deps.repo.markInboundEvent(ev.id, { processed: true });
        deps.log('info', 'automation.event', { type: ev.eventType, action, ms: Date.now() - started });
        return action;
      } catch (e) {
        await deps.repo.markInboundEvent(ev.id, { error: e instanceof Error ? e.message : 'erro' });
        throw e;
      }
    },
  };
};

export type AutomationEngine = ReturnType<typeof makeAutomationEngine>;
```

Atenção: os testes `'ramo empresa'` e `'nó apagado'` exigem que o `process` de um `message` devolva `'abandoned'` quando o nó sumiu. O `onMessage` acima já devolve isso.

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test packages/core`
Expected: PASS em tudo, **inclusive os 2 testes dourados sem nenhuma alteração**. Se um dourado falhar, o motor novo mudou o que a pessoa recebe. Corrija o motor, nunca o dourado.

- [ ] **Step 5: Typecheck e fronteiras**

Run: `bun run typecheck && bun run check:boundaries`
Expected: verde. O CRUD ainda usa `CommentAutomationConfigSchema` e compila; ele muda no Task 8.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/application/use-cases/comment-automation.ts packages/core/src/application/use-cases/comment-automation.test.ts
git commit -m "feat(core): motor da automação percorre o grafo (cursor de nó, mp2, compat v1)"
```

---

### Task 8: CRUD com fluxo, gatilhos e problemas

**Files:**
- Modify: `packages/core/src/application/use-cases/comment-automation.ts`: seção `// ---- CRUD`
- Modify: `packages/core/src/application/use-cases/comment-automation.test.ts`: `describe('CRUD')`

**Interfaces:**
- Consumes: `loadFlow`, `commentTriggerOf` (Task 7); `validateFlow`, `hasErrors` (Task 2); `FlowV2Schema`, `FlowTriggerInputSchema` (Task 1).
- Produces:

```ts
export interface AutomationTriggerView {
  /** `null` = gatilho ainda dentro da config v1 (sem linha na tabela) */
  id: string | null;
  kind: 'comment';
  config: CommentTriggerConfig;
  position: { x: number; y: number } | null;
}
export interface AutomationView extends Omit<AutomationRecord, 'config'> {
  flow: FlowV2 | null;
  triggers: AutomationTriggerView[];
  problems: FlowProblem[];
}
// makeAutomations:
//   create({ orgId, actor, channelId, name, flow: unknown, triggers?: unknown[], testUsernames?, status? })
//   update({ orgId, id, actor, name?, flow?: unknown, triggers?: unknown[], testUsernames? })
//   setStatus / remove / list / get / leads com as mesmas assinaturas de hoje
```

- [ ] **Step 1: Reescrever os testes de CRUD**

Substituir o `describe('CRUD', ...)` inteiro por:

```ts
describe('CRUD', () => {
  const canal = (over: Partial<ChannelRecord> = {}): ChannelRecord => ({
    id: CH,
    orgId: ORG,
    provider: 'instagram-standalone',
    externalId: '17841',
    name: 'Invista',
    username: 'invista',
    avatarUrl: null,
    status: 'ACTIVE',
    scopes: [],
    settings: {},
    tokenEnc: new Uint8Array(),
    refreshTokenEnc: null,
    tokenKeyVersion: 1,
    tokenExpiresAt: null,
    ...over,
  });
  function crud(canais = [canal()]) {
    const mem = memRepo();
    const audit: Array<Record<string, unknown>> = [];
    const svc = makeAutomations({
      repo: mem.repo,
      channels: { findMany: async (orgId, ids) => canais.filter((c) => c.orgId === orgId && ids.includes(c.id)) },
      audit: { append: async (e) => void audit.push(e) },
    });
    return { svc, audit, mem };
  }
  const ATOR = { type: 'USER' as const, id: 'u-1' };
  const SOLTO = { ...FLOW, edges: FLOW.edges.filter((x) => !(x.source === 'tipo' && x.sourceHandle === 'pf')) };

  test('cria em rascunho com fluxo normalizado, gatilho e auditoria', async () => {
    const { svc, audit, mem } = crud();
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: ' Cotação ', flow: FLOW, triggers: TRIGGER });
    expect(a).toMatchObject({ name: 'Cotação', status: 'DRAFT', problems: [] });
    expect(a.flow?.nodes[0]).toMatchObject({ data: { mode: 'text', disclosure: true } });
    expect(a.triggers).toEqual([{ id: expect.any(String), kind: 'comment', config: { mediaIds: [], keywords: ['plano'], publicReplies: [] }, position: null }]);
    expect(mem.triggers).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'automation.created', targetId: a.id });
  });

  test('automação v1 é lida como grafo, com o gatilho da config', async () => {
    const { svc, mem } = crud();
    const raw = await mem.repo.create({ orgId: ORG, channelId: CH, name: 'v1', status: 'ACTIVE', config: CONFIG, testUsernames: [], createdBy: null });
    const v = await svc.get(ORG, raw.id);
    expect(v.flow?.nodes.map((n) => n.id)).toEqual(['opening', 'q0', 'q1', 'finish', 'end']);
    expect(v.triggers).toEqual([{ id: null, kind: 'comment', config: { mediaIds: [], keywords: ['cotação'], publicReplies: ['Te chamei no direct!'] }, position: null }]);
    expect(v.problems.map((p) => p.code)).toEqual(['opening_button']);
  });

  test('canal de outra org → not_found; canal que não é Instagram → capability.disabled', async () => {
    const { svc } = crud([canal(), canal({ id: 'ch-x', provider: 'linkedin' })]);
    const e1 = await svc.create({ orgId: 'org-2', actor: ATOR, channelId: CH, name: 'x', flow: FLOW }).catch((e) => e);
    expect((e1 as DomainError).code).toBe('common.not_found');
    const e2 = await svc.create({ orgId: ORG, actor: ATOR, channelId: 'ch-x', name: 'x', flow: FLOW }).catch((e) => e);
    expect((e2 as DomainError).code).toBe('capability.disabled');
  });

  test('fluxo fora do formato → validation.invalid_request com os campos', async () => {
    const { svc } = crud();
    const bad = { ...FLOW, nodes: [{ ...FLOW.nodes[0], data: { text: 'x', buttonTitle: 'um título grande demais aqui' } }] };
    const e = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', flow: bad }).catch((err) => err);
    expect((e as DomainError).code).toBe('validation.invalid_request');
    expect(JSON.stringify((e as DomainError).detail)).toContain('buttonTitle');
  });

  test('rascunho salva com problema; Teste/Ativa com problema → automation.flow_invalid', async () => {
    const { svc } = crud();
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', flow: SOLTO, triggers: TRIGGER, testUsernames: ['iagovieira.ia'] });
    expect(a.problems).toContainEqual({ code: 'missing_edge', severity: 'error', nodeId: 'tipo', handle: 'pf' });
    const e = await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'TEST' }).catch((err) => err);
    expect((e as DomainError).code).toBe('automation.flow_invalid');
    expect((e as DomainError).detail?.problems).toBeArray();
    await svc.update({ orgId: ORG, id: a.id, actor: ATOR, flow: FLOW });
    expect((await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'TEST' })).status).toBe('TEST');
    const e2 = await svc.update({ orgId: ORG, id: a.id, actor: ATOR, flow: SOLTO }).catch((err) => err);
    expect((e2 as DomainError).code).toBe('automation.flow_invalid');
  });

  test('Teste/Ativa exigem gatilho', async () => {
    const { svc } = crud();
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', flow: FLOW, testUsernames: ['iagovieira.ia'] });
    const e = await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'TEST' }).catch((err) => err);
    expect((e as DomainError).code).toBe('validation.invalid_request');
  });

  test('aviso não bloqueia ativação', async () => {
    const { svc } = crud();
    const comBotao = { ...FLOW, nodes: [{ ...FLOW.nodes[0], data: { text: 'Oi!', mode: 'button' } }, ...FLOW.nodes.slice(1)] };
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', flow: comBotao, triggers: TRIGGER });
    const v = await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'ACTIVE' });
    expect(v.status).toBe('ACTIVE');
    expect(v.problems).toEqual([{ code: 'opening_button', severity: 'warning', nodeId: 'opening' }]);
  });

  test('modo teste exige conta de teste; usernames normalizados', async () => {
    const { svc } = crud();
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', flow: FLOW, triggers: TRIGGER });
    const e = await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'TEST' }).catch((err) => err);
    expect((e as DomainError).code).toBe('validation.invalid_request');
    await svc.update({ orgId: ORG, id: a.id, actor: ATOR, testUsernames: ['@IagoVieira.IA'] });
    const t = await svc.setStatus({ orgId: ORG, id: a.id, actor: ATOR, status: 'TEST' });
    expect(t).toMatchObject({ status: 'TEST', testUsernames: ['iagovieira.ia'] });
  });

  test('automação de outra org não é lida nem alterada', async () => {
    const { svc } = crud();
    const a = await svc.create({ orgId: ORG, actor: ATOR, channelId: CH, name: 'x', flow: FLOW });
    expect(((await svc.get('org-2', a.id).catch((e) => e)) as DomainError).code).toBe('common.not_found');
    expect(((await svc.update({ orgId: 'org-2', id: a.id, actor: ATOR, name: 'y' }).catch((e) => e)) as DomainError).code).toBe('common.not_found');
    expect(((await svc.remove({ orgId: 'org-2', id: a.id, actor: ATOR }).catch((e) => e)) as DomainError).code).toBe('common.not_found');
  });
});
```

`FLOW`, `TRIGGER` e `P` são os do `describe('fluxo v2')` do Task 7. Se aquele bloco foi declarado depois do CRUD, mova as três constantes para o topo do arquivo, junto de `CONFIG`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test packages/core/src/application/use-cases/comment-automation.test.ts -t CRUD`
Expected: FAIL (`flow` desconhecido em `create`).

- [ ] **Step 3: Reescrever a seção CRUD**

Em `comment-automation.ts`, substituir de `export interface AutomationView` até o fim de `makeAutomations` (`export type Automations = ...` fica) por:

```ts
export interface AutomationTriggerView {
  /** `null` = gatilho ainda dentro da config v1 (sem linha na tabela) */
  id: string | null;
  kind: 'comment';
  config: CommentTriggerConfig;
  position: { x: number; y: number } | null;
}

export interface AutomationView extends Omit<AutomationRecord, 'config'> {
  /** grafo v2 (v1 convertida na leitura); `null` = config gravada não passa mais na validação */
  flow: FlowV2 | null;
  triggers: AutomationTriggerView[];
  problems: FlowProblem[];
}

const invalid = (message: string, detail?: Record<string, unknown>) =>
  new DomainError(ErrorCodes.ValidationInvalidRequest, message, detail);

const issuesOf = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  e.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));

function parseFlow(raw: unknown): FlowV2 {
  const r = FlowV2Schema.safeParse(raw);
  if (!r.success) throw invalid('fluxo da automação inválido', { issues: issuesOf(r.error) });
  return r.data;
}

function parseTriggers(raw: unknown[]): AutomationTriggerInput[] {
  const r = z.array(FlowTriggerInputSchema).max(1, 'por enquanto, um gatilho por fluxo').safeParse(raw);
  if (!r.success) throw invalid('gatilho inválido', { issues: issuesOf(r.error) });
  return r.data.map((t) => ({ kind: t.kind, config: t.config, position: t.position }));
}

const flowInvalid = (problems: FlowProblem[]) =>
  new DomainError(ErrorCodes.AutomationFlowInvalid, 'o fluxo tem problemas que impedem testar ou ativar', { problems });

/** `@Fulano.X` → `fulano.x`; formato de username do Instagram */
function normalizeUsernames(list: string[]): string[] {
  const out = [...new Set(list.map((u) => u.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  if (out.length > 10) throw invalid('no máximo 10 contas de teste');
  const bad = out.find((u) => !/^[a-z0-9._]{1,30}$/.test(u));
  if (bad) throw invalid(`username de teste inválido: ${bad}`);
  return out;
}

function cleanName(name: string): string {
  const n = name.trim();
  if (n.length < 1 || n.length > 80) throw invalid('dê um nome de 1 a 80 caracteres');
  return n;
}

function triggerViews(a: AutomationRecord, rows: AutomationTriggerRecord[], loaded: LoadedFlow | null): AutomationTriggerView[] {
  const mine = rows.filter((t) => t.automationId === a.id && t.kind === 'comment');
  if (mine.length) {
    return mine.flatMap((t) => {
      const p = CommentTriggerConfigSchema.safeParse(t.config);
      return p.success ? [{ id: t.id, kind: 'comment' as const, config: p.data, position: t.position }] : [];
    });
  }
  return loaded?.legacy ? [{ id: null, kind: 'comment', config: triggerFromV1(loaded.legacy), position: null }] : [];
}

function view(a: AutomationRecord, rows: AutomationTriggerRecord[]): AutomationView {
  const { config, ...rest } = a;
  const loaded = loadFlow(config);
  return {
    ...rest,
    flow: loaded?.flow ?? null,
    triggers: triggerViews(a, rows, loaded),
    problems: loaded ? validateFlow(loaded.flow) : [],
  };
}

export const makeAutomations = (deps: AutomationsDeps) => {
  async function mustGet(orgId: string, id: string) {
    const a = await deps.repo.get(orgId, id);
    if (!a) throw new DomainError(ErrorCodes.NotFound, 'automação não encontrada');
    return a;
  }

  async function viewOf(a: AutomationRecord) {
    return view(a, await deps.repo.listTriggers([a.id]));
  }

  function assertTestable(status: AutomationStatus, testUsernames: string[]) {
    if (status === 'TEST' && testUsernames.length === 0) {
      throw invalid('o modo teste precisa de pelo menos uma conta de teste');
    }
  }

  /** Teste/Ativa: fluxo sem erro e com gatilho (avisos não bloqueiam) */
  function assertRunnable(v: AutomationView) {
    if (!v.flow) throw invalid('configuração da automação inválida');
    if (hasErrors(v.problems)) throw flowInvalid(v.problems);
    if (v.triggers.length === 0) throw invalid('a automação precisa de um gatilho para testar ou ativar');
  }

  const audit = (orgId: string, actor: AutomationActor, action: string, id: string, detail?: Record<string, unknown>) =>
    deps.audit
      .append({
        orgId,
        actorType: actor.type,
        actorId: actor.id,
        action,
        targetType: 'automation',
        targetId: id,
        ...(detail ? { detail } : {}),
        ip: actor.ip ?? null,
      })
      .catch(() => {});

  return {
    async list(orgId: string, filter?: { channelId?: string }) {
      const items = await deps.repo.list(orgId, filter);
      const rows = await deps.repo.listTriggers(items.map((a) => a.id));
      return items.map((a) => view(a, rows));
    },

    async get(orgId: string, id: string) {
      return viewOf(await mustGet(orgId, id));
    },

    async create(input: {
      orgId: string;
      actor: AutomationActor;
      channelId: string;
      name: string;
      flow: unknown;
      triggers?: unknown[];
      testUsernames?: string[];
      status?: AutomationStatus;
    }) {
      const [channel] = await deps.channels.findMany(input.orgId, [input.channelId]);
      if (!channel) throw new DomainError(ErrorCodes.NotFound, 'canal não encontrado');
      if (!(AUTOMATION_PROVIDERS as readonly string[]).includes(channel.provider)) {
        throw new DomainError(ErrorCodes.CapabilityDisabled, 'automação de comentários só existe para o Instagram');
      }
      const flow = parseFlow(input.flow);
      const triggers = parseTriggers(input.triggers ?? []);
      const testUsernames = normalizeUsernames(input.testUsernames ?? []);
      const status = input.status ?? 'DRAFT';
      assertTestable(status, testUsernames);
      // nascer em Teste/Ativa só com fluxo que roda — conferido antes de gravar
      if (status === 'TEST' || status === 'ACTIVE') {
        const at = new Date();
        const draft: AutomationRecord = {
          id: 'novo',
          orgId: input.orgId,
          channelId: channel.id,
          name: 'novo',
          status,
          config: flow,
          testUsernames,
          createdBy: null,
          createdAt: at,
          updatedAt: at,
        };
        const rows = triggers.map((t, i) => ({
          ...t,
          id: `novo-${i}`,
          orgId: input.orgId,
          automationId: 'novo',
          channelId: channel.id,
          createdAt: at,
        }));
        assertRunnable(view(draft, rows));
      }
      const a = await deps.repo.create({
        orgId: input.orgId,
        channelId: channel.id,
        name: cleanName(input.name),
        status,
        config: flow,
        testUsernames,
        createdBy: input.actor.type === 'USER' ? input.actor.id : null,
        triggers,
      });
      await audit(input.orgId, input.actor, 'automation.created', a.id, { status });
      return viewOf(a);
    },

    async update(input: {
      orgId: string;
      id: string;
      actor: AutomationActor;
      name?: string;
      flow?: unknown;
      triggers?: unknown[];
      testUsernames?: string[];
    }) {
      const current = await mustGet(input.orgId, input.id);
      const testUsernames = input.testUsernames ? normalizeUsernames(input.testUsernames) : current.testUsernames;
      assertTestable(current.status, testUsernames);
      const flow = input.flow !== undefined ? parseFlow(input.flow) : undefined;
      const triggers = input.triggers !== undefined ? parseTriggers(input.triggers) : undefined;

      // em Teste/Ativa, o que vai ser gravado já tem de rodar
      if (current.status === 'TEST' || current.status === 'ACTIVE') {
        const draft: AutomationRecord = { ...current, ...(flow ? { config: flow } : {}) };
        const rows = triggers
          ? triggers.map((t, i) => ({ ...t, id: `novo-${i}`, orgId: current.orgId, automationId: current.id, channelId: current.channelId, createdAt: new Date() }))
          : await deps.repo.listTriggers([current.id]);
        assertRunnable(view(draft, rows));
      }

      const a = await deps.repo.update(
        input.orgId,
        input.id,
        {
          ...(input.name !== undefined ? { name: cleanName(input.name) } : {}),
          ...(flow ? { config: flow } : {}),
          ...(input.testUsernames ? { testUsernames } : {}),
        },
        triggers,
      );
      if (!a) throw new DomainError(ErrorCodes.NotFound, 'automação não encontrada');
      await audit(input.orgId, input.actor, 'automation.updated', a.id);
      return viewOf(a);
    },

    async setStatus(input: { orgId: string; id: string; actor: AutomationActor; status: AutomationStatus }) {
      const current = await mustGet(input.orgId, input.id);
      assertTestable(input.status, current.testUsernames);
      if (input.status === 'ACTIVE' || input.status === 'TEST') assertRunnable(await viewOf(current));
      const a = await deps.repo.update(input.orgId, input.id, { status: input.status });
      if (!a) throw new DomainError(ErrorCodes.NotFound, 'automação não encontrada');
      await audit(input.orgId, input.actor, 'automation.status', a.id, { from: current.status, to: input.status });
      return viewOf(a);
    },

    async remove(input: { orgId: string; id: string; actor: AutomationActor }) {
      if (!(await deps.repo.softDelete(input.orgId, input.id))) {
        throw new DomainError(ErrorCodes.NotFound, 'automação não encontrada');
      }
      await audit(input.orgId, input.actor, 'automation.deleted', input.id);
    },

    /** execuções como leads, com o nome da automação */
    async leads(
      orgId: string,
      filter: { automationId?: string; status?: AutomationRunStatus; cursor?: string; limit: number },
    ) {
      const [page, automations] = await Promise.all([deps.repo.listRuns(orgId, filter), deps.repo.list(orgId)]);
      const names = new Map(automations.map((a) => [a.id, a.name]));
      return {
        items: page.items.map((r) => ({ ...r, automationName: names.get(r.automationId) ?? null })),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  };
};
```

Ajustes de import nesta etapa:

- de `@manypost/contracts`: `FlowV2Schema`, `FlowTriggerInputSchema` e o tipo `FlowProblem`;
- `CommentAutomationConfigSchema`, `parseConfig` e `tryConfig` saem, porque ninguém mais usa;
- `import { z } from 'zod';`: confira se `packages/core/package.json` lista `zod`. Se não listar, troque a validação da lista por um laço manual: rejeite se `raw.length > 1` e aplique `FlowTriggerInputSchema.safeParse` em cada item. Não adicione dependência;
- de `../../domain/automation/flow-validate`: `validateFlow`, `hasErrors`;
- de `../ports/automation`: o tipo `AutomationTriggerInput`;
- `loadFlow`, `commentTriggerOf` e `LoadedFlow` estão no mesmo arquivo. Mova a seção `// ---- fluxo carregado` para **antes** da seção CRUD, para a leitura do arquivo seguir a ordem de uso.

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test packages/core && bun run typecheck`
Expected: PASS. O typecheck pode acusar erro em `apps/api` (rotas ainda mandam `config`). Isso é esperado e se resolve no Task 9; anote e siga.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): CRUD de automação com fluxo, gatilhos e bloqueio por problemas"
```

---

### Task 9: API

**Files:**
- Modify: `apps/api/src/http/routes/automations.routes.ts`
- Modify: `apps/api/src/http/routes/automations.routes.test.ts`
- Regenerate: `apps/web/openapi.json`, `apps/web/src/lib/api/schema.d.ts`

**Interfaces:**
- Consumes: `AutomationView` (Task 8).
- Produces:
  - **`GET /v1/automations`, `GET /v1/automations/{id}` e respostas de escrita:** `{ id, channelId, name, status, flow: FlowV2 | null, triggers: TriggerView[], problems: FlowProblem[], testUsernames, createdBy, createdAt, updatedAt }`.
  - **`POST /`:** corpo `{ channelId, name, flow, triggers?, testUsernames? }`.
  - **`PATCH /{id}`:** corpo `{ name?, flow?, triggers?, testUsernames? }`.
  - **`POST /{id}/status`:** sem mudança.

- [ ] **Step 1: Atualizar os testes de rota**

Em `automations.routes.test.ts`:

- trocar `CONFIG` por um fluxo mínimo e um gatilho:

```ts
const FLOW = {
  version: 2,
  nodes: [
    { id: 'opening', type: 'opening', position: { x: 0, y: 0 }, data: { text: 'Oi!' } },
    { id: 'fim', type: 'end', position: { x: 0, y: 160 }, data: {} },
  ],
  edges: [{ id: 'e1', source: 'opening', sourceHandle: 'next', target: 'fim' }],
};
const TRIGGERS = [{ kind: 'comment', config: { keywords: ['plano'] } }];
```

- no `view` do `makeApp`, trocar `config: null` por `flow: null, triggers: [], problems: []`;
- trocar os testes `'cria com a org do principal...'` e `'configuração fora do contrato...'` por:

```ts
  it('cria com a org do principal, repassa fluxo e gatilho e devolve datas ISO', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request('/', req('POST', { channelId: CH, name: 'Cotação', flow: FLOW, triggers: TRIGGERS }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { createdAt: string; problems: unknown[]; triggers: unknown[] };
    expect(body.createdAt).toBe('2026-10-12T12:00:00.000Z');
    expect(body.problems).toEqual([]);
    expect(chamadas[0]?.input).toMatchObject({ orgId: 'org-1', channelId: CH, actor: { type: 'USER', id: 'user-1' }, flow: { version: 2 } });
    expect((chamadas[0]?.input as { triggers: Array<{ config: { publicReplies: string[] } }> }).triggers[0]!.config.publicReplies).toEqual([]);
  });

  it('fluxo fora do contrato → 400 sem chamar o caso de uso', async () => {
    const { app, chamadas } = makeApp();
    const bad = { ...FLOW, nodes: [{ ...FLOW.nodes[0], data: { text: 'Oi!', buttonTitle: 'um título grande demais aqui' } }] };
    const res = await app.request('/', req('POST', { channelId: CH, name: 'x', flow: bad }));
    expect(res.status).toBe(400);
    expect(chamadas).toEqual([]);
  });

  it('mais de um gatilho → 400', async () => {
    const { app, chamadas } = makeApp();
    const res = await app.request('/', req('POST', { channelId: CH, name: 'x', flow: FLOW, triggers: [...TRIGGERS, ...TRIGGERS] }));
    expect(res.status).toBe(400);
    expect(chamadas).toEqual([]);
  });

  it('problema de fluxo vira 400 automation.flow_invalid com a lista', async () => {
    const { DomainError } = await import('@manypost/core');
    const problems = [{ code: 'missing_edge', severity: 'error', nodeId: 'm', handle: 'b' }];
    const rota = automationRoutes({
      auth: {
        authenticateHuman: async () => ({ userId: 'user-1', orgId: 'org-1', role: 'ADMIN' }),
        verifyApiKey: async () => null,
      },
      automation: {
        automations: {
          setStatus: async () => {
            throw new DomainError('automation.flow_invalid', 'o fluxo tem problemas', { problems });
          },
        },
      },
    } as unknown as Container);
    rota.onError(errorHandler);
    const res = await rota.request(`/${ID}/status`, req('POST', { status: 'ACTIVE' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { title: string; extra: { problems: unknown[] } };
    expect(body.title).toBe('automation.flow_invalid');
    expect(body.extra.problems).toEqual(problems);
  });
```


- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test apps/api/src/http/routes/automations.routes.test.ts`
Expected: FAIL (corpo com `flow` recusado ou não repassado).

- [ ] **Step 3: Atualizar as rotas**

Em `automations.routes.ts`:

- imports de `@manypost/contracts`: `AutomationRunStatuses`, `AutomationStatuses`, `CommentTriggerConfigSchema`, `FlowProblemCodes`, `FlowTriggerInputSchema`, `FlowV2Schema` (sai `CommentAutomationConfigSchema`);
- trocar os schemas do topo por:

```ts
const IdParam = z.object({ id: z.string().uuid() });
const Flow = FlowV2Schema.openapi?.('AutomationFlow') ?? FlowV2Schema;
const TriggerInput = FlowTriggerInputSchema.openapi?.('AutomationTriggerInput') ?? FlowTriggerInputSchema;
const Triggers = z.array(TriggerInput).max(1);

const CreateBody = z.object({
  channelId: z.string().uuid(),
  name: z.string().min(1).max(80),
  flow: Flow,
  triggers: Triggers.optional(),
  testUsernames: z.array(z.string().max(31)).max(10).optional(),
});
const UpdateBody = z.object({
  name: z.string().min(1).max(80).optional(),
  flow: Flow.optional(),
  triggers: Triggers.optional(),
  testUsernames: z.array(z.string().max(31)).max(10).optional(),
});
```

- no schema de resposta `Automation`, trocar o campo `config` por:

```ts
    // schema sem nome aqui: `.nullable()` sobre o componente nomeado o tornaria anulável também no corpo
    flow: FlowV2Schema.nullable().openapi({ description: '`null` = configuração gravada não passa mais na validação' }),
    triggers: z.array(
      z.object({
        id: z.string().nullable(),
        kind: z.literal('comment'),
        config: CommentTriggerConfigSchema,
        position: z.object({ x: z.number(), y: z.number() }).nullable(),
      }),
    ),
    problems: z.array(
      z.object({
        code: z.enum(FlowProblemCodes),
        severity: z.enum(['error', 'warning']),
        nodeId: z.string().optional(),
        handle: z.string().optional(),
      }),
    ),
```

- em `out`, trocar `config: a.config,` por `flow: a.flow, triggers: a.triggers, problems: a.problems,`;
- no `POST /`, trocar `config: b.config,` por `flow: b.flow, ...(b.triggers ? { triggers: b.triggers } : {}),`;
- no `PATCH /:id`, trocar `...(b.config !== undefined ? { config: b.config } : {}),` por:

```ts
      ...(b.flow !== undefined ? { flow: b.flow } : {}),
      ...(b.triggers !== undefined ? { triggers: b.triggers } : {}),
```

- atualizar o `summary` do PATCH para `'Edita nome, fluxo, gatilho ou contas de teste'`.

- [ ] **Step 4: Rodar e ver passar**

Run: `bun test apps/api && bun run typecheck`
Expected: PASS e typecheck verde no root.

- [ ] **Step 5: Regenerar o cliente da web**

Com o `.env` de desenvolvimento e o Postgres local de pé:

```bash
bun run dev &                                   # API em :3100
sleep 8
API_URL=http://localhost:3100 bun run --cwd apps/web generate:api
kill %1
git diff --stat apps/web/openapi.json apps/web/src/lib/api/schema.d.ts
```

Expected: o diff mostra `AutomationFlow`, `triggers` e `problems` no componente `CommentAutomation`, e o status `ABANDONED` em `AutomationLead`. Não edite esses arquivos à mão.

Run: `bun run typecheck:web`
Expected: FALHA em `features/automation/*`, porque `hooks.ts` e `builder-view.tsx` ainda usam `config`. Isso se resolve nos Tasks 10 a 12. **Não** conserte `builder-view.tsx`: ele será apagado.

- [ ] **Step 6: Commit**

```bash
git add apps/api apps/web/openapi.json apps/web/src/lib/api/schema.d.ts
git commit -m "feat(api): rotas de automação com fluxo, gatilhos e problemas"
```

---

### Task 10: Lógica do fluxo na web (espelho + helpers do editor)

**Files:**
- Create: `apps/web/src/features/automation/flow/logic.ts`
- Create: `apps/web/src/features/automation/flow/logic.test.ts`
- Create: `apps/web/src/features/automation/flow/history.ts`
- Create: `apps/web/src/features/automation/flow/history.test.ts`

**Interfaces:**
- Consumes: `LIMITS`, `TEXT_VALIDATIONS`, `TextValidation`, `normalize`, `renderTemplate`, `fieldFromPrompt` de `../logic` (já existem); fixtures do Task 5.
- Produces (`flow/logic.ts`):
  - **Tipos:** `Flow`, `FlowNode`, `NodeOf<T>`, `FlowEdge`, `Position`, `TriggerConfig`, `Problem`, `ShapeKey`, `ShapeIssue`, `SimMessage`, `SimState`, `SimInput`, `BlockKind`, `NodeTexts`.
  - **Constantes:** `FLOW_NODE_TYPES`, `OPENING_MODES`, `MESSAGE_FORMATS`, `ON_TYPED_MODES`, `CONDITION_OPS`, `PROBLEM_CODES`, `FLOW_ID_RE`, `FIELD_RE`, `TRIGGER_NODE_ID`, `OPENING_TEXT_HINT`, `OPENING_DISCLOSURE`.
  - **Leitura do fluxo:** `normalizeFlow(raw)`, `handlesOf(node)`, `outputsOf(node)`, `waits(node)`, `targetOf(flow, src, handle)`, `fieldsWritten(flow)`.
  - **Validação:** `validateFlow(flow)`, `shapeIssues(flow)`, `triggerIssues(trigger)`.
  - **Mensagens e simulação:** `messageFor(node, ctx)`, `startSim(flow, opts)`, `sendSim(state, input)`, `tapForTitle(flow, nodeId, title)`, `simulateFlow(flow, inputs, opts)`.
  - **Edição:** `emptyFlow(texts)`, `defaultTrigger()`, `createNode(kind, position, flow, texts, username)`, `addNode`, `moveNode`, `updateNodeData`, `connect`, `removeNode`, `removeEdge`, `duplicateNode`, `addOption`, `removeOption`, `profileUrl`.
- Produces (`flow/history.ts`): `historyInit(v)`, `historySet(h, next, merge)`, `historySeal(h)`, `historyUndo(h)`, `historyRedo(h)`, `historyMarkSaved(h)` (puras), `useFlowHistory(initial)`.

- [ ] **Step 1: Escrever os testes de lógica**

`apps/web/src/features/automation/flow/logic.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import {
  FlowConditionOps,
  FlowMessageFormats,
  FlowNodeTypes,
  FlowOnTypedModes,
  FlowOpeningModes,
  FlowProblemCodes,
  FlowV2Schema,
} from '@manypost/contracts';
import {
  CONDITION_OPS,
  FLOW_NODE_TYPES,
  MESSAGE_FORMATS,
  ON_TYPED_MODES,
  OPENING_MODES,
  PROBLEM_CODES,
  addOption,
  connect,
  createNode,
  duplicateNode,
  emptyFlow,
  normalizeFlow,
  removeNode,
  removeOption,
  shapeIssues,
  simulateFlow,
  updateNodeData,
  validateFlow,
  type NodeTexts,
} from './logic';

const TEXTS: NodeTexts = {
  opening: 'Oi! Vi seu comentário.',
  askName: 'Qual é o seu nome?',
  thanks: 'Obrigado, {nome}!',
  message: 'Escolha:',
  option: 'Opção',
  question: 'Sua resposta?',
  end: 'Obrigado!',
  link: 'Toque abaixo.',
  linkButton: 'Abrir',
  follow: 'Segue a gente.',
  followButton: 'Seguir',
};

describe('paridade com @manypost/contracts', () => {
  test('vocabulário igual', () => {
    expect([...FLOW_NODE_TYPES]).toEqual([...FlowNodeTypes]);
    expect([...OPENING_MODES]).toEqual([...FlowOpeningModes]);
    expect([...MESSAGE_FORMATS]).toEqual([...FlowMessageFormats]);
    expect([...ON_TYPED_MODES]).toEqual([...FlowOnTypedModes]);
    expect([...CONDITION_OPS]).toEqual([...FlowConditionOps]);
    expect([...PROBLEM_CODES]).toEqual([...FlowProblemCodes]);
  });

  test('o fluxo inicial passa no schema da API e não tem problemas', () => {
    const f = emptyFlow(TEXTS);
    expect(FlowV2Schema.safeParse(f).success).toBe(true);
    expect(validateFlow(f)).toEqual([]);
    expect(shapeIssues(f)).toEqual([]);
  });

  test('todo bloco novo passa no schema (WhatsApp com telefone preenchido)', () => {
    let f = emptyFlow(TEXTS);
    for (const kind of ['message', 'question', 'condition', 'link', 'follow', 'end'] as const) {
      let n = createNode(kind, { x: 10, y: 20 }, f, TEXTS, 'sua.conta');
      if (n.type === 'link' && n.data.target.kind === 'whatsapp') {
        n = { ...n, data: { ...n.data, target: { kind: 'whatsapp', phone: '5592999990000', message: '' } } };
      }
      if (n.type === 'condition') n = { ...n, data: { ...n.data, field: 'nome' } };
      f = { ...f, nodes: [...f.nodes, n] };
    }
    expect(FlowV2Schema.safeParse(f).success).toBe(true);
    expect(f.nodes.find((n) => n.id.startsWith('seguir'))).toMatchObject({
      type: 'link',
      data: { target: { kind: 'url', url: 'https://instagram.com/sua.conta' }, buttonTitle: 'Seguir' },
    });
  });
});

describe('fixtures compartilhadas com o core', () => {
  const DIR = new URL('../../../../../../testdata/automation-flows/', import.meta.url);
  for (const file of readdirSync(DIR).filter((x) => x.endsWith('.json')).sort()) {
    const fx = JSON.parse(readFileSync(new URL(file, DIR), 'utf8'));
    test(`${file}: ${fx.name}`, () => {
      const flow = normalizeFlow(fx.flow);
      expect(validateFlow(flow)).toEqual(fx.expect.problems ?? []);
      if (fx.expect.messages) {
        const r = simulateFlow(flow, fx.inputs ?? [], { username: fx.username ?? null });
        expect(r.messages).toEqual(fx.expect.messages);
        expect(r.status).toBe(fx.expect.status);
        if (fx.expect.answers) expect(r.answers).toEqual(fx.expect.answers);
      }
    });
  }
});

describe('edição', () => {
  test('ligar substitui a saída e recusa ligar na abertura ou em si mesmo', () => {
    let f = emptyFlow(TEXTS);
    const end = createNode('end', { x: 0, y: 0 }, f, TEXTS, null);
    f = { ...f, nodes: [...f.nodes, end] };
    f = connect(f, { source: 'opening', sourceHandle: 'next', target: end.id });
    expect(f.edges.filter((e) => e.source === 'opening')).toEqual([
      { id: 'e-opening-next', source: 'opening', sourceHandle: 'next', target: end.id },
    ]);
    expect(connect(f, { source: end.id, sourceHandle: 'next', target: 'opening' })).toBe(f);
    expect(connect(f, { source: 'nome', sourceHandle: 'next', target: 'nome' })).toBe(f);
  });

  test('abertura não sai; remover nó leva as ligações junto', () => {
    const f = emptyFlow(TEXTS);
    expect(removeNode(f, 'opening')).toBe(f);
    const g = removeNode(f, 'nome');
    expect(g.nodes.map((n) => n.id)).toEqual(['opening', 'fim']);
    expect(g.edges).toEqual([]);
  });

  test('opções: adicionar respeita o limite, remover apaga a ligação, formato sem botões limpa', () => {
    let f = emptyFlow(TEXTS);
    const m = createNode('message', { x: 0, y: 0 }, f, TEXTS, null);
    f = { ...f, nodes: [...f.nodes, m] };
    f = addOption(addOption(addOption(f, m.id, 'Mais'), m.id, 'Outra'), m.id, 'Quarta');
    const opts = () => (f.nodes.find((n) => n.id === m.id) as Extract<typeof m, { type: 'message' }>).data.options;
    expect(opts()).toHaveLength(3);
    f = connect(f, { source: m.id, sourceHandle: opts()[1]!.id, target: 'fim' });
    f = removeOption(f, m.id, opts()[1]!.id);
    expect(f.edges.some((e) => e.source === m.id)).toBe(false);
    f = connect(f, { source: m.id, sourceHandle: opts()[0]!.id, target: 'fim' });
    f = updateNodeData(f, m.id, { format: 'none', options: [] });
    expect(f.edges.some((e) => e.source === m.id)).toBe(false);
  });

  test('duplicar gera id novo, desloca e copia só as saídas', () => {
    const f = emptyFlow(TEXTS);
    const r = duplicateNode(f, 'nome');
    const copy = r.flow.nodes.find((n) => n.id === r.id)!;
    expect(r.id).not.toBe('nome');
    expect(copy.position).toEqual({ x: 360 + 48, y: 48 });
    expect(r.flow.edges.filter((e) => e.target === r.id)).toEqual([]);
    expect(r.flow.edges.filter((e) => e.source === r.id).map((e) => e.target)).toEqual(['fim']);
    expect(duplicateNode(f, 'opening').flow).toBe(f);
  });

  test('shapeIssues aponta botão longo, telefone e campo inválidos', () => {
    let f = emptyFlow(TEXTS);
    const m = createNode('message', { x: 0, y: 0 }, f, TEXTS, null);
    const l = createNode('link', { x: 0, y: 0 }, f, TEXTS, null);
    f = { ...f, nodes: [...f.nodes, m, l] };
    f = updateNodeData(f, m.id, { options: [{ id: 'o1', title: 'x'.repeat(21) }], saveTo: 'Plano' });
    expect(shapeIssues(f)).toEqual([
      { nodeId: m.id, key: 'optionTitleInvalid' },
      { nodeId: m.id, key: 'fieldInvalid' },
      { nodeId: l.id, key: 'phoneInvalid' },
    ]);
  });
});
```

`apps/web/src/features/automation/flow/history.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { historyInit, historyMarkSaved, historyRedo, historySeal, historySet, historyUndo } from './history';

describe('histórico do editor', () => {
  test('desfaz e refaz; nova edição apaga o futuro', () => {
    let h = historyInit(1);
    h = historySet(h, 2, false);
    h = historySet(h, 3, false);
    h = historyUndo(h);
    expect(h.present).toBe(2);
    h = historyRedo(h);
    expect(h.present).toBe(3);
    h = historyUndo(h);
    h = historySet(h, 9, false);
    expect(h.future).toEqual([]);
    expect(h.past).toEqual([1, 2]);
  });

  test('digitação e arraste viram um passo só até selar', () => {
    let h = historyInit('a');
    h = historySet(h, 'ab', true);
    h = historySet(h, 'abc', true);
    h = historySeal(h);
    h = historySet(h, 'abcd', true);
    expect(h.past).toEqual(['a', 'abc']);
    expect(historyUndo(h).present).toBe('abc');
  });

  test('limite de 50 passos e marca de salvo', () => {
    let h = historyInit(0);
    for (let i = 1; i <= 60; i++) h = historySet(h, i, false);
    expect(h.past).toHaveLength(50);
    expect(h.saved).toBe(0);
    h = historyMarkSaved(h);
    expect(h.saved).toBe(60);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test apps/web/src/features/automation/flow/`
Expected: FAIL com `Cannot find module './logic'` e `'./history'`.

- [ ] **Step 3: Escrever `flow/history.ts`**

```ts
'use client';

import { useCallback, useState } from 'react';

/** Histórico de desfazer/refazer do editor (design D8): até 50 passos; digitação e arraste se fundem. */

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** passo aberto por digitação/arraste: as próximas mudanças substituem o presente */
  merging: boolean;
  /** último estado salvo na API */
  saved: T;
}

const LIMIT = 50;

export const historyInit = <T>(v: T): History<T> => ({ past: [], present: v, future: [], merging: false, saved: v });

export function historySet<T>(h: History<T>, next: T, merge: boolean): History<T> {
  if (merge && h.merging) return { ...h, present: next, future: [] };
  return { ...h, past: [...h.past, h.present].slice(-LIMIT), present: next, future: [], merging: merge };
}

export const historySeal = <T>(h: History<T>): History<T> => (h.merging ? { ...h, merging: false } : h);

export function historyUndo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { ...h, past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future], merging: false };
}

export function historyRedo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { ...h, past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1), merging: false };
}

export const historyMarkSaved = <T>(h: History<T>): History<T> => ({ ...h, saved: h.present, merging: false });

export function useFlowHistory<T>(initial: T) {
  const [h, setH] = useState(() => historyInit(initial));
  const set = useCallback((next: T, opts?: { merge?: boolean }) => setH((s) => historySet(s, next, Boolean(opts?.merge))), []);
  const seal = useCallback(() => setH(historySeal), []);
  const undo = useCallback(() => setH(historyUndo), []);
  const redo = useCallback(() => setH(historyRedo), []);
  const markSaved = useCallback(() => setH(historyMarkSaved), []);
  const dirty = h.present !== h.saved && JSON.stringify(h.present) !== JSON.stringify(h.saved);
  return {
    present: h.present,
    set,
    seal,
    undo,
    redo,
    markSaved,
    dirty,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
  };
}
```

- [ ] **Step 4: Escrever `flow/logic.ts`**

```ts
import { LIMITS, type TextValidation, fieldFromPrompt, normalize, renderTemplate } from '../logic';

/**
 * Fluxo v2 no editor (openspec add-flow-builder-canvas, design D8). Repete o formato, a validação e o
 * passo do motor de `packages/core/src/domain/automation/` porque `apps/web` não carrega o core no
 * bundle. A paridade é assertada em `logic.test.ts` com as fixtures de `testdata/automation-flows/`.
 * A API valida de novo — aqui é para orientar quem edita e para o simulador.
 */

export const FLOW_NODE_TYPES = ['opening', 'message', 'question', 'condition', 'link', 'end'] as const;
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];
export const OPENING_MODES = ['text', 'button'] as const;
export const MESSAGE_FORMATS = ['none', 'buttons', 'quick'] as const;
export const ON_TYPED_MODES = ['reask', 'branch'] as const;
export const CONDITION_OPS = ['equals', 'contains', 'filled', 'empty'] as const;
export const PROBLEM_CODES = [
  'unreachable',
  'missing_edge',
  'wait_free_cycle',
  'unknown_field',
  'no_finish',
  'opening_button',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];
export const FLOW_ID_RE = /^[a-z0-9_-]{1,24}$/;
export const FIELD_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const TRIGGER_NODE_ID = 'trigger';
export const OPENING_TEXT_HINT = 'Responda esta mensagem para continuar.';
export const OPENING_DISCLOSURE = 'Mensagem automática.';
const MAX_REASKS = 1;
const MAX_AUTO_STEPS = 20;

export interface Position {
  x: number;
  y: number;
}
interface Base<T extends FlowNodeType, D> {
  id: string;
  type: T;
  position: Position;
  data: D;
}
export type LinkTarget = { kind: 'whatsapp'; phone: string; message: string } | { kind: 'url'; url: string };
export type FlowNode =
  | Base<'opening', { text: string; mode: (typeof OPENING_MODES)[number]; buttonTitle: string; disclosure: boolean }>
  | Base<
      'message',
      {
        text: string;
        format: (typeof MESSAGE_FORMATS)[number];
        options: Array<{ id: string; title: string }>;
        saveTo?: string;
        onTyped: (typeof ON_TYPED_MODES)[number];
      }
    >
  | Base<'question', { text: string; field: string; validate: TextValidation }>
  | Base<'condition', { field: string; op: (typeof CONDITION_OPS)[number]; value: string }>
  | Base<'link', { text: string; buttonTitle: string; target: LinkTarget }>
  | Base<'end', { text: string }>;
export type NodeOf<T extends FlowNodeType> = Extract<FlowNode, { type: T }>;
export interface FlowEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
}
export interface Flow {
  version: 2;
  nodes: FlowNode[];
  edges: FlowEdge[];
}
export interface TriggerConfig {
  mediaIds: string[];
  keywords: string[];
  publicReplies: string[];
}
export interface Problem {
  code: ProblemCode;
  severity: 'error' | 'warning';
  nodeId?: string;
  handle?: string;
}

// ---------------------------------------------------------------- leitura

type Raw = Record<string, unknown>;
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

/** aplica os padrões do schema (a API já devolve normalizado; as fixtures não) */
export function normalizeFlow(raw: { nodes?: unknown[]; edges?: unknown[] }): Flow {
  const nodes = (raw.nodes ?? []).map((x): FlowNode => {
    const n = x as Raw;
    const d = (n.data ?? {}) as Raw;
    const base = { id: str(n.id), position: (n.position as Position) ?? { x: 0, y: 0 } };
    switch (n.type as FlowNodeType) {
      case 'opening':
        return {
          ...base,
          type: 'opening',
          data: {
            text: str(d.text),
            mode: (d.mode as 'text' | 'button') ?? 'text',
            buttonTitle: str(d.buttonTitle, 'Quero!'),
            disclosure: d.disclosure === undefined ? true : Boolean(d.disclosure),
          },
        };
      case 'message':
        return {
          ...base,
          type: 'message',
          data: {
            text: str(d.text),
            format: (d.format as 'none' | 'buttons' | 'quick') ?? 'buttons',
            options: ((d.options as Array<{ id: string; title: string }>) ?? []).map((o) => ({ id: o.id, title: o.title })),
            ...(typeof d.saveTo === 'string' && d.saveTo ? { saveTo: d.saveTo } : {}),
            onTyped: (d.onTyped as 'reask' | 'branch') ?? 'reask',
          },
        };
      case 'question':
        return { ...base, type: 'question', data: { text: str(d.text), field: str(d.field), validate: (d.validate as TextValidation) ?? 'free' } };
      case 'condition':
        return {
          ...base,
          type: 'condition',
          data: { field: str(d.field), op: (d.op as NodeOf<'condition'>['data']['op']) ?? 'filled', value: str(d.value) },
        };
      case 'link': {
        const t = (d.target ?? {}) as Raw;
        const target: LinkTarget =
          t.kind === 'url' ? { kind: 'url', url: str(t.url) } : { kind: 'whatsapp', phone: str(t.phone), message: str(t.message) };
        return { ...base, type: 'link', data: { text: str(d.text), buttonTitle: str(d.buttonTitle, 'Abrir'), target } };
      }
      default:
        return { ...base, type: 'end', data: { text: str(d.text) } };
    }
  });
  const edges = (raw.edges ?? []).map((x) => {
    const e = x as FlowEdge;
    return { id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target };
  });
  return { version: 2, nodes, edges };
}

export function handlesOf(n: FlowNode): string[] {
  switch (n.type) {
    case 'opening':
    case 'question':
    case 'link':
      return ['next'];
    case 'message':
      return n.data.format === 'none' ? ['next'] : [...n.data.options.map((o) => o.id), 'typed'];
    case 'condition':
      return ['yes', 'no'];
    case 'end':
      return [];
  }
}

export function outputsOf(n: FlowNode): Array<{ handle: string; required: boolean }> {
  switch (n.type) {
    case 'opening':
    case 'question':
      return [{ handle: 'next', required: true }];
    case 'message':
      if (n.data.format === 'none') return [{ handle: 'next', required: true }];
      return [
        ...n.data.options.map((o) => ({ handle: o.id, required: true })),
        { handle: 'typed', required: n.data.onTyped === 'branch' },
      ];
    case 'condition':
      return [
        { handle: 'yes', required: true },
        { handle: 'no', required: true },
      ];
    case 'link':
      return [{ handle: 'next', required: false }];
    case 'end':
      return [];
  }
}

export const waits = (n: FlowNode) =>
  n.type === 'opening' || n.type === 'question' || (n.type === 'message' && n.data.format !== 'none');

const nodeById = (flow: Flow, id: string | null) => (id ? (flow.nodes.find((n) => n.id === id) ?? null) : null);

export const targetOf = (flow: Flow, source: string, handle: string) =>
  flow.edges.find((e) => e.source === source && e.sourceHandle === handle)?.target ?? null;

export function fieldsWritten(flow: Flow): Set<string> {
  const out = new Set<string>();
  for (const n of flow.nodes) {
    if (n.type === 'question' && n.data.field) out.add(n.data.field);
    if (n.type === 'message' && n.data.saveTo) out.add(n.data.saveTo);
  }
  return out;
}

// ---------------------------------------------------------------- validação (espelho do core)

export function validateFlow(flow: Flow): Problem[] {
  const out: Problem[] = [];
  const opening = flow.nodes.find((n) => n.type === 'opening');
  if (!opening) return out;
  const seen = new Set<string>([opening.id]);
  const queue = [opening.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of flow.edges) {
      if (e.source === id && !seen.has(e.target)) {
        seen.add(e.target);
        queue.push(e.target);
      }
    }
  }
  for (const n of flow.nodes) if (!seen.has(n.id)) out.push({ code: 'unreachable', severity: 'error', nodeId: n.id });
  for (const n of flow.nodes) {
    if (!seen.has(n.id)) continue;
    for (const o of outputsOf(n)) {
      if (o.required && !targetOf(flow, n.id, o.handle)) out.push({ code: 'missing_edge', severity: 'error', nodeId: n.id, handle: o.handle });
    }
  }
  const free = new Set(flow.nodes.filter((n) => !waits(n)).map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const e of flow.edges) if (free.has(e.source) && free.has(e.target)) adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  const color = new Map<string, 1 | 2>();
  const loops = new Set<string>();
  const visit = (u: string) => {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v);
      if (c === 1) loops.add(v);
      else if (!c) visit(v);
    }
    color.set(u, 2);
  };
  for (const id of free) if (!color.has(id)) visit(id);
  for (const id of loops) out.push({ code: 'wait_free_cycle', severity: 'error', nodeId: id });
  const fields = fieldsWritten(flow);
  for (const n of flow.nodes) if (n.type === 'condition' && !fields.has(n.data.field)) out.push({ code: 'unknown_field', severity: 'error', nodeId: n.id });
  if (!flow.nodes.some((n) => seen.has(n.id) && (n.type === 'end' || n.type === 'link'))) out.push({ code: 'no_finish', severity: 'error' });
  if (opening.type === 'opening' && opening.data.mode === 'button') out.push({ code: 'opening_button', severity: 'warning', nodeId: opening.id });
  return out;
}

export type ShapeKey =
  | 'textRequired'
  | 'textTooLong'
  | 'optionCount'
  | 'optionTitleInvalid'
  | 'buttonTitleInvalid'
  | 'fieldInvalid'
  | 'valueRequired'
  | 'valueTooLong'
  | 'phoneInvalid'
  | 'urlInvalid'
  | 'tooManyNodes'
  | 'triggerKeywords'
  | 'triggerReplies';
export interface ShapeIssue {
  nodeId: string | null;
  key: ShapeKey;
}

const validTitle = (t: string) => t.trim().length >= 1 && t.trim().length <= LIMITS.buttonTitle;

/** o que a API recusaria com 400 (formato), para travar o Salvar e apontar no balão */
export function shapeIssues(flow: Flow): ShapeIssue[] {
  const out: ShapeIssue[] = [];
  const add = (nodeId: string | null, key: ShapeKey) => out.push({ nodeId, key });
  if (flow.nodes.length > LIMITS.maxNodes) add(null, 'tooManyNodes');
  for (const n of flow.nodes) {
    const text = n.type === 'condition' ? null : n.data.text;
    if (text !== null && n.type !== 'end' && !text.trim()) add(n.id, 'textRequired');
    if (text !== null && text.trim().length > LIMITS.messageText) add(n.id, 'textTooLong');
    switch (n.type) {
      case 'opening':
        if (n.data.mode === 'button' && !validTitle(n.data.buttonTitle)) add(n.id, 'buttonTitleInvalid');
        break;
      case 'message': {
        const c = n.data.options.length;
        const [min, max] = n.data.format === 'none' ? [0, 0] : n.data.format === 'buttons' ? [1, LIMITS.maxButtons] : [1, LIMITS.maxOptions];
        if (c < min || c > max) add(n.id, 'optionCount');
        if (n.data.options.some((o) => !validTitle(o.title))) add(n.id, 'optionTitleInvalid');
        if (n.data.saveTo && !FIELD_RE.test(n.data.saveTo)) add(n.id, 'fieldInvalid');
        break;
      }
      case 'question':
        if (!FIELD_RE.test(n.data.field)) add(n.id, 'fieldInvalid');
        break;
      case 'condition':
        if (!FIELD_RE.test(n.data.field)) add(n.id, 'fieldInvalid');
        if ((n.data.op === 'equals' || n.data.op === 'contains') && !n.data.value.trim()) add(n.id, 'valueRequired');
        if (n.data.value.trim().length > LIMITS.conditionValue) add(n.id, 'valueTooLong');
        break;
      case 'link':
        if (!validTitle(n.data.buttonTitle)) add(n.id, 'buttonTitleInvalid');
        if (n.data.target.kind === 'whatsapp' && !/^\d{10,15}$/.test(n.data.target.phone)) add(n.id, 'phoneInvalid');
        if (n.data.target.kind === 'url' && !/^https:\/\/\S+$/.test(n.data.target.url)) add(n.id, 'urlInvalid');
        break;
      case 'end':
        break;
    }
  }
  return out;
}

export function triggerIssues(t: TriggerConfig): ShapeKey[] {
  const out: ShapeKey[] = [];
  if (t.keywords.length > LIMITS.maxKeywords || t.keywords.some((k) => k.trim().length > LIMITS.keyword)) out.push('triggerKeywords');
  if (t.publicReplies.length > LIMITS.maxPublicReplies || t.publicReplies.some((r) => !r.trim() || r.trim().length > LIMITS.publicReply)) {
    out.push('triggerReplies');
  }
  return out;
}

// ---------------------------------------------------------------- passo e simulação (espelho do core)

export interface SimMessage {
  text: string;
  buttons?: string[];
  quick?: string[];
  urls?: string[];
}
interface Ctx {
  answers: Record<string, string>;
  username: string | null;
}

function linkUrl(n: NodeOf<'link'>, ctx: Ctx): string {
  const t = n.data.target;
  if (t.kind === 'url') return t.url;
  const msg = renderTemplate(t.message, ctx.answers, ctx.username).trim();
  return `https://wa.me/${t.phone}${msg ? `?text=${encodeURIComponent(msg)}` : ''}`;
}

export function messageFor(n: FlowNode, ctx: Ctx): SimMessage | null {
  const r = (t: string) => renderTemplate(t, ctx.answers, ctx.username);
  switch (n.type) {
    case 'opening': {
      const parts = [r(n.data.text)];
      if (n.data.mode === 'text') parts.push(OPENING_TEXT_HINT);
      if (n.data.disclosure) parts.push(OPENING_DISCLOSURE);
      const text = parts.join('\n\n');
      return n.data.mode === 'button' ? { text, buttons: [n.data.buttonTitle] } : { text };
    }
    case 'message': {
      const text = r(n.data.text);
      if (n.data.format === 'none') return { text };
      const titles = n.data.options.map((o) => o.title);
      return n.data.format === 'buttons' ? { text, buttons: titles } : { text, quick: titles };
    }
    case 'question':
      return { text: r(n.data.text) };
    case 'condition':
      return null;
    case 'link':
      return { text: r(n.data.text), buttons: [n.data.buttonTitle], urls: [linkUrl(n, ctx)] };
    case 'end':
      return n.data.text.trim() ? { text: r(n.data.text) } : null;
  }
}

function validateAnswer(kind: TextValidation, raw: string): { ok: true; value: string } | { ok: false } {
  const t = raw.trim();
  switch (kind) {
    case 'phone': {
      const digits = t.replace(/\D/g, '');
      return digits.length >= 10 && digits.length <= 13 ? { ok: true, value: digits } : { ok: false };
    }
    case 'email': {
      const v = t.toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254 ? { ok: true, value: v } : { ok: false };
    }
    case 'name':
      return t.length >= 2 && t.length <= 80 ? { ok: true, value: t } : { ok: false };
    case 'free':
      return t.length >= 1 ? { ok: true, value: t.slice(0, 500) } : { ok: false };
  }
}

function conditionHolds(n: NodeOf<'condition'>, answers: Record<string, string>): boolean {
  const v = normalize(answers[n.data.field] ?? '');
  const want = normalize(n.data.value);
  switch (n.data.op) {
    case 'equals':
      return v === want;
    case 'contains':
      return want.length > 0 && v.includes(want);
    case 'filled':
      return v.length > 0;
    case 'empty':
      return v.length === 0;
  }
}

type Decision = { kind: 'advance'; handle: string; save?: { field: string; value: string } } | { kind: 'reask' } | { kind: 'ignore' };

function decideInput(flow: Flow, n: FlowNode, input: { handle: string | null; text: string }, reasks: number): Decision {
  const text = input.text.trim();
  switch (n.type) {
    case 'opening':
      return { kind: 'advance', handle: 'next' };
    case 'message': {
      if (n.data.format === 'none') return { kind: 'ignore' };
      const saveTo = n.data.saveTo;
      const save = (value: string) => (saveTo ? { save: { field: saveTo, value } } : {});
      const byHandle = input.handle ? n.data.options.find((o) => o.id === input.handle) : undefined;
      const key = normalize(text);
      const opt = byHandle ?? (key ? n.data.options.find((o) => normalize(o.title) === key) : undefined);
      if (opt) return { kind: 'advance', handle: opt.id, ...save(opt.title) };
      if (!text) return { kind: 'ignore' };
      const typed = targetOf(flow, n.id, 'typed') ? 'typed' : null;
      if (n.data.onTyped === 'branch' && typed) return { kind: 'advance', handle: typed, ...save(text.slice(0, 200)) };
      if (reasks < MAX_REASKS) return { kind: 'reask' };
      return { kind: 'advance', handle: typed ?? n.data.options[0]!.id, ...save(text.slice(0, 200)) };
    }
    case 'question': {
      if (!text) return { kind: 'ignore' };
      const v = validateAnswer(n.data.validate, text);
      if (v.ok) return { kind: 'advance', handle: 'next', save: { field: n.data.field, value: v.value } };
      if (reasks < MAX_REASKS) return { kind: 'reask' };
      return { kind: 'advance', handle: 'next', save: { field: n.data.field, value: text.slice(0, 500) } };
    }
    default:
      return { kind: 'ignore' };
  }
}

export interface SimInput {
  tap?: string;
  text?: string;
}
export interface SimState {
  flow: Flow;
  nodeId: string | null;
  answers: Record<string, string>;
  reasks: number;
  status: 'waiting' | 'completed' | 'abandoned' | 'failed';
  transcript: Array<{ from: 'brand' | 'user'; msg: SimMessage }>;
  username: string | null;
}

function drive(s: SimState, pending: boolean): SimState {
  let { nodeId, reasks } = s;
  const transcript = [...s.transcript];
  let send = pending;
  for (let i = 0; i <= MAX_AUTO_STEPS; i++) {
    const n = nodeById(s.flow, nodeId);
    if (!n) return { ...s, nodeId, reasks, transcript, status: 'abandoned' };
    if (send) {
      const m = messageFor(n, { answers: s.answers, username: s.username });
      if (m) transcript.push({ from: 'brand', msg: m });
      send = false;
    }
    if (waits(n)) return { ...s, nodeId, reasks, transcript, status: 'waiting' };
    let to: string | null = null;
    if (n.type === 'condition') to = targetOf(s.flow, n.id, conditionHolds(n, s.answers) ? 'yes' : 'no');
    else if (n.type === 'link') {
      to = targetOf(s.flow, n.id, 'next');
      if (!to) return { ...s, nodeId, reasks, transcript, status: 'completed' };
    } else if (n.type === 'end') return { ...s, nodeId, reasks, transcript, status: 'completed' };
    else to = targetOf(s.flow, n.id, 'next');
    if (!to) return { ...s, nodeId, reasks, transcript, status: 'abandoned' };
    nodeId = to;
    reasks = 0;
    send = true;
  }
  return { ...s, nodeId, reasks, transcript, status: 'failed' };
}

export function startSim(flow: Flow, opts: { username?: string | null; startAt?: string | null; answers?: Record<string, string> } = {}): SimState {
  const opening = flow.nodes.find((n) => n.type === 'opening');
  const base: SimState = {
    flow,
    nodeId: opts.startAt ?? opening?.id ?? null,
    answers: { ...(opts.answers ?? {}) },
    reasks: 0,
    status: 'waiting',
    transcript: [],
    username: opts.username ?? null,
  };
  return drive(base, true);
}

/** título do botão/resposta rápida → saída do nó atual (para tocar no simulador) */
export function tapForTitle(flow: Flow, nodeId: string | null, title: string): string | null {
  const n = nodeById(flow, nodeId);
  if (!n) return null;
  if (n.type === 'opening') return n.data.mode === 'button' && n.data.buttonTitle === title ? 'next' : null;
  if (n.type === 'message') return n.data.options.find((o) => o.title === title)?.id ?? null;
  return null;
}

export function sendSim(s: SimState, input: SimInput): SimState {
  if (s.status !== 'waiting') return s;
  const n = nodeById(s.flow, s.nodeId);
  if (!n) return { ...s, status: 'abandoned' };
  const shown = input.text ?? (n.type === 'message' ? n.data.options.find((o) => o.id === input.tap)?.title : undefined) ?? '';
  const withUser: SimState = { ...s, transcript: [...s.transcript, { from: 'user', msg: { text: shown } }] };
  const d = decideInput(s.flow, n, { handle: input.tap ?? null, text: input.text ?? '' }, s.reasks);
  if (d.kind === 'ignore') return withUser;
  if (d.kind === 'reask') return drive({ ...withUser, reasks: s.reasks + 1 }, true);
  const answers = d.save ? { ...s.answers, [d.save.field]: d.save.value } : s.answers;
  const to = targetOf(s.flow, n.id, d.handle);
  if (!to) return { ...withUser, answers, status: 'abandoned' };
  return drive({ ...withUser, answers, nodeId: to, reasks: 0 }, true);
}

export function simulateFlow(flow: Flow, inputs: SimInput[], opts: { username?: string | null } = {}) {
  let s = startSim(flow, opts);
  for (const i of inputs) {
    if (s.status !== 'waiting') break;
    s = sendSim(s, i);
  }
  return {
    messages: s.transcript.filter((x) => x.from === 'brand').map((x) => x.msg),
    answers: s.answers,
    status: s.status,
    nodeId: s.nodeId,
  };
}

// ---------------------------------------------------------------- edição

export type BlockKind = Exclude<FlowNodeType, 'opening'> | 'follow';
export interface NodeTexts {
  opening: string;
  askName: string;
  thanks: string;
  message: string;
  option: string;
  question: string;
  end: string;
  link: string;
  linkButton: string;
  follow: string;
  followButton: string;
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'no';
  const set = new Set(taken);
  if (!set.has(clean)) return clean;
  for (let i = 2; ; i++) {
    const id = `${clean}-${i}`;
    if (!set.has(id)) return id;
  }
}

export const profileUrl = (username: string | null) => {
  const u = (username ?? '').replace(/^@/, '').trim();
  return `https://instagram.com/${u}`;
};

export function emptyFlow(t: NodeTexts): Flow {
  return {
    version: 2,
    nodes: [
      { id: 'opening', type: 'opening', position: { x: 0, y: 0 }, data: { text: t.opening, mode: 'text', buttonTitle: 'Quero!', disclosure: true } },
      { id: 'nome', type: 'question', position: { x: 360, y: 0 }, data: { text: t.askName, field: 'nome', validate: 'name' } },
      { id: 'fim', type: 'end', position: { x: 720, y: 0 }, data: { text: t.thanks } },
    ],
    edges: [
      { id: 'e-opening-next', source: 'opening', sourceHandle: 'next', target: 'nome' },
      { id: 'e-nome-next', source: 'nome', sourceHandle: 'next', target: 'fim' },
    ],
  };
}

export const defaultTrigger = (): TriggerConfig => ({ mediaIds: [], keywords: ['quero'], publicReplies: ['Te chamei no direct!'] });

export function createNode(kind: BlockKind, position: Position, flow: Flow, t: NodeTexts, username: string | null): FlowNode {
  const id = uniqueId(kind === 'follow' ? 'seguir' : kind, flow.nodes.map((n) => n.id));
  const fields = [...fieldsWritten(flow)];
  switch (kind) {
    case 'message':
      return { id, type: 'message', position, data: { text: t.message, format: 'buttons', options: [{ id: 'o1', title: t.option }], onTyped: 'reask' } };
    case 'question':
      return { id, type: 'question', position, data: { text: t.question, field: fieldFromPrompt('campo', fields), validate: 'free' } };
    case 'condition':
      return { id, type: 'condition', position, data: { field: fields[0] ?? '', op: 'filled', value: '' } };
    case 'link':
      return { id, type: 'link', position, data: { text: t.link, buttonTitle: t.linkButton, target: { kind: 'whatsapp', phone: '', message: '' } } };
    case 'follow':
      return { id, type: 'link', position, data: { text: t.follow, buttonTitle: t.followButton, target: { kind: 'url', url: profileUrl(username) } } };
    case 'end':
      return { id, type: 'end', position, data: { text: t.end } };
  }
}

export const addNode = (flow: Flow, node: FlowNode): Flow => ({ ...flow, nodes: [...flow.nodes, node] });

export const moveNode = (flow: Flow, id: string, position: Position): Flow => ({
  ...flow,
  nodes: flow.nodes.map((n) => (n.id === id ? { ...n, position } : n)),
});

/** ligações cujas saídas deixaram de existir saem junto */
function pruneEdges(flow: Flow): Flow {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  return {
    ...flow,
    edges: flow.edges.filter((e) => {
      const s = byId.get(e.source);
      return s && byId.has(e.target) && handlesOf(s).includes(e.sourceHandle);
    }),
  };
}

export function updateNodeData(flow: Flow, id: string, patch: Record<string, unknown>): Flow {
  return pruneEdges({
    ...flow,
    nodes: flow.nodes.map((n) => (n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as FlowNode) : n)),
  });
}

export function connect(flow: Flow, c: { source: string; sourceHandle: string | null; target: string }): Flow {
  const src = nodeById(flow, c.source);
  const dst = nodeById(flow, c.target);
  const handle = c.sourceHandle ?? 'next';
  if (!src || !dst || dst.type === 'opening' || c.source === c.target || !handlesOf(src).includes(handle)) return flow;
  const id = `e-${c.source}-${handle}`;
  return {
    ...flow,
    edges: [...flow.edges.filter((e) => !(e.source === c.source && e.sourceHandle === handle)), { id, source: c.source, sourceHandle: handle, target: c.target }],
  };
}

export function removeNode(flow: Flow, id: string): Flow {
  const n = nodeById(flow, id);
  if (!n || n.type === 'opening') return flow;
  return { ...flow, nodes: flow.nodes.filter((x) => x.id !== id), edges: flow.edges.filter((e) => e.source !== id && e.target !== id) };
}

export const removeEdge = (flow: Flow, id: string): Flow => ({ ...flow, edges: flow.edges.filter((e) => e.id !== id) });

export function duplicateNode(flow: Flow, id: string): { flow: Flow; id: string } {
  const n = nodeById(flow, id);
  if (!n || n.type === 'opening') return { flow, id };
  const newId = uniqueId(n.id.replace(/-\d+$/, ''), flow.nodes.map((x) => x.id));
  const copy = { ...structuredClone(n), id: newId, position: { x: n.position.x + 48, y: n.position.y + 48 } } as FlowNode;
  const outs = flow.edges
    .filter((e) => e.source === id)
    .map((e) => ({ ...e, id: `e-${newId}-${e.sourceHandle}`, source: newId }));
  return { flow: { ...flow, nodes: [...flow.nodes, copy], edges: [...flow.edges, ...outs] }, id: newId };
}

export function addOption(flow: Flow, nodeId: string, title: string): Flow {
  const n = nodeById(flow, nodeId);
  if (!n || n.type !== 'message' || n.data.format === 'none') return flow;
  const max = n.data.format === 'buttons' ? LIMITS.maxButtons : LIMITS.maxOptions;
  if (n.data.options.length >= max) return flow;
  let k = n.data.options.length + 1;
  while (n.data.options.some((o) => o.id === `o${k}`)) k++;
  return updateNodeData(flow, nodeId, { options: [...n.data.options, { id: `o${k}`, title }] });
}

export function removeOption(flow: Flow, nodeId: string, optionId: string): Flow {
  const n = nodeById(flow, nodeId);
  if (!n || n.type !== 'message' || n.data.options.length <= 1) return flow;
  return updateNodeData(flow, nodeId, { options: n.data.options.filter((o) => o.id !== optionId) });
}
```

`structuredClone` existe no Bun e nos navegadores-alvo.

- [ ] **Step 5: Rodar e ver passar**

Run: `bun test apps/web/src/features/automation/flow/`
Expected: PASS em todas as fixtures, inclusive as 9 compartilhadas com o core. Se uma fixture passa no core e falha aqui, a web divergiu: corrija a web.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/features/automation/flow/logic.ts apps/web/src/features/automation/flow/logic.test.ts apps/web/src/features/automation/flow/history.ts apps/web/src/features/automation/flow/history.test.ts
git commit -m "feat(web): lógica do fluxo no editor (espelho do motor, simulador, edição, histórico)"
```

---

### Task 11: Canvas: balões, ⚙, próximo passo, dock e gatilho

**Files:**
- Modify: `apps/web/package.json` e `bun.lock` (via `bun add`)
- Create: `apps/web/src/features/automation/flow/flow.css`
- Create: `apps/web/src/features/automation/flow/layout.ts`
- Create: `apps/web/src/features/automation/flow/actions.tsx` (contexto das ações dos balões; evita import circular entre `nodes.tsx` e `node-settings.tsx`)
- Create: `apps/web/src/features/automation/flow/nodes.tsx`
- Create: `apps/web/src/features/automation/flow/node-settings.tsx`
- Create: `apps/web/src/features/automation/flow/next-step-menu.tsx`
- Create: `apps/web/src/features/automation/flow/dock.tsx`
- Create: `apps/web/src/features/automation/flow/trigger-panel.tsx`
- Create: `apps/web/src/features/automation/flow/editor.tsx`
- Modify: `apps/web/src/messages/pt-BR.json` (bloco `automation.flow`)

**Interfaces:**
- Consumes: Task 10.
- Produces:
  - `EditorDoc = { name: string; flow: Flow; trigger: TriggerConfig; triggerPosition: Position; testUsernames: string[] }` (exportado de `editor.tsx`);
  - `FlowEditor(props: { doc: EditorDoc; onChange: (doc: EditorDoc, opts?: { merge?: boolean }) => void; onSeal: () => void; readOnly: boolean; channelId: string; username: string | null; problems: Problem[]; shape: ShapeIssue[]; focus: { id: string; n: number } | null; onTestFrom: (nodeId: string) => void; texts: NodeTexts })`;
  - `useNodeTexts(): NodeTexts` (de `editor.tsx`).

- [ ] **Step 1: Instalar as dependências**

```bash
bun add --cwd apps/web --exact @xyflow/react @dagrejs/dagre
grep -n '"@xyflow/react"\|"@dagrejs/dagre"' apps/web/package.json
```

Expected: as duas com versão exata, sem `^`. Conferir a licença:

```bash
grep -m1 '"license"' node_modules/@xyflow/react/package.json node_modules/@dagrejs/dagre/package.json
```

Expected: `"MIT"` nas duas. Se não for, **pare** e reporte.

- [ ] **Step 2: Textos (i18n)**

Em `apps/web/src/messages/pt-BR.json`, dentro de `"automation"`, acrescentar a chave `"flow"`:

```json
"flow": {
  "save": "Salvar",
  "saved": "Alterações salvas",
  "unsaved": "Alterações não salvas",
  "undo": "Desfazer",
  "redo": "Refazer",
  "simulate": "Simular conversa",
  "zoomIn": "Aproximar",
  "zoomOut": "Afastar",
  "fit": "Centralizar",
  "organize": "Organizar",
  "duplicate": "Duplicar",
  "testFromHere": "Testar daqui",
  "delete": "Excluir",
  "settings": "Opções do bloco",
  "close": "Fechar",
  "nextStep": "Próximo passo",
  "soon": "em breve",
  "addOption": "Adicionar botão",
  "removeOption": "Remover botão",
  "readOnly": "No celular o fluxo abre só para leitura. Edite no computador.",
  "problems": "{count, plural, =0 {Sem problemas} one {# problema} other {# problemas}}",
  "problemsTitle": "Revise antes de testar ou ativar",
  "general": "Fluxo",
  "leaveTitle": "Sair sem salvar?",
  "leaveDescription": "As alterações deste fluxo ainda não foram salvas.",
  "leaveConfirm": "Sair sem salvar",
  "activeSaveWarning": "Esta automação está no ar: quem está no meio da conversa recebe a versão nova a partir da próxima mensagem.",
  "openingHint": "Junto vão a dica para responder e o aviso de mensagem automática.",
  "endHint": "Fecha o lead e envia ao CRM.",
  "savesTo": "Guarda em {field}",
  "namePlaceholder": "Nome da automação",
  "node": { "trigger": "Gatilho: comentário", "opening": "Abertura", "message": "Mensagem", "question": "Pergunta", "condition": "Condição", "link": "Link", "end": "Fim" },
  "block": { "message": "Mensagem", "question": "Pergunta", "condition": "Condição", "link": "Link ou WhatsApp", "follow": "Pedir para seguir", "end": "Fim", "delay": "Espera", "media": "Imagem ou vídeo", "action": "Ação" },
  "output": { "reply": "Quando responder", "next": "Seguir", "typed": "Digitou outra coisa", "answered": "Respondeu", "yes": "Sim", "no": "Não", "nextOptional": "Depois (opcional)" },
  "placeholder": { "text": "Escreva a mensagem", "option": "Título do botão", "endText": "Mensagem final (opcional)", "phone": "DDI + DDD + número", "waMessage": "Mensagem pronta", "url": "https://", "value": "Valor" },
  "defaults": { "opening": "Oi! Vi seu comentário.", "askName": "Para começar, qual é o seu nome?", "thanks": "Obrigado, {nome}! Já já falamos com você.", "message": "Escolha uma opção:", "option": "Opção", "question": "Qual é a sua resposta?", "end": "Obrigado! Em breve falamos com você.", "link": "Toque abaixo para continuar.", "linkButton": "Abrir", "follow": "Segue a gente para não perder as novidades.", "followButton": "Seguir" },
  "settingsPanel": { "openingMode": "Como a conversa abre", "modeText": "Pedir para responder (recomendado)", "modeButton": "Botão: só chega a quem segue a conta", "buttonTitle": "Texto do botão", "disclosure": "Avisar que é mensagem automática", "format": "Formato das opções", "formatButtons": "Botões (até 3)", "formatQuick": "Respostas rápidas (até 13)", "formatNone": "Sem botões", "saveTo": "Guardar a escolha em", "saveToHint": "Nome do campo, ex.: plano", "onTyped": "Se a pessoa digitar em vez de tocar", "onTypedReask": "Perguntar de novo uma vez", "onTypedBranch": "Sair por “digitou outra coisa”", "field": "Guardar a resposta em", "validate": "Tipo de resposta", "validation": { "name": "Nome", "phone": "Telefone", "email": "E-mail", "free": "Texto livre" } },
  "condition": { "field": "Campo", "noFields": "Crie uma pergunta antes", "op": { "equals": "é igual a", "contains": "contém", "filled": "foi respondido", "empty": "está vazio" } },
  "link": { "whatsapp": "WhatsApp", "url": "Link", "buttonTitle": "Texto do botão" },
  "trigger": { "edit": "Editar gatilho", "title": "Gatilho: comentário", "description": "Quando alguém comentar, a conversa começa pela abertura.", "anyPost": "Qualquer post", "posts": "{count, plural, one {# post} other {# posts}}", "anyComment": "Qualquer comentário", "repliesSummary": "{count, plural, =0 {sem resposta pública} one {# resposta pública} other {# respostas públicas}}", "media": "Posts", "mediaHint": "Nenhum marcado = qualquer post da conta.", "keywords": "Palavras-chave", "keywordsHint": "Separe por vírgula. Vazio = qualquer comentário.", "publicReplies": "Respostas públicas", "publicRepliesHint": "Uma é sorteada a cada comentário. Vazio = não responde em público.", "addReply": "Adicionar resposta", "testUsers": "Contas de teste", "testUsersHint": "No modo Teste, só estes @ disparam a automação." },
  "problem": { "unreachable": "Bloco solto: nada leva até ele", "missing_edge": "Ligue esta saída a um próximo passo", "wait_free_cycle": "Volta para trás sem esperar resposta (laço)", "unknown_field": "Nenhuma pergunta grava este campo", "no_finish": "O fluxo não chega a um fim nem a um link", "opening_button": "Com botão, quem não segue a conta não recebe a abertura" },
  "shape": { "textRequired": "Escreva o texto", "textTooLong": "Texto acima de 600 caracteres", "optionCount": "Quantidade de botões fora do limite", "optionTitleInvalid": "Botão vazio ou com mais de 20 caracteres", "buttonTitleInvalid": "Texto do botão vazio ou com mais de 20 caracteres", "fieldInvalid": "Campo: só minúsculas, números e _", "valueRequired": "Informe o valor", "valueTooLong": "Valor acima de 60 caracteres", "phoneInvalid": "WhatsApp: só dígitos com DDI (10 a 15)", "urlInvalid": "Use um link que comece com https://", "tooManyNodes": "No máximo 40 blocos", "triggerKeywords": "Palavras-chave: até 20, com até 60 caracteres", "triggerReplies": "Respostas públicas: até 10, com até 300 caracteres" },
  "sim": { "title": "Simular conversa", "restart": "Recomeçar", "placeholder": "Responda como o cliente", "send": "Enviar", "fields": "Campos gravados", "noFields": "Nada gravado ainda", "completed": "Conversa concluída: o lead seria registrado.", "abandoned": "Conversa encerrada sem lead.", "failed": "O fluxo entrou em laço.", "fromNode": "Começando em: {node}", "nothingSent": "Simulação: nada é enviado de verdade." }
}
```

Os textos de `defaults` e de `placeholder.waMessage` levam `{nome}` literal. **Leia `defaults.*` com `t.raw(...)`**, porque `t(...)` interpretaria `{nome}` como argumento ICU. `useNodeTexts` abaixo já faz isso.

Acrescente também, em `automation`, a chave `"summaryBlocks": "{count, plural, one {# bloco} other {# blocos}}"` e, no mapa de status de execução (a chave irmã de `"SKIPPED": "Ignorado"`, ~linha 2067), `"ABANDONED": "Encerrada sem lead"`.

- [ ] **Step 3: `flow.css` e `layout.ts`**

`flow/flow.css`:

```css
/*
 * React Flow com os tokens da marca (openspec add-flow-builder-canvas, design D8): o pacote entra
 * só com `base.css` (layout), e a aparência vem daqui — sem sombra, raio por função, cor por token.
 */
.flow-canvas {
  background: var(--canvas);
}
.flow-canvas .react-flow__edge-path {
  stroke: var(--line-strong);
  stroke-width: 1.5;
}
.flow-canvas .react-flow__edge.selected .react-flow__edge-path,
.flow-canvas .react-flow__edge:focus-visible .react-flow__edge-path {
  stroke: var(--accent);
}
.flow-canvas .react-flow__connection-path {
  stroke: var(--accent);
  stroke-width: 1.5;
}
.flow-canvas .react-flow__node {
  cursor: grab;
}
.flow-canvas .react-flow__node.dragging {
  cursor: grabbing;
}
.flow-canvas .react-flow__attribution {
  background: transparent;
  color: var(--graphite);
}
.flow-canvas .react-flow__attribution a {
  color: var(--graphite);
}
.flow-handle {
  width: 10px;
  height: 10px;
  border-radius: 4px;
  background: var(--surface);
  border: 1.5px solid var(--line-strong);
  transition: border-color 0.2s, background-color 0.2s;
}
.flow-handle:hover,
.flow-handle.connectingto {
  border-color: var(--accent);
  background: var(--accent-tint);
}
```

`flow/layout.ts`:

```ts
import dagre from '@dagrejs/dagre';
import { TRIGGER_NODE_ID, type Flow, type Position } from './logic';

/** "Organizar": camadas da esquerda para a direita (dagre), com o tamanho medido de cada balão */
export function autoLayout(
  flow: Flow,
  sizes: Map<string, { width: number; height: number }>,
): { flow: Flow; triggerPosition: Position } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 96 });
  g.setDefaultEdgeLabel(() => ({}));
  const size = (id: string) => sizes.get(id) ?? { width: 288, height: 160 };
  g.setNode(TRIGGER_NODE_ID, size(TRIGGER_NODE_ID));
  for (const n of flow.nodes) g.setNode(n.id, size(n.id));
  g.setEdge(TRIGGER_NODE_ID, 'opening');
  for (const e of flow.edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const pos = (id: string): Position => {
    const p = g.node(id);
    const s = size(id);
    return { x: Math.round(p.x - s.width / 2), y: Math.round(p.y - s.height / 2) };
  };
  return { flow: { ...flow, nodes: flow.nodes.map((n) => ({ ...n, position: pos(n.id) })) }, triggerPosition: pos(TRIGGER_NODE_ID) };
}
```

- [ ] **Step 4: Ações (`actions.tsx`) e balões (`nodes.tsx`)**

`flow/actions.tsx`:

```tsx
'use client';

import { createContext, useContext } from 'react';
import type { Problem, ShapeKey } from './logic';

/** Ações do editor que os balões usam (design D8) — o estado vive no editor, não no React Flow. */
export interface FlowActions {
  readOnly: boolean;
  problems: Map<string, Problem[]>;
  shape: Map<string, ShapeKey[]>;
  fields: string[];
  update: (id: string, patch: Record<string, unknown>, opts?: { merge?: boolean }) => void;
  seal: () => void;
  addOption: (id: string) => void;
  removeOption: (id: string, optionId: string) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  testFrom: (id: string) => void;
  openTrigger: () => void;
}
export const FlowActionsContext = createContext<FlowActions | null>(null);
export function useFlowActions(): FlowActions {
  const v = useContext(FlowActionsContext);
  if (!v) throw new Error('FlowActionsContext ausente');
  return v;
}
```

`flow/nodes.tsx`:

```tsx
'use client';

import { Handle, NodeToolbar, Position, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import {
  Copy,
  FlaskConical,
  Flag,
  GitBranch,
  Link2,
  MessageSquare,
  MessageSquareText,
  Plus,
  TextCursorInput,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { LIMITS } from '../logic';
import { useFlowActions } from './actions';
import { CONDITION_OPS, type NodeOf, type TriggerConfig } from './logic';
import { NodeSettings } from './node-settings';

const INPUT =
  'nodrag w-full rounded-compact border border-transparent bg-surface-2 px-2 py-1.5 text-compact text-ink outline-none transition-colors duration-200 focus:border-accent';

function InlineText({ nodeId, value, placeholder, field = 'text' }: { nodeId: string; value: string; placeholder: string; field?: string }) {
  const a = useFlowActions();
  if (a.readOnly) return <p className="whitespace-pre-line text-compact text-ink">{value}</p>;
  return (
    <textarea
      className={cn(INPUT, 'nowheel resize-none')}
      value={value}
      rows={Math.min(8, Math.max(2, value.split('\n').length))}
      maxLength={LIMITS.messageText}
      placeholder={placeholder}
      onChange={(e) => a.update(nodeId, { [field]: e.target.value }, { merge: true })}
      onBlur={a.seal}
    />
  );
}

function InlineInput({ value, placeholder, maxLength, onChange }: { value: string; placeholder: string; maxLength?: number; onChange: (v: string) => void }) {
  const a = useFlowActions();
  if (a.readOnly) return <span className="text-compact text-ink">{value}</span>;
  return (
    <input className={INPUT} value={value} placeholder={placeholder} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} onBlur={a.seal} />
  );
}

/** linha com saída (bolinha à direita) */
function OutputRow({ handleId, label, children }: { handleId: string; label?: string; children?: ReactNode }) {
  const a = useFlowActions();
  return (
    <div className="relative flex items-center gap-2">
      {children ?? <span className="flex-1 text-meta text-graphite">{label}</span>}
      <Handle type="source" id={handleId} position={Position.Right} className="flow-handle" isConnectable={!a.readOnly} style={{ right: -18 }} />
    </div>
  );
}

function ToolbarButton({ label, icon: Icon, onClick }: { label: string; icon: LucideIcon; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-8 cursor-pointer items-center justify-center rounded-compact text-ink transition-colors duration-200 hover:bg-surface-2 hover:text-accent"
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

function NodeShell({
  id,
  selected,
  icon: Icon,
  title,
  settings,
  fixed = false,
  target = true,
  children,
}: {
  id: string;
  selected: boolean;
  icon: LucideIcon;
  title: string;
  settings?: ReactNode;
  /** abertura e gatilho: sem duplicar/excluir */
  fixed?: boolean;
  target?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations('automation.flow');
  const a = useFlowActions();
  const problems = a.problems.get(id) ?? [];
  const shape = a.shape.get(id) ?? [];
  const hasError = shape.length > 0 || problems.some((p) => p.severity === 'error');
  return (
    <div
      className={cn(
        'flex w-72 flex-col gap-2 rounded-card border bg-surface p-3',
        selected ? 'border-accent' : hasError ? 'border-destructive' : 'border-line-strong',
      )}
    >
      {!a.readOnly && id !== 'trigger' ? (
        <NodeToolbar isVisible={selected} position={Position.Top} className="flex gap-1 rounded-control border border-line bg-surface p-1">
          {!fixed ? <ToolbarButton label={t('duplicate')} icon={Copy} onClick={() => a.duplicate(id)} /> : null}
          <ToolbarButton label={t('testFromHere')} icon={FlaskConical} onClick={() => a.testFrom(id)} />
          {!fixed ? <ToolbarButton label={t('delete')} icon={Trash2} onClick={() => a.remove(id)} /> : null}
        </NodeToolbar>
      ) : null}
      {target ? <Handle type="target" position={Position.Left} className="flow-handle" isConnectable={!a.readOnly} /> : null}
      <header className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-meta font-medium text-graphite">
          <Icon className="size-3.5 text-accent" aria-hidden />
          {title}
        </span>
        {settings}
      </header>
      {children}
      {shape.map((k) => (
        <p key={k} className="text-meta text-destructive">
          {t(`shape.${k}`)}
        </p>
      ))}
      {problems.map((p, i) => (
        <p key={`${p.code}-${i}`} className={cn('text-meta', p.severity === 'error' ? 'text-destructive' : 'text-state-review')}>
          {t(`problem.${p.code}`)}
        </p>
      ))}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="flex flex-1 items-center justify-center rounded-compact border border-line bg-surface px-3 py-1.5 text-meta font-medium text-accent">
      {children}
    </span>
  );
}

type P<T extends 'opening' | 'message' | 'question' | 'condition' | 'link' | 'end'> = NodeProps<Node<{ node: NodeOf<T> }, T>>;

function OpeningView({ id, data, selected }: P<'opening'>) {
  const t = useTranslations('automation.flow');
  const n = data.node;
  return (
    <NodeShell id={id} selected={selected} fixed icon={MessageSquareText} title={t('node.opening')} settings={<NodeSettings node={n} />}>
      <InlineText nodeId={id} value={n.data.text} placeholder={t('placeholder.text')} />
      {n.data.mode === 'button' ? (
        <OutputRow handleId="next">
          <Chip>{n.data.buttonTitle}</Chip>
        </OutputRow>
      ) : (
        <>
          <p className="text-meta text-graphite">{t('openingHint')}</p>
          <OutputRow handleId="next" label={t('output.reply')} />
        </>
      )}
    </NodeShell>
  );
}

function MessageView({ id, data, selected }: P<'message'>) {
  const t = useTranslations('automation.flow');
  const a = useFlowActions();
  const n = data.node;
  const max = n.data.format === 'buttons' ? LIMITS.maxButtons : LIMITS.maxOptions;
  return (
    <NodeShell id={id} selected={selected} icon={MessageSquare} title={t('node.message')} settings={<NodeSettings node={n} />}>
      <InlineText nodeId={id} value={n.data.text} placeholder={t('placeholder.text')} />
      {n.data.format === 'none' ? (
        <OutputRow handleId="next" label={t('output.next')} />
      ) : (
        <div className="flex flex-col gap-1">
          {n.data.options.map((o) => (
            <OutputRow key={o.id} handleId={o.id}>
              <InlineInput
                value={o.title}
                placeholder={t('placeholder.option')}
                maxLength={LIMITS.buttonTitle}
                onChange={(v) =>
                  a.update(id, { options: n.data.options.map((x) => (x.id === o.id ? { ...x, title: v } : x)) }, { merge: true })
                }
              />
              {!a.readOnly && n.data.options.length > 1 ? (
                <button
                  type="button"
                  aria-label={t('removeOption')}
                  onClick={() => a.removeOption(id, o.id)}
                  className="nodrag flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-compact text-graphite transition-colors duration-200 hover:text-destructive"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </OutputRow>
          ))}
          {!a.readOnly && n.data.options.length < max ? (
            <button
              type="button"
              onClick={() => a.addOption(id)}
              className="nodrag flex cursor-pointer items-center gap-1 self-start rounded-compact px-2 py-1 text-meta font-medium text-accent transition-colors duration-200 hover:bg-accent-tint"
            >
              <Plus className="size-3.5" aria-hidden />
              {t('addOption')}
            </button>
          ) : null}
          {n.data.onTyped === 'branch' ? <OutputRow handleId="typed" label={t('output.typed')} /> : null}
        </div>
      )}
      {n.data.saveTo ? <p className="text-meta text-graphite">{t('savesTo', { field: n.data.saveTo })}</p> : null}
    </NodeShell>
  );
}

function QuestionView({ id, data, selected }: P<'question'>) {
  const t = useTranslations('automation.flow');
  const n = data.node;
  return (
    <NodeShell id={id} selected={selected} icon={TextCursorInput} title={t('node.question')} settings={<NodeSettings node={n} />}>
      <InlineText nodeId={id} value={n.data.text} placeholder={t('placeholder.text')} />
      <p className="text-meta text-graphite">
        {t('savesTo', { field: n.data.field })} · {t(`settingsPanel.validation.${n.data.validate}`)}
      </p>
      <OutputRow handleId="next" label={t('output.answered')} />
    </NodeShell>
  );
}

function ConditionView({ id, data, selected }: P<'condition'>) {
  const t = useTranslations('automation.flow');
  const a = useFlowActions();
  const n = data.node;
  const needsValue = n.data.op === 'equals' || n.data.op === 'contains';
  return (
    <NodeShell id={id} selected={selected} icon={GitBranch} title={t('node.condition')}>
      {a.fields.length === 0 ? (
        <p className="text-meta text-graphite">{t('condition.noFields')}</p>
      ) : (
        <div className="nodrag flex flex-col gap-2">
          <Select value={n.data.field || undefined} onValueChange={(v) => a.update(id, { field: v })} disabled={a.readOnly}>
            <SelectTrigger aria-label={t('condition.field')}>
              <SelectValue placeholder={t('condition.field')} />
            </SelectTrigger>
            <SelectContent>
              {a.fields.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={n.data.op} onValueChange={(v) => a.update(id, { op: v })} disabled={a.readOnly}>
            <SelectTrigger aria-label={t('node.condition')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONDITION_OPS.map((op) => (
                <SelectItem key={op} value={op}>
                  {t(`condition.op.${op}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {needsValue ? (
            <InlineInput value={n.data.value} placeholder={t('placeholder.value')} maxLength={LIMITS.conditionValue} onChange={(v) => a.update(id, { value: v }, { merge: true })} />
          ) : null}
        </div>
      )}
      <OutputRow handleId="yes" label={t('output.yes')} />
      <OutputRow handleId="no" label={t('output.no')} />
    </NodeShell>
  );
}

function LinkView({ id, data, selected }: P<'link'>) {
  const t = useTranslations('automation.flow');
  const a = useFlowActions();
  const n = data.node;
  const target = n.data.target;
  const setTarget = (next: NodeOf<'link'>['data']['target'], merge = false) => a.update(id, { target: next }, { merge });
  return (
    <NodeShell id={id} selected={selected} icon={Link2} title={t('node.link')}>
      <InlineText nodeId={id} value={n.data.text} placeholder={t('placeholder.text')} />
      {!a.readOnly ? (
        <div className="nodrag flex gap-1">
          {(['whatsapp', 'url'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={target.kind === k}
              onClick={() => target.kind !== k && setTarget(k === 'url' ? { kind: 'url', url: '' } : { kind: 'whatsapp', phone: '', message: '' })}
              className={cn(
                'flex-1 cursor-pointer rounded-compact border px-2 py-1 text-meta font-medium transition-colors duration-200',
                target.kind === k ? 'border-accent bg-accent-tint text-accent' : 'border-line text-graphite hover:bg-surface-2',
              )}
            >
              {t(`link.${k}`)}
            </button>
          ))}
        </div>
      ) : null}
      {target.kind === 'whatsapp' ? (
        <>
          <InlineInput value={target.phone} placeholder={t('placeholder.phone')} maxLength={15} onChange={(v) => setTarget({ ...target, phone: v.replace(/\D/g, '') }, true)} />
          <InlineInput value={target.message} placeholder={t('placeholder.waMessage')} maxLength={LIMITS.whatsappMessage} onChange={(v) => setTarget({ ...target, message: v }, true)} />
        </>
      ) : (
        <InlineInput value={target.url} placeholder={t('placeholder.url')} maxLength={2000} onChange={(v) => setTarget({ kind: 'url', url: v.trim() }, true)} />
      )}
      <OutputRow handleId="next">
        <InlineInput value={n.data.buttonTitle} placeholder={t('link.buttonTitle')} maxLength={LIMITS.buttonTitle} onChange={(v) => a.update(id, { buttonTitle: v }, { merge: true })} />
      </OutputRow>
      <p className="text-meta text-graphite">{t('output.nextOptional')}</p>
    </NodeShell>
  );
}

function EndView({ id, data, selected }: P<'end'>) {
  const t = useTranslations('automation.flow');
  const n = data.node;
  return (
    <NodeShell id={id} selected={selected} icon={Flag} title={t('node.end')}>
      <InlineText nodeId={id} value={n.data.text} placeholder={t('placeholder.endText')} />
      <p className="text-meta text-graphite">{t('endHint')}</p>
    </NodeShell>
  );
}

function TriggerView({ selected, data }: NodeProps<Node<{ trigger: TriggerConfig }, 'trigger'>>) {
  const t = useTranslations('automation.flow');
  const a = useFlowActions();
  const tr = data.trigger;
  return (
    <NodeShell id="trigger" selected={selected} fixed target={false} icon={Zap} title={t('node.trigger')}>
      <p className="text-compact text-ink">
        {tr.mediaIds.length ? t('trigger.posts', { count: tr.mediaIds.length }) : t('trigger.anyPost')}
        {' · '}
        {tr.keywords.length ? tr.keywords.slice(0, 4).join(', ') : t('trigger.anyComment')}
      </p>
      <p className="text-meta text-graphite">{t('trigger.repliesSummary', { count: tr.publicReplies.length })}</p>
      {!a.readOnly ? (
        <button
          type="button"
          onClick={a.openTrigger}
          className="nodrag cursor-pointer self-start rounded-compact px-2 py-1 text-meta font-medium text-accent transition-colors duration-200 hover:bg-accent-tint"
        >
          {t('trigger.edit')}
        </button>
      ) : null}
      <div className="relative h-0">
        <Handle type="source" id="next" position={Position.Right} className="flow-handle" isConnectable={false} style={{ right: -18 }} />
      </div>
    </NodeShell>
  );
}

export const NODE_TYPES = {
  trigger: TriggerView,
  opening: OpeningView,
  message: MessageView,
  question: QuestionView,
  condition: ConditionView,
  link: LinkView,
  end: EndView,
} as unknown as NodeTypes;
```

Se `components/ui/select` não aceitar `disabled` no `Select` raiz, passe-o no `SelectTrigger`.

- [ ] **Step 5: ⚙ (`node-settings.tsx`)**

```tsx
'use client';

import { Settings2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { LIMITS, TEXT_VALIDATIONS } from '../logic';
import { useFlowActions } from './actions';
import type { NodeOf } from './logic';

/** opções avançadas do balão (decisão `painel-opcoes`): formato, guardar em, se digitar, modo da abertura */
export function NodeSettings({ node }: { node: NodeOf<'opening'> | NodeOf<'message'> | NodeOf<'question'> }) {
  const t = useTranslations('automation.flow');
  const a = useFlowActions();
  if (a.readOnly) return null;
  const set = (patch: Record<string, unknown>) => a.update(node.id, patch);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('settings')}
          className="nodrag flex size-7 cursor-pointer items-center justify-center rounded-compact text-graphite transition-colors duration-200 hover:bg-surface-2 hover:text-accent"
        >
          <Settings2 className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-4">
        {node.type === 'opening' ? (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-compact font-medium text-ink">{t('settingsPanel.openingMode')}</legend>
              <RadioGroup value={node.data.mode} onValueChange={(v) => set({ mode: v })}>
                {(['text', 'button'] as const).map((m) => (
                  <Label key={m} className="flex cursor-pointer items-center gap-2 text-compact">
                    <RadioGroupItem value={m} />
                    {t(m === 'text' ? 'settingsPanel.modeText' : 'settingsPanel.modeButton')}
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>
            {node.data.mode === 'button' ? (
              <Label className="flex flex-col gap-1 text-compact">
                {t('settingsPanel.buttonTitle')}
                <Input value={node.data.buttonTitle} maxLength={LIMITS.buttonTitle} onChange={(e) => a.update(node.id, { buttonTitle: e.target.value }, { merge: true })} onBlur={a.seal} />
              </Label>
            ) : null}
            <Label className="flex cursor-pointer items-center justify-between gap-2 text-compact">
              {t('settingsPanel.disclosure')}
              <Switch checked={node.data.disclosure} onCheckedChange={(v) => set({ disclosure: v })} />
            </Label>
          </>
        ) : null}

        {node.type === 'message' ? (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-compact font-medium text-ink">{t('settingsPanel.format')}</legend>
              <RadioGroup
                value={node.data.format}
                onValueChange={(v) => {
                  if (v === 'none') set({ format: 'none', options: [] });
                  else if (node.data.format === 'none') set({ format: v, options: [{ id: 'o1', title: t('defaults.option') }] });
                  else set({ format: v });
                }}
              >
                {(['buttons', 'quick', 'none'] as const).map((f) => (
                  <Label key={f} className="flex cursor-pointer items-center gap-2 text-compact">
                    <RadioGroupItem value={f} disabled={f === 'buttons' && node.data.options.length > LIMITS.maxButtons} />
                    {t(f === 'buttons' ? 'settingsPanel.formatButtons' : f === 'quick' ? 'settingsPanel.formatQuick' : 'settingsPanel.formatNone')}
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>
            {node.data.format !== 'none' ? (
              <>
                <Label className="flex flex-col gap-1 text-compact">
                  {t('settingsPanel.saveTo')}
                  <Input
                    value={node.data.saveTo ?? ''}
                    placeholder={t('settingsPanel.saveToHint')}
                    maxLength={32}
                    onChange={(e) => a.update(node.id, { saveTo: e.target.value.toLowerCase() || undefined }, { merge: true })}
                    onBlur={a.seal}
                  />
                </Label>
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-compact font-medium text-ink">{t('settingsPanel.onTyped')}</legend>
                  <RadioGroup value={node.data.onTyped} onValueChange={(v) => set({ onTyped: v })}>
                    {(['reask', 'branch'] as const).map((m) => (
                      <Label key={m} className="flex cursor-pointer items-center gap-2 text-compact">
                        <RadioGroupItem value={m} />
                        {t(m === 'reask' ? 'settingsPanel.onTypedReask' : 'settingsPanel.onTypedBranch')}
                      </Label>
                    ))}
                  </RadioGroup>
                </fieldset>
              </>
            ) : null}
          </>
        ) : null}

        {node.type === 'question' ? (
          <>
            <Label className="flex flex-col gap-1 text-compact">
              {t('settingsPanel.field')}
              <Input value={node.data.field} maxLength={32} onChange={(e) => a.update(node.id, { field: e.target.value.toLowerCase() }, { merge: true })} onBlur={a.seal} />
            </Label>
            <Label className="flex flex-col gap-1 text-compact">
              {t('settingsPanel.validate')}
              <Select value={node.data.validate} onValueChange={(v) => set({ validate: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEXT_VALIDATIONS.map((v) => (
                    <SelectItem key={v} value={v}>
                      {t(`settingsPanel.validation.${v}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
```

Para não ficar com `undefined` dentro de `data`: `updateNodeData` aplica `{ ...n.data, ...patch }`, então um `saveTo: undefined` deixa a chave com `undefined`. O `JSON.stringify` do corpo descarta a chave, e a API recebe sem `saveTo`. Não é preciso tratar à parte.

- [ ] **Step 6: Menu "Próximo passo" e dock**

`flow/next-step-menu.tsx`:

```tsx
'use client';

import { Clock, Flag, GitBranch, ImageIcon, Link2, MessageSquare, TextCursorInput, UserPlus, Zap, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import type { BlockKind } from './logic';

export const BLOCKS: Array<{ kind: BlockKind; icon: LucideIcon }> = [
  { kind: 'message', icon: MessageSquare },
  { kind: 'question', icon: TextCursorInput },
  { kind: 'condition', icon: GitBranch },
  { kind: 'link', icon: Link2 },
  { kind: 'follow', icon: UserPlus },
  { kind: 'end', icon: Flag },
];
/** blocos das entregas 3 e 4 — aparecem desabilitados */
export const SOON: Array<{ key: 'delay' | 'media' | 'action'; icon: LucideIcon }> = [
  { key: 'delay', icon: Clock },
  { key: 'media', icon: ImageIcon },
  { key: 'action', icon: Zap },
];

export function NextStepMenu({ x, y, onPick, onClose }: { x: number; y: number; onPick: (k: BlockKind) => void; onClose: () => void }) {
  const t = useTranslations('automation.flow');
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - 380);
  return (
    <>
      <button type="button" aria-label={t('close')} className="fixed inset-0 z-40 cursor-pointer" onClick={onClose} />
      <div role="menu" aria-label={t('nextStep')} className="fixed z-50 flex w-56 flex-col gap-1 rounded-control border border-line-strong bg-surface p-2" style={{ left, top }}>
        <p className="px-2 py-1 text-meta font-medium text-graphite">{t('nextStep')}</p>
        {BLOCKS.map((b) => (
          <button
            key={b.kind}
            type="button"
            role="menuitem"
            onClick={() => onPick(b.kind)}
            className="flex cursor-pointer items-center gap-2 rounded-compact px-2 py-1.5 text-left text-compact text-ink transition-colors duration-200 hover:bg-surface-2"
          >
            <b.icon className="size-4 text-accent" aria-hidden />
            {t(`block.${b.kind}`)}
          </button>
        ))}
        {SOON.map((s) => (
          <span key={s.key} className="flex items-center gap-2 px-2 py-1.5 text-compact text-mist" aria-disabled>
            <s.icon className="size-4" aria-hidden />
            {t(`block.${s.key}`)}
            <span className="ml-auto text-meta">{t('soon')}</span>
          </span>
        ))}
      </div>
    </>
  );
}
```

`flow/dock.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BLOCKS, SOON } from './next-step-menu';
import type { BlockKind } from './logic';

export const DRAG_MIME = 'application/x-manypost-block';

/** paleta compacta de ícones: clicar insere no centro; arrastar insere onde soltar */
export function Dock({ onAdd }: { onAdd: (kind: BlockKind) => void }) {
  const t = useTranslations('automation.flow');
  return (
    <div className="absolute left-3 top-3 z-10 flex flex-col gap-1 rounded-control border border-line bg-surface p-1">
      {BLOCKS.map((b) => (
        <Tooltip key={b.kind}>
          <TooltipTrigger asChild>
            <button
              type="button"
              draggable
              aria-label={t(`block.${b.kind}`)}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, b.kind);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => onAdd(b.kind)}
              className="flex size-10 cursor-pointer items-center justify-center rounded-compact text-ink transition-colors duration-200 hover:bg-surface-2 hover:text-accent"
            >
              <b.icon className="size-5" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{t(`block.${b.kind}`)}</TooltipContent>
        </Tooltip>
      ))}
      {SOON.map((s) => (
        <Tooltip key={s.key}>
          <TooltipTrigger asChild>
            <span className="flex size-10 items-center justify-center text-mist" aria-label={`${t(`block.${s.key}`)} (${t('soon')})`}>
              <s.icon className="size-5" aria-hidden />
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">
            {t(`block.${s.key}`)} — {t('soon')}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
```

Se `Tooltip` exigir `TooltipProvider` acima, confira o shell (`app/(app)/layout.tsx` ou `components/shell`). Se já houver provider global, nada a fazer. Se não houver, envolva o `Dock` em `<TooltipProvider>`.

- [ ] **Step 7: Painel do gatilho (`trigger-panel.tsx`)**

Mova o `MediaPicker` de `builder-view.tsx` (linhas ~95–153) para cá **sem mudança de comportamento**, com os mesmos imports (`useRecentMedia`, `captionPreview`, `EngagementError`, `Skeleton`, `Check`, `ImageIcon`, `cn`, `Button`). Depois acrescente:

```tsx
export function TriggerPanel({
  open,
  onOpenChange,
  channelId,
  trigger,
  testUsernames,
  onTrigger,
  onTestUsernames,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  channelId: string;
  trigger: TriggerConfig;
  testUsernames: string[];
  onTrigger: (t: TriggerConfig) => void;
  onTestUsernames: (list: string[]) => void;
}) {
  const t = useTranslations('automation.flow');
  const [keywords, setKeywords] = useState(trigger.keywords.join(', '));
  const [testers, setTesters] = useState(testUsernames.map((u) => `@${u}`).join(', '));
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-6 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('trigger.title')}</SheetTitle>
          <SheetDescription>{t('trigger.description')}</SheetDescription>
        </SheetHeader>
        <section className="flex flex-col gap-2">
          <h3 className="text-compact font-medium text-ink">{t('trigger.media')}</h3>
          <p className="text-meta text-graphite">{t('trigger.mediaHint')}</p>
          <MediaPicker
            channelId={channelId}
            selected={trigger.mediaIds}
            onToggle={(id) =>
              onTrigger({
                ...trigger,
                mediaIds: trigger.mediaIds.includes(id) ? trigger.mediaIds.filter((x) => x !== id) : [...trigger.mediaIds, id],
              })
            }
          />
        </section>
        <Label className="flex flex-col gap-1 text-compact">
          {t('trigger.keywords')}
          <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} onBlur={() => onTrigger({ ...trigger, keywords: splitKeywords(keywords) })} />
          <span className="text-meta text-graphite">{t('trigger.keywordsHint')}</span>
        </Label>
        <section className="flex flex-col gap-2">
          <h3 className="text-compact font-medium text-ink">{t('trigger.publicReplies')}</h3>
          <p className="text-meta text-graphite">{t('trigger.publicRepliesHint')}</p>
          {trigger.publicReplies.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={r}
                maxLength={LIMITS.publicReply}
                onChange={(e) => onTrigger({ ...trigger, publicReplies: trigger.publicReplies.map((x, j) => (j === i ? e.target.value : x)) })}
              />
              <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={() => onTrigger({ ...trigger, publicReplies: trigger.publicReplies.filter((_, j) => j !== i) })}>
                <X aria-hidden />
              </Button>
            </div>
          ))}
          {trigger.publicReplies.length < LIMITS.maxPublicReplies ? (
            <Button variant="outline" size="sm" className="self-start" onClick={() => onTrigger({ ...trigger, publicReplies: [...trigger.publicReplies, ''] })}>
              <Plus aria-hidden />
              {t('trigger.addReply')}
            </Button>
          ) : null}
        </section>
        <Label className="flex flex-col gap-1 text-compact">
          {t('trigger.testUsers')}
          <Input value={testers} onChange={(e) => setTesters(e.target.value)} onBlur={() => onTestUsernames(splitUsernames(testers))} />
          <span className="text-meta text-graphite">{t('trigger.testUsersHint')}</span>
        </Label>
      </SheetContent>
    </Sheet>
  );
}
```

Imports adicionais:

- `useState` de `react`;
- `Plus` e `X` de `lucide-react`;
- `Input` e `Label`;
- `Sheet`, `SheetContent`, `SheetDescription`, `SheetHeader` e `SheetTitle` de `@/components/ui/sheet`;
- `LIMITS`, `splitKeywords` e `splitUsernames` de `../logic`;
- o tipo `TriggerConfig` de `./logic`.

Os textos de `MediaPicker` continuam vindo de `useTranslations('automation')` e `('engagement')`, como antes.

- [ ] **Step 8: O editor (`editor.tsx`)**

```tsx
'use client';

import {
  Background,
  BackgroundVariant,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import './flow.css';
import { LayoutGrid, Maximize, Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dock, DRAG_MIME } from './dock';
import { autoLayout } from './layout';
import {
  TRIGGER_NODE_ID,
  addNode,
  addOption,
  connect,
  createNode,
  duplicateNode,
  fieldsWritten,
  moveNode,
  removeEdge,
  removeNode,
  removeOption,
  updateNodeData,
  type BlockKind,
  type Flow,
  type NodeTexts,
  type Position,
  type Problem,
  type ShapeIssue,
  type ShapeKey,
  type TriggerConfig,
} from './logic';
import { NextStepMenu } from './next-step-menu';
import { FlowActionsContext, type FlowActions } from './actions';
import { NODE_TYPES } from './nodes';
import { TriggerPanel } from './trigger-panel';

export interface EditorDoc {
  name: string;
  flow: Flow;
  trigger: TriggerConfig;
  triggerPosition: Position;
  testUsernames: string[];
}

export function useNodeTexts(): NodeTexts {
  const t = useTranslations('automation.flow');
  // `raw`: os textos padrão levam `{nome}` literal, que o ICU interpretaria
  const r = (k: string) => t.raw(`defaults.${k}`) as string;
  return useMemo(
    () => ({
      opening: r('opening'),
      askName: r('askName'),
      thanks: r('thanks'),
      message: r('message'),
      option: r('option'),
      question: r('question'),
      end: r('end'),
      link: r('link'),
      linkButton: r('linkButton'),
      follow: r('follow'),
      followButton: r('followButton'),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );
}

interface Props {
  doc: EditorDoc;
  onChange: (doc: EditorDoc, opts?: { merge?: boolean }) => void;
  onSeal: () => void;
  readOnly: boolean;
  channelId: string;
  username: string | null;
  problems: Problem[];
  shape: ShapeIssue[];
  focus: { id: string; n: number } | null;
  onTestFrom: (nodeId: string) => void;
  texts: NodeTexts;
}

export function FlowEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({ doc, onChange, onSeal, readOnly, channelId, username, problems, shape, focus, onTestFrom, texts }: Props) {
  const t = useTranslations('automation.flow');
  const rf = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<null | { x: number; y: number; at: Position; from: { nodeId: string; handle: string } }>(null);
  const [triggerOpen, setTriggerOpen] = useState(false);

  // sempre a versão mais recente do documento dentro dos callbacks do React Flow
  const docRef = useRef(doc);
  docRef.current = doc;
  const setFlow = useCallback(
    (flow: Flow, opts?: { merge?: boolean }) => onChange({ ...docRef.current, flow }, opts),
    [onChange],
  );

  const byNode = useMemo(() => {
    const m = new Map<string, Problem[]>();
    for (const p of problems) if (p.nodeId) m.set(p.nodeId, [...(m.get(p.nodeId) ?? []), p]);
    return m;
  }, [problems]);
  const shapeByNode = useMemo(() => {
    const m = new Map<string, ShapeKey[]>();
    for (const s of shape) if (s.nodeId) m.set(s.nodeId, [...(m.get(s.nodeId) ?? []), s.key]);
    return m;
  }, [shape]);

  const derived: Node[] = useMemo(
    () => [
      {
        id: TRIGGER_NODE_ID,
        type: 'trigger',
        position: doc.triggerPosition,
        data: { trigger: doc.trigger },
        deletable: false,
        selected: selected === TRIGGER_NODE_ID,
      },
      ...doc.flow.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: { node: n },
        deletable: !readOnly && n.type !== 'opening',
        selected: selected === n.id,
      })),
    ],
    [doc.flow.nodes, doc.trigger, doc.triggerPosition, selected, readOnly],
  );
  // o React Flow guarda a medida de cada balão no nó; o estado local preserva `measured` entre renders
  const [nodes, setNodes] = useState<Node[]>(derived);
  useEffect(() => {
    setNodes((prev) => {
      const measured = new Map(prev.map((n) => [n.id, n.measured]));
      return derived.map((n) => ({ ...n, measured: measured.get(n.id) }));
    });
  }, [derived]);
  const edges: Edge[] = useMemo(
    () => [
      { id: 'e-trigger', source: TRIGGER_NODE_ID, sourceHandle: 'next', target: 'opening', deletable: false, focusable: false },
      ...doc.flow.edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, deletable: !readOnly })),
    ],
    [doc.flow.edges, readOnly],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      const cur = docRef.current;
      let flow = cur.flow;
      let triggerPosition = cur.triggerPosition;
      let moved = false;
      let dragging = false;
      let ended = false;
      for (const c of changes) {
        if (c.type === 'select') setSelected((s) => (c.selected ? c.id : s === c.id ? null : s));
        if (c.type === 'position') {
          if (c.position) {
            moved = true;
            dragging ||= Boolean(c.dragging);
            if (c.id === TRIGGER_NODE_ID) triggerPosition = c.position;
            else flow = moveNode(flow, c.id, c.position);
          }
          if (c.dragging === false) ended = true;
        }
        if (c.type === 'remove' && c.id !== TRIGGER_NODE_ID) {
          flow = removeNode(flow, c.id);
          moved = true;
        }
      }
      if (moved) onChange({ ...cur, flow, triggerPosition }, { merge: dragging });
      if (ended) onSeal();
    },
    [onChange, onSeal],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      let flow = docRef.current.flow;
      for (const c of changes) if (c.type === 'remove' && c.id !== 'e-trigger') flow = removeEdge(flow, c.id);
      if (flow !== docRef.current.flow) setFlow(flow);
    },
    [setFlow],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === TRIGGER_NODE_ID) return;
      setFlow(connect(docRef.current.flow, { source: c.source, sourceHandle: c.sourceHandle ?? null, target: c.target }));
    },
    [setFlow],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (readOnly || state.isValid || !state.fromNode || state.fromNode.id === TRIGGER_NODE_ID) return;
      const point = 'changedTouches' in event ? event.changedTouches[0]! : event;
      setMenu({
        x: point.clientX,
        y: point.clientY,
        at: rf.screenToFlowPosition({ x: point.clientX, y: point.clientY }),
        from: { nodeId: state.fromNode.id, handle: state.fromHandle?.id ?? 'next' },
      });
    },
    [readOnly, rf],
  );

  const insert = useCallback(
    (kind: BlockKind, at: Position, from?: { nodeId: string; handle: string }) => {
      const cur = docRef.current.flow;
      const node = createNode(kind, at, cur, texts, username);
      let flow = addNode(cur, node);
      if (from) flow = connect(flow, { source: from.nodeId, sourceHandle: from.handle, target: node.id });
      setFlow(flow);
      setSelected(node.id);
    },
    [setFlow, texts, username],
  );

  const center = () => {
    const r = wrapper.current?.getBoundingClientRect();
    return rf.screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 0) / 2, y: (r?.top ?? 0) + (r?.height ?? 0) / 2 });
  };

  // foco vindo da lista de problemas
  useEffect(() => {
    if (!focus) return;
    setSelected(focus.id);
    void rf.fitView({ nodes: [{ id: focus.id }], duration: 300, maxZoom: 1.1 });
  }, [focus, rf]);

  const organize = () => {
    const sizes = new Map(rf.getNodes().map((n) => [n.id, { width: n.measured?.width ?? 288, height: n.measured?.height ?? 160 }]));
    const r = autoLayout(docRef.current.flow, sizes);
    onChange({ ...docRef.current, flow: r.flow, triggerPosition: r.triggerPosition });
    requestAnimationFrame(() => void rf.fitView({ duration: 300 }));
  };

  const actions: FlowActions = useMemo(
    () => ({
      readOnly,
      problems: byNode,
      shape: shapeByNode,
      fields: [...fieldsWritten(doc.flow)],
      update: (id, patch, opts) => setFlow(updateNodeData(docRef.current.flow, id, patch), opts),
      seal: onSeal,
      addOption: (id) => setFlow(addOption(docRef.current.flow, id, texts.option)),
      removeOption: (id, optionId) => setFlow(removeOption(docRef.current.flow, id, optionId)),
      remove: (id) => {
        setFlow(removeNode(docRef.current.flow, id));
        setSelected(null);
      },
      duplicate: (id) => {
        const r = duplicateNode(docRef.current.flow, id);
        setFlow(r.flow);
        setSelected(r.id);
      },
      testFrom: onTestFrom,
      openTrigger: () => setTriggerOpen(true),
    }),
    [readOnly, byNode, shapeByNode, doc.flow, setFlow, onSeal, texts.option, onTestFrom],
  );

  const ctrl =
    'flex size-8 cursor-pointer items-center justify-center rounded-compact text-ink transition-colors duration-200 hover:bg-surface-2 hover:text-accent';

  return (
    <FlowActionsContext.Provider value={actions}>
      <div
        ref={wrapper}
        className="flow-canvas relative h-full w-full"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(DRAG_MIME)) e.preventDefault();
        }}
        onDrop={(e) => {
          const kind = e.dataTransfer.getData(DRAG_MIME) as BlockKind;
          if (!kind) return;
          e.preventDefault();
          insert(kind, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          isValidConnection={(c) => c.target !== 'opening' && c.target !== TRIGGER_NODE_ID && c.source !== c.target}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
          deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
          fitView
          minZoom={0.3}
          maxZoom={1.5}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--line-strong)" />
          <Panel position="bottom-left" className="flex gap-1 rounded-control border border-line bg-surface p-1">
            <button type="button" aria-label={t('zoomIn')} title={t('zoomIn')} className={ctrl} onClick={() => void rf.zoomIn()}>
              <Plus className="size-4" aria-hidden />
            </button>
            <button type="button" aria-label={t('zoomOut')} title={t('zoomOut')} className={ctrl} onClick={() => void rf.zoomOut()}>
              <Minus className="size-4" aria-hidden />
            </button>
            <button type="button" aria-label={t('fit')} title={t('fit')} className={ctrl} onClick={() => void rf.fitView({ duration: 300 })}>
              <Maximize className="size-4" aria-hidden />
            </button>
            {!readOnly ? (
              <button type="button" aria-label={t('organize')} title={t('organize')} className={ctrl} onClick={organize}>
                <LayoutGrid className="size-4" aria-hidden />
              </button>
            ) : null}
          </Panel>
        </ReactFlow>
        {!readOnly ? <Dock onAdd={(k) => insert(k, center())} /> : null}
        {menu ? (
          <NextStepMenu
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            onPick={(k) => {
              insert(k, menu.at, menu.from);
              setMenu(null);
            }}
          />
        ) : null}
        <TriggerPanel
          open={triggerOpen}
          onOpenChange={setTriggerOpen}
          channelId={channelId}
          trigger={doc.trigger}
          testUsernames={doc.testUsernames}
          onTrigger={(trigger) => onChange({ ...docRef.current, trigger })}
          onTestUsernames={(testUsernames) => onChange({ ...docRef.current, testUsernames })}
        />
      </div>
    </FlowActionsContext.Provider>
  );
}
```

- [ ] **Step 9: Typecheck da web**

Run: `bun run typecheck:web`
Expected: os arquivos novos de `flow/` compilam. Os erros que restarem devem estar só em `builder-view.tsx`, `hooks.ts`, `automations-view.tsx` e `logic.ts` (uso de `config`), que mudam no Task 12. Se o erro vier de tipos do React Flow, confira os nomes na versão instalada:

```bash
grep -n "FinalConnectionState\|NodeToolbar\|screenToFlowPosition" node_modules/@xyflow/react/dist/esm/index.d.ts | head
```

Ajuste os nomes **sem** mudar o comportamento descrito.

- [ ] **Step 10: Brand**

Run: `bun run check:brand`
Expected: verde nos arquivos novos. Os pontos mais prováveis de falha:

- **Gap fora da escala:** use só `gap-1/2/3/4/5/6/7/8` (4 a 32 px).
- **Raio:** `rounded-compact`, `rounded-control` e `rounded-card` são permitidos.
- **`<button>` sem `cursor-pointer`:** todo `<button>` acima já tem.

- [ ] **Step 11: Commit**

```bash
git add apps/web/package.json bun.lock apps/web/src/features/automation/flow apps/web/src/messages/pt-BR.json
git commit -m "feat(web): canvas do fluxo (balões editáveis, ⚙, próximo passo, dock, gatilho)"
```

---

### Task 12: Página do editor, lista, leads e remoção do formulário v1

**Files:**
- Create: `apps/web/src/features/automation/flow/top-bar.tsx`
- Create: `apps/web/src/features/automation/flow/editor-page.tsx`
- Modify: `apps/web/src/features/automation/hooks.ts`
- Modify: `apps/web/src/features/automation/automations-view.tsx`
- Modify: `apps/web/src/features/automation/logic.ts` e `logic.test.ts`
- Modify: `apps/web/src/app/(app)/automacoes/[id]/page.tsx` e `nova/page.tsx`
- Delete: `apps/web/src/features/automation/builder-view.tsx` e `conversation-preview.tsx`

**Interfaces:**
- Consumes: Tasks 10 e 11; tipos gerados no Task 9.
- Produces: `AutomationEditorPage({ id?: string })`.

- [ ] **Step 1: Hooks com o corpo novo**

Em `hooks.ts`, trocar o tipo do corpo e as duas mutations:

```ts
import type { Flow, TriggerConfig, Position } from './flow/logic';
```

(remover `import type { configFromDraft } from './logic';` e `type ConfigBody`.)

```ts
export interface AutomationBody {
  name: string;
  flow: Flow;
  triggers: Array<{ kind: 'comment'; config: TriggerConfig; position: Position | null }>;
  testUsernames: string[];
}

export function useCreateAutomation() {
  const qc = useQueryClient();
  return useMutation({
    // o tipo gerado do grafo é a união do OpenAPI; a paridade do formato é provada em flow/logic.test.ts
    mutationFn: async (body: AutomationBody & { channelId: string }) =>
      unwrap(await api.POST('/v1/automations', { body: body as never })),
    onSuccess: () => qc.invalidateQueries({ queryKey: [AUTOMATIONS] }),
  });
}

export function useUpdateAutomation(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: AutomationBody) =>
      unwrap(await api.PATCH('/v1/automations/{id}', { params: { path: { id: id! } }, body: body as never })),
    onSuccess: () => qc.invalidateQueries({ queryKey: [AUTOMATIONS] }),
  });
}
```

- [ ] **Step 2: Barra superior (`top-bar.tsx`)**

Leve para cá a lógica de status do `StatusBar` de `builder-view.tsx` (linhas ~334–434): Testar, Ativar com `AlertDialog` e os 3 avisos, Pausar e Excluir. Mantenha o comportamento e as chaves i18n (`automation.*`). O componente:

```tsx
'use client';

import { FlaskConical, Pause, Play, Redo2, Trash2, Undo2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useApiErrorMessage } from '@/lib/api/errors';
import { cn } from '@/lib/utils';
import { useDeleteAutomation, useSetAutomationStatus } from '../hooks';
import { LIMITS, type Status, statusVariant } from '../logic';
import type { Flow, Problem, ShapeIssue } from './logic';

export function TopBar({
  id,
  name,
  onName,
  status,
  flow,
  problems,
  shape,
  dirty,
  saving,
  canUndo,
  canRedo,
  hasTesters,
  onUndo,
  onRedo,
  onSave,
  onSimulate,
  onFocus,
  readOnly,
}: {
  id: string | undefined;
  name: string;
  onName: (v: string) => void;
  status: Status;
  flow: Flow;
  problems: Problem[];
  shape: ShapeIssue[];
  dirty: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasTesters: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onSimulate: () => void;
  onFocus: (nodeId: string) => void;
  readOnly: boolean;
}) {
  const t = useTranslations('automation');
  const tf = useTranslations('automation.flow');
  const router = useRouter();
  const errorMessage = useApiErrorMessage();
  const setStatus = useSetAutomationStatus(id);
  const remove = useDeleteAutomation();
  const errors = problems.filter((p) => p.severity === 'error').length + shape.length;
  const titleOf = (nodeId?: string | null) => {
    const n = flow.nodes.find((x) => x.id === nodeId);
    return n ? tf(`node.${n.type}`) : nodeId === 'trigger' ? tf('node.trigger') : tf('general');
  };
  const change = (s: Status) =>
    setStatus.mutate(s, {
      onSuccess: () => toast.success(t(`statusChanged.${s}`)),
      onError: (e) => toast.error(errorMessage(e)),
    });
  const blocked = !id || dirty || errors > 0;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Input
          value={name}
          onChange={(e) => onName(e.target.value)}
          maxLength={LIMITS.name}
          aria-label={tf('namePlaceholder')}
          placeholder={tf('namePlaceholder')}
          className="max-w-xs"
          disabled={readOnly}
        />
        <Badge variant={statusVariant(status)}>{t(`status.${status}`)}</Badge>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                'cursor-pointer rounded-compact px-2 py-1 text-meta font-medium transition-colors duration-200',
                errors ? 'bg-state-failed-tint text-state-failed' : problems.length ? 'bg-state-review-tint text-state-review' : 'bg-surface-2 text-graphite',
              )}
            >
              {tf('problems', { count: errors || problems.length })}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="flex w-80 flex-col gap-2">
            <p className="text-compact font-medium text-ink">{tf('problemsTitle')}</p>
            {[...shape.map((s) => ({ nodeId: s.nodeId, text: tf(`shape.${s.key}`), error: true })), ...problems.map((p) => ({ nodeId: p.nodeId ?? null, text: tf(`problem.${p.code}`), error: p.severity === 'error' }))].map((x, i) => (
              <button
                key={i}
                type="button"
                disabled={!x.nodeId}
                onClick={() => x.nodeId && onFocus(x.nodeId)}
                className="flex cursor-pointer flex-col items-start gap-0.5 rounded-compact px-2 py-1.5 text-left transition-colors duration-200 hover:bg-surface-2 disabled:cursor-default"
              >
                <span className="text-meta text-graphite">{titleOf(x.nodeId)}</span>
                <span className={cn('text-compact', x.error ? 'text-state-failed' : 'text-state-review')}>{x.text}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
        {dirty ? <span className="text-meta text-graphite">{tf('unsaved')}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!readOnly ? (
          <>
            <Button variant="ghost" size="icon-sm" aria-label={tf('undo')} title={tf('undo')} disabled={!canUndo} onClick={onUndo}>
              <Undo2 aria-hidden />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label={tf('redo')} title={tf('redo')} disabled={!canRedo} onClick={onRedo}>
              <Redo2 aria-hidden />
            </Button>
          </>
        ) : null}
        <Button variant="outline" size="sm" onClick={onSimulate}>
          {tf('simulate')}
        </Button>
        {!readOnly ? (
          <Button size="sm" variant={dirty ? 'primary' : 'outline'} disabled={!dirty || shape.length > 0 || !name.trim()} isLoading={saving} onClick={onSave}>
            {tf('save')}
          </Button>
        ) : null}
        {id && !readOnly ? (
          <>
            {status !== 'TEST' ? (
              <Button variant="outline" size="sm" disabled={blocked || !hasTesters} isLoading={setStatus.isPending && setStatus.variables === 'TEST'} onClick={() => change('TEST')}>
                <FlaskConical aria-hidden />
                {t('actionTest')}
              </Button>
            ) : null}
            {status !== 'ACTIVE' ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button size="sm" disabled={blocked}>
                    <Play aria-hidden />
                    {t('actionActivate')}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('activateTitle')}</AlertDialogTitle>
                    <AlertDialogDescription>{t('activateDescription')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-compact text-ink">
                    <li>{t('activateCheck1')}</li>
                    <li>{t('activateCheck2')}</li>
                    <li>{t('activateCheck3')}</li>
                  </ul>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => change('ACTIVE')}>{t('activateConfirm')}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
            {status === 'ACTIVE' || status === 'TEST' ? (
              <Button variant="outline" size="sm" isLoading={setStatus.isPending && setStatus.variables === 'PAUSED'} onClick={() => change('PAUSED')}>
                <Pause aria-hidden />
                {t('actionPause')}
              </Button>
            ) : null}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('actionDelete')}>
                  <Trash2 aria-hidden />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('deleteDescription')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      remove.mutate(id, {
                        onSuccess: () => router.push('/automacoes'),
                        onError: (e) => toast.error(errorMessage(e)),
                      })
                    }
                  >
                    {t('deleteConfirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Página do editor (`editor-page.tsx`)**

```tsx
'use client';

import { ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useChannels } from '@/features/channels/hooks';
import { ChannelSelect, NoEligibleChannel, useEngagementChannel } from '@/features/engagement/shared';
import { useApiErrorMessage } from '@/lib/api/errors';
import { useAutomation, useCreateAutomation, useUpdateAutomation } from '../hooks';
import type { Status } from '../logic';
import { FlowEditor, useNodeTexts, type EditorDoc } from './editor';
import { useFlowHistory } from './history';
import {
  TRIGGER_NODE_ID,
  defaultTrigger,
  emptyFlow,
  normalizeFlow,
  shapeIssues,
  triggerIssues,
  validateFlow,
  type NodeTexts,
} from './logic';
import { Simulator } from './simulator';
import { TopBar } from './top-bar';

/** abaixo de 768 px o canvas é só leitura (design D8) */
function useNarrow() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia('(max-width: 767px)');
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia('(max-width: 767px)').matches,
    () => false,
  );
}

type ApiAutomation = NonNullable<ReturnType<typeof useAutomation>['data']>;

function docFromApi(a: ApiAutomation, texts: NodeTexts): EditorDoc {
  const t0 = a.triggers[0];
  return {
    name: a.name,
    flow: a.flow ? normalizeFlow(a.flow as { nodes?: unknown[]; edges?: unknown[] }) : emptyFlow(texts),
    trigger: t0
      ? { mediaIds: t0.config.mediaIds ?? [], keywords: t0.config.keywords ?? [], publicReplies: t0.config.publicReplies ?? [] }
      : defaultTrigger(),
    triggerPosition: t0?.position ?? { x: -360, y: 0 },
    testUsernames: a.testUsernames,
  };
}

export function AutomationEditorPage({ id }: { id?: string }) {
  const t = useTranslations('automation');
  const errorMessage = useApiErrorMessage();
  const automation = useAutomation(id);
  const ch = useEngagementChannel('comments');
  const texts = useNodeTexts();

  if (id && automation.isPending) return <Skeleton className="h-[560px] rounded-lg" />;
  if (id && automation.isError) return <p className="text-compact text-state-failed">{errorMessage(automation.error)}</p>;
  if (!id && ch.isPending) return <Skeleton className="h-[560px] rounded-lg" />;
  if (!id && !ch.selected) return <NoEligibleChannel />;

  const channelId = id ? automation.data!.channelId : ch.selected!.id;
  const initial: EditorDoc = id
    ? docFromApi(automation.data!, texts)
    : { name: t('newTitle'), flow: emptyFlow(texts), trigger: defaultTrigger(), triggerPosition: { x: -360, y: 0 }, testUsernames: [] };
  return (
    <div className="flex flex-col gap-3">
      {!id && ch.list.length > 1 ? <ChannelSelect channels={ch.list} value={ch.selected!.id} onChange={ch.select} /> : null}
      <EditorShell
        key={`${id ?? 'nova'}:${channelId}`}
        id={id}
        channelId={channelId}
        status={id ? (automation.data!.status as Status) : 'DRAFT'}
        initial={initial}
        texts={texts}
      />
    </div>
  );
}

function EditorShell({ id, channelId, status, initial, texts }: { id?: string; channelId: string; status: Status; initial: EditorDoc; texts: NodeTexts }) {
  const t = useTranslations('automation');
  const tf = useTranslations('automation.flow');
  const router = useRouter();
  const errorMessage = useApiErrorMessage();
  const channels = useChannels();
  const username = channels.data?.find((c) => c.id === channelId)?.username ?? null;
  const history = useFlowHistory(initial);
  const doc = history.present;
  const create = useCreateAutomation();
  const update = useUpdateAutomation(id);
  const readOnly = useNarrow();
  const problems = useMemo(() => validateFlow(doc.flow), [doc.flow]);
  const shape = useMemo(
    () => [...shapeIssues(doc.flow), ...triggerIssues(doc.trigger).map((key) => ({ nodeId: TRIGGER_NODE_ID, key }))],
    [doc.flow, doc.trigger],
  );
  const [sim, setSim] = useState<{ startAt: string | null; n: number } | null>(null);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);

  // desfazer/refazer fora de campos de texto (os campos têm o próprio desfazer)
  const { undo, redo } = history;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [undo, redo]);

  // aviso do navegador ao fechar a aba com alterações
  useEffect(() => {
    if (!history.dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [history.dirty]);

  const save = () => {
    const body = {
      name: doc.name.trim(),
      flow: doc.flow,
      triggers: [{ kind: 'comment' as const, config: doc.trigger, position: doc.triggerPosition }],
      testUsernames: doc.testUsernames,
    };
    const onError = (e: unknown) => toast.error(errorMessage(e));
    if (status === 'ACTIVE') toast.message(tf('activeSaveWarning'));
    if (id) {
      update.mutate(body, {
        onSuccess: () => {
          history.markSaved();
          toast.success(tf('saved'));
        },
        onError,
      });
    } else {
      create.mutate(
        { channelId, ...body },
        {
          onSuccess: (a) => {
            history.markSaved();
            toast.success(t('created'));
            router.replace(`/automacoes/${(a as { id: string }).id}`);
          },
          onError,
        },
      );
    }
  };

  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-[560px] flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link
            href="/automacoes"
            onClick={(e) => {
              if (history.dirty && !window.confirm(tf('leaveDescription'))) e.preventDefault();
            }}
          >
            <ArrowLeft aria-hidden />
            {t('back')}
          </Link>
        </Button>
      </div>
      <TopBar
        id={id}
        name={doc.name}
        onName={(name) => history.set({ ...doc, name }, { merge: true })}
        status={status}
        flow={doc.flow}
        problems={problems}
        shape={shape}
        dirty={history.dirty}
        saving={create.isPending || update.isPending}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        hasTesters={doc.testUsernames.length > 0}
        onUndo={history.undo}
        onRedo={history.redo}
        onSave={save}
        onSimulate={() => setSim((s) => ({ startAt: null, n: (s?.n ?? 0) + 1 }))}
        onFocus={(nodeId) => setFocus((f) => ({ id: nodeId, n: (f?.n ?? 0) + 1 }))}
        readOnly={readOnly}
      />
      {readOnly ? <p className="rounded-control bg-surface-2 px-3 py-2 text-meta text-graphite">{tf('readOnly')}</p> : null}
      <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-card border border-line">
        <div className="min-w-0 flex-1">
          <FlowEditor
            doc={doc}
            onChange={history.set}
            onSeal={history.seal}
            readOnly={readOnly}
            channelId={channelId}
            username={username}
            problems={problems}
            shape={shape}
            focus={focus}
            onTestFrom={(nodeId) => setSim((s) => ({ startAt: nodeId, n: (s?.n ?? 0) + 1 }))}
            texts={texts}
          />
        </div>
        {sim ? <Simulator key={sim.n} flow={doc.flow} startAt={sim.startAt} onClose={() => setSim(null)} /> : null}
      </div>
    </div>
  );
}
```

`window.confirm` no "Voltar" é um diálogo nativo do navegador. Ele é aceitável aqui porque é a única saída interna da tela, e o `beforeunload` cobre fechar a aba. Se a revisão pedir o `AlertDialog` da marca, troque usando as chaves `leaveTitle`, `leaveDescription` e `leaveConfirm`.

O `ChannelSelect` só aparece em `nova` com mais de um canal elegível. Confira a assinatura em `features/engagement/shared.tsx` (`channels`, `value`, `onChange`) e ajuste os nomes se diferirem.

- [ ] **Step 4: Rotas, lista e Leads**

`apps/web/src/app/(app)/automacoes/[id]/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { AutomationEditorPage } from '@/features/automation/flow/editor-page';

export const metadata: Metadata = { title: 'Automação' };

export default async function AutomacaoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AutomationEditorPage id={id} />;
}
```

`apps/web/src/app/(app)/automacoes/nova/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { AutomationEditorPage } from '@/features/automation/flow/editor-page';

export const metadata: Metadata = { title: 'Nova automação' };

export default function NovaAutomacaoPage() {
  return <AutomationEditorPage />;
}
```

Em `automations-view.tsx`, trocar o miolo do `map`:

```tsx
            const trig = a.triggers[0]?.config;
            const keywords = trig?.keywords ?? [];
            const media = trig?.mediaIds ?? [];
            const blocks = a.flow?.nodes.length ?? 0;
```

Também:

- no resumo, trocar `t('summaryQuestions', { count: questions })` por `t('summaryBlocks', { count: blocks })`;
- trocar `a.config === null` por `a.flow === null`.

O editor só é carregado nas rotas `[id]` e `nova`, então a lista `/automacoes` não importa React Flow. Depois do `bun run build:web` (Step 6), confira na saída que `/automacoes` não cresceu mais que ~5 kB em relação ao build anterior. Se crescer, alguma importação da lista puxou `flow/`; remova.

`leads-view.tsx`: confira que o filtro de status lista `RUN_STATUSES` e usa `runStatusVariant`. Com o Task 1 e o i18n do Task 11, `ABANDONED` já aparece.

- [ ] **Step 5: Remover o formulário v1**

```bash
git rm apps/web/src/features/automation/builder-view.tsx apps/web/src/features/automation/conversation-preview.tsx
```

Em `logic.ts`, apagar o que só o formulário usava:

- `ChoiceQuestion`, `TextQuestion`, `Question`, `Draft`;
- `emptyDraft`, `draftFromConfig`, `configFromDraft`;
- `IssueKey`, `Issue`, `draftIssues`;
- `SAMPLE`, `Bubble`, `previewConversation`.

Ficam:

- `LIMITS`, `STATUSES`, `Status`, `RUN_STATUSES`, `RunStatus`;
- `TEXT_VALIDATIONS`, `TextValidation`;
- `splitKeywords`, `normalize`, `fieldFromPrompt`, `renderTemplate`;
- `statusVariant`, `runStatusVariant`, `answerEntries`, `splitUsernames`.

Em `logic.test.ts`, apagar os testes que importam o que saiu: o `describe('draftIssues')`, o de `previewConversation` e os 3 últimos de `'paridade com @manypost/contracts'`, que usam rascunho. Mantenha o primeiro, `'limites, status e validações são os mesmos'`, e os testes das funções que ficaram.

Run: `bun run typecheck:web && bun test apps/web`
Expected: verde. Se sobrar referência a algo apagado, o typecheck aponta.

- [ ] **Step 6: Build e brand**

```bash
bun run check:brand
bun run build:web
```

Expected: os dois verdes. O build não pode reclamar de `window` em SSR. Os usos de `window` no editor estão em `useEffect`, em handlers ou em `useSyncExternalStore` com o snapshot de servidor. O `NextStepMenu` usa `window.innerWidth` no render, mas só é montado depois de uma interação, no cliente.

- [ ] **Step 7: Commit**

```bash
git add -A apps/web/src
git commit -m "feat(web): editor de fluxo em canvas substitui o formulário da automação"
```

---

### Task 13: Simulador

**Files:**
- Create: `apps/web/src/features/automation/flow/simulator.tsx`

**Interfaces:**
- Consumes: `startSim`, `sendSim`, `tapForTitle`, `Flow` (Task 10).
- Produces: `Simulator({ flow, startAt, onClose })`.

- [ ] **Step 1: Escrever o simulador**

```tsx
'use client';

import { ExternalLink, RotateCcw, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { sendSim, startSim, tapForTitle, type Flow, type SimState } from './logic';

/**
 * Simulação local (design D8): roda o mesmo passo do motor sobre o fluxo em edição, sem chamar a API
 * nem a ponte. "Testar daqui" começa no balão escolhido.
 */
export function Simulator({ flow, startAt, onClose }: { flow: Flow; startAt: string | null; onClose: () => void }) {
  const t = useTranslations('automation.flow');
  const first = useMemo(() => startSim(flow, { username: 'cliente', startAt }), [flow, startAt]);
  const [state, setState] = useState<SimState>(first);
  const [text, setText] = useState('');
  const startNode = startAt ? flow.nodes.find((n) => n.id === startAt) : null;
  const lastBrand = [...state.transcript].reverse().find((x) => x.from === 'brand');

  const send = () => {
    if (!text.trim()) return;
    setState((s) => sendSim(s, { text }));
    setText('');
  };
  const tap = (title: string) => {
    const handle = tapForTitle(state.flow, state.nodeId, title);
    setState((s) => sendSim(s, handle ? { tap: handle } : { text: title }));
  };

  return (
    <aside aria-label={t('sim.title')} className="flex w-80 shrink-0 flex-col border-l border-line bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <span className="text-panel font-medium text-ink">{t('sim.title')}</span>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon-sm" aria-label={t('sim.restart')} title={t('sim.restart')} onClick={() => setState(startSim(flow, { username: 'cliente', startAt }))}>
            <RotateCcw aria-hidden />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}>
            <X aria-hidden />
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
        <p className="text-meta text-graphite">{t('sim.nothingSent')}</p>
        {startNode ? <p className="text-meta text-graphite">{t('sim.fromNode', { node: t(`node.${startNode.type}`) })}</p> : null}
        <ol className="flex flex-col gap-2">
          {state.transcript.map((x, i) => (
            <li key={i} className={cn('flex max-w-[85%] flex-col gap-1', x.from === 'user' ? 'items-end self-end' : 'self-start')}>
              <span className={cn('whitespace-pre-line rounded-card px-3 py-2 text-compact text-ink', x.from === 'user' ? 'bg-accent-tint' : 'bg-surface-2')}>
                {x.msg.text}
              </span>
              {x.msg.buttons?.map((b, j) =>
                x.msg.urls?.[j] ? (
                  <a key={j} href={x.msg.urls[j]} target="_blank" rel="noreferrer" className="flex items-center justify-center gap-1 rounded-compact border border-line px-3 py-1.5 text-meta font-medium text-accent">
                    {b}
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                ) : (
                  <button
                    key={j}
                    type="button"
                    disabled={x !== lastBrand || state.status !== 'waiting'}
                    onClick={() => tap(b)}
                    className="cursor-pointer rounded-compact border border-line bg-surface px-3 py-1.5 text-meta font-medium text-accent transition-colors duration-200 hover:bg-accent-tint disabled:cursor-default disabled:opacity-60"
                  >
                    {b}
                  </button>
                ),
              )}
              {x.msg.quick?.length ? (
                <span className="flex flex-wrap gap-1">
                  {x.msg.quick.map((q, j) => (
                    <button
                      key={j}
                      type="button"
                      disabled={x !== lastBrand || state.status !== 'waiting'}
                      onClick={() => tap(q)}
                      className="cursor-pointer rounded-compact border border-line-strong px-2.5 py-1 text-meta text-ink transition-colors duration-200 hover:bg-surface-2 disabled:cursor-default disabled:opacity-60"
                    >
                      {q}
                    </button>
                  ))}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
        {state.status !== 'waiting' ? (
          <p className={cn('text-meta', state.status === 'completed' ? 'text-state-published' : 'text-state-failed')}>{t(`sim.${state.status}`)}</p>
        ) : null}
      </div>
      <form
        className="flex gap-2 border-t border-line px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('sim.placeholder')} disabled={state.status !== 'waiting'} />
        <Button type="submit" size="sm" disabled={state.status !== 'waiting' || !text.trim()}>
          {t('sim.send')}
        </Button>
      </form>
      <section className="flex flex-col gap-1 border-t border-line px-4 py-3">
        <span className="text-meta font-medium text-graphite">{t('sim.fields')}</span>
        {Object.keys(state.answers).length === 0 ? (
          <span className="text-meta text-graphite">{t('sim.noFields')}</span>
        ) : (
          Object.entries(state.answers).map(([k, v]) => (
            <span key={k} className="text-meta text-ink">
              <span className="text-graphite">{k}:</span> {v}
            </span>
          ))
        )}
      </section>
    </aside>
  );
}
```

O simulador recebe `key={sim.n}` do editor: cada "Simular" ou "Testar daqui" monta do zero com o fluxo atual. Editar o fluxo com o painel aberto **não** reinicia a conversa. Para ver a mudança, use o botão Recomeçar.

- [ ] **Step 2: Typecheck, build e brand**

Run: `bun run typecheck:web && bun run check:brand && bun run build:web`
Expected: verde.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/features/automation/flow/simulator.tsx
git commit -m "feat(web): simulador de conversa do fluxo"
```

---

### Task 14: E2E e diagnóstico

**Files:**
- Modify: `scripts/e2e-automation.ts`
- Modify: `scripts/diag-automation.ts`

- [ ] **Step 1: Ajustar o E2E v1 ao motor novo**

Em `scripts/e2e-automation.ts`, trocar as quatro checagens que dependem do formato v1 do payload e da chave:

```ts
  check(prButtons?.[0]?.payload === `mp2:${run.id}:opening:next`, 'botão da abertura carrega o id da execução');
```

```ts
  await send('message.received', message({ text: 'Quero!' }, { postbackPayload: `mp2:${run.id}:opening:next` }));
  const q1 = await until(() => sends()[0], 'pergunta 1');
  check(q1.idem === `${run.id}:c1:0`, 'pergunta enviada com Idempotency-Key');
```

```ts
  await send('message.received', message({ text: 'Vida' }, { postbackPayload: `mp2:${run.id}:q0:o1` }));
```

```ts
  check(reask.idem === `${run.id}:c2:1`, 'telefone inválido re-pergunta com chave nova');
```

A automação do E2E é criada direto pelo repositório com `config` v1 e **sem** linha de gatilho. Então ela também prova a queda para `config.trigger`.

- [ ] **Step 2: Acrescentar o cenário v2**

Depois da criação da automação v1, criar a v2 com gatilho na tabela:

```ts
const P = { x: 0, y: 0 };
const ed = (source: string, sourceHandle: string, target: string) => ({ id: `e-${source}-${sourceHandle}`, source, sourceHandle, target });
const automationV2 = await makeAutomationRepository(db).create({
  orgId,
  channelId: channel!.id,
  name: 'E2E canvas',
  status: 'ACTIVE',
  testUsernames: [],
  createdBy: null,
  config: {
    version: 2,
    nodes: [
      { id: 'opening', type: 'opening', position: P, data: { text: 'Oi!', mode: 'text', buttonTitle: 'Quero!', disclosure: true } },
      { id: 'tipo', type: 'message', position: P, data: { text: 'Para quem?', format: 'buttons', options: [{ id: 'pf', title: 'Pessoa física' }, { id: 'pj', title: 'Minha empresa' }], saveTo: 'tipo', onTyped: 'reask' } },
      { id: 'info', type: 'message', position: P, data: { text: 'Empresarial tem condições especiais.', format: 'none', options: [], onTyped: 'reask' } },
      { id: 'nome', type: 'question', position: P, data: { text: 'Seu nome?', field: 'nome', validate: 'name' } },
      { id: 'c', type: 'condition', position: P, data: { field: 'tipo', op: 'equals', value: 'minha empresa' } },
      { id: 'wa', type: 'link', position: P, data: { text: 'Fale com a gente', buttonTitle: 'WhatsApp', target: { kind: 'whatsapp', phone: '5592999990000', message: 'Sou {nome}' } } },
      { id: 'seguir', type: 'link', position: P, data: { text: 'Segue a gente', buttonTitle: 'Seguir', target: { kind: 'url', url: 'https://instagram.com/e2e.conta' } } },
      { id: 'fim', type: 'end', position: P, data: { text: 'Obrigado, {nome}!' } },
    ],
    edges: [ed('opening', 'next', 'tipo'), ed('tipo', 'pf', 'nome'), ed('tipo', 'pj', 'info'), ed('info', 'next', 'nome'), ed('nome', 'next', 'c'), ed('c', 'yes', 'wa'), ed('c', 'no', 'fim'), ed('wa', 'next', 'seguir')],
  },
  triggers: [{ kind: 'comment', config: { mediaIds: [], keywords: ['empresarial'], publicReplies: [] }, position: null }],
});
```

E, antes do `catch`, um bloco que conduz o v2 numa segunda conversa:

```ts
  console.log('fluxo v2 (canvas)');
  const message2 = (over: Record<string, unknown>, metadata: Record<string, unknown> = {}) => ({
    message: { conversationId: 'conv-e2e-2', platform: 'instagram', direction: 'incoming', text: '', sender: { id: 'igsid-e2e-2', username: 'empresa.e2e' }, ...over },
    conversation: { id: 'conv-e2e-2', participantId: 'igsid-e2e-2' },
    metadata,
  });
  const sends2 = () => calls.filter((c) => c.path === '/api/v1/inbox/conversations/conv-e2e-2/messages');
  await send('comment.received', {
    comment: { id: 'c-e2e-2', platformPostId: '1802', platform: 'instagram', text: 'plano EMPRESARIAL', author: { id: 'igsid-e2e-2', username: 'empresa.e2e', isOwnAccount: false }, isReply: false, parentCommentId: null },
  });
  const pr2 = await until(() => calls.find((c) => c.path.endsWith('/c-e2e-2/private-reply')), 'resposta privada v2');
  check(!pr2.body.buttons && String(pr2.body.message).includes('Responda esta mensagem para continuar.'), 'abertura v2 em texto, sem botão');
  const run2 = await until(() => db.query.automationRuns.findFirst({ where: (r, { eq }) => eq(r.automationId, automationV2.id) }), 'execução v2');
  await send('message.received', message2({ text: 'oi' }));
  await until(() => sends2()[0], 'botões v2');
  await send('message.received', message2({ text: 'Minha empresa' }, { postbackPayload: `mp2:${run2.id}:tipo:pj` }));
  await until(() => sends2()[2], 'info + nome');
  check(sends2()[1]?.body.message === 'Empresarial tem condições especiais.' && sends2()[2]?.body.message === 'Seu nome?', 'mensagens encadeadas no mesmo evento');
  await send('message.received', message2({ text: 'Ana' }));
  await until(() => sends2()[4], 'WhatsApp + seguir');
  check(JSON.stringify(sends2()[3]?.body.buttons).includes(encodeURIComponent('Sou Ana')), 'link do WhatsApp preenchido');
  check(JSON.stringify(sends2()[4]?.body.buttons).includes('instagram.com/e2e.conta'), 'pedir para seguir depois do WhatsApp');
  const done2 = await until(async () => {
    const r = await db.query.automationRuns.findFirst({ where: (x, { eq }) => eq(x.automationId, automationV2.id) });
    return r?.status === 'COMPLETED' && r.leadEmittedAt ? r : null;
  }, 'execução v2 completa');
  check(JSON.stringify(done2.answers) === JSON.stringify({ tipo: 'Minha empresa', nome: 'Ana' }), 'respostas v2 gravadas');
  await until(() => hooks.find((h) => (h.body.data as { runId?: string })?.runId === run2.id), 'lead.captured v2', 30_000);
```

Se `sends2()[n]?.body.message` não for o nome do campo de texto que a ponte manda, use o mesmo que o bloco v1 lê (`q1.body.buttons` / `fim.body.buttons`). Abra `packages/providers/src/zernio/zernio-bridge.ts` e confira o nome do campo de texto em `sendMessage`.

- [ ] **Step 3: Rodar o E2E**

```bash
DATABASE_URL=postgresql://mp:mp@localhost:5599/mp REDIS_URL=redis://localhost:6379 ENCRYPTION_KEY=<a do .env local> bun run scripts/e2e-automation.ts
```

O Postgres de teste do Task 6 serve; o Redis tem de estar de pé, como no E2E original. Expected: todas as checagens `ok` e `E2E da automação ok`.

- [ ] **Step 4: Diagnóstico**

Em `scripts/diag-automation.ts`:

- **Seção de automações:** além do que já imprime, listar os gatilhos de `listTriggers([ids])` com tipo, número de posts, palavras-chave e número de respostas públicas, ou "(gatilho da config v1)" quando não houver linha. Imprimir a versão do config (`config.version ?? 1`) e o número de nós.
- **Na reavaliação dos eventos:** usar `commentTriggerOf` + `matchesCommentTrigger` (exportados pelo core) em vez de `matchesTrigger(cfg, …)`.
- **Nas execuções:** imprimir `nodeId`, `cursor` e `sentCursor` ao lado de `step`.

Conferir se o core exporta `commentTriggerOf`, `loadFlow` e `matchesCommentTrigger` no índice. Se não exportar, acrescentar em `packages/core/src/index.ts`, ao lado de onde `automationLogic` é exportado.

Run: `bun run typecheck` e um smoke contra o banco local:

```bash
DATABASE_URL=postgresql://mp:mp@localhost:5599/mp bun run scripts/diag-automation.ts <channelId do E2E>
```

Expected: imprime gatilhos e cursor sem erro (o pg-boss ausente localmente é esperado).

- [ ] **Step 5: Commit**

```bash
git add scripts/e2e-automation.ts scripts/diag-automation.ts packages/core/src/index.ts
git commit -m "test(e2e): automação v1 no motor novo e fluxo v2 com condição e pedir para seguir"
```

---

### Task 15: Validação no navegador, documentação e fechamento

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/principal/STATUS.md`
- Modify: `docs/principal/CHANGELOG_ONDAS.md`
- Create: `docs/principal/RUNBOOK_FLOW_BUILDER.md`
- Modify: `openspec/changes/add-flow-builder-canvas/tasks.md` (marcar o que foi feito)

- [ ] **Step 1: Montar um fluxo de verdade no navegador**

Com `bun run dev:all` (API :3100 + web :3000) e o banco local, abra `http://localhost:3000/automacoes/nova` e:

1. Confira o fluxo inicial (abertura → pergunta nome → fim) sem problemas.
2. Puxe a saída "Respondeu" para o vazio, escolha **Mensagem**, renomeie os botões ("Pessoa física", "Minha empresa") e adicione um terceiro. O quarto fica bloqueado.
3. No ⚙ da mensagem, "Guardar a escolha em" `tipo`. Ligue cada botão a um caminho, com **Condição** (`tipo` é igual a `minha empresa`), **Link ou WhatsApp** e **Pedir para seguir** depois do WhatsApp.
4. Deixe uma saída sem ligar: o selo mostra o problema, clicar nele foca o balão, e Ativar fica desabilitado.
5. Desfazer e refazer (botões e Ctrl/Cmd+Z fora de campo de texto). Use Organizar e Centralizar.
6. Simular conversa: toque nos botões, digite texto inválido (re-pergunta), chegue ao fim e confira "Campos gravados". Use "Testar daqui" num balão do meio.
7. Salve. A URL vira `/automacoes/<id>` e recarregar a página mantém tudo, inclusive posições e gatilho.
8. Abra em largura < 768 px (DevTools): só leitura, sem dock.
9. Abra uma automação v1 (crie uma pelo E2E ou pelo repositório): ela aparece convertida, com aviso no modo botão.

Anote qualquer defeito, corrija com teste quando houver lógica envolvida, e commite cada correção separado: `fix(web): …`.

- [ ] **Step 2: Runbook**

`docs/principal/RUNBOOK_FLOW_BUILDER.md`:

```md
# Runbook: construtor de fluxo em canvas (add-flow-builder-canvas)

## Antes do deploy
- `bun run check:ci` verde na `maquina`.
- Nenhuma automação ou workflow da Zernio ativo na conta (eles respondem antes do manypost).

## Deploy (Easypanel, manual)
1. Clicar em Deploy. No boot entram as migrations `0012_flow-builder` (tabela de gatilhos e cursor
   nas execuções) e `0013_flow-builder-backfill` (um gatilho por automação existente).
2. Conferir no console: `bun run scripts/diag-automation.ts <channelId>` mostra o gatilho da
   automação ativa e as execuções com `nodeId`.
3. A automação ativa continua no formato antigo no banco e roda pelo motor novo.

## Teste em produção
1. Criar uma automação nova no canvas, em **Teste**, com o @ de teste.
2. Comentar a palavra-chave com o @ de teste e percorrer o fluxo (botões, condição, pedir para
   seguir, fim). Conferir o lead em /leads e o `lead.captured` no n8n.

## Migrar a automação ativa
1. Abrir a automação ativa no canvas. Ela aparece convertida, com o aviso de abertura em botão.
2. Trocar a abertura para "Pedir para responder" (quem não segue a conta passa a receber).
3. Salvar. A partir daqui ela é v2.

## Voltar atrás
- Antes do passo "Migrar a automação ativa": voltar o deploy anterior no Easypanel é seguro.
  Conversas que começaram no código novo e estavam no meio podem repetir uma pergunta.
- Depois: não voltar o deploy (o código antigo não lê v2). Pausar a automação, corrigir e
  publicar de novo.
```

- [ ] **Step 3: CHANGELOG, STATUS e CHANGELOG_ONDAS**

- **`CHANGELOG.md`:** em `## [Unreleased]`, `### Added`, uma linha:
  "Construtor de fluxo em canvas para automações do Instagram: balões conectados, ramificação por botão, condição, pedir para seguir, simulador e gatilho separado do fluxo (add-flow-builder-canvas)."
  Em `### Changed`, outra:
  "O motor da automação percorre o fluxo em grafo; automações e conversas do formato antigo continuam funcionando."
- **`docs/principal/STATUS.md`:** atualizar a seção de automações. Ela passa a dizer:
  - o editor agora é o canvas;
  - o roteiro tem 5 entregas, e esta é a 1;
  - as provas são o número de testes, as fixtures compartilhadas, a sequência dourada da v1 e o E2E v1 + v2;
  - o que falta: entregas 2 a 5 e a tarefa 10.3 (produção).
- **`docs/principal/CHANGELOG_ONDAS.md`:** entrada no topo, "Onda 46: construtor de fluxo em canvas (entrega 1 de 5)", no mesmo formato da onda 45. Incluir o que mudou, as decisões do Iago de 13/10/2026 e as provas.

Sem segredos, ids de conta ou dados pessoais. O @ de teste aparece como "o @ de teste".

- [ ] **Step 4: Marcar as tarefas da mudança OpenSpec**

Em `openspec/changes/add-flow-builder-canvas/tasks.md`, marcar `[x]` em tudo que foi feito. A tarefa de produção (deploy pelo Iago e teste com o @) fica `[ ]`.

- [ ] **Step 5: Verificação final**

```bash
bun install --frozen-lockfile
bun run check:ci
TEST_DATABASE_URL=postgresql://mp:mp@localhost:5599/mp bun test packages/db
```

Expected: tudo verde. Em especial, `spec:validate` (38+ itens) e `db:check`. Se algo falhar, corrija antes do commit final. Não pule nem desligue testes.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md docs/principal openspec/changes/add-flow-builder-canvas/tasks.md
git commit -m "docs: onda 46, construtor de fluxo em canvas (entrega 1)"
```

Não fazer push nem deploy: o Iago decide o push e clica Deploy no Easypanel.
