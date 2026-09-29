import type { ContentPieceStatus } from '@manypost/contracts';

/** Transições permitidas — única fonte de verdade; o repositório aplica com UPDATE condicional. */
export const AllowedContentTransitions: Record<ContentPieceStatus, readonly ContentPieceStatus[]> = {
  ideia: ['roteiro', 'erro', 'reprovado'],
  roteiro: ['producao', 'ideia', 'erro', 'reprovado'],
  producao: ['aprovado', 'revisao', 'roteiro', 'erro', 'reprovado'],
  revisao: ['aprovado', 'reprovado', 'roteiro', 'producao', 'ideia'],
  aprovado: ['agendado', 'revisao', 'erro'],
  agendado: ['publicado', 'erro'],
  publicado: [],
  reprovado: ['ideia'],
  // `publicado` a partir de erro só por confirmação humana de publicação incerta
  erro: ['ideia', 'roteiro', 'producao', 'aprovado', 'reprovado', 'publicado'],
};

export function canContentTransition(from: ContentPieceStatus, to: ContentPieceStatus): boolean {
  return AllowedContentTransitions[from].includes(to);
}

/** status que têm uma etapa automática (a fila executa); os demais esperam pessoa ou são terminais */
export const AUTOMATIC_STAGES: ReadonlySet<ContentPieceStatus> = new Set(['ideia', 'roteiro', 'producao', 'aprovado']);

export const isAutomatic = (s: ContentPieceStatus): boolean => AUTOMATIC_STAGES.has(s);
