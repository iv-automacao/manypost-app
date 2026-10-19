# Balão Ação (enviar dados e avisar a equipe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um balão `action` no fluxo da automação que, em qualquer ponto, dispara o webhook `lead.updated` ("Enviar dados") ou cria uma notificação para a equipe ("Avisar a equipe") e segue para o próximo balão.

**Architecture:** O tipo novo entra no contrato (`packages/contracts`), nas funções puras do passo (`packages/core/src/domain/automation`) e no espelho da web (`apps/web/.../flow/logic.ts`), com fixtures compartilhadas. O motor executa o efeito no mesmo ponto em que um balão "sai" e grava `sentCursor`, então retomar não repete. O envio usa o pipeline de webhooks que já existe; o aviso usa a tabela `notifications`.

**Tech Stack:** Bun, TypeScript, Zod, Hono (API), pg-boss, Next.js + React Flow (`@xyflow/react`) + next-intl (web).

**Spec:** `openspec/changes/add-flow-action-node/` — `proposal.md`, `design.md`, `specs/automation-flow-builder/spec.md`, `tasks.md`. Leia o `design.md` antes de começar.

## Global Constraints

- Fluxo OpenSpec obrigatório (`AGENTS.md`): ao terminar cada grupo, marque as caixas correspondentes em `openspec/changes/add-flow-action-node/tasks.md`.
- Comentários de código em **português**. O wordmark é sempre `manypost`, em caixa baixa.
- Tipo do nó: `'action'`. Tipos de ação: `'send_data'` (campo `label`) e `'notify'` (campo `text`).
- Rótulo: mesmo formato de campo, `/^[a-z][a-z0-9_]{0,31}$/`.
- Texto do aviso: 1 a 280 caracteres (`AUTOMATION_LIMITS.notifyText = 280`), aceita `{campo}` e `{username}`.
- O nó de ação **não tem `delaySec`**; se vier, o schema descarta (como na abertura).
- Saída única `next`, obrigatória. `waits(action) = false`.
- Evento novo: `WebhookEvents.LeadUpdated = 'lead.updated'`. O `lead.captured` **não muda**.
- Payload do `lead.updated`: `label`, `nodeId`, `runId`, `automationId`, `automationName`, `channelId`, `mediaId`, `commentId`, `commentText`, `participantId`, `participantUsername`, `answers`, `whatsappUrl`, `status: 'OPEN'`, `test`, `sentAt`.
- Notificação: `{ orgId, userId: null, kind: 'automation.notify', title: <nome da automação>, body: <texto preenchido>, link: '/leads' }`.
- Nenhum código de problema novo (`FlowProblemCodes` não muda). Formato inválido = 400 na API e `shapeIssues` na web.
- Sem migration.
- Web: só tokens CSS do brand, `cursor-pointer` em botão, hover só por cor (ver `docs/brand/BRAND_SYSTEM.md`). Textos novos só em `apps/web/src/messages/pt-BR.json`; mensagens com `{campo}` literal são lidas com `t.raw`.
- `apps/web/openapi.json` e `apps/web/src/lib/api/schema.d.ts` são gerados, nunca editados à mão.
- E2E e geração do OpenAPI rodam numa stack **isolada** (Postgres `mp-test-pg` na 5599, Redis `mp-test-redis` na 6379), **nunca** no banco de dev do dono (5499).

## Review Focus

1. **Ação logo depois de uma retentativa de envio:** um envio que falha depois da ação faz o job ser refeito, e o `lead.updated` não pode sair duas vezes. O teste fica na Task 3 ("retry depois da ação não repete o evento").
2. **Falha ao gravar o evento:** o job tem que lançar e a ação tem que sair na retentativa, sem perder o lead. Teste na Task 3.
3. **Trocar o tipo da ação no editor:** de "Enviar dados" para "Avisar" e de volta não pode deixar dado velho que trave o Salvar ou vá para a API. Teste na Task 2 (`normalizeFlow` limpa) e cuidado na Task 4 (o patch zera o campo do outro tipo).
4. **Duas ações seguidas e ação seguida de Fim sem texto:** o simulador e o motor seguem sem parar e sem mandar mensagem. Fixture `18` na Task 1 e teste do motor na Task 3.
5. **Modo Teste:** o `lead.updated` sai com `test: true`, e o receptor decide. Teste na Task 3.

---

### Task 1: Contrato, passo puro do core e fixtures

