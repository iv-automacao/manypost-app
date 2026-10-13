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
