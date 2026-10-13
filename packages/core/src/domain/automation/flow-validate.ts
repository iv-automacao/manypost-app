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
