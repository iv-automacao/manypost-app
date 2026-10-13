import { describe, expect, test } from 'bun:test';
import { dragMerge, offsetFree, shouldOpenNextStepMenu } from './canvas-logic';

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
