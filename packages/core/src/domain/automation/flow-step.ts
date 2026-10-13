import type { DirectMessage, FlowNode, FlowNodeOf, FlowV2 } from '@manypost/contracts';
import {
  OPENING_DISCLOSURE,
  OPENING_TEXT_HINT,
  normalizeText,
  renderTemplate,
  validateAnswer,
  whatsappDigits,
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
  return `https://wa.me/${whatsappDigits(t.phone)}${msg ? `?text=${encodeURIComponent(msg)}` : ''}`;
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