**Files:**
- Modify: `packages/contracts/src/automation.ts` (`AUTOMATION_LIMITS`, linha ~33)
- Modify: `packages/contracts/src/automation-flow.ts` (`FlowNodeTypes` :23, nós :100-156, `handlesOf` :169)
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/automation-flow.test.ts`
- Modify: `packages/core/src/domain/automation/flow-step.ts`
- Modify: `packages/core/src/domain/automation/flow-graph.ts`
- Modify: `packages/core/src/domain/automation/flow-simulate.ts`
- Create: `testdata/automation-flows/17-action-send-data.json`, `18-action-chain-notify.json`, `19-action-dead-end.json`
- Test: `packages/core/src/domain/automation/flow-step.test.ts`, `flow-fixtures.test.ts` (já roda as fixtures novas)

**Interfaces:**
- Produces (contracts): `FlowNodeOf<'action'>` com `data: { kind: 'send_data'; label: string } | { kind: 'notify'; text: string }`; `AUTOMATION_LIMITS.notifyText = 280`; `WebhookEvents.LeadUpdated`.
- Produces (core, exportado de `flow-step.ts`): `export type ActionEffect = { kind: 'send_data'; label: string } | { kind: 'notify'; text: string }` e `export function actionFor(node: FlowNode, ctx: StepContext): ActionEffect | null`.
- Produces (core, `flow-simulate.ts`): `export interface SimActionLine { action: ActionEffect }`; `SimResult.messages: Array<SimMessage | SimActionLine>`.

- [ ] **Step 1: Testes do contrato que falham**

Acrescente ao fim de `packages/contracts/src/automation-flow.test.ts` (o arquivo já define `opening`, `end`, `flow`, `edge`, `issues`):

```ts
describe('balão de ação', () => {
  const acao = (data: unknown, extra: Record<string, unknown> = {}) => ({ id: 'acao', type: 'action', position: { x: 0, y: 100 }, data, ...extra });
  const comAcao = (data: unknown) => flow([opening, acao(data), end], [edge('opening', 'next', 'acao'), edge('acao', 'next', 'fim')]);

  test('enviar dados: rótulo no formato de campo', () => {
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'send_data', label: 'whatsapp_coletado' })).success).toBe(true);
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'send_data', label: 'WhatsApp coletado' })).success).toBe(false);
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'send_data', label: '' })).success).toBe(false);
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'send_data', label: `a${'b'.repeat(32)}` })).success).toBe(false);
  });

  test('avisar a equipe: texto de 1 a 280 caracteres', () => {
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'notify', text: 'Lead novo: {nome}' })).success).toBe(true);
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'notify', text: '   ' })).success).toBe(false);
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'notify', text: 'x'.repeat(281) })).success).toBe(false);
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'notify', text: 'x'.repeat(280) })).success).toBe(true);
  });

  test('tipo de ação desconhecido é recusado', () => {
    expect(FlowV2Schema.safeParse(comAcao({ kind: 'tag', label: 'x' })).success).toBe(false);
  });

  test('a ação não tem atraso: delaySec é descartado', () => {
    const r = FlowV2Schema.parse(comAcao({ kind: 'send_data', label: 'x', delaySec: 5 }));
    expect(r.nodes[1]).not.toHaveProperty('data.delaySec');
  });

  test('saída única next', () => {
    const outra = flow([opening, acao({ kind: 'send_data', label: 'x' }), end], [edge('opening', 'next', 'acao'), edge('acao', 'yes', 'fim')]);
    expect(issues(outra)).toContain('saída inexistente no nó de origem');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test packages/contracts/src/automation-flow.test.ts`
Expected: FAIL nos testes de "balão de ação" (o `type: 'action'` não existe no `discriminatedUnion`).

- [ ] **Step 3: Implementar o contrato**

Em `packages/contracts/src/automation.ts`, dentro de `AUTOMATION_LIMITS`, depois de `reminderMaxMinutes: 1380,`:

```ts
  /** texto do balão "Avisar a equipe" (notificação no sino) */
  notifyText: 280,
```

Em `packages/contracts/src/automation-flow.ts`:

```ts
export const FlowNodeTypes = ['opening', 'message', 'question', 'condition', 'link', 'end', 'action'] as const;
export const FlowActionKinds = ['send_data', 'notify'] as const;
```

Antes de `export const FlowNodeSchema`:

```ts
/** efeito sem mensagem para a pessoa: dispara `lead.updated` ou avisa a equipe, e segue por `next` */
const ActionNode = z.object({
  id: flowId,
  type: z.literal('action'),
  position: Position,
  data: z.discriminatedUnion('kind', [
    // o rótulo vira chave no sistema que recebe: mesmo formato dos campos
    z.object({ kind: z.literal('send_data'), label: field }),
    /** aceita {campo} e {username} */
    z.object({ kind: z.literal('notify'), text: text(L.notifyText) }),
  ]),
});
```

Inclua `ActionNode` no fim da lista do `FlowNodeSchema`. Em `handlesOf`:

```ts
    case 'opening':
    case 'question':
    case 'link':
    case 'action':
      return ['next'];
```

Em `packages/contracts/src/events.ts`, depois de `LeadCaptured`:

```ts
  // lead no meio do fluxo, disparado pelo balão Ação "Enviar dados" (add-flow-action-node)
  LeadUpdated: 'lead.updated',
```

Os enums de evento da API (`webhooks.routes.ts:10` e `public-v1.routes.ts:202`) usam `Object.values(WebhookEvents)` e pegam o evento novo sozinhos.

- [ ] **Step 4: Rodar o teste do contrato**

Run: `bun test packages/contracts/src/automation-flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Testes do passo que falham**

Acrescente a `packages/core/src/domain/automation/flow-step.test.ts`. Confira os imports do topo do arquivo e inclua `actionFor` e `autoNext`, se faltarem:

```ts
describe('balão de ação', () => {
  const P = { x: 0, y: 0 };
  const fluxo = FlowV2Schema.parse({
    version: 2,
    nodes: [
      { id: 'opening', type: 'opening', position: P, data: { text: 'Oi' } },
      { id: 'dados', type: 'action', position: P, data: { kind: 'send_data', label: 'nome_coletado' } },
      { id: 'avisa', type: 'action', position: P, data: { kind: 'notify', text: 'Lead novo: {nome} (@{username})' } },
      { id: 'fim', type: 'end', position: P, data: {} },
    ],
    edges: [
      { id: 'e1', source: 'opening', sourceHandle: 'next', target: 'dados' },
      { id: 'e2', source: 'dados', sourceHandle: 'next', target: 'avisa' },
    ],
  });
  const ctx = { runId: 'r', answers: { nome: 'Ana' }, username: 'ana.s' };
  const no = (id: string) => fluxo.nodes.find((n) => n.id === id)!;

  test('actionFor resolve o efeito com os campos preenchidos', () => {
    expect(actionFor(no('dados'), ctx)).toEqual({ kind: 'send_data', label: 'nome_coletado' });
    expect(actionFor(no('avisa'), ctx)).toEqual({ kind: 'notify', text: 'Lead novo: Ana (@ana.s)' });
    expect(actionFor(no('opening'), ctx)).toBeNull();
  });

  test('a ação não manda mensagem, não espera, não atrasa e segue por next', () => {
    expect(messageFor(no('dados'), ctx)).toBeNull();
    expect(waits(no('dados'))).toBe(false);
    expect(delayOf(no('dados'))).toBe(0);
    expect(autoNext(fluxo, no('dados'), ctx.answers)).toEqual({ kind: 'goto', to: 'avisa' });
    expect(autoNext(fluxo, no('avisa'), ctx.answers)).toEqual({ kind: 'dead_end', handle: 'next' });
    expect(outputsOf(no('dados'))).toEqual([{ handle: 'next', required: true }]);
  });
});
```

(`waits` e `outputsOf` vêm de `./flow-graph`; `FlowV2Schema` vem de `@manypost/contracts`. Ajuste os imports.)

- [ ] **Step 6: Rodar e ver falhar**

Run: `bun test packages/core/src/domain/automation/flow-step.test.ts`
Expected: FAIL (`actionFor` não existe, e o `switch` de `messageFor` não trata `action`).

- [ ] **Step 7: Implementar o passo e o grafo**

Em `flow-step.ts`, em `messageFor`, depois de `case 'end': ...`:

```ts
    case 'action':
      return null;
```

E, depois de `messageFor`:

```ts
export type ActionEffect = { kind: 'send_data'; label: string } | { kind: 'notify'; text: string };

/** efeito do balão de ação, com o texto do aviso já preenchido; `null` = o nó não é ação */
export function actionFor(node: FlowNode, ctx: StepContext): ActionEffect | null {
  if (node.type !== 'action') return null;
  const d = node.data;
  return d.kind === 'send_data' ? { kind: 'send_data', label: d.label } : { kind: 'notify', text: renderTemplate(d.text, ctx.answers, ctx.username) };
}
```

`delayOf` (`'delaySec' in node.data`) e `autoNext` (`default: go('next')`) já tratam a ação; não mude.

Em `flow-graph.ts`, em `outputsOf`:

```ts
    case 'opening':
    case 'question':
    case 'action':
      return [{ handle: 'next', required: true }];
```

`waits` não muda (devolve `false` para `action`).

- [ ] **Step 8: Simulador do core**

Em `flow-simulate.ts`:

```ts
import { MAX_AUTO_STEPS, actionFor, autoNext, decideInput, messageFor, type ActionEffect } from './flow-step';

/** linha de sistema: o balão de ação rodou (nada vai para a pessoa) */
export interface SimActionLine {
  action: ActionEffect;
}
```

Troque o tipo de `SimResult.messages` para `Array<SimMessage | SimActionLine>`, e o `const messages: SimMessage[] = []` para `const messages: Array<SimMessage | SimActionLine> = []`. No `drive`, dentro de `if (pending) { ... }`, logo depois de `if (m) messages.push(toSimMessage(m));`:

```ts
        const a = actionFor(node, ctx());
        if (a) messages.push({ action: a });
```

- [ ] **Step 9: Fixtures novas**

`testdata/automation-flows/17-action-send-data.json`:

```json
{
  "name": "enviar dados no meio do fluxo não manda mensagem e segue",
  "flow": {
    "version": 2,
    "nodes": [
      { "id": "opening", "type": "opening", "position": { "x": 0, "y": 0 }, "data": { "text": "Olá!" } },
      { "id": "nome", "type": "question", "position": { "x": 0, "y": 160 }, "data": { "text": "Qual é o seu nome?", "field": "nome", "validate": "name" } },
      { "id": "dados", "type": "action", "position": { "x": 0, "y": 320 }, "data": { "kind": "send_data", "label": "nome_coletado" } },
      { "id": "fim", "type": "end", "position": { "x": 0, "y": 480 }, "data": { "text": "Obrigado, {nome}!" } }
    ],
    "edges": [
      { "id": "e1", "source": "opening", "sourceHandle": "next", "target": "nome" },
      { "id": "e2", "source": "nome", "sourceHandle": "next", "target": "dados" },
      { "id": "e3", "source": "dados", "sourceHandle": "next", "target": "fim" }
    ]
  },
  "inputs": [{ "text": "oi" }, { "text": "Ana" }],
  "expect": {
    "messages": [
      { "text": "Olá!\n\nResponda esta mensagem para continuar.\n\nMensagem automática." },
      { "text": "Qual é o seu nome?" },
      { "action": { "kind": "send_data", "label": "nome_coletado" } },
      { "text": "Obrigado, Ana!" }
    ],
    "status": "completed",
    "answers": { "nome": "Ana" }
  }
}
```

`testdata/automation-flows/18-action-chain-notify.json`:

```json
{
  "name": "duas ações seguidas e fim sem texto: aviso preenchido e conversa concluída",
  "username": "ana.s",
  "flow": {
    "version": 2,
    "nodes": [
      { "id": "opening", "type": "opening", "position": { "x": 0, "y": 0 }, "data": { "text": "Olá!" } },
      { "id": "nome", "type": "question", "position": { "x": 0, "y": 160 }, "data": { "text": "Qual é o seu nome?", "field": "nome", "validate": "name" } },
      { "id": "avisa", "type": "action", "position": { "x": 0, "y": 320 }, "data": { "kind": "notify", "text": "Lead novo: {nome} (@{username})" } },
      { "id": "dados", "type": "action", "position": { "x": 0, "y": 480 }, "data": { "kind": "send_data", "label": "lead_novo" } },
      { "id": "fim", "type": "end", "position": { "x": 0, "y": 640 }, "data": { "text": "" } }
    ],
    "edges": [
      { "id": "e1", "source": "opening", "sourceHandle": "next", "target": "nome" },
      { "id": "e2", "source": "nome", "sourceHandle": "next", "target": "avisa" },
      { "id": "e3", "source": "avisa", "sourceHandle": "next", "target": "dados" },
      { "id": "e4", "source": "dados", "sourceHandle": "next", "target": "fim" }
    ]
  },
  "inputs": [{ "text": "oi" }, { "text": "Ana" }],
  "expect": {
    "messages": [
      { "text": "Olá!\n\nResponda esta mensagem para continuar.\n\nMensagem automática." },
      { "text": "Qual é o seu nome?" },
      { "action": { "kind": "notify", "text": "Lead novo: Ana (@ana.s)" } },
      { "action": { "kind": "send_data", "label": "lead_novo" } }
    ],
    "status": "completed",
    "answers": { "nome": "Ana" }
  }
}
```

`testdata/automation-flows/19-action-dead-end.json`:

```json
{
  "name": "ação sem ligação na saída: saída sem ligação e fluxo sem fim",
  "flow": {
    "version": 2,
    "nodes": [
      { "id": "opening", "type": "opening", "position": { "x": 0, "y": 0 }, "data": { "text": "Olá!" } },
      { "id": "acao", "type": "action", "position": { "x": 0, "y": 160 }, "data": { "kind": "send_data", "label": "x" } }
    ],
    "edges": [{ "id": "e1", "source": "opening", "sourceHandle": "next", "target": "acao" }]
  },
  "expect": {
    "problems": [
      { "code": "missing_edge", "severity": "error", "nodeId": "acao", "handle": "next" },
      { "code": "no_finish", "severity": "error" }
    ]
  }
}
```

- [ ] **Step 10: Rodar os testes do core e do contrato**

Run: `bun test packages/contracts packages/core/src/domain/automation`
Expected: PASS, incluindo `flow-fixtures.test.ts` com as fixtures 17, 18 e 19.

Run: `bun run typecheck`
Expected: PASS. Se algum outro `switch` exaustivo em `packages/` reclamar de `action`, trate como em `messageFor` (sem efeito), mas **não** mexa no motor `comment-automation.ts` além do necessário para compilar: o comportamento do motor é a Task 3.

O teste da web (`apps/web/.../flow/logic.test.ts`) vai falhar até a Task 2 (paridade de tipos e fixtures novas). É esperado.

- [ ] **Step 11: Commit**

```bash
git add packages/contracts packages/core/src/domain/automation testdata/automation-flows
git commit -m "feat(contracts): balão de ação (enviar dados e avisar) e evento lead.updated

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Espelho da web (`logic.ts`)

**Files:**
- Modify: `apps/web/src/features/automation/logic.ts` (`LIMITS`)
- Modify: `apps/web/src/features/automation/flow/logic.ts`
- Test: `apps/web/src/features/automation/flow/logic.test.ts`

**Interfaces:**
- Consumes: os formatos da Task 1 (`type: 'action'`, `data.kind`, `label`, `text`, limite 280).
- Produces (web `flow/logic.ts`):
  - `FLOW_NODE_TYPES` com `'action'`;
  - `FlowNode` com `Base<'action', ActionData>`, em que `export type ActionData = { kind: 'send_data'; label: string } | { kind: 'notify'; text: string }`;
  - `export type ActionEffect = ActionData`;
  - `export function actionFor(n: FlowNode, ctx: { answers: Record<string, string>; username: string | null }): ActionEffect | null`;
  - `SimEntry` ganha `{ from: 'action'; action: ActionEffect }`;
  - `simulateFlow().messages: Array<SimMessage | { action: ActionEffect }>`;
  - `BlockKind` inclui `'action'`;
  - `ShapeKey` ganha `'labelInvalid'` e `'notifyTooLong'`.

- [ ] **Step 1: Testes que falham**

Em `apps/web/src/features/automation/flow/logic.test.ts`, no teste `'todo bloco novo passa no schema (WhatsApp com telefone preenchido)'`, troque o loop e o ajuste da condição por:

```ts
    for (const kind of ['message', 'question', 'condition', 'link', 'follow', 'end', 'action'] as const) {
      let n = createNode(kind, { x: 10, y: 20 }, f, TEXTS, 'sua.conta');
      if (n.type === 'link' && n.data.target.kind === 'whatsapp') {
        n = { ...n, data: { ...n.data, target: { kind: 'whatsapp', phone: '5592999990000', message: '' } } };
      }
      if (n.type === 'condition') n = { ...n, data: { ...n.data, field: 'nome' } };
      // a ação nasce sem rótulo (o Salvar trava até preencher)
      if (n.type === 'action') n = { ...n, data: { kind: 'send_data', label: 'dados' } };
      f = { ...f, nodes: [...f.nodes, n] };
    }
```

E acrescente:

```ts
describe('balão de ação', () => {
  test('nasce como enviar dados sem rótulo e trava o Salvar até preencher', () => {
    const f = emptyFlow(TEXTS);
    const n = createNode('action', { x: 0, y: 0 }, f, TEXTS, null);
    expect(n).toMatchObject({ type: 'action', data: { kind: 'send_data', label: '' } });
    expect(shapeIssues({ ...f, nodes: [...f.nodes, n] })).toEqual([{ nodeId: n.id, key: 'labelInvalid' }]);
  });

  test('formato: rótulo de campo, aviso de 1 a 280', () => {
    const base = emptyFlow(TEXTS);
    const com = (data: unknown) => ({ ...base, nodes: [...base.nodes, { id: 'a', type: 'action', position: { x: 0, y: 0 }, data } as never] });
    expect(shapeIssues(com({ kind: 'send_data', label: 'WhatsApp' }))).toEqual([{ nodeId: 'a', key: 'labelInvalid' }]);
    expect(shapeIssues(com({ kind: 'send_data', label: 'whatsapp_coletado' }))).toEqual([]);
    expect(shapeIssues(com({ kind: 'notify', text: ' ' }))).toEqual([{ nodeId: 'a', key: 'textRequired' }]);
    expect(shapeIssues(com({ kind: 'notify', text: 'x'.repeat(281) }))).toEqual([{ nodeId: 'a', key: 'notifyTooLong' }]);
  });

  test('normalizeFlow limpa o campo do outro tipo', () => {
    const f = normalizeFlow({
      nodes: [
        { id: 'a', type: 'action', position: { x: 0, y: 0 }, data: { kind: 'notify', text: 'Oi', label: 'velho' } },
        { id: 'b', type: 'action', position: { x: 0, y: 0 }, data: { kind: 'send_data', label: 'x', text: 'velho', delaySec: 5 } },
      ],
    });
    expect(f.nodes[0]!.data).toEqual({ kind: 'notify', text: 'Oi' });
    expect(f.nodes[1]!.data).toEqual({ kind: 'send_data', label: 'x' });
  });

  test('trocar o tipo pelo patch do editor não deixa dado velho', () => {
    let f = emptyFlow(TEXTS);
    const n = createNode('action', { x: 0, y: 0 }, f, TEXTS, null);
    f = { ...f, nodes: [...f.nodes, n] };
    f = updateNodeData(f, n.id, { kind: 'notify', text: 'Oi', label: undefined });
    expect(normalizeFlow(f).nodes.find((x) => x.id === n.id)!.data).toEqual({ kind: 'notify', text: 'Oi' });
    expect(FlowV2Schema.safeParse(normalizeFlow(f)).success).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun test apps/web/src/features/automation/flow/logic.test.ts`
Expected: FAIL. A paridade de tipos falha (`FLOW_NODE_TYPES` sem `action`), as fixtures 17 a 19 falham e os testes novos falham.

- [ ] **Step 3: Implementar**

Em `apps/web/src/features/automation/logic.ts`, em `LIMITS`, depois de `reminderMaxMinutes: 1380,`, ponha `notifyText: 280,`. O teste `expect(LIMITS).toEqual(AUTOMATION_LIMITS)` cobre a paridade.

Em `apps/web/src/features/automation/flow/logic.ts`:

1. Tipos:

```ts
export const FLOW_NODE_TYPES = ['opening', 'message', 'question', 'condition', 'link', 'end', 'action'] as const;
export type ActionData = { kind: 'send_data'; label: string } | { kind: 'notify'; text: string };
export type ActionEffect = ActionData;
```

Acrescente `| Base<'action', ActionData>` à união `FlowNode`.

2. `normalizeFlow`: um `case 'action'` antes do `default` (o `default` vira `end`):

```ts
      case 'action':
        return {
          ...base,
          type: 'action',
          // só o campo do tipo escolhido (trocar o tipo no editor não deixa resto)
          data: d.kind === 'notify' ? { kind: 'notify', text: str(d.text) } : { kind: 'send_data', label: str(d.label) },
        };
```

3. `handlesOf`: inclua `case 'action':` junto de `opening`/`question`/`link` (→ `['next']`). `outputsOf`: inclua `case 'action':` junto de `opening`/`question` (→ `[{ handle: 'next', required: true }]`). `waits` não muda.

4. `shapeIssues`. Troque a linha do texto por:

```ts
    const text = n.type === 'condition' || n.type === 'action' ? null : n.data.text;
```

E acrescente o caso no `switch`:

```ts
      case 'action':
        if (n.data.kind === 'send_data' && !FIELD_RE.test(n.data.label)) add(n.id, 'labelInvalid');
        if (n.data.kind === 'notify') {
          if (!n.data.text.trim()) add(n.id, 'textRequired');
          else if (n.data.text.trim().length > LIMITS.notifyText) add(n.id, 'notifyTooLong');
        }
        break;
```

Inclua `| 'labelInvalid' | 'notifyTooLong'` no tipo `ShapeKey`.

5. Passo e simulação. Em `messageFor`, depois de `case 'end'`:

```ts
    case 'action':
      return null;
```

Depois de `messageFor`:

```ts
/** espelho de `actionFor` do core: efeito do balão de ação com o aviso preenchido */
export function actionFor(n: FlowNode, ctx: Ctx): ActionEffect | null {
  if (n.type !== 'action') return null;
  return n.data.kind === 'send_data' ? { kind: 'send_data', label: n.data.label } : { kind: 'notify', text: renderTemplate(n.data.text, ctx.answers, ctx.username) };
}
```

`SimEntry`:

```ts
export type SimEntry =
  | { from: 'brand' | 'user'; msg: SimMessage }
  | { from: 'typing'; seconds: number }
  /** balão de ação: nada vai para a pessoa */
  | { from: 'action'; action: ActionEffect };
```

No `drive` da web, dentro de `if (send) { ... }`, depois de `if (m) transcript.push({ from: 'brand', msg: m });`:

```ts
      const act = actionFor(n, { answers: s.answers, username: s.username });
      if (act) transcript.push({ from: 'action', action: act });
```

Em `simulateFlow` (o da web), troque o `messages` por:

```ts
    messages: s.transcript.flatMap((x) => (x.from === 'brand' ? [x.msg] : x.from === 'action' ? [{ action: x.action }] : [])),
```

6. Edição:

```ts
export type BlockKind = Exclude<FlowNodeType, 'opening'> | 'follow';
```

Esse tipo já inclui `'action'` porque deriva de `FLOW_NODE_TYPES`. Em `createNode`:

```ts
    case 'action':
      return { id, type: 'action', position, data: { kind: 'send_data', label: '' } };
```

O id sai de `uniqueId(kind, ...)`, o que dá `action`, `action-2`… e está ok.

- [ ] **Step 4: Rodar os testes da web**

Run: `bun test apps/web/src/features/automation`
Expected: PASS, incluindo a paridade e as fixtures 17 a 19.

Run: `bun run typecheck:web`
Expected: pode falhar em `nodes.tsx` ou `simulator.tsx` (`switch` e `NODE_TYPES` sem `action`). Se o erro for **só** nesses arquivos, siga para o commit: eles são a Task 4. Erro em `logic.ts`: corrija aqui.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/automation/logic.ts apps/web/src/features/automation/flow/logic.ts apps/web/src/features/automation/flow/logic.test.ts
git commit -m "feat(web): espelho do balão de ação na lógica do fluxo e no simulador

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Motor e ligação na API

**Files:**
- Modify: `packages/core/src/application/use-cases/comment-automation.ts` (imports :1-40, `AutomationEngineDeps` :382, `drive` :531-656)
- Modify: `apps/api/src/automation.container.ts` (:12 imports, :65 `makeAutomationEngine`)
- Test: `packages/core/src/application/use-cases/comment-automation.test.ts` (harness :183-312)

**Interfaces:**
- Consumes: `actionFor`, `ActionEffect` (Task 1, `../../domain/automation/flow-step`); `WebhookEvents.LeadUpdated`; `NotificationRepository` (`packages/core/src/application/ports/approvals.ts:61`).
- Produces: `AutomationEngineDeps.notifications?: Pick<NotificationRepository, 'create'>`.

- [ ] **Step 1: Ajustar o harness do teste**

Em `comment-automation.test.ts`, mude a assinatura de `harness`:

```ts
function harness(opts: { privateReplyError?: unknown; sendErrors?: unknown[]; status?: 'ACTIVE' | 'TEST'; emitErrors?: unknown[]; noNotifications?: boolean } = {}) {
```

Logo depois de `const sendErrors = ...`:

```ts
  const emitErrors = [...(opts.emitErrors ?? [])];
  const notified: Array<{ orgId: string; userId?: string | null; kind: string; title: string; body?: string; link?: string }> = [];
```

Troque o `events` do `makeAutomationEngine` por:

```ts
    events: {
      async emit(e) {
        const err = emitErrors.shift();
        if (err) throw err;
        emitted.push({ event: e.event, data: e.data });
      },
    },
    ...(opts.noNotifications
      ? {}
      : {
          notifications: {
            async create(n) {
              notified.push(n);
            },
          },
        }),
```

E inclua `notified` no `return` do harness.

- [ ] **Step 2: Testes do motor que falham**

Acrescente ao fim do arquivo:

```ts
describe('balão de ação', () => {
  const FLOW_ACAO = {
    version: 2,
    nodes: [
      { id: 'opening', type: 'opening', position: P, data: { text: 'Oi!' } },
      { id: 'nome', type: 'question', position: P, data: { text: 'Seu nome?', field: 'nome', validate: 'name' } },
      { id: 'dados', type: 'action', position: P, data: { kind: 'send_data', label: 'nome_coletado' } },
      { id: 'avisa', type: 'action', position: P, data: { kind: 'notify', text: 'Lead novo: {nome}' } },
      { id: 'fim', type: 'end', position: P, data: { text: 'Obrigado, {nome}!' } },
    ],
    edges: [ed('opening', 'next', 'nome'), ed('nome', 'next', 'dados'), ed('dados', 'next', 'avisa'), ed('avisa', 'next', 'fim')],
  };
  async function aberto(h: ReturnType<typeof harness>, testers = ['iagovieira.ia']) {
    await h.seedAutomation(FLOW_ACAO, testers, TRIGGER);
    expect(await h.deliver(h.comment({ text: 'quero o PLANO' }))).toBe('run');
    await h.deliver(h.message({ text: 'oi' }));
    expect(h.sent.at(-1)?.msg?.text).toBe('Seu nome?');
  }

  test('enviar dados e avisar rodam no mesmo evento e o fluxo segue até o fim', async () => {
    const h = harness();
    await aberto(h);
    await h.deliver(h.message({ text: 'Ana' }));
    expect(h.sent.at(-1)?.msg?.text).toBe('Obrigado, Ana!');
    expect(h.emitted.map((e) => e.event)).toEqual(['lead.updated', 'lead.captured']);
    expect(h.emitted[0]!.data).toMatchObject({
      label: 'nome_coletado',
      nodeId: 'dados',
      runId: h.runs[0]!.id,
      automationName: 'Cotação',
      participantUsername: 'cliente',
      answers: { nome: 'Ana' },
      whatsappUrl: null,
      status: 'OPEN',
      test: false,
    });
    expect(typeof h.emitted[0]!.data.sentAt).toBe('string');
    expect(h.emitted[1]!.data).not.toHaveProperty('label');
    expect(h.notified).toEqual([{ orgId: ORG, userId: null, kind: 'automation.notify', title: 'Cotação', body: 'Lead novo: Ana', link: '/leads' }]);
    expect(h.runs[0]!.status).toBe('COMPLETED');
  });

  test('em modo Teste o lead.updated sai com test: true', async () => {
    const h = harness({ status: 'TEST' });
    await aberto(h, ['cliente']);
    await h.deliver(h.message({ text: 'Ana' }));
    expect(h.emitted[0]).toMatchObject({ event: 'lead.updated', data: { test: true } });
  });

  test('retry depois da ação não repete o evento nem o aviso', async () => {
    const h = harness({ sendErrors: [undefined, { status: 503, body: '{}', errorClass: 'transient' }] });
    await aberto(h);
    const ev = await h.engine.ingest({ eventId: 'z-ana', eventType: 'message', payload: h.message({ text: 'Ana' }) });
    const id = (ev as { id: string }).id;
    await expect(h.engine.process(id)).rejects.toThrow();
    await h.engine.process(id);
    expect(h.emitted.filter((e) => e.event === 'lead.updated')).toHaveLength(1);
    expect(h.notified).toHaveLength(1);
    expect(h.sent.filter((s) => s.msg?.text === 'Obrigado, Ana!')).toHaveLength(1);
  });

  test('falha ao gravar o evento faz o job lançar e a ação sai na retentativa', async () => {
    const h = harness({ emitErrors: [new Error('banco fora')] });
    await aberto(h);
    const ev = await h.engine.ingest({ eventId: 'z-ana', eventType: 'message', payload: h.message({ text: 'Ana' }) });
    const id = (ev as { id: string }).id;
    await expect(h.engine.process(id)).rejects.toThrow('banco fora');
    expect(h.sent.filter((s) => s.msg?.text === 'Obrigado, Ana!')).toHaveLength(0);
    await h.engine.process(id);
    expect(h.emitted.filter((e) => e.event === 'lead.updated')).toHaveLength(1);
    expect(h.sent.filter((s) => s.msg?.text === 'Obrigado, Ana!')).toHaveLength(1);
  });

  test('sem notificações ligadas o aviso é ignorado e o fluxo conclui', async () => {
    const h = harness({ noNotifications: true });
    await aberto(h);
    await h.deliver(h.message({ text: 'Ana' }));
    expect(h.runs[0]!.status).toBe('COMPLETED');
    expect(h.notified).toHaveLength(0);
  });
});
```

Se `h.engine.ingest` devolver `duplicate` para o mesmo `eventId`, use outro id. O teste existente "retry no meio do encadeamento" (:740) usa o mesmo padrão.

- [ ] **Step 3: Rodar e ver falhar**

Run: `bun test packages/core/src/application/use-cases/comment-automation.test.ts`
Expected: FAIL nos 5 testes novos (nenhum `lead.updated` emitido); os outros continuam passando.

- [ ] **Step 4: Implementar no motor**

Em `comment-automation.ts`:

1. Imports: acrescente `actionFor` e `type ActionEffect` ao import de `../../domain/automation/flow-step`, e `import type { NotificationRepository } from '../ports/approvals';`.

2. `AutomationEngineDeps`, depois de `events?: EventPublisher;`:

```ts
  /** balão "Avisar a equipe"; ausente = o aviso vira no-op */
  notifications?: Pick<NotificationRepository, 'create'>;
```

3. Dentro de `makeAutomationEngine`, antes de `async function drive(`:

```ts
  /**
   * Efeito do balão de ação (add-flow-action-node). Pelo menos uma vez: falha aqui lança e o job é
   * refeito; quem recebe o `lead.updated` deduplica por runId + nodeId.
   */
  async function runAction(effect: ActionEffect, nodeId: string, run: AutomationRunRecord, automation: AutomationRecord, flow: FlowV2) {
    const ctx = { runId: run.id, answers: run.answers, username: run.participantUsername };
    if (effect.kind === 'send_data') {
      await deps.events?.emit({
        orgId: run.orgId,
        event: WebhookEvents.LeadUpdated,
        channelId: run.channelId,
        data: {
          label: effect.label,
          nodeId,
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
          whatsappUrl: leadWhatsappUrl(flow, ctx),
          status: 'OPEN',
          test: automation.status === 'TEST',
          sentAt: now().toISOString(),
        },
      });
      return;
    }
    await deps.notifications?.create({
      orgId: run.orgId,
      userId: null,
      kind: 'automation.notify',
      title: automation.name,
      body: effect.text,
      link: '/leads',
    });
  }
```

4. No `drive`, dentro de `if (run.sentCursor < run.cursor) {`, logo **antes** de `const msg = messageFor(node, ctx());`:

```ts
          // balão de ação: efeito sem mensagem; o sentCursor abaixo impede repetir ao retomar
          const effect = actionFor(node, ctx());
          if (effect) await runAction(effect, node.id, run, automation, flow);
```

`AutomationRecord`, `AutomationRunRecord`, `FlowV2` e `leadWhatsappUrl` já são importados ou usados no arquivo. Confira com o typecheck.

- [ ] **Step 5: Rodar os testes do motor**

Run: `bun test packages/core/src/application/use-cases/comment-automation.test.ts`
Expected: PASS, todos.

- [ ] **Step 6: Ligar as notificações na API**

Em `apps/api/src/automation.container.ts`, acrescente `makeNotificationRepository` ao import de `@manypost/db` (linha 12) e, em `makeAutomationEngine({ ... })`, depois de `events: runtime.events,`:

```ts
    // balão "Avisar a equipe" (add-flow-action-node)
    notifications: makeNotificationRepository(db),
```

Confira se a variável do banco nesse arquivo se chama `db`. `buildAutomation` recebe o `Db`; use o nome que estiver lá.

Run: `bun run typecheck && bun test packages/core`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/application/use-cases/comment-automation.ts packages/core/src/application/use-cases/comment-automation.test.ts apps/api/src/automation.container.ts
git commit -m "feat(automation): motor executa o balão de ação (lead.updated e aviso à equipe)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Editor (balão, dock, menu, simulador, configurações, textos e OpenAPI)

**Files:**
- Modify: `apps/web/src/features/automation/flow/nodes.tsx` (`InlineText` :34, tipo `P` :183, `NODE_TYPES` :418)
- Modify: `apps/web/src/features/automation/flow/next-step-menu.tsx` (`BLOCKS` :8, `SOON` :17)
- Modify: `apps/web/src/features/automation/flow/simulator.tsx` (transcrição :52)
- Modify: `apps/web/src/features/settings/settings-view.tsx` (`ALL_EVENTS` :60), `apps/web/src/features/settings/hooks.ts` (`WebhookEvent` :17)
- Modify: `apps/web/src/messages/pt-BR.json` (namespace `automation.flow`, linhas ~1947-1959)
- Regenerate: `apps/web/openapi.json`, `apps/web/src/lib/api/schema.d.ts`

**Interfaces:**
- Consumes: `ActionData`, `ActionEffect`, `SimEntry` com `from: 'action'`, `LIMITS.notifyText` e `createNode('action')` (Task 2).

- [ ] **Step 1: Textos (pt-BR)**

Em `apps/web/src/messages/pt-BR.json`, dentro de `automation.flow`, faça estas edições exatas com o Edit:

- Linha do `"node"`: troque `"link": "Link", "end": "Fim" },` por `"link": "Link", "end": "Fim", "action": "Ação" },`.
- Linha do `"shape"`: troque `"triggerReplies": "Respostas públicas: até 10, com até 300 caracteres" },` por:
  `"triggerReplies": "Respostas públicas: até 10, com até 300 caracteres", "labelInvalid": "Rótulo: minúsculas, números e _ (até 32, começando por letra)", "notifyTooLong": "Aviso acima de 280 caracteres" },`
- Linha do `"sim"`: troque `"silence": "Simular silêncio" }` por:
  `"silence": "Simular silêncio", "actionSend": "⚡ Enviaria dados: {label}", "actionNotify": "⚡ Avisaria a equipe: {text}" }`
- Nova linha, logo antes da linha que começa com `      "shape": {`:

```json
      "action": { "sendData": "Enviar dados", "notify": "Avisar a equipe", "labelPlaceholder": "rótulo, ex.: whatsapp_coletado", "notifyPlaceholder": "Ex.: Lead novo: {nome}", "sendDataHint": "Manda as respostas até aqui no webhook lead.updated, com este rótulo.", "notifyHint": "Aparece no sino do manypost para toda a equipe. Aceita {nome} e outros campos." },
```

`notifyPlaceholder` e `notifyHint` têm `{nome}` literal: leia os dois com `t.raw(...) as string`, como o `reminder.textHint` (o `t` normal trataria `{nome}` como argumento ICU). Os outros textos são lidos com `t`.

Run: `bun -e "JSON.parse(require('fs').readFileSync('apps/web/src/messages/pt-BR.json','utf8'))"`
Expected: sem erro.

- [ ] **Step 2: Balão no canvas**

Em `nodes.tsx`, deixe o `InlineText` aceitar um limite:

```tsx
function InlineText({ nodeId, value, placeholder, field = 'text', maxLength = LIMITS.messageText }: { nodeId: string; value: string; placeholder: string; field?: string; maxLength?: number }) {
```

E troque `maxLength={LIMITS.messageText}` por `maxLength={maxLength}` no `<textarea>`.

Amplie o tipo `P`:

```tsx
type P<T extends 'opening' | 'message' | 'question' | 'condition' | 'link' | 'end' | 'action'> = NodeProps<Node<{ node: NodeOf<T> } & Record<string, unknown>, T>>;
```

Antes de `TriggerView`:

```tsx
/** balão de ação (add-flow-action-node): enviar dados (lead.updated) ou avisar a equipe; sem ⚙ e sem atraso */
function ActionView({ id, data, selected }: P<'action'>) {
  const t = useTranslations('automation.flow');
  const a = useFlowActions();
  const n = data.node;
  const kind = n.data.kind;
  return (
    <NodeShell id={id} selected={selected} icon={Zap} title={t('node.action')}>
      {!a.readOnly ? (
        <div className="nodrag flex gap-1">
          {(['send_data', 'notify'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              // trocar o tipo zera o campo do outro (normalizeFlow também limpa)
              onClick={() => kind !== k && a.update(id, k === 'notify' ? { kind: 'notify', text: '', label: undefined } : { kind: 'send_data', label: '', text: undefined })}
              className={cn(
                'flex-1 cursor-pointer rounded-compact border px-2 py-1 text-meta font-medium transition-colors duration-200',
                kind === k ? 'border-accent bg-accent-tint text-accent' : 'border-line text-graphite hover:bg-surface-2',
              )}
            >
              {t(k === 'notify' ? 'action.notify' : 'action.sendData')}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-meta font-medium text-graphite">{t(kind === 'notify' ? 'action.notify' : 'action.sendData')}</p>
      )}
      {n.data.kind === 'send_data' ? (
        <>
          <InlineInput value={n.data.label} placeholder={t('action.labelPlaceholder')} maxLength={32} onChange={(v) => a.update(id, { label: v.trim() }, { merge: true })} />
          <p className="text-meta text-graphite">{t('action.sendDataHint')}</p>
        </>
      ) : (
        <>
          <InlineText nodeId={id} value={n.data.text} placeholder={t.raw('action.notifyPlaceholder') as string} maxLength={LIMITS.notifyText} />
          <p className="text-meta text-graphite">{t.raw('action.notifyHint') as string}</p>
        </>
      )}
      <OutputRow handleId="next" label={t('output.next')} />
    </NodeShell>
  );
}
```

Em `NODE_TYPES`, acrescente `action: ActionView,`. O `Zap` já é importado. O `cn` também.

- [ ] **Step 3: Dock e menu**

Em `next-step-menu.tsx`, depois de `{ kind: 'follow', icon: UserPlus },`:

```ts
  { kind: 'action', icon: Zap },
```

Troque o `SOON`:

```ts
/** blocos da entrega 4 — aparecem desabilitados */
export const SOON: Array<{ key: 'delay' | 'media'; icon: LucideIcon }> = [
  { key: 'delay', icon: Clock },
  { key: 'media', icon: ImageIcon },
];
```

O `dock.tsx` usa `BLOCKS`/`SOON` e não muda. O rótulo `block.action` ("Ação") já existe.

- [ ] **Step 4: Simulador**

Em `simulator.tsx`, no `state.transcript.map(...)`, trate o caso novo antes do `typing`:

```tsx
          {state.transcript.map((x, i) =>
            x.from === 'action' ? (
              <li key={i} className="self-start text-meta text-graphite">
                {x.action.kind === 'send_data' ? t('sim.actionSend', { label: x.action.label }) : t('sim.actionNotify', { text: x.action.text })}
              </li>
            ) : x.from === 'typing' ? (
```

O resto do ternário fica como está; o ramo final continua usando `x.msg`. O `lastBrand` (`x.from === 'brand'`) não muda.

- [ ] **Step 5: Configurações → Webhooks**

Em `settings-view.tsx`, `ALL_EVENTS`: depois de `'lead.captured',`, ponha `'lead.updated',`. Em `hooks.ts`, no tipo `WebhookEvent`: troque `| 'lead.captured';` por `| 'lead.captured'\n  | 'lead.updated';`.

- [ ] **Step 6: Typecheck, testes e brand**

Run: `bun run typecheck:web && bun test apps/web && bun run check:brand`
Expected: PASS.

- [ ] **Step 7: Regenerar o OpenAPI (stack isolada)**

Suba o Postgres e o Redis de teste: `docker start mp-test-pg mp-test-redis`. Pegue a URL de conexão no `docker inspect mp-test-pg` (variáveis `POSTGRES_*`, porta 5599). Depois:

```bash
DATABASE_URL=<url do mp-test-pg na 5599> REDIS_URL=redis://localhost:6379 IS_SELF_HOSTED=false HIDE_BILLING=false STRIPE_SECRET_KEY=sk_test_placeholder bun run dev   # API em :3100, em outro terminal
API_URL=http://localhost:3100 bun run --cwd apps/web generate:api
```

Expected: `git diff --stat apps/web/openapi.json apps/web/src/lib/api/schema.d.ts` mostra o `lead.updated` acrescentado aos enums de eventos e mais nada estranho. Pare a API.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src apps/web/openapi.json
git commit -m "feat(web): balão Ação no canvas, no simulador e lead.updated nos webhooks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: E2E, documentação e fechamento

**Files:**
- Modify: `scripts/e2e-automation.ts` (fluxo v2 :132-147, webhook :167-177, checagens :283-319)
- Modify: `docs/specs/SPEC_INTEGRATIONS.md` (onde descreve o `lead.captured`), `docs/principal/RUNBOOK_FLOW_BUILDER.md` (roteiro do dono)
- Modify: `CHANGELOG.md`, `docs/principal/STATUS.md`, `docs/principal/CHANGELOG_ONDAS.md`
- Modify: `openspec/changes/add-flow-action-node/tasks.md` (marcar as caixas)

- [ ] **Step 1: E2E com a ação no fluxo v2**

Em `scripts/e2e-automation.ts`:

1. No `config.nodes` da automação `E2E canvas`, depois do nó `nome`:

```ts
      { id: 'dados', type: 'action', position: P, data: { kind: 'send_data', label: 'nome_coletado' } },
```

2. Nas `edges` dessa automação, troque `ed('nome', 'next', 'c')` por `ed('nome', 'next', 'dados'), ed('dados', 'next', 'c')`.
3. No webhook de saída do E2E: `events: ['lead.captured', 'lead.updated'],`.
4. A checagem `await until(() => hooks.find((h) => (h.body.data as { runId?: string })?.runId === run2.id), 'lead.captured v2', 30_000);` passa a filtrar o evento. Troque por:

```ts
  const captured2 = await until(
    () => hooks.find((h) => h.event === 'lead.captured' && (h.body.data as { runId?: string })?.runId === run2.id),
    'lead.captured v2',
    30_000,
  );
  const updated2 = hooks.find((h) => h.event === 'lead.updated' && (h.body.data as { runId?: string })?.runId === run2.id);
  check(updated2, 'lead.updated v2 recebido');
  check(updated2?.signature?.startsWith('t=') && updated2.signature.includes(',v1='), 'lead.updated assinado');
  const up = updated2?.body.data as { label?: string; nodeId?: string; status?: string; answers?: Record<string, string> } | undefined;
  check(up?.label === 'nome_coletado' && up.nodeId === 'dados' && up.status === 'OPEN' && up.answers?.nome === 'Ana', 'lead.updated com rótulo, nó e respostas');
  check(hooks.indexOf(updated2!) < hooks.indexOf(captured2), 'lead.updated antes do lead.captured');
```

Confira como cada `hooks[i]` guarda o evento e a assinatura (o receptor fica perto da linha 46) e ajuste os nomes `event`/`signature`, se forem outros. Confira também se `lead.captured` do fluxo v1 (linha ~283) continua achando o evento certo: ele já filtra por `h.event === 'lead.captured'`.

- [ ] **Step 2: Rodar o E2E (stack isolada)**

```bash
docker start mp-test-pg mp-test-redis
DATABASE_URL=<url do mp-test-pg na 5599> REDIS_URL=redis://localhost:6379 IS_SELF_HOSTED=false HIDE_BILLING=false STRIPE_SECRET_KEY=sk_test_placeholder bun run scripts/e2e-automation.ts
```

Expected: todas as checagens OK, incluindo as quatro novas do `lead.updated`. O banco de teste acumula entregas de execuções anteriores; isso é esperado.

- [ ] **Step 3: Documentação**

- `docs/specs/SPEC_INTEGRATIONS.md`: ao lado do `lead.captured`, descreva o `lead.updated`:
  - quando sai (balão Ação "Enviar dados");
  - o payload (campos da Global Constraints);
  - a deduplicação por `runId` + `nodeId`;
  - que `test: true` marca o modo Teste;
  - que o `lead.captured` não mudou.
- `docs/principal/RUNBOOK_FLOW_BUILDER.md`, no roteiro do dono, acrescente:

```markdown
Ação:
- [ ] "Ação" aparece no dock e no menu "Próximo passo" (Espera e Imagem ou vídeo continuam "em breve").
- [ ] Balão nasce em "Enviar dados" sem rótulo e o Salvar trava até preencher (ex.: `whatsapp_coletado`).
- [ ] Trocar para "Avisar a equipe", escrever "Lead novo: {nome}" e simular: aparece "⚡ Avisaria a equipe: Lead novo: <nome>" e a conversa segue.
- [ ] Em Configurações → Webhooks, `lead.updated` aparece na lista de eventos.
```

- [ ] **Step 4: Changelogs e STATUS**

- `CHANGELOG.md` (Keep a Changelog, seção `Unreleased` → `Added`):
  - balão Ação no construtor (Enviar dados → `lead.updated`; Avisar a equipe → notificação);
  - evento `lead.updated` nos webhooks de saída.
- `docs/principal/STATUS.md`: na linha das automações, conte que a Ação saiu do "em breve" (enviar dados e avisar) e que contatos, tags e humano ficam para a próxima.
- `docs/principal/CHANGELOG_ONDAS.md`: entrada no topo, "Onda 50: balão Ação (add-flow-action-node)", com:
  - o que entrou;
  - as provas (número de testes do `bun run check`, E2E OK);
  - o que ficou de fora (contatos, tags, condição por tag, passar para humano, espera longa, mídia).

- [ ] **Step 5: Marcar as tarefas do OpenSpec**

Em `openspec/changes/add-flow-action-node/tasks.md`, marque `[x]` em tudo o que foi feito. Se algo não foi feito, deixe aberto e diga por quê.

- [ ] **Step 6: Verificação final**

Run: `bun run check && bun run spec:validate`
Expected: PASS nos dois. Anote o número de testes para a entrada do CHANGELOG_ONDAS.

- [ ] **Step 7: Commit**

```bash
git add scripts/e2e-automation.ts docs CHANGELOG.md openspec/changes/add-flow-action-node/tasks.md
git commit -m "test(automation): E2E do lead.updated; docs da onda 50 (balão Ação)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Depois do merge (fora deste plano, com o Iago)

1. Deploy manual no Easypanel (o Iago clica).
2. Função `instagram-lead` no CRM: confere `x-manypost-signature` (HMAC-SHA256 de `"<t>.<corpo>"`), faz upsert por `runId`, deduplica `lead.updated` por `runId` + `nodeId` e ignora `test: true`.
3. Configurações → Webhooks: URL da função, eventos `lead.captured` e `lead.updated`.
4. Na Triagem Invista (PLANO): Ação "Enviar dados" `whatsapp_coletado` logo depois da pergunta do WhatsApp; testar em modo Teste antes de Ativar.
