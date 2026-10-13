import { describe, expect, test } from 'bun:test';
import { ContentPieceStatuses } from '@manypost/contracts';
import { AUTOMATIC_STAGES, canContentTransition, isAutomatic } from './content-piece-state';

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

  test('erro pode ser retomado de uma etapa', () => {
    expect(canContentTransition('erro', 'ideia')).toBe(true);
  });

  test('erro → publicado existe só para a confirmação humana de publicação incerta', () => {
    // a tabela permite; quem garante que há um NEEDS_REVIEW por trás é o caso de uso
    expect(canContentTransition('erro', 'publicado')).toBe(true);
    // nenhuma etapa automática leva a publicado sem passar por agendado
    for (const s of ['ideia', 'roteiro', 'producao', 'aprovado'] as const) {
      expect(canContentTransition(s, 'publicado')).toBe(false);
    }
  });

  test('só os status com etapa automática entram na fila', () => {
    expect([...AUTOMATIC_STAGES].sort()).toEqual(['aprovado', 'ideia', 'producao', 'roteiro']);
    expect(isAutomatic('revisao')).toBe(false);
    expect(isAutomatic('ideia')).toBe(true);
  });
});
