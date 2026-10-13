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
