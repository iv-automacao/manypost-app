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
    case 'action':
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
