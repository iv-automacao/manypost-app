'use client';

import { useCallback, useState } from 'react';

/** Histórico de desfazer/refazer do editor (design D8): até 50 passos; digitação e arraste se fundem. */

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** passo aberto por digitação/arraste: as próximas mudanças substituem o presente */
  merging: boolean;
  /** último estado salvo na API */
  saved: T;
}

const LIMIT = 50;

export const historyInit = <T>(v: T): History<T> => ({ past: [], present: v, future: [], merging: false, saved: v });

export function historySet<T>(h: History<T>, next: T, merge: boolean): History<T> {
  if (merge && h.merging) return { ...h, present: next, future: [] };
  return { ...h, past: [...h.past, h.present].slice(-LIMIT), present: next, future: [], merging: merge };
}

export const historySeal = <T>(h: History<T>): History<T> => (h.merging ? { ...h, merging: false } : h);

export function historyUndo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { ...h, past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future], merging: false };
}

export function historyRedo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { ...h, past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1), merging: false };
}

export const historyMarkSaved = <T>(h: History<T>): History<T> => ({ ...h, saved: h.present, merging: false });

export function useFlowHistory<T>(initial: T) {
  const [h, setH] = useState(() => historyInit(initial));
  const set = useCallback((next: T, opts?: { merge?: boolean }) => setH((s) => historySet(s, next, Boolean(opts?.merge))), []);
  const seal = useCallback(() => setH(historySeal), []);
  const undo = useCallback(() => setH(historyUndo), []);
  const redo = useCallback(() => setH(historyRedo), []);
  const markSaved = useCallback(() => setH(historyMarkSaved), []);
  const dirty = h.present !== h.saved && JSON.stringify(h.present) !== JSON.stringify(h.saved);
  return {
    present: h.present,
    set,
    seal,
    undo,
    redo,
    markSaved,
    dirty,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
  };
}
