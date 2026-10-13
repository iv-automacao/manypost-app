import type { Position } from './logic';

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
