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
