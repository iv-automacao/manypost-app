import { PublicationStates, type PublicationState } from '@manypost/contracts';

export { PublicationStates, type PublicationState };

/** Transições permitidas — única fonte de verdade; UPDATEs condicionais no repositório (fencing). */
export const AllowedTransitions: Record<PublicationState, readonly PublicationState[]> = {
  DRAFT: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['PUBLISHING', 'CANCELLED'],
  PUBLISHING: ['PUBLISHED', 'RETRYING', 'TOKEN_REFRESH', 'FAILED', 'NEEDS_REVIEW'],
  RETRYING: ['PUBLISHING', 'FAILED', 'CANCELLED'],
  TOKEN_REFRESH: ['PUBLISHING', 'FAILED'],
  PUBLISHED: [],
  // retry manual, ou descarte: quem refaz o conteúdo (ex.: máquina de conteúdo) aposenta o post que
  // falhou para ele não voltar ao ar por um "tentar de novo" esquecido no Quadro
  FAILED: ['SCHEDULED', 'CANCELLED'],
  CANCELLED: [],
  NEEDS_REVIEW: ['PUBLISHED', 'SCHEDULED', 'FAILED'], // resolução humana (DECISIONS v1 §7)
};

export function canTransition(from: PublicationState, to: PublicationState): boolean {
  return AllowedTransitions[from].includes(to);
}
