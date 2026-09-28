import { describe, expect, test } from 'bun:test';
import { ContentPieceStatuses } from '@manypost/contracts';
import { AUTOMATIC_STAGES, canContentTransition, isAutomatic, keywordFor } from './content-piece-state';

describe('ciclo de vida da peça', () => {
  test('as etapas automáticas avançam na ordem da esteira', () => {
    expect(canContentTransition('ideia', 'roteiro')).toBe(true);
    expect(canContentTransition('roteiro', 'producao')).toBe(true);
    expect(canContentTransition('producao', 'aprovado')).toBe(true);
    expect(canContentTransition('producao', 'revisao')).toBe(true);
    expect(canContentTransition('aprovado', 'agendado')).toBe(true);
    expect(canContentTransition('agendado', 'publicado')).toBe(true);
  });

  test('publicado é terminal', () => {
    for (const s of ContentPieceStatuses) expect(canContentTransition('publicado', s)).toBe(false);
  });

  test('a revisão humana aprova, reprova ou manda regerar', () => {
    expect(canContentTransition('revisao', 'aprovado')).toBe(true);
    expect(canContentTransition('revisao', 'reprovado')).toBe(true);
    expect(canContentTransition('revisao', 'roteiro')).toBe(true);
    expect(canContentTransition('revisao', 'agendado')).toBe(false);
  });

  test('erro pode ser retomado de uma etapa, nunca pulando para publicado', () => {
    expect(canContentTransition('erro', 'ideia')).toBe(true);
    expect(canContentTransition('erro', 'publicado')).toBe(false);
  });

  test('só os status com etapa automática entram na fila', () => {
    expect([...AUTOMATIC_STAGES].sort()).toEqual(['aprovado', 'ideia', 'producao', 'roteiro']);
    expect(isAutomatic('revisao')).toBe(false);
    expect(isAutomatic('ideia')).toBe(true);
  });

  test('palavra-chave: linha, dia e letra', () => {
    const d = new Date('2026-10-06T12:00:00Z');
    expect(keywordFor('empresario', d, [])).toBe('PME-1006-A');
    expect(keywordFor('familia', d, ['PLANO-1006-A', 'PLANO-1006-B'])).toBe('PLANO-1006-C');
  });
});
