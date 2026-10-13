import { describe, expect, test } from 'bun:test';
import { applyDeletion, answerOrder, dragMerge, isInternalNavigation, offsetFree, saveBlockedByErrors, shouldOpenNextStepMenu } from './canvas-logic';
import { historyInit, historySet, historyUndo } from './history';
import type { Flow } from './logic';

const base = { isValid: null, fromNodeId: 'a', toNode: null, toHandle: null };
describe('canvas-logic', () => {
  test('menu abre só em espaço vazio', () => {
    expect(shouldOpenNextStepMenu(base, false, 'trigger')).toBe(true);
    expect(shouldOpenNextStepMenu({ ...base, isValid: false, toNode: {} }, false, 'trigger')).toBe(false);
    expect(shouldOpenNextStepMenu({ ...base, isValid: false, toHandle: {} }, false, 'trigger')).toBe(false);
    expect(shouldOpenNextStepMenu({ ...base, isValid: true }, false, 'trigger')).toBe(false);
    expect(shouldOpenNextStepMenu({ ...base, fromNodeId: 'trigger' }, false, 'trigger')).toBe(false);
    expect(shouldOpenNextStepMenu(base, true, 'trigger')).toBe(false);
  });
  test('arraste: o dragging:false final também funde', () => {
    expect(dragMerge({ dragging: true, ended: false, removed: false })).toBe(true);
    expect(dragMerge({ dragging: false, ended: true, removed: false })).toBe(true);
    expect(dragMerge({ dragging: false, ended: false, removed: false })).toBe(false);
    expect(dragMerge({ dragging: false, ended: true, removed: true })).toBe(false);
  });
  test('offsetFree desloca até achar vaga', () => {
    expect(offsetFree({ x: 0, y: 0 }, [])).toEqual({ x: 0, y: 0 });
    expect(offsetFree({ x: 0, y: 0 }, [{ x: 0, y: 0 }, { x: 24, y: 24 }])).toEqual({ x: 48, y: 48 });
  });
});

const noKeys = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 };
const here = 'https://app.manypost.io/automacoes/abc';

describe('salvar bloqueado', () => {
  test('em teste/ativa com erro; rascunho e pausada passam', () => {
    expect(saveBlockedByErrors('TEST', 1)).toBe(true);
    expect(saveBlockedByErrors('ACTIVE', 2)).toBe(true);
    expect(saveBlockedByErrors('ACTIVE', 0)).toBe(false);
    expect(saveBlockedByErrors('DRAFT', 3)).toBe(false);
    expect(saveBlockedByErrors('PAUSED', 3)).toBe(false);
  });
});

describe('navegação interna', () => {
  test('link interno comum pede confirmação', () => {
    expect(isInternalNavigation({ href: '/leads' }, noKeys, here)).toBe(true);
    expect(isInternalNavigation({ href: 'https://app.manypost.io/leads?x=1' }, noKeys, here)).toBe(true);
  });
  test('ignora externo, nova aba, modificadores, download e âncora da mesma página', () => {
    expect(isInternalNavigation({ href: 'https://outro.com/' }, noKeys, here)).toBe(false);
    expect(isInternalNavigation({ href: '/leads', target: '_blank' }, noKeys, here)).toBe(false);
    expect(isInternalNavigation({ href: '/leads' }, { ...noKeys, metaKey: true }, here)).toBe(false);
    expect(isInternalNavigation({ href: '/leads' }, { ...noKeys, button: 1 }, here)).toBe(false);
    expect(isInternalNavigation({ href: '/x.csv', download: true }, noKeys, here)).toBe(false);
    expect(isInternalNavigation({ href: '#topo' }, noKeys, here)).toBe(false);
    expect(isInternalNavigation({ href: 'mailto:a@b.c' }, noKeys, here)).toBe(false);
  });
});

describe('ordem das respostas', () => {
  test('perguntas e saveTo de mensagem, na ordem do grafo, sem repetir', () => {
    const nodes = [
      { type: 'opening', data: { text: 'x' } },
      { type: 'message', data: { saveTo: 'interesse' } },
      { type: 'question', data: { field: 'nome' } },
      { type: 'message', data: {} },
      { type: 'question', data: { field: 'interesse' } },
    ];
    expect(answerOrder(nodes)).toEqual(['interesse', 'nome']);
  });
});

describe('exclusão pelo teclado', () => {
  const flow = {
    nodes: [
      { id: 'opening', type: 'opening', position: { x: 0, y: 0 }, data: { text: 'a', mode: 'text', buttonTitle: '' } },
      { id: 'a', type: 'end', position: { x: 1, y: 1 }, data: { text: 'b' } },
    ],
    edges: [{ id: 'e1', source: 'opening', sourceHandle: 'next', target: 'a' }],
  } as unknown as Flow;
  test('remove nó com as ligações e desfaz em 1 passo, ligação volta junto', () => {
    const next = applyDeletion(flow, ['a'], ['e1']);
    expect(next.nodes.map((n) => n.id)).toEqual(['opening']);
    expect(next.edges).toEqual([]);
    let h = historyInit(flow);
    h = historySet(h, next, false);
    expect(historyUndo(h).present).toBe(flow);
  });
  test('a abertura é protegida', () => {
    expect(applyDeletion(flow, ['opening'], [], ['opening']).nodes).toHaveLength(2);
  });
});
