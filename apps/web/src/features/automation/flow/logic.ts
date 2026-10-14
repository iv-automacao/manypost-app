import { LIMITS, type TextValidation, fieldFromPrompt, normalize, renderTemplate } from '../logic';

/**
 * Fluxo v2 no editor (openspec add-flow-builder-canvas, design D8). Repete o formato, a validação e o
 * passo do motor de `packages/core/src/domain/automation/` porque `apps/web` não carrega o core no
 * bundle. A paridade é assertada em `logic.test.ts` com as fixtures de `testdata/automation-flows/`.
 * A API valida de novo — aqui é para orientar quem edita e para o simulador.
 */

export const FLOW_NODE_TYPES = ['opening', 'message', 'question', 'condition', 'link', 'end'] as const;
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];
export const OPENING_MODES = ['text', 'button', 'quick'] as const;
export type OpeningMode = (typeof OPENING_MODES)[number];
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
        delaySec?: number;
      }
    >
  | Base<'question', { text: string; field: string; validate: TextValidation; delaySec?: number }>
  | Base<'condition', { field: string; op: (typeof CONDITION_OPS)[number]; value: string }>
  | Base<'link', { text: string; buttonTitle: string; target: LinkTarget; delaySec?: number }>
  | Base<'end', { text: string; delaySec?: number }>;
export type NodeOf<T extends FlowNodeType> = Extract<FlowNode, { type: T }>;
export interface FlowEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
}
/** lembrete único para quem parou de responder (add-flow-delay-reminder) */
export interface FlowReminder {
  afterMinutes: number;
  text: string;
}
export interface Flow {
  version: 2;
  nodes: FlowNode[];
  edges: FlowEdge[];
  reminder?: FlowReminder;
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
/** atraso gravado só quando é número; 0 some (é o padrão) */
const delayOf = (d: Raw) => (typeof d.delaySec === 'number' && d.delaySec > 0 ? { delaySec: d.delaySec } : {});

export function normalizeFlow(raw: { nodes?: unknown[]; edges?: unknown[]; reminder?: unknown }): Flow {
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
            mode: (OPENING_MODES as readonly unknown[]).includes(d.mode) ? (d.mode as OpeningMode) : 'text',
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
            ...delayOf(d),
          },
        };
      case 'question':
        return {
          ...base,
          type: 'question',
          data: { text: str(d.text), field: str(d.field), validate: (d.validate as TextValidation) ?? 'free', ...delayOf(d) },
        };
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
        return { ...base, type: 'link', data: { text: str(d.text), buttonTitle: str(d.buttonTitle, 'Abrir'), target, ...delayOf(d) } };
      }
      default:
        return { ...base, type: 'end', data: { text: str(d.text), ...delayOf(d) } };
    }
  });
  const edges = (raw.edges ?? []).map((x) => {
    const e = x as FlowEdge;
    return { id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target };
  });
  const r = raw.reminder as Raw | undefined;
  const reminder =
    r && typeof r.afterMinutes === 'number' && typeof r.text === 'string' ? { reminder: { afterMinutes: r.afterMinutes, text: r.text } } : {};
  return { version: 2, nodes, edges, ...reminder };
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
  | 'waMessageTooLong'
  | 'tooManyNodes'
  | 'delayInvalid'
  | 'reminderInvalid'
  | 'triggerKeywords'
  | 'triggerReplies';
export interface ShapeIssue {
  nodeId: string | null;
  key: ShapeKey;
}

/** https parseável e de até 2000 caracteres (o `.url()` do schema recusa "https://:") */
function validHttpsUrl(u: string): boolean {
  if (u.length > 2000) return false;
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
}

const validTitle = (t: string) => t.trim().length >= 1 && t.trim().length <= LIMITS.buttonTitle;
const validDelay = (v: number) => Number.isInteger(v) && v >= 0 && v <= LIMITS.maxDelaySec;
const validReminder = (r: FlowReminder) =>
  Number.isInteger(r.afterMinutes) &&
  r.afterMinutes >= LIMITS.reminderMinMinutes &&
  r.afterMinutes <= LIMITS.reminderMaxMinutes &&
  r.text.trim().length >= 1 &&
  r.text.trim().length <= LIMITS.reminderText;

