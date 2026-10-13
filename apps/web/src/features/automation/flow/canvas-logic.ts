import { removeEdge, removeNode, type Flow, type Position } from './logic';

/** Estado final de uma conexão arrastada (subconjunto do `FinalConnectionState` do React Flow) */
export interface DropState {
  isValid: boolean | null;
  fromNodeId: string | null;
  toNode: unknown;
  toHandle: unknown;
}

/** O menu "Próximo passo" só abre quando o fio é solto em espaço vazio (nunca sobre nó/saída inválida) */
export function shouldOpenNextStepMenu(s: DropState, readOnly: boolean, triggerId: string): boolean {
  if (readOnly || s.isValid === true || !s.fromNodeId || s.fromNodeId === triggerId) return false;
  return !s.toNode && !s.toHandle;
}

/** Um arraste vira 1 passo do histórico: movimentos e o `dragging:false` final entram na mesma fusão */
export function dragMerge(opts: { dragging: boolean; ended: boolean; removed: boolean }): boolean {
  return !opts.removed && (opts.dragging || opts.ended);
}

/** Inserções repetidas no mesmo ponto não se empilham: desloca 24px na diagonal enquanto houver bloco ali */
export function offsetFree(at: Position, taken: Position[], step = 24): Position {
  let p = { ...at };
  while (taken.some((t) => Math.abs(t.x - p.x) < 8 && Math.abs(t.y - p.y) < 8)) p = { x: p.x + step, y: p.y + step };
  return p;
}

/** Salvar fica bloqueado em Teste/Ativa enquanto houver erro: a API recusaria com `automation.flow_invalid` */
export function saveBlockedByErrors(status: string, errorCount: number): boolean {
  return (status === 'TEST' || status === 'ACTIVE') && errorCount > 0;
}

/** Âncora que navega dentro do app, na mesma aba e sem tecla modificadora (candidata ao aviso de sair sem salvar) */
export function isInternalNavigation(
  a: { href: string; target?: string | null; download?: boolean },
  ev: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button?: number },
  currentHref: string,
): boolean {
  if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || (ev.button ?? 0) !== 0) return false;
  if (a.download || (a.target && a.target !== '_self')) return false;
  let to: URL;
  let from: URL;
  try {
    to = new URL(a.href, currentHref);
    from = new URL(currentHref);
  } catch {
    return false;
  }
  if (to.origin !== from.origin || !/^https?:$/.test(to.protocol)) return false;
  // âncora para trecho da mesma página não sai do editor
  return !(to.pathname === from.pathname && to.search === from.search && to.hash !== '');
}

/** Ordem das respostas no lead: campos de pergunta e `saveTo` de mensagem, na ordem do grafo */
export function answerOrder(nodes: Array<{ type: string; data: unknown }>): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const d = n.data as { field?: unknown; saveTo?: unknown };
    const f = n.type === 'question' ? d.field : n.type === 'message' ? d.saveTo : undefined;
    if (typeof f === 'string' && f && !out.includes(f)) out.push(f);
  }
  return out;
}

/** Exclusão pelo teclado: nós e ligações de uma vez só (1 passo no histórico); abertura e gatilho não saem */
export function applyDeletion(flow: Flow, nodeIds: string[], edgeIds: string[], protectedIds: string[] = []): Flow {
  let next = flow;
  for (const id of nodeIds) if (!protectedIds.includes(id)) next = removeNode(next, id);
  for (const id of edgeIds) next = removeEdge(next, id);
  return next;
}
