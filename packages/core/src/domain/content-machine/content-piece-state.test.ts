import { describe, expect, test } from 'bun:test';
import { ContentPieceStatuses } from '@manypost/contracts';
import { AUTOMATIC_STAGES, canTransition, isAutomatic, keywordFor } from './content-piece-state';

describe('ciclo de vida da peça', () => {
  test('as etapas automáticas avançam na ordem da esteira', () => {
    expect(canTransition('ideia', 'roteiro')).toBe(true);
    expect(canTransition('roteiro', 'producao')).toBe(true);
    expect(canTransition('producao', 'aprovado')).toBe(true);
    expect(canTransition('producao', 'revisao')).toBe(true);
    expect(canTransition('aprovado', 'agendado')).toBe(true);
    expect(canTransition('agendado', 'publicado')).toBe(true);
  });

  test('publicado é terminal', () => {
    for (const s of ContentPieceStatuses) expect(canTransition('publicado', s)).toBe(false);
  });

  test('a revisão humana aprova, reprova ou manda regerar', () => {
    expect(canTransition('revisao', 'aprovado')).toBe(true);
    expect(canTransition('revisao', 'reprovado')).toBe(true);
    expect(canTransition('revisao', 'roteiro')).toBe(true);
    expect(canTransition('revisao', 'agendado')).toBe(false);
  });

  test('erro pode ser retomado de uma etapa, nunca pulando para publicado', () => {
    expect(canTransition('erro', 'ideia')).toBe(true);
    expect(canTransition('erro', 'publicado')).toBe(false);
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