/** o que a API recusaria com 400 (formato), para travar o Salvar e apontar no balão */
export function shapeIssues(flow: Flow): ShapeIssue[] {
  const out: ShapeIssue[] = [];
  const add = (nodeId: string | null, key: ShapeKey) => out.push({ nodeId, key });
  if (flow.nodes.length > LIMITS.maxNodes) add(null, 'tooManyNodes');
  if (flow.reminder && !validReminder(flow.reminder)) add(null, 'reminderInvalid');
  for (const n of flow.nodes) {
    if ('delaySec' in n.data && n.data.delaySec !== undefined && !validDelay(n.data.delaySec)) add(n.id, 'delayInvalid');
    const text = n.type === 'condition' ? null : n.data.text;
    if (text !== null && n.type !== 'end' && !text.trim()) add(n.id, 'textRequired');
    if (text !== null && text.trim().length > LIMITS.messageText) add(n.id, 'textTooLong');
    switch (n.type) {
      case 'opening':
        if (!validTitle(n.data.buttonTitle)) add(n.id, 'buttonTitleInvalid');
        break;
      case 'message': {
        const c = n.data.options.length;
        const [min, max] = n.data.format === 'none' ? [0, 0] : n.data.format === 'buttons' ? [1, LIMITS.maxButtons] : [1, LIMITS.maxOptions];
        if (c < min || c > max) add(n.id, 'optionCount');
        if (n.data.options.some((o) => !validTitle(o.title))) add(n.id, 'optionTitleInvalid');
        if (n.data.saveTo !== undefined && !FIELD_RE.test(n.data.saveTo)) add(n.id, 'fieldInvalid');
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
        if (n.data.target.kind === 'whatsapp') {
          if (!/^\d{10,15}$/.test(n.data.target.phone)) add(n.id, 'phoneInvalid');
          if (n.data.target.message.trim().length > LIMITS.whatsappMessage) add(n.id, 'waMessageTooLong');
        }
        if (n.data.target.kind === 'url' && !validHttpsUrl(n.data.target.url)) add(n.id, 'urlInvalid');
        break;
      case 'end':
        break;
    }
  }
  return out;
}

export function triggerIssues(t: TriggerConfig): ShapeKey[] {
  const out: ShapeKey[] = [];
  if (t.keywords.length > LIMITS.maxKeywords || t.keywords.some((k) => !k.trim() || k.trim().length > LIMITS.keyword)) out.push('triggerKeywords');
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

/** espelho de `whatsappDigits` do core: sem DDI (10 ou 11 dígitos) ganha 55 */
function whatsappDigits(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
}

function linkUrl(n: NodeOf<'link'>, ctx: Ctx): string {
  const t = n.data.target;
  if (t.kind === 'url') return t.url;
  const msg = renderTemplate(t.message, ctx.answers, ctx.username).trim();
  return `https://wa.me/${whatsappDigits(t.phone)}${msg ? `?text=${encodeURIComponent(msg)}` : ''}`;
}

export function messageFor(n: FlowNode, ctx: Ctx): SimMessage | null {
  const r = (t: string) => renderTemplate(t, ctx.answers, ctx.username);
  switch (n.type) {
    case 'opening': {
      const parts = [r(n.data.text)];
      if (n.data.mode !== 'button') parts.push(OPENING_TEXT_HINT);
      if (n.data.disclosure) parts.push(OPENING_DISCLOSURE);
      const text = parts.join('\n\n');
      if (n.data.mode === 'button') return { text, buttons: [n.data.buttonTitle] };
      return n.data.mode === 'quick' ? { text, quick: [n.data.buttonTitle] } : { text };
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
  transcript: SimEntry[];
  username: string | null;
  /** o lembrete único já apareceu nesta simulação */
  reminderSent?: boolean;
}
/** linha da conversa simulada; `typing` = espera do balão com atraso */
export type SimEntry = { from: 'brand' | 'user'; msg: SimMessage } | { from: 'typing'; seconds: number };

function drive(s: SimState, pending: boolean): SimState {
  let { nodeId, reasks } = s;
  const transcript = [...s.transcript];
  let send = pending;
  for (let i = 0; i <= MAX_AUTO_STEPS; i++) {
    const n = nodeById(s.flow, nodeId);
    if (!n) return { ...s, nodeId, reasks, transcript, status: 'abandoned' };
    if (send) {
      const m = messageFor(n, { answers: s.answers, username: s.username });
      const delay = 'delaySec' in n.data ? (n.data.delaySec ?? 0) : 0;
      if (m && delay > 0) transcript.push({ from: 'typing', seconds: delay });
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
  if (n.type === 'opening') return n.data.mode !== 'text' && n.data.buttonTitle === title ? 'next' : null;
  if (n.type === 'message') return n.data.options.find((o) => o.title === title)?.id ?? null;
  return null;
}

export function sendSim(s: SimState, input: SimInput): SimState {
  if (s.status !== 'waiting') return s;
  const n = nodeById(s.flow, s.nodeId);
  if (!n) return { ...s, status: 'abandoned' };
  const tapped =
    n.type === 'message' ? n.data.options.find((o) => o.id === input.tap)?.title : n.type === 'opening' && input.tap ? n.data.buttonTitle : undefined;
  const shown = input.text ?? tapped ?? '';
  const withUser: SimState = { ...s, transcript: [...s.transcript, { from: 'user', msg: { text: shown } }] };
  const d = decideInput(s.flow, n, { handle: input.tap ?? null, text: input.text ?? '' }, s.reasks);
  if (d.kind === 'ignore') return withUser;
  if (d.kind === 'reask') return drive({ ...withUser, reasks: s.reasks + 1 }, true);
  const answers = d.save ? { ...s.answers, [d.save.field]: d.save.value } : s.answers;
  const to = targetOf(s.flow, n.id, d.handle);
  if (!to) return { ...withUser, answers, status: 'abandoned' };
  return drive({ ...withUser, answers, nodeId: to, reasks: 0 }, true);
}

/** o lembrete pode aparecer: há lembrete, ainda não saiu e a conversa espera num balão depois da abertura */
export function canSimulateSilence(s: SimState): boolean {
  const n = nodeById(s.flow, s.nodeId);
  return Boolean(s.flow.reminder && !s.reminderSent && s.status === 'waiting' && n && n.type !== 'opening' && waits(n));
}

/** espelho do motor: texto do lembrete + a pergunta em que a pessoa parou, com as mesmas opções */
export function simulateSilence(s: SimState): SimState {
  if (!canSimulateSilence(s)) return s;
  const n = nodeById(s.flow, s.nodeId)!;
  const m = messageFor(n, { answers: s.answers, username: s.username });
  if (!m) return s;
  const text = `${renderTemplate(s.flow.reminder!.text, s.answers, s.username)}\n\n${m.text}`;
  return { ...s, reminderSent: true, transcript: [...s.transcript, { from: 'brand', msg: { ...m, text } }] };
}

export function simulateFlow(flow: Flow, inputs: SimInput[], opts: { username?: string | null } = {}) {
  let s = startSim(flow, opts);
  for (const i of inputs) {
    if (s.status !== 'waiting') break;
    s = sendSim(s, i);
  }
  return {
    messages: s.transcript.flatMap((x) => (x.from === 'brand' ? [x.msg] : [])),
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

/** WhatsApp no editor: a pessoa digita DDD + número; o valor gravado leva o +55 */
export const brPhoneDisplay = (stored: string) => (/^55\d{10,11}$/.test(stored) ? stored.slice(2) : stored);
export const brPhoneStore = (typed: string) => {
  const d = typed.replace(/\D/g, '').slice(0, 11);
  return d ? `55${d}` : '';
};

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

/** Modelos prontos de resposta pública: avisam quem não segue para olhar em "Solicitações de mensagem". */
export const PUBLIC_REPLY_TEMPLATES: readonly string[] = [
  'Te chamei no direct! Se não aparecer, olha em Solicitações de mensagem.',
  'Acabei de te mandar uma mensagem. Confere o direct, pode estar em Solicitações.',
  'Enviei os detalhes no seu direct. Se não achar, procura em Solicitações ou na pasta de spam.',
  'Já te respondi por mensagem! Dá uma olhada no direct, na aba Solicitações.',
  'Mandei tudo no privado. Não achou? Veja em Solicitações de mensagem.',
  'Respondi no seu direct. Se não estiver na caixa principal, confira em Solicitações.',
];

/** Acrescenta os modelos que ainda não estão na lista (sem diferenciar caixa/espaços), respeitando o limite. */
export function withReplyTemplates(current: string[]): string[] {
  const key = (r: string) => r.trim().toLowerCase();
  const seen = new Set(current.map(key));
  const out = [...current];
  for (const t of PUBLIC_REPLY_TEMPLATES) {
    if (out.length >= LIMITS.maxPublicReplies) break;
    if (seen.has(key(t))) continue;
    seen.add(key(t));
    out.push(t);
  }
  return out;
}

export const defaultTrigger = (): TriggerConfig => ({ mediaIds: [], keywords: ['quero'], publicReplies: PUBLIC_REPLY_TEMPLATES.slice(0, 3) });

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
    nodes: flow.nodes.map((n) => {
      if (n.id !== id) return n;
      const data: Record<string, unknown> = { ...n.data, ...patch };
      // saveTo vazio não existe: o schema recusa '' e o campo é opcional
      if ('saveTo' in patch && (patch.saveTo === '' || patch.saveTo === undefined)) delete data.saveTo;
      return { ...n, data } as FlowNode;
    }),
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
