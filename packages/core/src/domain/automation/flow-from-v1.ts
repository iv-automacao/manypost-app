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
