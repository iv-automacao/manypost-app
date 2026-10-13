'use client';

import { createContext, useContext } from 'react';
import type { Problem, ShapeKey } from './logic';

/** Ações do editor que os balões usam (design D8) — o estado vive no editor, não no React Flow. */
export interface FlowActions {
  readOnly: boolean;
  problems: Map<string, Problem[]>;
  shape: Map<string, ShapeKey[]>;
  fields: string[];
  update: (id: string, patch: Record<string, unknown>, opts?: { merge?: boolean }) => void;
  seal: () => void;
  addOption: (id: string) => void;
  removeOption: (id: string, optionId: string) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => void;
  testFrom: (id: string) => void;
  openTrigger: () => void;
}
export const FlowActionsContext = createContext<FlowActions | null>(null);
export function useFlowActions(): FlowActions {
  const v = useContext(FlowActionsContext);
  if (!v) throw new Error('FlowActionsContext ausente');
  return v;
}
