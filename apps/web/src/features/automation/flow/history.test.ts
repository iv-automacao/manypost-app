import { describe, expect, test } from 'bun:test';
import { historyInit, historyMarkSaved, historyRedo, historySeal, historySet, historyUndo } from './history';

describe('histórico do editor', () => {
  test('desfaz e refaz; nova edição apaga o futuro', () => {
    let h = historyInit(1);
    h = historySet(h, 2, false);
    h = historySet(h, 3, false);
    h = historyUndo(h);
    expect(h.present).toBe(2);
    h = historyRedo(h);
    expect(h.present).toBe(3);
    h = historyUndo(h);
    h = historySet(h, 9, false);
    expect(h.future).toEqual([]);
    expect(h.past).toEqual([1, 2]);
  });

  test('digitação e arraste viram um passo só até selar', () => {
    let h = historyInit('a');
    h = historySet(h, 'ab', true);
    h = historySet(h, 'abc', true);
    h = historySeal(h);
    h = historySet(h, 'abcd', true);
    expect(h.past).toEqual(['a', 'abc']);
    expect(historyUndo(h).present).toBe('abc');
  });

  test('limite de 50 passos e marca de salvo', () => {
    let h = historyInit(0);
    for (let i = 1; i <= 60; i++) h = historySet(h, i, false);
    expect(h.past).toHaveLength(50);
    expect(h.saved).toBe(0);
    h = historyMarkSaved(h);
    expect(h.saved).toBe(60);
  });
});
